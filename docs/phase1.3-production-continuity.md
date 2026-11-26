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
