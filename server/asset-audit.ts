// Semantic catalogue audit. Filenames and hashes prove transport identity only; these
// corrections are derived from actual image inspection plus the source History prompt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProductionSnapshot } from "./production-types.ts";

export type AssetAuditStatus = "trusted" | "requires_review" | "ambiguous";
export type AssetSemanticStatus = "visually-verified" | "requires-review" | "ambiguous" | "not-independently-verified";
export type AssetReferenceSuitability =
  | "character-multiview-reference"
  | "prop-reference"
  | "environment-reference"
  | "environment-reference-ambiguous"
  | "not-independently-audited";

export type AssetAuditEntry = {
  assetId: string;
  currentLabel: string;
  currentCategory: string;
  proposedLabel: string;
  proposedCategory: string;
  status: AssetAuditStatus;
  trusted: boolean;
  semanticStatus: AssetSemanticStatus;
  referenceSuitability: AssetReferenceSuitability;
  observedContent: string;
  semanticIdentity: string;
  reason: string;
  aliases: string[];
  proposedAliases: string[];
  tags: string[];
  proposedTags: string[];
  supersededTagChange: "none" | "remove" | "add";
  sourceRunId?: string;
  path: string;
  hash?: string;
};

export type AssetCorrectionBatchEntry = {
  assetId: string;
  currentLabel: string;
  proposedLabel: string;
  currentCategory: string;
  proposedCategory: string;
  currentAliases: string[];
  proposedAliases: string[];
  currentTags: string[];
  proposedTags: string[];
  supersededTagChange: "none" | "remove" | "add";
  referenceSuitability: AssetReferenceSuitability;
  semanticIdentity: string;
  observedContent: string;
  reason: string;
};

export type AssetCorrectionBatch = {
  id: string;
  status: "prepared-not-applied";
  generatedAt: string;
  source: "actual-image-inspection";
  instruction: "Apply only after human approval; media files and historical observations are never rewritten.";
  entries: AssetCorrectionBatchEntry[];
  ambiguous: { assetId: string; currentLabel: string; proposedLabel: string; reason: string }[];
};

type Correction = {
  label: string; category: string; status: AssetAuditStatus; content: string; reason: string;
  identity: string; suitability: AssetReferenceSuitability; supersededTagChange?: "none" | "remove" | "add";
};

