// Installed multimodal observer checkpoints.
//
// Model discovery is local and read-only: we read the safetensors header (never the
// weights) to prove which modality projectors are actually present, then merge that
// with the CLIPLoader recipe used by the existing ComfyUI graph. A checkpoint that is
// absent is returned with installed=false instead of being guessed at run time.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export type ObserverModality = "text" | "image" | "video" | "audio";

export type ObserverModel = {
  id: string;
  file: string;
  label: string;
  family: "qwen" | "gemma";
  repo: string;
  license: string;
  clipType: string;
  quantization: string;
  sizeGb: number;
  installed: boolean;
  compatible: boolean;
  modalities: Record<ObserverModality, boolean>;
  capabilityEvidence: {
    source: "safetensors-header";
    visionTensors: boolean;
    audioTensors: boolean;
    modelType?: string;
    modelVariant?: string;
  };
  warnings: string[];
};

type KnownModel = Omit<ObserverModel, "sizeGb" | "installed" | "compatible" | "modalities" | "capabilityEvidence" | "warnings"> & {
  /** If the header cannot prove a modality, the family contract is used and reported. */
  expected: Record<ObserverModality, boolean>;
};

export const DEFAULT_OBSERVER_MODEL_ID = "qwen3.8-27b-w4a8";

/** Static descriptor for the internal app manifest; discovery remains the authority at runtime. */
export const DEFAULT_OBSERVER_MODEL: ObserverModel = {
  id: DEFAULT_OBSERVER_MODEL_ID,
  file: "qwen3.8_27b_w4a8.safetensors",
  label: "Qwen3.8 27B · w4a8",
  family: "qwen",
  repo: "Qwen/Qwen3.8-27B",
  license: "Apache-2.0",
  clipType: "stable_diffusion",
  quantization: "w4a8",
  sizeGb: 17.1,
  installed: true,
  compatible: true,
  modalities: { text: true, image: true, video: true, audio: false },
  capabilityEvidence: { source: "safetensors-header", visionTensors: true, audioTensors: false, modelVariant: "Qwen3.8 27B" },
  warnings: [],
};

/**
 * These are the checkpoints the local stack already uses. `stable_diffusion` is the
 * CLIPLoader recipe that makes ComfyUI select the native Gemma4/Qwen3.5 TE classes for
 * TextGenerateV2; it does not load a diffusion model.
 */
const KNOWN: KnownModel[] = [
  {
    id: DEFAULT_OBSERVER_MODEL_ID,
    file: "qwen3.8_27b_w4a8.safetensors",
    label: "Qwen3.8 27B · w4a8",
    family: "qwen",
    repo: "Qwen/Qwen3.8-27B",
    license: "Apache-2.0",
    clipType: "stable_diffusion",
    quantization: "w4a8",
    expected: { text: true, image: true, video: true, audio: false },
  },
  {
    id: "qwen3.8-27b-heretic-w4a8",
    file: "qwen3.8_27b_uncensored_heretic_w4a8_convrot_v2.safetensors",
    label: "Qwen3.8 27B Heretic · w4a8",
    family: "qwen",
    repo: "local/Qwen3.8-27B-Heretic",
    license: "local",
    clipType: "stable_diffusion",
    quantization: "w4a8_convrot",
    expected: { text: true, image: true, video: true, audio: false },
  },
  {
    id: "qwen3.5-9b-uncensored-w4a8",
    file: "qwen3.5_9b_uncensored_w4a8.safetensors",
    label: "Qwen3.5 9B · w4a8",
    family: "qwen",
    repo: "local/Qwen3.5-9B-Uncensored",
    license: "local",
    clipType: "stable_diffusion",
    quantization: "w4a8",
    expected: { text: true, image: true, video: true, audio: false },
  },
  {
    id: "qwen3.5-9b-w4a8-gptq",
    file: "qwen3.5_9b_w4a8_gptq.safetensors",
    label: "Qwen3.5 9B GPTQ · w4a8",
    family: "qwen",
    repo: "local/Qwen3.5-9B-GPTQ",
    license: "local",
    clipType: "stable_diffusion",
    quantization: "w4a8_gptq",
    expected: { text: true, image: true, video: true, audio: false },
  },
  {
    id: "gemma4-12b-heretic-w4a8",
    file: "gemma4_12b_it_uncensored_heretic_w4a8.safetensors",
    label: "Gemma 4 12B Heretic · w4a8",
    family: "gemma",
    repo: "llmfan46/gemma-4-12B-it-uncensored-heretic",
    license: "local",
    clipType: "stable_diffusion",
    quantization: "w4a8",
    expected: { text: true, image: true, video: true, audio: true },
  },
  {
    id: "gemma4-e2b-int8-convrot",
    file: "gemma4_e2b_it_int8_convrot.safetensors",
    label: "Gemma 4 E2B · int8_convrot",
    family: "gemma",
    repo: "google/gemma-4-e2b-it",
    license: "Gemma",
    clipType: "stable_diffusion",
    quantization: "int8_convrot",
    expected: { text: true, image: true, video: true, audio: true },
  },
];

