// Organisational asset folders for a production. These are not canonical facts and do
// not change the production revision; they only keep the asset library navigable.
export const ASSET_CATEGORIES = ["characters", "locations", "props", "drafts", "references"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export function categoryForPrompt(raw: unknown): AssetCategory {
  const prompt = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!prompt) return "references";
  if (/location is completely unoccupied and deserted|empty location|draft plate|no human figure/i.test(prompt)) return "drafts";
  if (/expression studies|character sheet|character turnaround|character design|model sheet|mascot/i.test(prompt)) return "characters";
  if (/control panel|electronic toilet|inflatable heart|intercom telephone|hotel key|room-service trolley|service booklet|karaoke microphone|CRT terminal|prop\b/i.test(prompt)) return "props";
  if (/corridor|lobby|elevator|bar\b|diner|apartment|rooftop|terrace|karaoke room|pantry|maintenance room|hotel|suite|street|alley|room\b/i.test(prompt)) return "locations";
  return "references";
}
