# Pika Director in chat

Open **Pika Director**, **Direct a scene**, or **Make a micro-drama** in Agent. The flow stays inside the conversation: no modal, mandatory form, or separate settings panel. Interface text is English; spoken dialogue has its own language choice.

1. Fixed questions and buttons ask for native duration, generation resolution, Relay off/x2/x4, and cast size. **Use remaining defaults** skips the remaining setup questions without a model call. Optional **Change settings** choices are also inline.
2. Type the story idea in the usual chat composer. The writer returns plain text only. Type revisions, then use **Use story and prepare shot prompts**. Each bounded request fills one creative field, with zero tools and no JSON fallback. Visual descriptions are English; dialogue uses the selected language. SILENT becomes an empty dialogue field.
3. Review the creative text, generate missing character sheets/environment, or reuse attached/existing images. References are displayed for approval. Image corrections are described in chat and require a separate **Apply correction · GPU** button. MOSS stays at 8 steps; corrections use Qwen 2.1 Turbo.
4. **Generate video · GPU** uses the existing Pika app, LCM/six-step recipe and normal queue/history. Relay is a separate button after a successful Pika video, not an automatic render or SelfLift. x2 doubles both dimensions: 0.4 MP becomes approximately 1.6 MP.

`server/director-form.ts` owns app IDs, file slots, Picture/Subject/Speaker bindings, dialogue tags, native sections and timing. No writer output is interpreted as a tool call. Read-only, file permissions, duplicate-job protection and standalone completion notifications remain in force.

Defaults: Ref2VA, 0.4 MP, SLA sparsity 0.85, portrait, English dialogue, Relay x2. Duration choices include overlaps: 7.29, 12.96, 18.63, 29.96 and 46.96 seconds. Prompts adapt to the native segments; segments are never stretched.

Saved modal-era drafts migrate to inline chat without deleting conversations or media. Existing renders remain historical outputs; editing text does not update a video. An upscale is linked only to its actual source video and requested scale.

Tests use simulated writers/backends, including real HTTP/MCP routing. They do not establish real model writing quality, visual identity, spoken words or render quality. Real GPU inference requires user authorization.

## Writer connection failures

Managed Qwen loading first requires the local media gateway to acknowledge model-memory release. If that backend is offline, writing stops before loading Qwen; this is not a prompt or tool-call failure. The error names the unreachable backend. Do not bypass the release check. Restore the existing backend, then use **Retry writing story**. The idea and settings are preserved, and an empty story cannot be approved or used to prepare shots.

## Chat and character assignment safety

After the initial brief, ordinary chat messages are read-only questions/answers. They never silently become scenario rewrites. **Revise story**, **Rename**, and individual **Edit** buttons explicitly select the creative field to change; the responder and writer both have zero tools.

Character naming and description requests identify the numbered story slot, corresponding story person and other occupied slots. Names are assigned before appearances. Duplicate names and identical/near-identical descriptions are rejected before image/video dispatch. Existing duplicate casts show an inline **Repair cast and shot prompts** writing-only action. Questions about that condition receive a factual answer without overwriting the script.

Changing a character name/description invalidates its previous automatic reference binding, not the historical image file. Story/cast changes mark shot prompts stale; partial or failed preparation cannot be rendered. Only completed preparation clears that flag. No repair step automatically regenerates paid images or video.

The creative-text gate also rejects internal field labels, known unassigned human roles/groups, readable-screen-text requests, overlong visual/sound descriptions, and dialogue exceeding eight words per speaker per segment. A field gets at most one bounded plain-text correction attempt, never a tool call. Invalid story/set foundations stop preparation before paid shot-writing loops; invalid drafts cannot reach video dispatch. These are conservative text checks, not a universal semantic validator or a guarantee of render quality.

Spoken words belong only in the per-character dialogue field. A name-colon line, `[Dialogue]` heading, or dialogue prose in the visual action is rejected; saved text with that misrouting is repaired mechanically (the words are moved, not rewritten) before preparation. When a segment has dialogue, the compiled prompt puts the action first, then one line per speaker as `<Subject N> (S N) says, <d>[Language] exact words</d>`, then the continuity constraints. Every speaking character is staged on camera with face and mouth visible; multi-speaker beats are locked to a stable two-shot and cannot zoom or cut away to one speaker. If the saved action hides a speaker who has a line, the compiler adds a deterministic correction such as “When Brenda speaks, Brenda lifts her head and faces the camera”. The sound field carries ambience, physical sounds and non-verbal delivery only; dialogue belongs in the shot description and the sound field cannot contradict the line. This is prompt intent, not proof that a rendered clip actually lip-syncs: inspect the mouth movement in the output before claiming success.

## Pika/H3 prompting contract

Ref2VA uses `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`. FL2VA uses `integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music`. Referenced people are `<Subject N>` with stable speaker IDs `(S1)`, `(S2)`, ...; each line is attributed to its own speaker and keeps identity/delivery outside the `<d>` tag. `overall_soundscape` is ambience, physical sounds and non-verbal human sounds only. The writer system prompt and `mcp/prompt-guidance.ts` carry the same contract. Sources: Pika H3 Flex prompt guidance and MiniMax H3 prompting guidance.

Compiled prompts explicitly constrain person count, prohibit sheet panels/clones/extras, preserve set/lighting/wardrobe, and keep screens blank/abstract. Scene actions are not duplicated in summary and detail. Changes invalidate the current video/upscale binding while retaining original artifacts in History, so an old failed creative result is not offered as the corrected draft's Relay source.
