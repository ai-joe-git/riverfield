// Render profiles for the H3 Studio Directors, shared by the Director panel (browser),
// the server and the regression tests. Pure functions only: no DOM, no network, no GPU.
//
// A profile is an explicit rendering contract. It never touches the creative payload:
// timeline windows, segment prompts, the global prompt, references, seed, checkpoint or
// sampling settings stay exactly as they are. Build & Test forces 0.1 MP and no upscale;
// Production defaults to 0.4 MP and may use the app's own RelayVSR x2/x4 pair when the
// manifest exposes one. Values without render_profile keep their historical meaning.

export const BUILD_MEGAPIXELS = 0.1;
export const PRODUCTION_DEFAULT_MEGAPIXELS = 0.4;

export const ASPECT_RATIOS = {
  "1:1 (Square)": [1, 1],
  "2:3 (Portrait Photo)": [2, 3],
  "3:2 (Photo)": [3, 2],
  "3:4 (Portrait Standard)": [3, 4],
  "4:3 (Standard)": [4, 3],
  "9:16 (Portrait Widescreen)": [9, 16],
  "16:9 (Widescreen)": [16, 9],
  "21:9 (Ultrawide)": [21, 9],
  "1:1": [1, 1],
  "2:3": [2, 3],
  "3:2": [3, 2],
  "3:4": [3, 4],
  "4:3": [4, 3],
  "9:16": [9, 16],
  "16:9": [16, 9],
  "21:9": [21, 9],
};

/** Linear dimension factor and pixel-area factor. Off is one, not a scale factor. */
export const UPSCALE_FACTORS = {
  "": { value: "off", label: "Off", linear: 1, area: 1 },
  x2: { value: "x2", label: "X2", linear: 2, area: 4 },
  x4: { value: "x4", label: "X4", linear: 4, area: 16 },
};

