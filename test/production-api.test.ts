import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const listen = () => new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
  });
});

test("Production Engine HTTP API exposes proposals but no approval route", { timeout: 30000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), "riverfield-production-api-"));
  const reservation = await listen();
  const port = reservation.port;
  await reservation.close();
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "server/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), RIVERFIELD_HOST: "127.0.0.1", RIVERFIELD_OUT: out, RIVERFIELD_PASSCODE: "", RIVERFIELD_MAX_ACTIVE: "0", RIVERFIELD_MAX_RUNS_PER_DAY: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`server did not start: ${log}`)), 15_000);
      const poll = () => {
        if (log.includes("riverfield on")) { clearTimeout(timeout); resolve(); }
        else setTimeout(poll, 25);
      };
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(log)); });
      poll();
    });
    const base = `http://127.0.0.1:${port}`;
    const json = async (path: string, init?: RequestInit) => {
      const response = await fetch(base + path, init);
      const body = await response.json();
      return { response, body };
    };
    const post = (path: string, body: unknown) => json(path, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(body) });

    const empty = await json("/api/productions");
    assert.equal(empty.response.status, 200);
    assert.deepEqual(empty.body.productions, []);

    const created = await post("/api/productions", { id: "suite-404", title: "SUITE 404", logline: "fixture" });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.production.id, "suite-404");
    assert.equal(created.body.revision, 0);

    await post("/api/productions/suite-404/seasons", { id: "suite-404-s01", number: 1, title: "Season 01" });
    await post("/api/productions/suite-404/episodes", { id: "suite-404-s01e01", seasonId: "suite-404-s01", number: 1, title: "Passion Max" });
    await post("/api/productions/suite-404/scenes", { id: "suite-404-s01e01-sc01", episodeId: "suite-404-s01e01", number: 1, title: "Scene 01" });
    const proposal = await post("/api/productions/suite-404/proposals", {
      expectedRevision: 0,
      changes: [{ op: "add", category: "identity", text: "Akari is the hotel guest." }],
    });
    assert.equal(proposal.response.status, 201);
    assert.equal(proposal.body.proposal.status, "proposed");
    assert.equal(proposal.body.snapshot.revision, 0);

    const context = await json("/api/productions/suite-404/context?sceneId=suite-404-s01e01-sc01");
    assert.equal(context.response.status, 200);
    assert.equal(context.body.revision, 0);
    assert.equal(context.body.sections.identity.facts.length, 0, "a proposal is not canonical memory");

    const forbidden = await post("/api/productions/suite-404/approve", { proposalId: proposal.body.proposal.id });
    assert.equal(forbidden.response.status, 404, "there is deliberately no HTTP approval route");
    const snapshot = await json("/api/productions/suite-404");
    assert.equal(snapshot.body.revision, 0, "the proposal cannot be approved through the API");
    assert.equal(snapshot.body.proposals[proposal.body.proposal.id].status, "proposed");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(out, { recursive: true, force: true });
  }
});
