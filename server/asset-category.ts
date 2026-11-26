// Organisational asset folders for a production. These are not canonical facts and do
// not change the production revision; they only keep the asset library navigable.
// SUITE 404 uses the same top-level names as its official Assets/ folder plus References
// for production-only material that has no official folder.
export const ASSET_CATEGORIES = ["characters", "environments", "props", "tests", "references"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export function categoryForPrompt(raw: unknown): AssetCategory {
  const prompt = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!prompt) return "references";
  if (/expression studies|character sheet|character turnaround|character design|model sheet|mascot/i.test(prompt)) return "characters";
  if (/control panel|electronic toilet|inflatable heart|intercom telephone|hotel key|room-service trolley|service booklet|karaoke microphone|CRT terminal|prop\b/i.test(prompt)) return "props";
  if (/qwen21|test render|test sheet|comparison test/i.test(prompt)) return "tests";
  if (/corridor|lobby|elevator|bar\b|diner|apartment|rooftop|terrace|karaoke room|pantry|maintenance room|hotel|suite|street|alley|room\b|location|environment/i.test(prompt)) return "environments";
  return "references";
}
