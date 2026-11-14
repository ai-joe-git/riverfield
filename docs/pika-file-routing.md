# Maya session: repair the actual file-input contract

**Superseded interface design:** the experimental per-app `oneOf` tool schema described below was subsequently removed after the local model returned empty calls. Cinematic entries now open [Director guidé](director-guided.md): deterministic form settings, plain-text-only writing, and code-built actions. The safe transport normalizer remains for legacy/general callers; the guided writer receives no tools at all.

Inspected conversation `8e5ced38-8a41-42c3-9db5-72952874b004` and the uncommitted working tree. Both MOSS jobs succeeded and their files are retained. The selected duration is **18.63 seconds / three native segments**, not a one-segment pilot.

The two rejected calls were different transport mistakes:

1. Known file-input paths `image1`/`image2` were inside `values`, not `files`.
2. The correction supplied the right `files`, but added `values.image:[0,1]`, which is not a Pika input. Those same indices were already present in every segment's `images` selection.

The generic `run_app` schema did not express these app-specific constraints. The model now receives per-app JSON Schema branches derived only from completed `get_app` results: named file slots in `files`, non-file inputs in `values`, actual select enums, no cross-app key leakage (including Qwen's singular `image`). It remains the existing tool, not another agent or planning framework.

`server/run-inputs.ts` is shared by Agent preparation and MCP:

- Move a declared file-input string into its exact named `files` slot, with conflict rejection rather than overwriting another source.
- Canonicalize a ratio shorthand only when it matches one actual aspect option uniquely.
- Remove the misplaced Pika `image` index list **only** when it is redundant with every explicit window selection and all corresponding files are supplied. Ambiguous/unknown fields are still rejected.
- Apply conversation file permissions after routing, so this cannot upload a private file via `values`.

The Agent now reuses the same H3/Pika validators before offering tool approval. Local deterministic argument errors carry structured errors and the bounded-recovery guard, too. No new separate prompt validator is added.

The actual Maya script had one additional problem masked by the transport errors: its second segment omitted `(S1)` before the native English whisper. The reviewed replacement adds only that marker, preserves all three scenes/dialogue words and both original references, and passes full CPU/project validation. It awaits explicit execution approval; no new MOSS, model completion or GPU submission was run to prepare it. Prior history is retained, with a backup under `/tmp/opencode/riverfield-maya-before-typed-input-repair.json`.

Regression checks: **148 Node tests passed**, TypeScript and registry validation passed. `test/run-inputs.test.ts` checks both failure shapes, conflicts, real option mapping and app-specific schema separation. `test/agent-production.test.ts` verifies correction before approval, file-permission preservation and bounded local errors. `test/pika-api.test.ts` sends both failure shapes through the real isolated MCP/HTTP/SDK path with a Maya dialogue fixture and captures the corrected three-window workflow in the mock backend. The native GPU renderer and audiovisual quality remain untested by these mocks.
