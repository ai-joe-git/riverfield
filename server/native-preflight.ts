import {defaults} from "./native-options.ts";

/** Gemma4 vision has a 70-token minimum in the selected llama.cpp projector implementation. */
export function projectorBatchIssue(options:Record<string,unknown>,metadata:Record<string,unknown>,modelMetadata:Record<string,unknown>={}){
 const gemmaVision=/^gemma4(?:v|uv)$/.test(String(metadata["clip.projector_type"]||""))||/^gemma4/.test(String(modelMetadata["general.architecture"]||""))&&metadata["clip.has_vision_encoder"]===true;
 if(!options.mmprojPath||!gemmaVision)return null;
 const micro=Number(options.ubatchSize??defaults.ubatchSize);
 return micro<70?`Gemma 4 vision cannot start with micro batch ${micro}: its image budget needs at least 70 tokens. Increase Micro batch size (for example 512 or the matching BlackRiver setting) and keep Batch size at least as large. The new model was not loaded.`:null;
}
export function nativeFailureMessage(code:number|null,signal:string|null,logs:string[],options:Record<string,unknown>={}){
 const pixels=logs.findLast(line=>/image_max_pixels.*less than.*image_min_pixels/.test(line));
 if(pixels){const at=pixels.indexOf("load_hparams:"),detail=at>=0?pixels.slice(at+"load_hparams:".length).trim():pixels.slice(pixels.indexOf("image_max_pixels")),budget=logs.findLast(line=>/cap image_max_tokens.*n_ubatch/.test(line))||"",micro=/n_ubatch\s*=\s*(\d+)/.exec(budget)?.[1]||options.ubatchSize||defaults.ubatchSize;return `Multimodal startup failed: ${detail}. Effective micro batch ${micro} capped the image token budget. Increase Micro batch size and Batch size together; use the matching BlackRiver batch settings. The projector is not necessarily corrupt.`;}
 const errors=logs.filter(line=>/\bE\b|error:|out of memory|failed to allocate|cannot allocate/i.test(line)&&!/cleaning up|exiting due|server_run_i|srv\s+load_model: failed to load multimodal/i.test(line));
 return `llama-server exited (${signal||code}). ${(errors.length?errors.slice(-3):logs.slice(-3)).join(" ").slice(0,1400)}`;
}