const CORRECTIONS: Record<string, Correction> = {
  "suite404-asset-20261124-224902120-37c3-1": {
    label: "Suite_404_Hallway_Master_Alt", category: "environments", status: "ambiguous",
    content: "hotel corridor with burgundy doors, brass sconces and room-number plaques",
    identity: "Hallway environment, unconfirmed alternate master",
    suitability: "environment-reference-ambiguous",
    reason: "The actual image is a hallway environment, not Naomi. The source run prompt is a hallway; the intended catalogue slot is ambiguous because an earlier Hallway master already exists.",
  },
  "suite404-asset-20261124-225232945-54f9-1": {
    label: "Naomi_Bartender_Character_Sheet", category: "characters", status: "requires_review",
    content: "adult woman with dark ponytail, ivory shirt, charcoal vest and burgundy tie",
    identity: "Naomi, bartender character", suitability: "character-multiview-reference",
    reason: "Source prompt identifies Naomi; current label is Tetsuo. The image is a multi-view character sheet, suitable for identity reference.",
  },
  "suite404-asset-20261124-231235158-b8a5-1": {
    label: "Tetsuo_Technician_Character_Sheet", category: "characters", status: "requires_review",
    content: "lanky adult man with safety glasses, utility coveralls and tool belt",
    identity: "Tetsuo, technician character", suitability: "character-multiview-reference",
    reason: "Source prompt identifies Tetsuo; current label is Haru. The image is a multi-view character sheet, suitable for identity reference.",
  },
  "suite404-asset-20261124-231927643-6090-1": {
    label: "Haru_Room_Service_Character_Sheet", category: "characters", status: "requires_review",
    content: "young adult man in hotel service shirt, bow tie and vest",
    identity: "Haru, room-service character", suitability: "character-multiview-reference",
    reason: "Source prompt identifies Haru; current label is Emi. The image is a multi-view character sheet, suitable for identity reference.",
  },
  "suite404-asset-20261124-233704943-61ec-1": {
    label: "Emi_Diner_Owner_Character_Sheet", category: "characters", status: "requires_review",
    content: "older adult woman in teal blouse, apron and dark trousers",
    identity: "Emi, diner owner", suitability: "character-multiview-reference",
    reason: "Source prompt identifies Emi; current label is Momo. The image is a multi-view character sheet, suitable for identity reference.",
  },
  "suite404-asset-20261124-234855840-40f7-1": {
    label: "Momo_Mascot_Character_Sheet", category: "characters", status: "requires_review",
    content: "male character sheet plus cream heart-shaped Momo mascot turnaround",
    identity: "Momo mascot and human character sheet; not a heart prop",
    suitability: "character-multiview-reference",
    reason: "Actual image is the Momo character sheet, not the inflatable heart; current label is Inflatable_Heart_Prop. It is suitable as a character reference, not as a prop reference.",
  },
  "suite404-asset-20261124-235052163-a49c-1": {
    label: "Inflatable_Heart_Prop", category: "props", status: "requires_review",
    content: "large glossy dusty-pink inflatable heart decoration",
    identity: "Inflatable heart prop", suitability: "prop-reference",
    reason: "Actual image is the inflatable heart; source prompt identifies the inflatable heart; current label is Retro_Intercom_Prop.",
  },
  "suite404-asset-20261124-235222479-02cb-1": {
    label: "Retro_Intercom_Prop", category: "props", status: "requires_review",
    content: "burgundy and cream Bakelite-style hotel intercom telephone",
    identity: "Retro intercom telephone prop", suitability: "prop-reference",
    reason: "Actual image is the intercom telephone; source prompt identifies the intercom; current label is Suite_404_Key_Fob_Prop.",
  },
  "suite404-asset-20261124-235352755-7399-1": {
    label: "Suite_404_Key_Fob_Prop", category: "props", status: "requires_review",
    content: "brass key and burgundy diamond enamel fob marked 404",
    identity: "Suite 404 key-fob prop", suitability: "prop-reference",
    reason: "Actual image is the key fob; source prompt identifies the key fob; current label is Room_Service_Cart_Prop.",
  },
  "suite404-asset-20261124-235528748-f739-1": {
    label: "Room_Service_Cart_Prop", category: "props", status: "requires_review",
    content: "two-tier brass room-service trolley with cloche",
    identity: "Room-service cart prop", suitability: "prop-reference",
    reason: "Actual image is the service cart; source prompt identifies the cart; current label is Romance_Service_Menu_Prop.",
  },
  "suite404-asset-20261124-235658992-0df9-1": {
    label: "Romance_Service_Menu_Prop", category: "props", status: "requires_review",
    content: "burgundy leather Velvet Moon service booklet/menu",
    identity: "Romance service menu prop", suitability: "prop-reference",
    reason: "Actual image is the service menu; source prompt identifies the menu; current label is Karaoke_Microphone_Prop.",
  },
  "suite404-asset-20261124-235829229-3022-1": {
    label: "Karaoke_Microphone_Prop", category: "props", status: "requires_review",
    content: "brass-grille burgundy wired karaoke microphone",
    identity: "Karaoke microphone prop", suitability: "prop-reference", supersededTagChange: "remove",
    reason: "Actual image is the karaoke microphone; source prompt identifies the microphone; current label is Hotel_Mascot_Display_Prop (superseded). The superseded tag belongs to the later CRT display asset, not this microphone.",
  },
};

function aliasesOf(tags: string[]): string[] {
  return tags.filter((tag) => tag.startsWith("Assets/") || tag.startsWith("alias:"));
}
function proposedAlias(category: string, label: string): string {
  const folder = category === "characters" ? "Characters" : category === "props" ? "Props" : category === "environments" ? "Environments" : "References";
  return `Assets/${folder}/${label.replace(/\s+/g, "_")}.png`;
}
function proposedTagsOf(tags: string[], category: string, label: string, removeSuperseded = false): string[] {
  const base = tags.filter((tag) => !tag.startsWith("Assets/") && !tag.startsWith("alias:") && !tag.startsWith("official-category:") && tag !== "superseded");
  return [...new Set([...base, "official-catalog", `official-category:${category}`, proposedAlias(category, label), ...(removeSuperseded ? [] : [])])];
}

export function auditAssetCatalogue(snapshot: ProductionSnapshot): AssetAuditEntry[] {
  return Object.values(snapshot.assets).map((asset) => {
    const correction = CORRECTIONS[asset.id];
    const tags = asset.tags ?? [];
    const aliases = aliasesOf(tags);
    if (!correction) {
      return {
        assetId: asset.id, currentLabel: asset.label, currentCategory: asset.category,
        proposedLabel: asset.label, proposedCategory: asset.category, status: "trusted", trusted: true,
        semanticStatus: "not-independently-verified", referenceSuitability: "not-independently-audited",
        observedContent: "not separately reclassified in this audit",
        semanticIdentity: "current assignment not independently verified",
        reason: "No semantic correction was recorded, but this asset was not independently visually verified in this batch.",
        aliases, proposedAliases: aliases, tags, proposedTags: tags, supersededTagChange: "none",
        ...(asset.sourceRunId ? { sourceRunId: asset.sourceRunId } : {}), path: asset.path, ...(asset.hash ? { hash: asset.hash } : {}),
      };
    }
    const proposedAliases = [proposedAlias(correction.category, correction.label)];
    return {
      assetId: asset.id, currentLabel: asset.label, currentCategory: asset.category,
      proposedLabel: correction.label, proposedCategory: correction.category,
      status: correction.status, trusted: false,
      semanticStatus: correction.status === "ambiguous" ? "ambiguous" : "requires-review",
      referenceSuitability: correction.suitability, observedContent: correction.content,
      semanticIdentity: correction.identity, reason: correction.reason,
      aliases, proposedAliases, tags,
      proposedTags: proposedTagsOf(tags, correction.category, correction.label, correction.supersededTagChange === "remove"),
      supersededTagChange: correction.supersededTagChange ?? "none",
      ...(asset.sourceRunId ? { sourceRunId: asset.sourceRunId } : {}), path: asset.path, ...(asset.hash ? { hash: asset.hash } : {}),
    };
  });
}

