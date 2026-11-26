// Analysis-only image derivatives for the observer. Originals and their hashes are
// never modified. Each derivative gets a small readable margin with an alias, immutable
// evidence id and timestamp/frame number; the model sees only deterministic aliases.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { hashFile } from "./production-media.ts";
import type { ObservationEvidence } from "./production-types.ts";

export type AnalysisReference = {
  id: string;
  label: string;
  path: string;
  hash?: string;
};

export type AnalysisImage = {
  alias: string;
  kind: "evidence" | "reference";
  evidenceId: string;
  label: string;
  originalPath: string;
  originalHash: string;
  derivativePath: string;
  derivativeHash: string;
  timestampSeconds?: number;
  frame?: number;
  shotId?: string;
};

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const VERSION = "phase1.3-analysis-margin-v1";

const escapeFilterText = (value: string) => value
  .replace(/\\/g, "\\\\")
  .replace(/'/g, "\\'")
  .replace(/:/g, "\\:")
  .replace(/%/g, "\\%")
  .replace(/\n/g, " ");

function render(input: string, output: string, text: string) {
  execFileSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-i", input,
    "-vf", `pad=iw:ih+72:0:72:color=black,drawtext=fontfile='${FONT}':text='${escapeFilterText(text)}':x=14:y=22:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.72:boxborderw=7`,
    "-frames:v", "1", "-q:v", "2", output,
  ], { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
}

/**
 * Build deterministic derivatives in the requested chronological order. Evidence
 * aliases are image-01..image-07 and references continue image-08..image-09.
 */
export function createAnalysisImages(input: {
  frames: ObservationEvidence[];
  references: AnalysisReference[];
  outputDir: string;
  version?: string;
}): AnalysisImage[] {
  mkdirSync(input.outputDir, { recursive: true });
  const out: AnalysisImage[] = [];
  let index = 0;
  for (const frame of input.frames) {
    index += 1;
    const alias = `image-${String(index).padStart(2, "0")}`;
    const derivativePath = join(input.outputDir, `${alias}-${frame.id}.jpg`);
    const timestamp = frame.timestampSeconds !== undefined ? `${frame.timestampSeconds.toFixed(3)}s` : "?s";
    const label = `${alias} | ${frame.id} | ${timestamp} | frame ${frame.frame ?? "?"}${frame.shotId ? ` | ${frame.shotId}` : ""}`;
    render(frame.path!, derivativePath, label);
    out.push({
      alias, kind: "evidence", evidenceId: frame.id, label,
      originalPath: frame.path!, originalHash: frame.hash ?? hashFile(frame.path!),
      derivativePath, derivativeHash: hashFile(derivativePath),
      ...(frame.timestampSeconds !== undefined ? { timestampSeconds: frame.timestampSeconds } : {}),
      ...(frame.frame !== undefined ? { frame: frame.frame } : {}),
      ...(frame.shotId ? { shotId: frame.shotId } : {}),
    });
  }
  for (const reference of input.references) {
    index += 1;
    const alias = `image-${String(index).padStart(2, "0")}`;
    const derivativePath = join(input.outputDir, `${alias}-ref.jpg`);
    const label = `${alias} | ${reference.label} | reference`;
    render(reference.path, derivativePath, label);
    out.push({
      alias, kind: "reference", evidenceId: reference.id, label,
      originalPath: reference.path, originalHash: reference.hash ?? hashFile(reference.path),
      derivativePath, derivativeHash: hashFile(derivativePath),
    });
  }
  return out;
}

export function analysisImageManifest(images: AnalysisImage[], version = VERSION) {
  return {
    version,
    note: "Analysis-only derivatives. Original evidence frames and references are unchanged; these files carry labels and aliases for the model.",
    images,
  };
}