/** The manifest input that turns a Director into a render-profile app. */
const input = (app, id) => (app?.inputs || []).find((x) => x && x.id === id);
const number = (value, fallback = 0) => {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const ratioOf = (aspect) => {
  if (ASPECT_RATIOS[aspect]) return ASPECT_RATIOS[aspect];
  const match = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i.exec(String(aspect || ""));
  return match ? [Number(match[1]), Number(match[2])] : null;
};
/** Python's round() (ties to even), so the estimate matches ResolutionSelector exactly. */
const roundHalfEven = (x) => {
  const lower = Math.floor(x);
  const diff = x - lower;
  if (diff > 0.5) return lower + 1;
  if (diff < 0.5) return lower;
  return lower % 2 === 0 ? lower : lower + 1;
};

/**
 * The profile contract an app advertises from its actual manifest. Apps without the
 * render_profile/megapixels/Material-Planner trio are not profile apps, so other video
 * engines keep their own controls and are never forced into this contract.
 */
export function renderProfileCapability(app) {
  const profileInput = input(app, "render_profile");
  const megapixelsInput = input(app, "megapixels");
  if (!profileInput || !megapixelsInput || !input(app, "segment_windows")) return null;
  const productionInput = input(app, "production_megapixels") || megapixelsInput;
  const min = number(productionInput.min ?? megapixelsInput.min, BUILD_MEGAPIXELS);
  const max = number(productionInput.max ?? megapixelsInput.max, 3);
  const step = number(productionInput.step ?? megapixelsInput.step, 0.1);
  const upscaleInput = input(app, "upscale");
  const detailInput = input(app, "upscale_detail");
  const options = (upscaleInput?.options || []).map((option) => {
    const value = String(option.value);
    const factor = UPSCALE_FACTORS[value] || UPSCALE_FACTORS[""];
    return {
      value,
      label: option.label || factor.label,
      linear_factor: factor.linear,
      pixel_area_factor: factor.area,
      checkpoint_pair: relayVSRPairOf(option),
    };
  });
  return {
    supported: true,
    build_megapixels: clamp(BUILD_MEGAPIXELS, min, max),
    production_default_megapixels: clamp(PRODUCTION_DEFAULT_MEGAPIXELS, min, max),
    generation: { min, max, step },
    upscale: upscaleInput ? { options, relay_vsr: options.some((option) => Boolean(option.checkpoint_pair)) } : null,
    detail: detailInput
      ? {
          min: number(detailInput.min, 0),
          max: number(detailInput.max, 1),
          step: number(detailInput.step, 0.05),
          default: number(detailInput.default, 1),
        }
      : null,
  };
}

/** The ComfyUI ResolutionSelector formula: target megapixels, then the nearest dimension multiple. */
export function resolutionFor(aspect, megapixels, multiple = 32) {
  const ratio = ratioOf(aspect);
  const mp = number(megapixels);
  const step = Math.max(1, Math.round(number(multiple, 32)));
  if (!ratio || mp <= 0) return null;
  const total = mp * 1024 * 1024;
  const scale = Math.sqrt(total / (ratio[0] * ratio[1]));
  const width = roundHalfEven((ratio[0] * scale) / step) * step;
  const height = roundHalfEven((ratio[1] * scale) / step) * step;
  if (width < 1 || height < 1) return null;
  return { width, height, megapixels: (width * height) / (1024 * 1024) };
}

const factorOfName = (name) => /(?:^|[_-])x([24])(?:[_.-]|$)/i.exec(String(name || ""))?.[1] || null;

/** The pair a manifest option writes, only when both checkpoint names say the same factor. */
function relayVSRPairOf(option) {
  if (!option?.sets) return null;
  const unet = option.sets.find((s) => s.field === "unet_name")?.value;
  const vae = option.sets.find((s) => s.field === "vae_name")?.value;
  if (typeof unet !== "string" || typeof vae !== "string") return null;
  const expected = String(option.value).replace(/^x/i, "");
  const unetFactor = factorOfName(unet);
  const vaeFactor = factorOfName(vae);
  if (!expected || unetFactor !== expected || vaeFactor !== expected) return null;
  return { factor: String(option.value), unet, vae };
}

/** The app's own RelayVSR DIT and Flash VAE for a factor, only when both say the same factor. */
export function relayVSRPair(app, factor) {
  const upscaleInput = input(app, "upscale");
  const value = String(factor || "");
  const option = (upscaleInput?.options || []).find((o) => String(o.value) === value);
  return relayVSRPairOf(option);
}

/**
 * Metadata for the parameters that will actually execute. Native generation geometry is
 * kept separate from the estimated final output: x2 is 2x linear and 4x pixel area, x4
 * is 4x linear and 16x pixel area.
 */
export function renderMetadata(app, values = {}) {
  const capability = renderProfileCapability(app);
  if (!capability) return null;
  const declared = values.render_profile;
  const profile = declared === "build" || declared === "production" ? declared : "legacy";
  const megapixelsInput = input(app, "megapixels");
  const requested = number(values.megapixels, number(megapixelsInput?.default, capability.production_default_megapixels));
  const multiple = number(values.multiple, number(input(app, "multiple")?.default, 32));
  const aspect = String(values.aspect ?? input(app, "aspect")?.default ?? "1:1 (Square)");
  const native = resolutionFor(aspect, requested, multiple);
  const rawUpscale = capability.upscale && profile !== "build" ? String(values.upscale ?? "") : "";
  const upscale = capability.upscale && Object.prototype.hasOwnProperty.call(UPSCALE_FACTORS, rawUpscale) ? rawUpscale : "";
  const factor = UPSCALE_FACTORS[upscale];
  const output = native
    ? { width: native.width * factor.linear, height: native.height * factor.linear, megapixels: native.megapixels * factor.area, estimated: true }
    : null;
  return {
    profile,
    resolved: profile !== "legacy",
    generation: native
      ? {
          requested_megapixels: requested,
          width: native.width,
          height: native.height,
          megapixels: native.megapixels,
          aspect,
          multiple,
        }
      : { requested_megapixels: requested, width: null, height: null, megapixels: null, aspect, multiple },
    output,
    upscale: upscale || "off",
    upscale_detail: upscale ? number(values.upscale_detail, capability.detail?.default ?? 1) : null,
    upscale_linear_factor: factor.linear,
    upscale_pixel_area_factor: factor.area,
    relay_vsr: Boolean(upscale),
    relay_vsr_models: upscale
      ? capability.upscale?.options.find((option) => option.value === upscale)?.checkpoint_pair ?? relayVSRPair(app, upscale)
      : null,
  };
}

/**
 * Resolve the execution values for an explicit profile. A request without render_profile
 * is left untouched: that is the legacy contract, not a hidden Build & Test request.
 */
export function resolveRenderProfile(app, rawValues = {}) {
  const capability = renderProfileCapability(app);
  const values = { ...rawValues };
  if (!capability) return { values, meta: null, errors: [] };
  const profile = values.render_profile;
  if (profile === undefined || profile === null || profile === "") return { values, meta: null, errors: [] };
  if (profile !== "build" && profile !== "production") {
    return {
      values,
      meta: null,
      errors: [{ code: "RENDER_PROFILE", field: "render_profile", message: 'render_profile must be "build" or "production"' }],
    };
  }
  const errors = [];
  if (profile === "build") {
    values.megapixels = capability.build_megapixels;
    // Build & Test never upscales. Production preferences stay in production_* for later.
    if (capability.upscale) values.upscale = "";
  } else {
    let resolution = values.production_megapixels;
    if (resolution === undefined || resolution === null || resolution === "") resolution = values.megapixels;
    if (resolution === undefined || resolution === null || resolution === "") resolution = capability.production_default_megapixels;
    const megapixels = Number(resolution);
    if (!Number.isFinite(megapixels)) {
      errors.push({ code: "PRODUCTION_RESOLUTION", field: "production_megapixels", message: "Production resolution must be a number" });
    } else if (megapixels < capability.generation.min || megapixels > capability.generation.max) {
      errors.push({
        code: "PRODUCTION_RESOLUTION",
        field: "production_megapixels",
        message: `Production resolution must be between ${capability.generation.min} and ${capability.generation.max} MP for this app`,
      });
    } else {
      values.production_megapixels = megapixels;
      values.megapixels = megapixels;
    }

    if (capability.upscale) {
      let upscale = values.production_upscale;
      if (upscale === undefined) upscale = values.upscale;
      if (upscale === undefined || upscale === null) upscale = "";
      const chosen = String(upscale) === "off" ? "" : String(upscale);
      if (!capability.upscale.options.some((option) => option.value === chosen)) {
        errors.push({ code: "PRODUCTION_UPSCALE", field: "production_upscale", message: "Production upscale must be off, x2 or x4" });
      } else {
        values.production_upscale = chosen;
        values.upscale = chosen;
        if (chosen) {
          const option = capability.upscale.options.find((o) => o.value === chosen);
          const pair = option?.checkpoint_pair ?? relayVSRPair(app, chosen);
          if (capability.upscale.relay_vsr && !pair) {
            errors.push({
              code: "RELAY_MODEL_PAIR",
              field: "production_upscale",
              message: `RelayVSR ${chosen} needs the DIT and Flash VAE checkpoints of the same factor`,
            });
          }
          let detail = values.production_upscale_detail;
          if (detail === undefined) detail = values.upscale_detail;
          if (detail === undefined) detail = capability.detail?.default ?? 1;
          const parsed = Number(detail);
          if (!Number.isFinite(parsed) || parsed < (capability.detail?.min ?? 0) || parsed > (capability.detail?.max ?? 1)) {
            errors.push({ code: "UPSCALE_DETAIL", field: "production_upscale_detail", message: "Upscale detail must be between 0 and 1" });
          } else {
            values.production_upscale_detail = parsed;
            values.upscale_detail = parsed;
          }
        }
      }
    } else if ((values.production_upscale !== undefined && values.production_upscale !== "") || (values.upscale !== undefined && values.upscale !== "")) {
      errors.push({ code: "PRODUCTION_UPSCALE", field: "production_upscale", message: "This app has no RelayVSR upscale option" });
    }
  }
  return { values, meta: renderMetadata(app, values), errors };
}

/**
 * Switch profiles without touching the creative payload. Leaving Production stores the
 * resolution and upscale preferences that Build & Test must remember.
 */
export function switchRenderProfile(app, values = {}, profile) {
  const capability = renderProfileCapability(app);
  const next = { ...values };
  if (!capability) return { values: next, meta: null, errors: [] };
  if (profile === "build") {
    if (values.render_profile === "production") {
      const current = Number(values.megapixels);
      if (Number.isFinite(current)) next.production_megapixels = current;
      if (capability.upscale && values.upscale !== undefined) next.production_upscale = String(values.upscale);
      if (capability.detail && values.upscale_detail !== undefined) next.production_upscale_detail = Number(values.upscale_detail);
    }
    next.render_profile = "build";
  } else if (profile === "production") {
    next.render_profile = "production";
    const stored = Number(next.production_megapixels);
    if (!Number.isFinite(stored) || stored < capability.generation.min || stored > capability.generation.max) {
      next.production_megapixels = capability.production_default_megapixels;
    }
    if (capability.upscale && next.production_upscale === undefined) next.production_upscale = "";
    if (capability.detail && next.production_upscale_detail === undefined) next.production_upscale_detail = capability.detail.default;
  } else {
    return {
      values: next,
      meta: null,
      errors: [{ code: "RENDER_PROFILE", field: "render_profile", message: 'profile must be "build" or "production"' }],
    };
  }
  return resolveRenderProfile(app, next);
}

/**
 * Give a saved session a profile when it predates profiles. A brand-new session starts in
 * Build & Test. An existing workflow that already carries a resolution keeps it as the
 * starting Production preference, so opening it does not silently change what it renders.
 */
export function migrateRenderProfile(app, values = {}, { fresh = false } = {}) {
  const capability = renderProfileCapability(app);
  const next = { ...values };
  if (!capability) return { values: next, meta: null, errors: [], changed: false };
  if (next.render_profile === "build" || next.render_profile === "production") {
    const resolved = resolveRenderProfile(app, next);
    return { ...resolved, changed: JSON.stringify(resolved.values) !== JSON.stringify(values) };
  }
  if (fresh) {
    next.render_profile = "build";
  } else {
    const current = Number(next.megapixels ?? input(app, "megapixels")?.default);
    const upscale = capability.upscale ? String(next.upscale ?? "") : "";
    const looksBuild = Number.isFinite(current) && current <= capability.build_megapixels + 1e-6 && (!capability.upscale || !upscale);
    if (looksBuild) {
      next.render_profile = "build";
    } else {
      next.render_profile = "production";
      next.production_megapixels = Number.isFinite(current) ? current : capability.production_default_megapixels;
      if (capability.upscale) next.production_upscale = upscale;
      if (capability.detail && next.upscale_detail !== undefined) next.production_upscale_detail = Number(next.upscale_detail);
    }
  }
  const resolved = resolveRenderProfile(app, next);
  return { ...resolved, changed: JSON.stringify(resolved.values) !== JSON.stringify(values) };
}

/**
 * The production request for a preview: the preview's exact creative payload with only
 * the rendering parameters replaced. The seed, timeline, prompts, model, sampler, steps
 * and reference assignments are copied as they are.
 */
export function productionValuesFromPreview(app, previewValues = {}, choices = {}) {
  const capability = renderProfileCapability(app);
  if (!capability) {
    return {
      values: { ...previewValues },
      meta: null,
      errors: [{ code: "RENDER_PROFILE", field: "render_profile", message: "This app has no render profiles" }],
    };
  }
  const next = { ...previewValues, render_profile: "production" };
  const megapixels = choices.production_megapixels;
  const previewMegapixels = previewValues.production_megapixels;
  next.production_megapixels =
    megapixels !== undefined && megapixels !== null && megapixels !== ""
      ? megapixels
      : previewMegapixels !== undefined && previewMegapixels !== null && previewMegapixels !== ""
        ? previewMegapixels
        : capability.production_default_megapixels;
  if (capability.upscale) {
    const upscale = choices.production_upscale;
    next.production_upscale =
      upscale !== undefined && upscale !== null ? upscale : previewValues.production_upscale !== undefined ? previewValues.production_upscale : "";
    const detail = choices.production_upscale_detail;
    const previewDetail = previewValues.production_upscale_detail;
    next.production_upscale_detail =
      detail !== undefined && detail !== null
        ? detail
        : previewDetail !== undefined && previewDetail !== null
          ? previewDetail
          : capability.detail?.default ?? 1;
  }
  return resolveRenderProfile(app, next);
}
