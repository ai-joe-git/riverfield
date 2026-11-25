// Server-side adapter for the shared render-profile rules. It converts the shared
// validation errors into RiverField's InputError so the web UI and MCP receive the same
// structured 400 body. The resolution logic itself lives in web/js/render-profile.js and
// is also used by the Director panel and the regression tests.
import { InputError } from "./input-error.ts";
import type { App } from "./registry.ts";
import type { Values } from "./runner.ts";
import {
  renderProfileCapability as capability,
  resolveRenderProfile as resolve,
  renderMetadata,
  productionValuesFromPreview as previewProduction,
} from "../web/js/render-profile.js";

export type ProductionChoices = {
  production_megapixels?: unknown;
  production_upscale?: unknown;
  production_upscale_detail?: unknown;
};

export function renderProfileCapability(app: App) {
  return capability(app);
}

function firstError(errors: { message: string }[]) {
  return errors[0]?.message || "Invalid render profile";
}

/** Apply an explicit profile to raw values. No render_profile means the legacy contract. */
export function applyRenderProfile(app: App, values: Values): Values {
  const result = resolve(app, values);
  if (result.errors.length) throw new InputError(firstError(result.errors), result.errors);
  return result.values;
}

/** Metadata for the parameters that actually execute. */
export function renderMetadataFor(app: App, values: Values) {
  return renderMetadata(app, values);
}

/** Build the production request for a preview, preserving its whole creative payload. */
export function productionRequestFromPreview(app: App, previewValues: Values, choices: ProductionChoices = {}) {
  const result = previewProduction(app, previewValues, choices);
  if (result.errors.length) throw new InputError(firstError(result.errors), result.errors);
  return { values: result.values as Values, meta: result.meta };
}
