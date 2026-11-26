# Phase 1.3 — Production Continuity Pilot

No inference was launched while implementing Phase 1.3.

## Evidence-grounding correction

The Fast Review audit documented in `out/observations/phase1.3-passion-max-pilot/FAST_EVIDENCE_GROUNDING_AUDIT.md`
found a real backend-vs-manifest image-order discrepancy in the accepted Fast run, in
addition to valid-but-semantically-wrong model citations. The old package is preserved.

The observer now generates analysis-only image derivatives with a readable margin
containing the model alias, immutable evidence ID, timestamp, frame number and shot ID.
Original evidence files and hashes are untouched. The model-facing aliases resolve
deterministically to immutable evidence IDs.

## Deterministic corrections

- Monotonic dialogue alignment no longer reuses one ASR utterance unintentionally.
- Split and merged ASR segments are represented as explicit groups while one-to-one
  matches are preferred when equally supported.
- Intended utterance duration is not invented; timing is labelled coarse ASR-segment
  metadata, never dialogue onset or lip synchronization.
- Intended shot extraction ignores `[Shot N]` references in introductory prose.
- Intended soundscape and music remain separate comparison requirements even when actual
  fulfillment is not observable.
- Proposal validation continues to reject unknown subjects, invalid evidence, invalid
  updates and unsupported facts. Proposals can be audited without being created.
- Evidence derivatives and their hashes are recorded per report.

## Observer model residency

The duplicate Gemma load is investigated in `docs/model-residency-investigation.md`.
The gateway did not unload the model between the two passes; the backend runs with
`--cache-none`, which disables ComfyUI execution caching, and each `CLIPLoader` prompt
requests the checkpoint again. No global cache setting was changed.

## Passion Max pilot preparation

Prepared at:

```text
out/observations/phase1.3-passion-max-pilot/
```

Candidate verification and the blocking scene-mapping issue are documented there. The
requested accepted V4 bathroom candidate is bound to Engine scene 03, not scene 04; no
binding or canonical record was remapped. The only Engine-consecutive scene-04 bathroom
alternative is `SH04_test`, which is not the requested V4 candidate. Human approval is
required before inference.

Reference capacity is explicit:

- P4: 9 evidence slots, 0 references (7 shots + opening + closing).
- P5: 6 evidence + 3 references (Akari, Daichi, Bedroom).
- P6: 6 evidence + 3 references (Akari, Inflatable Heart, Key Fob).

The continuity contract keeps observed state separate from intended state and is
non-canonical.

## Invariants

- Canonical revision 0.
- No canonical proposal records.
- No candidate approval.
- No Bible changes.
- No media regeneration.
- No additional inference during implementation.

## Completed pilot

The human selected option 3. The binding correction was appended to the production
journal:

```text
original:  suite404-20261125-125611401-84f5-b001 -> scene 03
corrected: suite404-20261125-125611401-84f5-b001-sc-corrected-001 -> scene 04
range:     [0, 362)
source:    6a7df38a8b4c3e5d8f70dbfe85c27f2d99d86601ad71be7714cf7faa7fe588d7
```

The original binding remains in historical snapshot data; `activeBindings()` suppresses
it for continuity retrieval. Canonical revision stayed 0.

Three authorized Fast observations completed:

```text
P4  obs-20261126222816170-bb883570  observation 7cd5be4a-2965-4ef3-8c3b-d00360a3d888
P5  obs-20261126223529906-06d803b9  observation e7d95d04-0a8f-4d3d-b7b2-006dd5de7a08
P6  obs-20261126224432418-1f4376c8  observation 277e6cd4-9a50-42b0-a076-c4f8c822a01e
```

Evidence-integrity checks matched every actual ComfyUI `LoadImage` filename and content
hash to the run analysis manifest for all three jobs. The original evidence and labeled
derivative hashes are preserved.

The resulting non-canonical review is:

```text
out/observations/phase1.3-passion-max-pilot/continuity-review.json
out/observations/phase1.3-passion-max-pilot/CONTINUITY_REVIEW.md
out/observations/packages/passion-max-phase1.3-continuity-pilot.zip
```

The review distinguishes confirmed observations, plausible transitions and insufficient
evidence. P6 wetness and the key fob remain insufficient evidence, not affirmative
negatives. No additional inference was launched for the review.
