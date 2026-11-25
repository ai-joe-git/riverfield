// Types for the plain ES module shared by the Director panel and the server.
export type RenderProfileError = { code: string; field: string; message: string };
export type Resolution = { width: number; height: number; megapixels: number };
export type RenderProfileCapability = {
  supported: boolean;
  build_megapixels: number;
  production_default_megapixels: number;
  generation: { min: number; max: number; step: number };
  upscale: {
    options: {
      value: string;
      label: string;
      linear_factor: number;
      pixel_area_factor: number;
      checkpoint_pair: { factor: string; unet: string; vae: string } | null;
    }[];
    relay_vsr: boolean;
  } | null;
  detail: { min: number; max: number; step: number; default: number } | null;
};
export type RenderMetadata = {
  profile: "build" | "production" | "legacy";
  resolved: boolean;
  generation: {
    requested_megapixels: number;
    width: number | null;
    height: number | null;
    megapixels: number | null;
    aspect: string;
    multiple: number;
  };
  output: { width: number; height: number; megapixels: number; estimated: true } | null;
  upscale: "off" | "x2" | "x4";
  upscale_detail: number | null;
  upscale_linear_factor: number;
  upscale_pixel_area_factor: number;
  relay_vsr: boolean;
  relay_vsr_models: { factor: string; unet: string; vae: string } | null;
};
export type RenderProfileResult = {
  values: Record<string, unknown>;
  meta: RenderMetadata | null;
  errors: RenderProfileError[];
  changed?: boolean;
};
type AppLike = { inputs?: Array<{ id: string; [key: string]: unknown }> };

export const BUILD_MEGAPIXELS: number;
export const PRODUCTION_DEFAULT_MEGAPIXELS: number;
export const ASPECT_RATIOS: Record<string, [number, number]>;
export const UPSCALE_FACTORS: Record<string, { value: string; label: string; linear: number; area: number }>;

export function renderProfileCapability(app: AppLike): RenderProfileCapability | null;
export function resolutionFor(aspect: unknown, megapixels: unknown, multiple?: number): Resolution | null;
export function relayVSRPair(app: AppLike, factor: unknown): { factor: string; unet: string; vae: string } | null;
export function renderMetadata(app: AppLike, values?: Record<string, unknown>): RenderMetadata | null;
export function resolveRenderProfile(app: AppLike, values?: Record<string, unknown>): RenderProfileResult;
export function switchRenderProfile(app: AppLike, values: Record<string, unknown> | undefined, profile: string): RenderProfileResult;
export function migrateRenderProfile(
  app: AppLike,
  values: Record<string, unknown> | undefined,
  options?: { fresh?: boolean },
): RenderProfileResult;
export function productionValuesFromPreview(
  app: AppLike,
  previewValues?: Record<string, unknown>,
  choices?: Record<string, unknown>,
): RenderProfileResult;