/** The eleven concrete corrections; the ambiguous hallway entry is kept separate. */
export function buildAssetCorrectionBatch(snapshot: ProductionSnapshot): AssetCorrectionBatch {
  const audit = auditAssetCatalogue(snapshot);
  const entries = audit.filter((entry) => entry.assetId !== "suite404-asset-20261124-224902120-37c3-1" && !entry.trusted)
    .map((entry) => ({
      assetId: entry.assetId, currentLabel: entry.currentLabel, proposedLabel: entry.proposedLabel,
      currentCategory: entry.currentCategory, proposedCategory: entry.proposedCategory,
      currentAliases: entry.aliases, proposedAliases: entry.proposedAliases,
      currentTags: entry.tags, proposedTags: entry.proposedTags,
      supersededTagChange: entry.supersededTagChange, referenceSuitability: entry.referenceSuitability,
      semanticIdentity: entry.semanticIdentity, observedContent: entry.observedContent, reason: entry.reason,
    }));
  const ambiguous = audit.filter((entry) => entry.status === "ambiguous").map((entry) => ({
    assetId: entry.assetId, currentLabel: entry.currentLabel, proposedLabel: entry.proposedLabel, reason: entry.reason,
  }));
  return {
    id: "suite404-asset-correction-batch-001",
    status: "prepared-not-applied",
    generatedAt: "2026-11-26T23:00:00.000Z",
    source: "actual-image-inspection",
    instruction: "Apply only after human approval; media files and historical observations are never rewritten.",
    entries, ambiguous,
  };
}

export function untrustedAssetIds(snapshot: ProductionSnapshot): Set<string> {
  return new Set(auditAssetCatalogue(snapshot).filter((entry) => !entry.trusted).map((entry) => entry.assetId));
}

export function assertTrustedReferences(snapshot: ProductionSnapshot, ids: string[]): void {
  const untrusted = untrustedAssetIds(snapshot);
  const blocked = ids.filter((id) => untrusted.has(id));
  if (blocked.length) {
    const details = auditAssetCatalogue(snapshot).filter((entry) => blocked.includes(entry.assetId));
    throw new Error(`Reference assets require catalogue review before use: ${details.map((entry) => `${entry.assetId} (${entry.currentLabel} → ${entry.proposedLabel})`).join("; ")}`);
  }
}

export const P6_REFERENCE_WARNING = {
  observationId: "277e6cd4-9a50-42b0-a076-c4f8c822a01e",
  candidateId: "suite404-20261125-165620497-5c63",
  references: [
    "suite404-asset-20261124-234855840-40f7-1",
    "suite404-asset-20261124-235222479-02cb-1",
  ],
  status: "requires_review",
  warning: "The historical P6 observation retains its original reference provenance. Its Inflatable_Heart_Prop reference actually contained the Momo character sheet, and its Key_Fob_Prop reference actually contained the intercom telephone. Do not reuse these associations as trusted references.",
} as const;

export type AssetCorrectionDecision = {
  id: string;
  batchId: string;
  decision: "approved" | "rejected";
  note: string;
  entries: number;
  ambiguous: number;
  createdAt: string;
  actor: string;
};

/** Human decision only. It never rewrites asset metadata or applies the batch. */
export function readAssetCorrectionDecisions(outDir: string): AssetCorrectionDecision[] {
  const file = join(outDir, "observations", "phase2-asset-audit", "asset-correction-decisions.json");
  if (!existsSync(file)) return [];
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

export function recordAssetCorrectionDecision(
  outDir: string, batch: AssetCorrectionBatch, decision: "approved" | "rejected", actor: string, note = "",
): AssetCorrectionDecision {
  const file = join(outDir, "observations", "phase2-asset-audit", "asset-correction-decisions.json");
  const history = readAssetCorrectionDecisions(outDir);
  const record: AssetCorrectionDecision = {
    id: `asset-decision-${Date.now()}-${history.length + 1}`, batchId: batch.id, decision,
    note: String(note).trim(), entries: batch.entries.length, ambiguous: batch.ambiguous.length,
    createdAt: new Date().toISOString(), actor: String(actor || "human"),
  };
  mkdirSync(join(outDir, "observations", "phase2-asset-audit"), { recursive: true });
  writeFileSync(file, JSON.stringify([...history, record], null, 2));
  return record;
}
