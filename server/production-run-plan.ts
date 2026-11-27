// Editable production planning from a natural-language brief. It does not write cinematic
// model prompts: the existing Director prompt enhancer remains responsible for that step.
import type { ProductionRunProfile, ProductionRunScene, ProductionSnapshot } from "./production-types.ts";
import { auditAssetCatalogue } from "./asset-audit.ts";

export type ProductionPlanInput = {
  brief: string;
  sceneCount?: number;
  profile?: ProductionRunProfile;
  episodeId?: string;
  seasonId?: string;
  selectedApp?: string;
  sceneIds?: string[];
  targetDurationSeconds?: number;
};
export type ProductionPlan = {
  brief: string;
  profile: ProductionRunProfile;
  seasonId?: string;
  episodeId?: string;
  selectedApplications: string[];
  referenceAssets: string[];
  renderConfig: Record<string, unknown>;
  scenes: ProductionRunScene[];
  unresolved: string[];
  promptStrategy: "director-prompt-enhancer";
};

const unique = <T>(values: T[]) => [...new Set(values)];
const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const sentences = (brief: string) => brief.split(/(?<=[.!?])\s+|\n+/).map(clean).filter(Boolean);
const quoted = (brief: string) => [...brief.matchAll(/["“]([^"”]+)["”]/g)].map((match) => clean(match[1]));

export function planProductionRun(snapshot: ProductionSnapshot, input: ProductionPlanInput): ProductionPlan {
  const brief = clean(input.brief || "");
  if (!brief) throw new Error("PRODUCTION_PLAN_BRIEF_REQUIRED: A creative brief is required");
  const count = Math.max(1, Math.min(8, input.sceneCount ?? 2));
  const profile = input.profile ?? "build";
  const app = input.selectedApp ?? "h3-studio-director-flash";
  const parts = sentences(brief);
  const scenes: ProductionRunScene[] = [];
  const audit = auditAssetCatalogue(snapshot).filter((asset) => asset.trusted);
  const characterAssets = audit.filter((asset) => asset.currentCategory === "characters");
  const environmentAssets = audit.filter((asset) => asset.currentCategory === "environments");
  const propAssets = audit.filter((asset) => asset.currentCategory === "props");
  const existingScenes = [...snapshot.scenes].sort((a, b) => a.number - b.number);
  const proposedIds = input.sceneIds?.slice(0, count) ?? existingScenes.slice(0, count).map((scene) => scene.id);
  for (let index = 0; index < count; index += 1) {
    const text = parts[index] ?? parts.join(" ") ?? brief;
    const characterIds = characterAssets.filter((asset) => new RegExp(`\\b${asset.currentLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split(" ")[0]}\\b`, "i").test(brief)).map((asset) => asset.assetId);
    const locationIds = environmentAssets.filter((asset) => text.toLowerCase().includes(asset.currentLabel.split("_").at(-2)?.toLowerCase() ?? "!")).map((asset) => asset.assetId);
    const propIds = propAssets.filter((asset) => asset.currentLabel.split("_").some((part) => part.length > 3 && text.toLowerCase().includes(part.toLowerCase()))).map((asset) => asset.assetId);
    const sceneId = proposedIds[index] ?? `${snapshot.episodes.find((episode) => episode.id === input.episodeId)?.id ?? "production"}-sc-${String(index + 1).padStart(2, "0")}`;
    const dialogueRequirements = quoted(text);
    const transition = index === count - 1 ? "end" : "cut";
    scenes.push({
      sceneId, title: `Scene ${String(index + 1).padStart(2, "0")}`, objective: text,
      intendedEvents: [text], dialogueRequirements, characterIds: unique(characterIds),
      locationIds: unique(locationIds), propIds: unique(propIds), targetDurationSeconds: input.targetDurationSeconds ?? 8,
      intendedTransition: transition, selectedApp: app, profile,
      referenceAssetIds: unique([...characterIds, ...locationIds, ...propIds]),
      renderConfig: { render_profile: profile, production_megapixels: profile === "build" ? 0.1 : 0.3, production_upscale: profile === "build" ? "none" : "x2", prompt_enhancer: true },
      observationIds: [], continuityReviewIds: [], status: "planned", jobIds: [], attempts: 0, errors: [],
    });
  }
  const unresolved: string[] = [];
  if (!scenes.some((scene) => scene.characterIds.length)) unresolved.push("No trusted character asset was named in the brief; cast remains editable.");
  if (!scenes.some((scene) => scene.locationIds.length)) unresolved.push("No trusted location asset was named in the brief; location remains editable.");
  return {
    brief, profile, ...(input.seasonId ? { seasonId: input.seasonId } : {}), ...(input.episodeId ? { episodeId: input.episodeId } : {}),
    selectedApplications: [app], referenceAssets: unique(scenes.flatMap((scene) => scene.referenceAssetIds)),
    renderConfig: { render_profile: profile, production_megapixels: profile === "build" ? 0.1 : 0.3, production_upscale: profile === "build" ? "none" : "x2", prompt_enhancer: true },
    scenes, unresolved, promptStrategy: "director-prompt-enhancer",
  };
}
