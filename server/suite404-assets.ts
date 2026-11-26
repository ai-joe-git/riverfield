// Non-destructive naming/category sync for SUITE 404 assets. It reads the official
// Asset_Registry/Universe_Asset_Batch catalog and updates existing Production Engine
// asset labels/categories only; it never copies, moves or renames a media file and it
// never changes the canonical revision.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProductionStore } from "./production-store.ts";
import type { Actor, Asset } from "./production-types.ts";

export const SUITE404_CATALOG_ROOT = process.env.RIVERFIELD_SUITE404_ROOT
  || "/home/zardoz/comfyui-vanilla-gfx1151/ComfyUI/input/Suite_404";

type RegistryAsset = {
  id?: string;
  category?: string;
  relative_path?: string;
  job_id?: string | null;
  origin?: string;
  status?: string;
};
type BatchAsset = {
  n?: number;
  dest?: string;
  output?: string;
  job?: string;
  status?: string;
};
type CatalogEntry = {
  id: string;
  label: string;
  category: string;
  relativePath: string;
  origins: string[];
  jobIds: string[];
};

export type Suite404AssetSyncReport = {
  productionId: string;
  catalog: number;
  matched: number;
  updated: number;
  unchanged: number;
  added: number;
  superseded: number;
  unmatched: { id: string; label: string; sourceRunId?: string }[];
};

function normalizeCategory(category: string): string {
  const value = category.toLowerCase();
  if (value === "environments" || value === "environment" || value === "locations") return "environments";
  if (value === "characters" || value === "character") return "characters";
  if (value === "props" || value === "prop") return "props";
  if (value === "tests" || value === "test") return "tests";
  if (value === "drafts" || value === "draft") return "references";
  return category || "references";
}

function categoryFromPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("/Characters/")) return "characters";
  if (normalized.includes("/Environments/")) return "environments";
  if (normalized.includes("/Props/")) return "props";
  if (normalized.includes("/Tests/")) return "tests";
  return "references";
}

function stem(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || path;
}

function scanTestAssets(root: string): string[] {
  const testsRoot = join(root, "Assets", "Tests");
  if (!existsSync(testsRoot)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
      out.push(full.replace(root.replace(/[\\/]+$/, ""), "").replace(/^[/\\]/, "").replace(/\\/g, "/"));
    }
  };
  walk(testsRoot);
  return out;
}

export function loadOfficialCatalog(root = SUITE404_CATALOG_ROOT): CatalogEntry[] {
  const registryFile = join(root, "Production", "Asset_Registry.json");
  const batchFile = join(root, "Production", "Universe_Asset_Batch_v1.json");
  if (!existsSync(registryFile)) throw new Error(`Official SUITE 404 Asset_Registry.json not found at ${registryFile}`);
  const registry = JSON.parse(readFileSync(registryFile, "utf8")) as { assets?: RegistryAsset[] };
  const batch = existsSync(batchFile)
    ? JSON.parse(readFileSync(batchFile, "utf8")) as { assets?: Record<string, BatchAsset> }
    : { assets: {} };
  const byPath = new Map<string, CatalogEntry>();
  const byJob = new Map<string, CatalogEntry>();
  const byNumber = new Map<number, CatalogEntry>();

  const add = (id: string, relativePath: string, category: string, origin?: string, job?: string | null) => {
    const normalized = relativePath.replace(/\\/g, "/");
    if (!normalized) return;
    const entry: CatalogEntry = {
      id: id || stem(normalized), label: stem(normalized), category: categoryFromPath(normalized),
      relativePath: normalized, origins: origin ? [origin] : [], jobIds: job ? [job] : [],
    };
    byPath.set(normalized, entry);
    if (job) byJob.set(job, entry);
    if (category) entry.category = normalizeCategory(category);
  };

  for (const asset of registry.assets ?? []) {
    if (!asset.relative_path) continue;
    add(String(asset.id || ""), asset.relative_path, String(asset.category || ""), asset.origin, asset.job_id ?? undefined);
  }
  for (const [key, asset] of Object.entries(batch.assets ?? {})) {
    const path = String(asset.dest || asset.output || "");
    if (!path) continue;
    const n = Number(asset.n) || Number(key);
    const existing = byPath.get(path) ?? byPath.get(path.replace(/\\/g, "/"));
    if (existing) {
      if (asset.job && !existing.jobIds.includes(asset.job)) existing.jobIds.push(asset.job);
      byJob.set(asset.job || "", existing);
      if (n) byNumber.set(n, existing);
      continue;
    }
    add(stem(path), path, categoryFromPath(path), "universe_batch_v1", asset.job);
    const entry = byPath.get(path)!;
    if (n) byNumber.set(n, entry);
  }
  // The sequence in the imported history label is the Universe batch number.
  for (const [key, asset] of Object.entries(batch.assets ?? {})) {
    const n = Number(asset.n) || Number(key);
    const path = String(asset.dest || asset.output || "");
    if (n && path && byPath.has(path)) byNumber.set(n, byPath.get(path)!);
  }
  // Assets/Tests is a real official folder but is not part of the generated-master registry.
  for (const relativePath of scanTestAssets(root)) {
    if (byPath.has(relativePath)) continue;
    add(stem(relativePath), relativePath, "tests", "official_test", null);
  }
  return [...byPath.values()];
}

