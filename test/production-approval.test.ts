import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionStore } from "../server/production-store.ts";

const actor = { kind: "agent" as const, id: "test-agent" };

test("the production approval CLI refuses a non-interactive approval", { timeout: 15000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), "riverfield-production-cli-"));
  try {
    const store = new ProductionStore(out);
    store.createProduction({ id: "suite-404", title: "SUITE 404" }, actor, "production");
    store.createSeason("suite-404", { id: "suite-404-s01", number: 1, title: "Season 01" }, actor, "season");
    store.createEpisode("suite-404", { id: "suite-404-s01e01", seasonId: "suite-404-s01", number: 1, title: "Passion Max" }, actor, "episode");
    store.createScene("suite-404", { id: "suite-404-s01e01-sc01", episodeId: "suite-404-s01e01", number: 1, title: "Scene 01" }, actor, "scene");
    const proposal = store.propose("suite-404", { changes: [{ op: "add", category: "state", text: "A canonical fact." }] }, actor, "proposal").proposal;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "server/production-cli.ts", "approve", "suite-404", proposal.id], {
      cwd: process.cwd(), env: { ...process.env, RIVERFIELD_OUT: out }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise<number>((resolve) => child.once("exit", (status) => resolve(status ?? 1)));
    assert.notEqual(code, 0);
    assert.match(output, /interactive terminal|TTY|Canonical approval/i);
    assert.equal(new ProductionStore(out).snapshot("suite-404").revision, 0, "the proposal was not approved");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
