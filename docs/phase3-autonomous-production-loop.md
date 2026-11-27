# Phase 3 — Autonomous Production Loop Architecture

No autonomous loop was implemented or launched in this phase. This document prepares the
first real end-to-end production loop without authorizing unrestricted regeneration.

## Goal

```text
Director
  → render candidate
  → independent observation
  → deterministic validation
  → continuity review
  → correction recommendation
  → explicit human approval
  → canonical memory update
  → next scene
```

## Reuse, not a new runtime

The loop is a bounded orchestrator over existing Riverfield components:

- Director / H3 and other registered generation apps
- Production Engine journal (`ProductionStore`), active bindings and candidates
- existing ComfyUI workflow runner and shared inference queue
- History media and existing observation evidence/derivatives
- observer profiles (Fast, Detailed, Senior, Experimental AV)
- existing MCP operations and Production Studio
- append-only continuity reviews and canonical approval boundary

No second model runtime, vector database or parallel media system is introduced.

## Project scope

Every run is scoped to:

```text
production → season → episode → ordered scene range → selected candidate/bindings
```

The supervisor must resolve candidates through active bindings, including corrected
bindings. It must reject observations that do not match the selected revision and source
hash. Scope and budget are immutable inputs to a run.

## State machine and resumability

Each scene/iteration is a durable checkpoint:

1. `planned` — target scene and approved brief.
2. `rendering` — one candidate render with a generation budget reservation.
3. `candidate_registered` — immutable candidate and verified outputs.
4. `observed` — one explicit observation job, reusing evidence when allowed.
5. `deterministically_validated` — baseline findings and evidence checks.
6. `continuity_reviewed` — bounded senior review with baseline dispositions.
7. `correction_recommended` — keep, accept deviation, request evidence/human review,
   prepare a targeted correction, or recommend regeneration.
8. `awaiting_human` — no automatic approval.
9. `canonicalized` — only after an interactive human approval.
10. `next_scene` — resume from the durable journal.

A run can stop at any checkpoint and resume without repeating completed expensive work.
Idempotency keys are required for render, observation and review operations.

## Explicit budgets

A run carries a budget ledger with hard limits:

- maximum candidate renders per scene
- maximum total renders per episode
- maximum observation jobs and model calls
- maximum senior-review batches/tokens
- wall-clock deadline
- optional GPU/VRAM residency budget

Budget exhaustion stops the run in `awaiting_human`; it never silently retries. A failed
inference is recorded and does not trigger an automatic second pass.

## Candidate retention

The loop begins with `keep_existing_candidate` as the default disposition. Regeneration is
recommended only when a material contradiction is sufficiently supported by evidence and
the deterministic and senior reviews agree on the affected scope. Missing sampled evidence,
an offscreen prop, or a prompt omission is not sufficient.

Every correction recommendation must include:

- rationale
- evidence aliases and full provenance
- affected scenes/bindings/candidates
- estimated scope
- whether human visual/audio review is requested
- budget impact

## Human approval boundary

The loop cannot approve candidates, create canonical proposals, modify the Bible or apply
asset correction batches on its own. Human approval remains an interactive boundary:

```text
prepare proposal(s) → show exact fingerprint/scope → explicit human approval → append
```

Rollback remains a new restoration event. Canonical revision remains the only authority for
narrative memory.

## Asset integrity in the loop

Before reference reuse, the loop must:

1. resolve selected observations;
2. collect their reference asset IDs;
3. query the semantic asset audit;
4. block untrusted/ambiguous assets;
5. use only approved correction batches;
6. preserve historical reference provenance and warnings.

The prepared eleven-entry correction batch and ambiguous hallway asset remain human-review
items. Approval records a decision; it does not rewrite media or provenance.

## Failure policy

| Condition | Loop action |
| --- | --- |
| Missing observation | stop; request observation or human review |
| Baseline missing/mismatched | reject before inference |
| Invalid evidence alias/hash | stop; retain artifacts |
| Missing baseline disposition | incomplete review; no successful challenge claim |
| Material contradiction | recommend targeted correction/regeneration |
| No material contradiction | keep existing candidate |
| Budget exhausted | stop at checkpoint; await human |
| Human rejects | retain candidate and record decision |

## First-loop preparation

The first real end-to-end loop should use a **small two- or three-scene range**, one
candidate per scene, existing observer evidence where available, and zero unrestricted
regeneration. It should produce:

- a project-scoped budget ledger
- a resumable run record
- immutable observation and review links
- an explicit correction recommendation
- no canonical change unless a human approves it

No benchmark or additional model inference is launched by this document.

## Implementation status (Phase 3 preparation)

The durable run entity, budget ledger and engine are implemented in:

```text
server/production-types.ts       ProductionRun, scene plan, budget, provisional facts
server/production-store.ts       append-only production.run.* events
server/production-run.ts         resumable state machine, reservations, reconciliation
server/production-run-plan.ts    editable brief → scene plan
web/js/productions.js            Production Run workspace
mcp/server.ts                    project-scoped run tools
```

The first SUITE 404 pilot's first scene was executed in Phase 3.1 and stopped at human
review; the second scene remains unlaunched:

```text
run: phase3-suite404-pilot-001
plan: out/observations/phase3-pilot/pilot-plan.json
run:  out/observations/phase3-pilot/production-run.json
doc:  docs/phase3-first-suite404-pilot.md
live: docs/phase3.1-live-first-scene.md
```

The engine is tested with mocked adapters and existing observations. Live rendering and
Fast-observation adapters are now implemented through the existing Riverfield HTTP
services, Runner, History, candidate registration and ObservationManager. Senior Review
remains fail-closed and is not enabled for this pilot. No adapter is invoked by opening
Production Studio or by planning a run.
