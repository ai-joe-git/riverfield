# Phase 2.1 — Production-Independent Continuity Supervisor

No model inference was launched for Phase 2.1 implementation or regression tests. Existing
reviews v1–v5 and all existing artifacts are preserved. Canonical revision remains **0**.

## Generic planner

`server/continuity-scope.ts` now contains the production-independent planning path:

- resolves the selected scenes in Production Engine order
- resolves candidates through `activeBindings()`, including corrected/superseded bindings
- validates exact production, season, episode, scene range, candidates, binding set,
  observation revisions and source hashes, canonical revision and baseline content hash
- requires an explicit deterministic baseline ID; there is no fallback to another review
- normalizes baseline finding IDs and content hash
- plans bounded adjacent-scene transition batches, respecting the workflow image capacity
- selects opening/closing boundary evidence, observed-event evidence and evidence cited by
  unresolved baseline findings
- creates unique model-facing aliases and checks derivative/original hashes before use
- derives reference warnings from the selected observations’ historical reference IDs and
  the semantic asset audit, rather than a hardcoded production warning
- builds compact context using aliases; full provenance remains in artifacts

`server/continuity-supervisor.ts` only executes the explicitly planned batches and records
the immutable review. It contains no P4/P5/P6 roles, observation UUIDs, frame IDs or P6
warning text.

## Baseline integrity

The request now requires `baselineReviewId`. The planner rejects:

- a missing baseline
- a non-deterministic baseline
- another production, season or episode
- a different scene order/range, candidate set, binding set or observation revision/hash
- a stale canonical revision

The baseline ID, content hash and actual finding count are written into the request,
execution log and review `execution` metadata.

Every baseline finding must receive exactly one disposition:

- `confirms`
- `challenges`
- `insufficient_evidence`
- `not_reviewed` with a reason

The validator records unreviewed baseline findings separately. It does not claim coverage
success when dispositions are missing. It does not require the model to invent a challenge.

## Review validation

Findings are tagged by source:

- `independent_model` for senior findings
- deterministic baseline findings in the separate baseline artifact
- human audit findings in a separate artifact/input channel
- asset integrity warnings in their own artifact
- unreviewed baseline findings in their own artifact

Evidence aliases are checked against the actual batch. Baseline finding IDs and correction
plan references are checked. Dialogue findings must cite an audio/transcript alias. Missing
coverage produces `coverageComplete: false` and an explicit limitation.

## Bounded batching and context

A batch contains at most four scenes for a nine-image workflow, with overlapping adjacent
scenes so all transitions are covered. Larger ranges produce multiple bounded batches rather
than one episode-sized prompt.

The Passion Max scope now produces one 13.9k-character prompt (down from 51.7k), contains no
observation UUIDs, and uses aliases `S01`, `S02`, `S03` and evidence aliases such as
`batch-01-S01-01`. Full UUIDs, original/derivative hashes and labels remain in the artifacts.

## Asset correction workflow

The Assets workspace now shows the prepared eleven-entry correction batch with:

- original indexed image
- current and proposed labels
- current and proposed categories
- aliases
- proposed tags and superseded-tag change
- reference suitability
- rationale

The ambiguous hallway asset is shown separately and remains under review. The human
decision controls record approve/reject in an append-only decision file. They do not apply
metadata, rewrite media or change historical reference provenance automatically.

API:

```text
GET  /api/asset-corrections/decisions
POST /api/asset-corrections/decisions
```

## Regression coverage

`test/phase2.1-supervisor.test.ts` covers:

- existing Passion Max scope
- a different synthetic production with different characters, locations and props
- corrected active bindings
- multiple deterministic baselines in different episodes
- contradictory opening/closing states
- missing observations and missing evidence
- baseline disposition coverage
- scene ranges exceeding image capacity
- no Passion Max IDs or warnings in another production prompt

All deterministic; no inference. Full regression result: `npm test` **331 passing**;
`npm run typecheck` passed; `npm run validate` reports 171 apps, 0 errors, 0 warnings.

## Phase 3

The proposed Autonomous Production Loop is documented in
`docs/phase3-autonomous-production-loop.md`. It is architecture only and does not implement
unrestricted autonomous regeneration.
