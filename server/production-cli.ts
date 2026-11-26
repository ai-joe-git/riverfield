#!/usr/bin/env node
// Human-only approval boundary for the Production Engine.
// There is deliberately no HTTP or MCP approval route. This command requires a real
// interactive TTY and an exact challenge derived from the proposal fingerprint.
import { userInfo } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ProductionError, ProductionStore } from "./production-store.ts";
import { importSuite404 } from "./suite404-import.ts";
import { categoryForPrompt } from "./asset-category.ts";
import { approvalChallenge, proposalFingerprint, rollbackFingerprint, type HumanApproval } from "./production-types.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT = process.env.RIVERFIELD_OUT || join(ROOT, "out");
const store = new ProductionStore(OUT);

function usage(): never {
  console.error(`Usage:
  npm run production -- list
  npm run production -- show <productionId>
  npm run production -- approve <productionId> <proposalId>
  npm run production -- rollback <productionId> <targetRevision>
  npm run production -- import-suite404
  npm run production -- classify-suite404

Approval and rollback require an interactive terminal. Agents and MCP callers can create
and propose changes, but cannot approve them.`);
  process.exit(2);
}

async function askExact(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new ProductionError("HUMAN_TTY_REQUIRED", "Approval requires an interactive terminal");
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
}

function approvalFor(fingerprint: string, expectedRevision: number, challenge: string): HumanApproval {
  return {
    method: "interactive-cli", human: true, tty: true,
    approvedBy: (() => { try { return userInfo().username; } catch { return "local-human"; } })(),
    approvedAt: new Date().toISOString(), fingerprint, challenge, expectedRevision,
  };
}

async function approve(productionId: string, proposalId: string) {
  const snapshot = store.snapshot(productionId);
  const proposal = snapshot.proposals[proposalId];
  if (!proposal) throw new ProductionError("UNKNOWN_PROPOSAL", `Unknown proposal ${proposalId}`);
  if (proposal.status !== "proposed") throw new ProductionError("ALREADY_DECIDED", `Proposal is already ${proposal.status}`);
  const fingerprint = proposalFingerprint({
    productionId: proposal.productionId, expectedRevision: proposal.expectedRevision,
    sceneDecision: proposal.sceneDecision, changes: proposal.changes,
  });
  if (fingerprint !== proposal.fingerprint) throw new ProductionError("PROPOSAL_TAMPERED", "Proposal fingerprint does not match its stored content");
  console.log(`\nProduction: ${snapshot.production.title} (${snapshot.production.id})`);
  console.log(`Proposal:   ${proposal.title} (${proposal.id})`);
  console.log(`Expected canonical revision: ${proposal.expectedRevision} (current ${snapshot.revision})`);
  if (proposal.sceneDecision) {
    const decision = proposal.sceneDecision;
    console.log(`Scene decision: ${decision.decision} — scene ${decision.sceneId}, candidate ${decision.candidateId}`);
    if (decision.bindingIds?.length) console.log(`Bindings: ${decision.bindingIds.join(", ")}`);
  }
  if (proposal.changes.length) {
    console.log("Proposed canonical facts:");
    for (const change of proposal.changes) console.log(`- [${change.category}/${change.op}] ${change.text}`);
  }
  console.log(`Fingerprint: ${fingerprint}`);
  const challenge = approvalChallenge(fingerprint);
  const typed = await askExact(`Type exactly "${challenge}" to approve: `);
  if (typed !== challenge) throw new ProductionError("APPROVAL_CHALLENGE_MISMATCH", "The approval challenge did not match exactly");
  store.approveProposal(productionId, proposalId, approvalFor(fingerprint, proposal.expectedRevision, typed));
  const after = store.snapshot(productionId);
  console.log(`Approved. Canonical revision ${snapshot.revision} -> ${after.revision}.`);
}

async function rollback(productionId: string, targetRevisionRaw: string) {
  const targetRevision = Number(targetRevisionRaw);
  const snapshot = store.snapshot(productionId);
  if (!Number.isInteger(targetRevision) || targetRevision < 0 || targetRevision > snapshot.revision) {
    throw new ProductionError("INVALID_ROLLBACK", `Target revision must be between 0 and ${snapshot.revision}`);
  }
  const fingerprint = rollbackFingerprint(productionId, targetRevision, snapshot.revision);
  console.log(`\nProduction: ${snapshot.production.title} (${snapshot.production.id})`);
  console.log(`Rollback canonical revision ${snapshot.revision} -> ${targetRevision}.`);
  console.log(`Fingerprint: ${fingerprint}`);
  const challenge = approvalChallenge(fingerprint);
  const typed = await askExact(`Type exactly "${challenge}" to roll back: `);
  if (typed !== challenge) throw new ProductionError("APPROVAL_CHALLENGE_MISMATCH", "The rollback challenge did not match exactly");
  store.rollback(productionId, targetRevision, approvalFor(fingerprint, snapshot.revision, typed));
  console.log(`Rolled back. A new restoration event was appended; canonical revision is now ${store.snapshot(productionId).revision}.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help") usage();
  if (command === "list") {
    const productions = store.list();
    if (!productions.length) return console.log("No productions.");
    for (const item of productions) console.log(`${item.id} — ${item.title} (${item.scenes} scenes, revision ${item.revision})`);
    return;
  }
  if (command === "show") {
    if (!args[0]) usage();
    const snap = store.snapshot(args[0]);
    console.log(JSON.stringify({
      production: snap.production, revision: snap.revision,
      seasons: snap.seasons, episodes: snap.episodes, scenes: snap.scenes,
      sceneDecisions: snap.sceneDecisions, candidates: Object.values(snap.candidates).map((candidate) => ({
        id: candidate.id, label: candidate.label, sourceRunId: candidate.sourceRunId, bindings: candidate.bindings.length,
      })),
      proposals: Object.values(snap.proposals).filter((proposal) => proposal.status === "proposed").map((proposal) => ({
        id: proposal.id, title: proposal.title, expectedRevision: proposal.expectedRevision,
        sceneDecision: proposal.sceneDecision ?? null, changes: proposal.changes,
      })),
      bible: Object.fromEntries(Object.entries(snap.bible).map(([category, facts]) => [category, facts.length])),
    }, null, 2));
    return;
  }
  if (command === "approve") {
    if (!args[0] || !args[1]) usage();
    await approve(args[0], args[1]);
    return;
  }
  if (command === "rollback") {
    if (!args[0] || !args[1]) usage();
    await rollback(args[0], args[1]);
    return;
  }
  if (command === "import-suite404") {
    const report = importSuite404(OUT);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === "classify-suite404") {
    const productionId = "suite-404";
    const snapshot = store.snapshot(productionId);
    const historyDir = join(OUT, "history");
    const counts = new Map<string, number>();
    for (const asset of Object.values(snapshot.assets)) {
      if (!asset.sourceRunId || !asset.id.startsWith("suite404-asset-")) continue;
      let prompt = "";
      try { prompt = String((JSON.parse(readFileSync(join(historyDir, asset.sourceRunId, "meta.json"), "utf8")) as any).values?.prompt ?? ""); } catch { /* keep references */ }
      const category = categoryForPrompt(prompt);
      store.updateAsset(productionId, asset.id, { category }, { kind: "import", id: "suite404-classifier" }, `suite404:asset-category:${asset.id}:${category}`);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    console.log(JSON.stringify({ productionId, categories: Object.fromEntries(counts) }, null, 2));
    return;
  }
  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
