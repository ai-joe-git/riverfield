# Observer model residency investigation

Date: 2026-11-26  
Scope: Fast Review Gemma 4 12B observer  
No additional inference was run for this investigation.

## Observation

The Fast Review backend log contains two `Gemma4TEModel_` loads of **7,860.75 MB** for one observation job. The same pattern appears in the six-model Gemma rows.

## Evidence

1. ComfyUI is running with:

   ```text
   --cache-none
   --disable-dynamic-vram
   --disable-pinned-memory
   ```

   `--cache-none` disables ComfyUI's execution cache: every node is executed for each
   prompt instead of reusing cached node outputs.

2. The RiverField gateway's `/riverfield/prepare` records for the Fast Review visual
   and comparison prompts both returned:

   ```text
   {'freed': False, 'previous': 'riverfield-observer-internal-gemma4-12b-heretic-w4a8',
    'current': 'riverfield-observer-internal-gemma4-12b-heretic-w4a8'}
   ```

   The Runner did not switch the model set, and the gateway did not issue a model unload
   between the two observer passes.

3. The two observer apps use the same model key. `Runner.prepare` is therefore not the
   source of a model-set change for the visual/comparison pair.

4. Each pass still contains a `CLIPLoader` execution and a `TextGenerateV2` execution.
   With `--cache-none`, those nodes are not skipped as cached execution results; the
   CLIP/text-encoder node reconstructs its object and requests the checkpoint again.

## Conclusion

The duplicate Gemma load is **most consistent with ComfyUI's global `--cache-none`
execution mode plus the per-prompt `CLIPLoader` node**, not with a Riverfield gateway
model-set switch or a model-family change. The backend logs confirm the gateway did not
free the model between the visual and comparison passes.

This cannot be reduced by changing the observer's model selection alone. A cache policy
change would be a global ComfyUI lifecycle change and is intentionally not applied here,
because it could destabilize other Riverfield applications and their memory assumptions.

A scoped future option would be an explicit observer-only cache policy or a single
combined visual+comparison prompt, but that requires separate design and inference
validation. It is not part of this pilot.