function catalogForAsset(asset: Asset, catalog: CatalogEntry[], byJob: Map<string, CatalogEntry>, byNumber: Map<number, CatalogEntry>): CatalogEntry | undefined {
  const sequence = /Suite404_Assets_(\d{5})/i.exec(asset.label);
  if (sequence) {
    const hit = byNumber.get(Number(sequence[1]));
    if (hit) return hit;
  }
  const officialPath = (asset.tags ?? []).find((tag) => tag.startsWith("Assets/"));
  if (officialPath) {
    const hit = byJob.get(officialPath);
    if (hit) return hit;
    const catalogPath = officialPath.replace(/\\/g, "/");
    const byPathHit = catalog.find((entry) => entry.relativePath === catalogPath);
    if (byPathHit) return byPathHit;
  }
  if (asset.sourceRunId) {
    const hit = byJob.get(asset.sourceRunId);
    if (hit) return hit;
  }
  return undefined;
}

/** Update labels/categories in place, preserving asset ids and media paths. */
export function syncSuite404Assets(outDir: string, options: { productionId?: string; root?: string } = {}): Suite404AssetSyncReport {
  const productionId = options.productionId ?? "suite-404";
  const catalog = loadOfficialCatalog(options.root);
  const byJob = new Map<string, CatalogEntry>();
  const byNumber = new Map<number, CatalogEntry>();
  for (const entry of catalog) for (const job of entry.jobIds) byJob.set(job, entry);
  // Rebuild number mapping from the batch file (the import label uses this sequence).
  const batchFile = join(options.root ?? SUITE404_CATALOG_ROOT, "Production", "Universe_Asset_Batch_v1.json");
  if (existsSync(batchFile)) {
    const batch = JSON.parse(readFileSync(batchFile, "utf8")) as { assets?: Record<string, BatchAsset> };
    for (const [key, item] of Object.entries(batch.assets ?? {})) {
      const path = String(item.dest || item.output || "");
      const entry = catalog.find((candidate) => candidate.relativePath === path);
      if (entry) byNumber.set(Number(item.n) || Number(key), entry);
    }
  }
  const store = new ProductionStore(outDir);
  const snap = store.snapshot(productionId);
  const actor: Actor = { kind: "import", id: "suite404-asset-catalog" };
  const unmatched: Suite404AssetSyncReport["unmatched"] = [];
  let matched = 0, updated = 0, unchanged = 0, added = 0, superseded = 0;
  const labels = new Set(Object.values(snap.assets).map((asset) => asset.label));
  const officialCopyDir = join(outDir, "media", "suite404-official");
  mkdirSync(officialCopyDir, { recursive: true });
  for (const entry of catalog) {
    if (labels.has(entry.label)) continue;
    const source = join(options.root ?? SUITE404_CATALOG_ROOT, entry.relativePath);
    if (!existsSync(source)) continue;
    const target = join(officialCopyDir, `${entry.id.replace(/[^A-Za-z0-9_-]+/g, "-")}.png`);
    copyFileSync(source, target);
    const id = `suite404-official-${entry.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
    store.indexAsset(productionId, {
      id, kind: "image", label: entry.label, path: target,
      category: entry.category, tags: ["suite404", "official-catalog", `official-category:${entry.category}`, entry.relativePath],
    }, actor, `suite404:asset:add:${entry.id}`);
    labels.add(entry.label);
    added += 1;
  }
  for (const asset of Object.values(snap.assets)) {
    if (asset.kind !== "image") continue;
    const superseded = (asset.tags ?? []).includes("superseded") || asset.category === "drafts";
    if (superseded) {
      const nextTags = [...new Set([
        ...(asset.tags ?? []).filter((tag) => !["characters", "locations", "props", "drafts", "tests", "references", "environments", "official-catalog"].includes(tag) && !tag.startsWith("official-category:")),
        "superseded", "official-category:references",
      ])];
      if (asset.category !== "references") {
        store.updateAsset(productionId, asset.id, { category: "references", tags: nextTags }, actor, `suite404:asset:superseded-ref:${asset.id}`);
        unchanged += 0;
      }
      continue;
    }
    const entry = catalogForAsset(asset, catalog, byJob, byNumber);
    if (!entry) {
      unmatched.push({ id: asset.id, label: asset.label, ...(asset.sourceRunId ? { sourceRunId: asset.sourceRunId } : {}) });
      if (asset.category !== "references") {
        const tags = [...new Set([...(asset.tags ?? []), "production-extra", "official-category:references"])];
        store.updateAsset(productionId, asset.id, { category: "references", tags }, actor, `suite404:asset:extra:${asset.id}`);
      }
      continue;
    }
    matched += 1;
    const nextLabel = entry.label;
    const nextCategory = entry.category;
    const nextTags = [...new Set([
      ...(asset.tags ?? []).filter((tag) => !["characters", "locations", "props", "drafts", "tests", "references", "environments", "official-catalog"].includes(tag) && !tag.startsWith("official-category:")),
      "suite404", "official-catalog", `official-category:${entry.category}`, entry.relativePath,
    ])];
    if (asset.label === nextLabel && asset.category === nextCategory && JSON.stringify([...asset.tags].sort()) === JSON.stringify([...nextTags].sort())) {
      unchanged += 1;
      continue;
    }
    store.updateAsset(productionId, asset.id, { label: nextLabel, category: nextCategory, tags: nextTags }, actor, `suite404:asset:catalog:${asset.id}:${nextCategory}:${nextLabel}:${nextTags.join("|")}`);
    updated += 1;
  }
  // The official Assets folder holds the current master of each catalog entry. Older
  // generated versions remain in the Engine, but they belong under Drafts as superseded
  // references rather than next to the current master.
  const fresh = store.snapshot(productionId);
  const groups = new Map<string, Asset[]>();
  for (const asset of Object.values(fresh.assets)) {
    if (asset.category === "references" || (asset.tags ?? []).includes("superseded")) continue;
    groups.set(asset.label, [...(groups.get(asset.label) ?? []), asset]);
  }
  for (const [label, list] of groups) {
    if (list.length < 2) continue;
    const entry = catalog.find((candidate) => candidate.label === label);
    const current = entry?.jobIds ?? [];
    const preferred = list.find((asset) => asset.sourceRunId && current.includes(asset.sourceRunId))
      ?? [...list].sort((a, b) => (b.sourceRunId ?? "").localeCompare(a.sourceRunId ?? "") || b.createdAt.localeCompare(a.createdAt))[0];
    for (const asset of list) {
      if (asset.id === preferred?.id) continue;
      const nextTags = [...new Set([
        ...(asset.tags ?? []).filter((tag) => !["official-category:characters", "official-category:environments", "official-category:props", "official-category:tests", "official-category:references", "official-category:locations", "official-category:drafts"].includes(tag)),
        "superseded", "official-category:references",
      ])];
      store.updateAsset(productionId, asset.id, {
        label: `${label} (superseded)`, category: "references", tags: nextTags,
      }, actor, `suite404:asset:superseded:${asset.id}:${label}`);
      superseded += 1;
    }
  }
  return { productionId, catalog: catalog.length, matched, updated, unchanged, added, superseded, unmatched };
}

if (process.argv[1] && process.argv[1].endsWith("suite404-assets.ts")) {
  const out = process.env.RIVERFIELD_OUT || join(process.cwd(), "out");
  const report = syncSuite404Assets(out, {
    productionId: process.env.RIVERFIELD_PRODUCTION_ID || "suite-404",
    root: process.env.RIVERFIELD_SUITE404_ROOT || SUITE404_CATALOG_ROOT,
  });
  console.log(JSON.stringify(report, null, 2));
}
