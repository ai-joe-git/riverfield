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

## Phase 3.1 completion — second scene

The first candidate was explicitly retained as non-canonical for the Build pilot after the
comparison recovery and validation. The second prepared scene, Room Service Confession, was
then executed with the accepted first-scene provisional closing state in the Director
enhancer context.

```text
scene:         suite-404-s01e02-sc03
candidate:     run-phase3-suite404-pilot-001-suite-404-s01e02-sc03
history:       20261127-015801915-6fa2
observation:   56edfdfd-2ef4-4065-9d7f-cb51e7e2468a
status:        awaiting_human
```

The second scene generated a 416×256, 24 fps, 175-frame, 7.2917 s H.264 + audio clip and a
valid Fast Review observation/comparison. No Senior Review was called. The deterministic
cross-scene continuity review classified the transition as a plausible offscreen transition
from the bar to the suite, not as proof that the intended unstable-glass gag occurred.

Budget consumption is complete for the authorized pilot operations:

```text
renders 2/2 · prompt enhancements 2/2 · observations 2/2 · comparisons 2/2
senior reviews 0/0 · automatic regenerations 0
```

The first scene has an explicit non-canonical retention decision. The second scene remains
at its human-review checkpoint with no decision. Canonical revision is **0** and no Bible
fact or canonical proposal was created.

The two videos and combined review cut are packaged in:

```text
/home/zardoz/SUITE404_Phase3.1_Two_Scene_Pilot_Review.zip
```

## Phase 3.2 pilot closure

Room Service Confession was retained by explicit human decision as a non-canonical Build-pilot
candidate. The run is now **completed**; both candidates remain, and canonical revision is
still **0**. The final budget remains:

```text
renders 2/2 · prompt enhancements 2/2 · observations 2/2 · comparisons 2/2
senior reviews 0/0 · automatic regenerations 0
```

The observation-selection discrepancy is recorded separately in
`out/observations/phase3-pilot/recovery/observation-selection-audit.json`: the intended
next-scene context used recovered revision 2, while the historical scene-03 renderContext and
generation payload used revision 1. The historical payload was not rewritten. The accepted
revision is now explicitly stored on the scene, and future contexts require an accepted
observation identity and persist an effective context hash before enhancement.

The successor continuity review
`continuity-suite404-phase3.1-pilot-prop-r2` records the glass change from short glasses with
light-colored liquid to stemmed wine glasses with red liquid as a **possible offscreen prop
transition**, not a confirmed contradiction. No regeneration is recommended. The earlier
continuity review is preserved.

Separate recovery hashes are recorded in
`out/observations/phase3-pilot/recovery/recovery-hash-audit.json`: raw response, unfenced
source text, exact repaired text, serialized recovered JSON and effective validated
comparison. The delivered recovered file remains byte-preserved.

## Phase 3.2 episode preparation

A separate run, `phase3.2-suite404-s01e03-production-001`, has been prepared but not started.
It is the original three-minute episode **The Key to Room 404**, with twelve independently
generated fifteen-second scenes, Build profile at 0.1 MP, native English dialogue, Fast
Review, deterministic continuity and two selectively budgeted Senior Review scenes. See
`docs/phase3.2-episode-plan.md` and `out/productions/suite-404/phase3.2/episode-plan.json`.
