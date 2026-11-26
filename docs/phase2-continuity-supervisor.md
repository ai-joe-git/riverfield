# Phase 2 — Autonomous Continuity Supervisor

No model inference was launched during implementation. One senior continuity pass was later
executed with explicit human authorization after the preflight corrections below. No media
was regenerated, no candidate was approved, no canonical proposal was recorded and no Bible
fact changed. Canonical revision remains **0**.

## Asset catalogue integrity

The catalogue audit does not trust filenames or matching transport hashes as evidence of
semantic identity. It compares the indexed label, the original History prompt, the source
run and the actual image.

The audit found a systematic label shift beginning at the extra hallway asset:

```text
suite404-asset-20261124-224902120-37c3-1   actual hallway        label Naomi
suite404-asset-20261124-225232945-54f9-1   actual Naomi          label Tetsuo
suite404-asset-20261124-231235158-b8a5-1   actual Tetsuo         label Haru
suite404-asset-20261124-231927643-6090-1   actual Haru           label Emi
suite404-asset-20261124-233704943-61ec-1   actual Emi            label Momo
suite404-asset-20261124-234855840-40f7-1   actual Momo sheet     label Inflatable Heart
suite404-asset-20261124-235052163-a49c-1   actual heart          label Retro Intercom
suite404-asset-20261124-235222479-02cb-1   actual intercom       label Key Fob
suite404-asset-20261124-235352755-7399-1   actual key fob        label Room Service Cart
suite404-asset-20261124-235528748-f739-1   actual cart           label Romance Menu
suite404-asset-20261124-235658992-0df9-1   actual menu           label Karaoke Mic
suite404-asset-20261124-235829229-3022-1   actual microphone     label Hotel Mascot Display
```

The first entry remains **ambiguous** because an earlier Hallway master already exists.
The other eleven entries are prepared as an explicit, non-applied correction batch with
category, alias, tag and reference-suitability checks. The microphone entry removes the
incorrect `superseded` tag. Corrected character sheets are classified as multi-view
character references, not as props; the Momo sheet is not reusable as the inflatable heart.

Assets outside the batch are recorded as `not-independently-verified` rather than being
silently promoted to verified merely because no correction was found.

Artifacts:

```text
out/observations/phase2-asset-audit/contact-sheet-all.jpg
out/observations/phase2-asset-audit/contact-sheet-53-production-assets.jpg
out/observations/phase2-asset-audit/asset-audit.json
out/observations/phase2-asset-audit/asset-correction-batch.json
out/observations/phase2-asset-audit/p6-reference-audit-warning.json
```

`server/asset-audit.ts` exposes the audit and batch. The observation manager rejects any
new reference selection containing an untrusted asset. The Production Studio reference
picker marks and disables those options. Historical P6 reference provenance remains in its
report; the P6 warning is a separate record and does not rewrite the report.

## Temporal state correction

`server/observed-state.ts` now separates:

- observed opening state, using only first-shot boundary evidence;
- chronological observed events, sorted by actual frame timestamps;
- observed closing state, using only last-shot boundary evidence;
- persistent/scene-wide identity, wardrobe, location, props and environmental state;
- unknown boundary conditions, including P6 wetness and the key fob.

P4's opening state no longer contains the toilet/bathtub actions. P5 wetness is retained as
probable with boundary-specific evidence: `frame-0004` at opening and `frame-0005` at
closing. P6 wetness is unknown, not dry. The key fob is unknown when unsampled, not absent.

Regression tests prove late-scene events cannot leak into opening state and that P5/P6
wetness are treated differently.

## First-class continuity reviews

`ContinuityReview` is an append-only entity in the Production Engine. It links production,
season/episode, ordered scenes, scene bindings, candidates, exact observation revisions and
source hashes, canonical revision, reviewer model/configuration, evidence references,
findings, state records, correction plans, limitations and version history.

Current chain:

```text
v1 continuity-passion-max-p4-p6-deterministic          completed, non-canonical
v2 continuity-passion-max-p4-p6-senior-prepared         prepared, preserved
v3 continuity-passion-max-p4-p6-senior-corrected-prepared prepared, corrected states
v4 continuity-4cf9219b-fc3c-4c67-b4fa-88e572fe0157       completed senior review
v5 continuity-passion-max-p4-p6-posthoc-validation       completed validation addendum
```

The senior pass used Qwen3.8 27B W4A8 at temperature 0.1, max output 4096, top-k 64,
top-p 0.9, seed 0, thinking off. Eight actual boundary/context images were attached with
verified SHA-256 hashes and aliases. Audio waveforms were not attached; ASR transcripts
and audio-file provenance were supplied, so dialogue reasoning is transcript-grounded, not
independent audio verification.

The senior run took 346.75 seconds and produced three validated findings. Its recommended
disposition was `keep_existing_candidate`.

### Recorded limitation

The actual request resolved the immediate predecessor, the earlier prepared review with an
empty findings array, as its baseline. The deterministic baseline was therefore not in the
model context. The model did not independently challenge the baseline; all three findings
marked `not_in_baseline`. The baseline resolution code has since been fixed to walk the
immutable chain to the nearest deterministic review.

No automatic retry was performed under the one-pass authorization. A deterministic
post-hoc comparison against the real baseline, plus additional validation findings and
human-review recommendations, are packaged separately and are not attributed to Qwen.

The validation addendum records the missing key-fob, P6-wetness, petal, dialogue/ASR and
baseline-challenge coverage. It recommends keeping the existing candidate and requests
human visual/audio review only where sampled evidence is insufficient.

## Interfaces

Production Studio has a **Continuity** workspace. It lists immutable reviews, exposes
prepared-review creation from existing observations, and displays asset warnings including
the P6 contamination warning. Opening the workspace starts no inference.

MCP exposes:

- `list_continuity_reviews`
- `get_continuity_review`
- `prepare_continuity_review`
- `get_asset_audit`

## Validation

- `npm test`: 320 passing.
- `npm run typecheck`: passed.
- `npm run validate`: 171 apps, 0 errors, 0 warnings.
- Browser verification against a local Phase 2 server: Continuity tab renders reviews,
  asset warnings and the separate P6 warning; no inference starts on opening.

## Senior review package

```text
out/observations/packages/passion-max-phase2-senior-continuity-review.zip
out/observations/packages/phase2-senior-continuity-review/SENIOR_CONTINUITY_REVIEW.md
```

It contains the exact request and configuration, corrected states, supplied-image manifest,
exact system/input prompts, raw output, validated findings, correction recommendations,
actual and post-hoc baseline comparisons, logs, timings and the Markdown review.
