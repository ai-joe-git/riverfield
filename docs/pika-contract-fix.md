# Pika Director contract regression

Update: the later stable-profile instruction supersedes the earlier five-second benchmark. Automated Pika requests now use the native 175-frame / 39-overlap geometry; see [pika-native-defaults.md](pika-native-defaults.md). Manual Director timelines remain editable.

Inspected the exported conversation at `/home/zardoz/Downloads/riverfield-78e5c3e7-05e8-4511-8203-084004c84c6c.md` and its persisted conversation. The working tree was clean before this fix. The session contains 46 rejected Pika calls; 37 share the retention/Picture errors. No Pika job was created. Both successful MOSS outputs are reused unchanged.

## Findings

- The repeated prompts genuinely lacked official retention markers. Rejecting `Picture 1: 0: Character sheet. Alex identity.` was correct; trying it 37 times was not.
- A Picture inside a Subject definition was already recognized by the old label scanner. There was no need to manufacture a redundant standalone Picture definition. The old requirement that every assigned input appear specifically in `subject_definitions` was unnecessarily restrictive for frame anchors referenced elsewhere; now every mentioned source label is checked against the selected local bin without requiring redundant definitions.
- The official simple `examples/prompts/ref2va.txt` omits the task marker and `[Shot 1]`. These are prompt-writing guidance, not engine constraints; they are no longer hard rejection rules. Inline speaker introduction is accepted. Balanced dialogue tags, language tags, speaker markers and consistency with explicitly declared vocal sources remain checked. Advisory word budgets are not engine limits.
- The gallery example predates the validator: four prose segments, one image, quoted speech without native dialogue tags. MCP must not advertise it as the current executable recipe. Gallery media are preserved separately; `get_app` and `examples` now expose the same tested request recipe.
- `plan_segments` remains geometry/material arithmetic and preserves prompt text unchanged. Its result explicitly reports `promptValidation: "not_performed"`; execution uses the single shared Pika validator.

## Exact accepted request

[`apps/pika-studio-director/request-example.json`](../apps/pika-studio-director/request-example.json) is the complete MCP `run_app` arguments object, without placeholders: original Alex and apartment file paths, local images `[0,1]`, six Ref2VA sections, Subject retention, inline `(S1)` and `<d>[English] Done.</d>`, one native `[0,175)` window at 24 fps, exact portrait aspect and 0.4 MP. It is reference generation, not endpoint conditioning.

## Recovery

HTTP 400 responses include `status`, `code`, `issues[{code,field,message}]` and `retryable:false`; MCP preserves them. The agent compares stable issue codes/fields, not generated prose. An unchanged signature stops after one correction; changing signatures allow at most two corrections (three attempts total) in the same turn/app. An identical rejected payload is not dispatched again. Pending tool calls are closed when recovery stops so Continue cannot replay them. Accepted assets are retained and no rejected input is recorded as a GPU job. HTTP 500 and bounded lost-job recovery are preserved.

## Tests (no GPU)

```sh
npm test
npm run typecheck
npm run validate
```

- `test/pika-prompt.test.ts`: Alex, five official simple/mixed/character-sheet/audio-excerpt/voice-reference fixtures, local source bindings, native speech, aspect/megapixels and frame geometry. Upstream sources: Pika-Labs/Pika-H3-Flex `examples/prompts/{ref2va,ref2va-mixed}.txt` and `docs/prompt-guidance.md` examples 5–7.
- `test/agent-production.test.ts`: 46 speculative corrections bounded to two dispatches for an unchanged signature; at most three for changing issues; same-payload suppression, preserved assets, no fake jobs or deferred-call replay; HTTP 500 remains recoverable. Existing lost/expired-job tests remain intact.
- **`test/pika-api.test.ts` starts the real `server/server.ts` in an isolated output directory**, with only `COMFY_BASE_URL` replaced by a local mock. Calls go through real MCP, the real multipart HTTP route, `resolveValues`, the real shared validator, queue and SDK asset upload/workflow construction. Invalid prompts/files reach no backend dispatch. The valid Alex request is accepted on its first valid submission and its exact workflow is captured at `POST /api/v2/jobs`, with two uploads, locked LCM, `[0,1]`, 9:16 and 0.4 MP unchanged. The mock deliberately refuses execution after capture; it implements no inference. All test processes are closed afterward.

Real ComfyUI inference and visual/audio quality remain untested. This is proof of the request/dispatch contract, not proof of a generated video.

Result: **126/126 tests passed**, TypeScript passed, registry validation passed (150 apps, zero errors/warnings). The live server was reloaded afterward: both MCP example tools expose this recipe, both original files pass CPU validation, HTTP 400 carries the structured envelope, and the inference queue remains empty. No real Pika submission was made.

Changed implementation files: `server/{pika-prompt,input-error,runner,server,h3-plan,agent-mcp,agent}.ts`, `mcp/{server,prompt-guidance}.ts`, `apps/pika-studio-director/request-example.json`. Regression files: `test/{pika-api,pika-prompt,agent-production}.test.ts` and the five `test/fixtures/pika-official-*.txt` files. This report is `docs/pika-contract-fix.md`.
