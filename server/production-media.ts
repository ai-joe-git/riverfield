// Production media boundary: all candidate/asset files are regular files below explicit
// allowed roots. History-backed candidates are derived by the server, never trusted from
// caller-supplied replacements. No inference here.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MEDIA_EXTENSIONS = {
  image: new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]),
  video: new Set([".mp4", ".mov", ".webm", ".mkv"]),
  audio: new Set([".mp3", ".wav", ".flac", ".ogg", ".m4a"]),
} as const;

export class MediaSecurityError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function productionMediaRoots(outDir: string): string[] {
  const configured = String(process.env.RIVERFIELD_PRODUCTION_MEDIA_ROOTS || "")
    .split(",").map((value) => value.trim()).filter(Boolean).map((value) => resolve(value));
  return [...new Set([join(outDir, "media"), join(outDir, "history"), join(outDir, "productions"), ...configured])];
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function rejectSymlinkInside(root: string, path: string) {
  const rel = relative(root, path).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of rel) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new MediaSecurityError("SYMLINK_MEDIA", `Symlink media is not allowed: ${path}`);
    } catch (error) {
      if (error instanceof MediaSecurityError) throw error;
      throw new MediaSecurityError("MISSING_MEDIA", `Media file is missing: ${path}`);
    }
  }
}

/** Canonical allowed-root and symlink validation. Throws on any unsafe path. */
export function resolveMediaPath(raw: unknown, roots: string[]): string {
  if (typeof raw !== "string" || !raw.trim()) throw new MediaSecurityError("INVALID_MEDIA_PATH", "A media path is required");
  if (!isAbsolute(raw)) throw new MediaSecurityError("INVALID_MEDIA_PATH", "Media paths must be absolute");
  const requested = resolve(raw);
  if (!existsSync(requested)) throw new MediaSecurityError("MISSING_MEDIA", `No media at ${requested}`);
  const realRoots = roots.map((root) => { try { return realpathSync(root); } catch { return resolve(root); } });
  const real = realpathSync(requested);
  const rootIndex = realRoots
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => inside(candidate, real))
    .sort((a, b) => b.candidate.length - a.candidate.length)[0];
  if (!rootIndex) throw new MediaSecurityError("MEDIA_OUTSIDE_ROOT", "Media path is outside the allowed production roots");
  const root = rootIndex.candidate;
  // Check the requested path, not only its resolved target, so a symlink component
  // cannot make an out-of-root file look as if it lives inside an allowed root.
  rejectSymlinkInside(roots[rootIndex.index], requested);
  if (!statSync(real).isFile()) throw new MediaSecurityError("INVALID_MEDIA_PATH", "Media path must be a regular file");
  const ext = extname(real).toLowerCase();
  const supported = Object.values(MEDIA_EXTENSIONS).some((set) => set.has(ext));
  if (!supported) throw new MediaSecurityError("UNSUPPORTED_MEDIA", `Unsupported media extension: ${ext || "(none)"}`);
  return real;
}

export function mediaKind(path: string): keyof typeof MEDIA_EXTENSIONS | null {
  const ext = extname(path).toLowerCase();
  for (const [kind, set] of Object.entries(MEDIA_EXTENSIONS) as [keyof typeof MEDIA_EXTENSIONS, Set<string>][]) {
    if (set.has(ext)) return kind;
  }
  return null;
}

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export type MediaProbe = {
  verified: boolean;
  fps?: number;
  frameCount?: number;
  duration?: number;
  width?: number;
  height?: number;
  source: "ffprobe" | "unverified";
};

/** Probe only actual media; never label a guessed value as verified. */
export function probeMedia(path: string): MediaProbe {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=avg_frame_rate,r_frame_rate,nb_frames,duration,width,height",
      "-of", "json", path,
    ], { encoding: "utf8", timeout: 20_000 });
    const stream = (JSON.parse(out) as { streams?: Record<string, string>[] }).streams?.[0] ?? {};
    const rate = String(stream.avg_frame_rate || stream.r_frame_rate || "");
    const [num, den] = rate.split("/").map(Number);
    const fps = Number.isFinite(num) && Number.isFinite(den) && den ? num / den : Number(rate) || undefined;
    const frameCount = Number(stream.nb_frames) || undefined;
    const duration = Number(stream.duration) || (fps && frameCount ? frameCount / fps : undefined);
    return {
      verified: Boolean(fps && (frameCount || duration)),
      ...(fps ? { fps } : {}), ...(frameCount ? { frameCount } : {}), ...(duration ? { duration } : {}),
      ...(Number(stream.width) ? { width: Number(stream.width) } : {}),
      ...(Number(stream.height) ? { height: Number(stream.height) } : {}),
      source: "ffprobe",
    };
  } catch {
    return { verified: false, source: "unverified" };
  }
}

/** Recover authoritative outputs from a succeeded History entry. */
export function historyOutputPath(historyDir: string, runId: string, file: string): string {
  const root = join(historyDir, runId);
  return resolveMediaPath(join(root, file), productionMediaRoots(historyDir.replace(/\/history$/, "")));
}