function textEncodersRoot(): string {
  if (process.env.RIVERFIELD_TEXT_ENCODERS_DIR) return process.env.RIVERFIELD_TEXT_ENCODERS_DIR;
  const comfyRoot = process.env.COMFYUI_ROOT || "/home/zardoz/comfyui-vanilla-gfx1151/ComfyUI";
  return join(comfyRoot, "models", "text_encoders");
}

type Header = {
  tensors: string[];
  metadata: Record<string, string>;
};

/** Read only the safetensors JSON header. The 17 GB weights are never mapped. */
function readHeader(path: string): Header {
  const fd = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(8);
    if (readSync(fd, prefix, 0, 8, 0) !== 8) throw new Error("truncated safetensors header");
    const length = Number(prefix.readBigUInt64LE(0));
    if (!Number.isSafeInteger(length) || length < 2 || length > 64 * 1024 * 1024) throw new Error("invalid safetensors header length");
    const body = Buffer.alloc(length);
    if (readSync(fd, body, 0, length, 8) !== length) throw new Error("truncated safetensors header body");
    const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    const tensors = Object.keys(parsed).filter((key) => key !== "__metadata__");
    const rawMeta = parsed.__metadata;
    const metadata: Record<string, string> = {};
    if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
      for (const [key, value] of Object.entries(rawMeta as Record<string, unknown>)) metadata[key] = String(value);
    }
    return { tensors, metadata };
  } finally {
    closeSync(fd);
  }
}

function inspect(path: string): Pick<ObserverModel, "sizeGb" | "installed" | "compatible" | "modalities" | "capabilityEvidence" | "warnings"> {
  if (!existsSync(path)) {
    return {
      sizeGb: 0, installed: false, compatible: false,
      modalities: { text: true, image: false, video: false, audio: false },
      capabilityEvidence: { source: "safetensors-header", visionTensors: false, audioTensors: false },
      warnings: ["checkpoint is not installed in the local text_encoders directory"],
    };
  }
  const sizeGb = Math.round((statSync(path).size / 1024 ** 3) * 10) / 10;
  try {
    const header = readHeader(path);
    const visionTensors = header.tensors.some((key) =>
      /^(model\.)?visual\./.test(key) || /^vision_model\./.test(key));
    const audioTensors = header.tensors.some((key) =>
      /^(audio_model|audio_projector)\./.test(key));
    return {
      sizeGb, installed: true, compatible: visionTensors,
      modalities: { text: true, image: visionTensors, video: visionTensors, audio: audioTensors },
      capabilityEvidence: {
        source: "safetensors-header", visionTensors, audioTensors,
        ...(header.metadata.model_type ? { modelType: header.metadata.model_type } : {}),
        ...(header.metadata.model_variant ? { modelVariant: header.metadata.model_variant } : {}),
      },
      warnings: visionTensors ? [] : ["no vision projector tensor was found in the checkpoint header"],
    };
  } catch (error) {
    return {
      sizeGb, installed: true, compatible: false,
      modalities: { text: true, image: false, video: false, audio: false },
      capabilityEvidence: { source: "safetensors-header", visionTensors: false, audioTensors: false },
      warnings: [`could not inspect safetensors header: ${(error as Error).message}`],
    };
  }
}

export function discoverObserverModels(): ObserverModel[] {
  const root = textEncodersRoot();
  return KNOWN.map((known) => {
    const inspected = inspect(join(root, known.file));
    const warnings = [...inspected.warnings];
    for (const modality of ["image", "video", "audio"] as const) {
      if (known.expected[modality] && !inspected.modalities[modality]) {
        warnings.push(`expected ${modality} support, but the installed checkpoint header does not expose it`);
      }
      if (!known.expected[modality] && inspected.modalities[modality]) {
        warnings.push(`checkpoint exposes ${modality} support not expected for this family; the header wins`);
      }
    }
    return {
      ...known,
      ...inspected,
      modalities: { ...inspected.modalities },
      warnings,
    };
  });
}

export function findObserverModel(id: string): ObserverModel | undefined {
  return discoverObserverModels().find((item) => item.id === id);
}

export function observerModel(id: string): ObserverModel {
  const model = findObserverModel(id);
  if (!model) throw new ObserverModelError("OBSERVER_MODEL_UNKNOWN", `Unknown observer model ${id}`);
  if (!model.installed) throw new ObserverModelError("OBSERVER_MODEL_NOT_INSTALLED", `${model.file} is not installed in ${textEncodersRoot()}`);
  if (!model.compatible) throw new ObserverModelError("OBSERVER_MODEL_INCOMPATIBLE", `${model.file} has no usable vision projector for observation`);
  return model;
}

export function assertObserverModalities(model: ObserverModel, requested: { video?: boolean; audio?: boolean }): void {
  if (requested.video && !model.modalities.video) {
    throw new ObserverModelError("OBSERVER_MODALITY_UNSUPPORTED",
      `${model.label} does not expose native video input; disable native video or select a compatible model`);
  }
  if (requested.audio && !model.modalities.audio) {
    throw new ObserverModelError("OBSERVER_MODALITY_UNSUPPORTED",
      `${model.label} does not expose native audio input; disable native audio or select a compatible model`);
  }
}

export class ObserverModelError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
