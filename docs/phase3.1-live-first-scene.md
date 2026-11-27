# Phase 3.1 — First Live Scene

Status: **stopped at the first human-review checkpoint**. No candidate approval, canonical
proposal, Bible change or second scene render occurred. Canonical revision remains **0**.

## Run

```text
run:             phase3-suite404-pilot-001
scene:           suite-404-s01e02-sc02 — After Hours Toast
candidate:       run-phase3-suite404-pilot-001-suite-404-s01e02-sc02
history run:     20261127-012009140-1b32
observation:     7e975d52-7f9e-4b52-afa9-6acebefa5ec9 (revision 1)
status:          awaiting_human
profile:         build
```

Generated media:

```text
out/history/20261127-012009140-1b32/out-01.mp4
416×256 · 24 fps · 175 frames · 7.2917 s · H.264 + audio
SHA-256 f97b464bc4ee9167a885f0c28d04a95440db8e69366ef591dfc82bbb7727c7b8
```

## Generation

- H3 Studio Director Flash, Build profile.
- 0.1 MP, upscale off.
- Full scene objective, intended events, dialogue requirements, style and transition were
  supplied to the existing Director prompt enhancer.
- All three reference files were hash-verified before submission:
  - Akari character sheet
  - Daichi character sheet
  - Velvet Moon Bar master

The actual History entry, candidate provenance, enhanced prompt and reference manifest are
included in the first-scene review ZIP.

## Observation

Fast Review completed:

- visual pass
- ASR
- deterministic dialogue alignment
- evidence extraction and manifest

The **comparison stage failed** because the observer returned invalid JSON. The raw
comparison output and the exact error are preserved. No comparison or observation retry was
made. Deterministic validation is therefore marked incomplete (`validation.ok=false`) and
the run remains at `awaiting_human`.

This is deliberately not presented as a successful complete observation.

## Provisional state

The provisional record is derived only from the structured observation:

- observed opening/closing states
- observed events
- dialogue transcript text
- uncertainty and evidence references

Intended events are stored separately and are not substituted for observed facts.
A next-scene context preview was prepared but is marked `prepared-not-authorized`; it was not
used by any generation and is not canonical.

## Budget ledger

```text
renders used:             1 / 2
prompt enhancements:      1 / 2
observation jobs:         1 / 2
comparison calls:         1 / 2
senior review batches:    0 / 0
automatic regenerations:  0
```

Preflight corrections (unsupported `production_upscale:"none"` and observation image
capacity) are recorded in the run journal. The invalid pre-inference requests did not create
backend work; the failed comparison remains a real failed inference and was not retried.

## Human checkpoint

No decision has been recorded. Approval would require a valid candidate, structured
observation and completed deterministic validation. Because comparison is incomplete, the
current validation is not considered complete; a human must inspect the failure before any
decision.

## Review ZIP

```text
/home/zardoz/SUITE404_Phase3.1_First_Scene_Review.zip
```

Verification: `npm test` **350 passing**, typecheck passed, manifest validation passed,
and the Production Run workspace was browser-verified. It contains the actual video,
effective payload, enhanced prompt, reference manifest,
History/candidate IDs, raw and structured observation reports, dialogue alignment, provisional
state, next-scene context preview, ProductionRun events, budget ledger, timings, errors and
SHA-256 manifest.
