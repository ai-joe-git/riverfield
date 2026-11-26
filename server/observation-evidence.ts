// Phase 1 evidence extraction. Deterministic, bounded and cached; this module never
// modifies the source video and never calls a model. FFprobe/FFmpeg are the only tools.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashFile, probeMedia, resolveMediaPath } from "./production-media.ts";
import type {
  Candidate, ObservationEvidence, ObservationShot, ObservationTechnical, SceneRenderBinding,
} from "./production-types.ts";

export class ObservationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type ObservationEvidenceConfig = {
  maxFrames: number;
  visualFrames: number;
  sampleIntervalSeconds: number;
  sceneThreshold: number;
  includeAudio: boolean;
};

export const DEFAULT_OBSERVATION_EVIDENCE_CONFIG: ObservationEvidenceConfig = {
  maxFrames: 12,
  visualFrames: 9,
  sampleIntervalSeconds: 2,
  sceneThreshold: 0.3,
  includeAudio: true,
};

export type ObservationEvidenceBundle = {
  cacheKey: string;
  dir: string;
  source: { path: string; hash: string; expectedHash?: string; verified: boolean };
  technical: ObservationTechnical;
  nativeBoundaries: {
    bindingId: string; segmentIndex: number; startFrame: number; endFrame: number; startSeconds: number; endSeconds: number;
  }[];
  shots: ObservationShot[];
  frames: ObservationEvidence[];
  audio: ObservationEvidence[];
  visualFrameIds: string[];
  config: ObservationEvidenceConfig;
  sourceHash: string;
};

type EvidenceManifest = Omit<ObservationEvidenceBundle, "dir"> & { complete: true; createdAt: string; schemaVersion: 1 };

const frameRate = (value: string | undefined): number => {
  const [num, den] = String(value ?? "").split("/").map(Number);
  return Number.isFinite(num) && Number.isFinite(den) && den ? num / den : Number(value) || 0;
};

function atomicWrite(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${createHash("sha1").update(`${Date.now()}:${Math.random()}`).digest("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}

function run(bin: string, args: string[], timeout = 120_000): { stdout: string; stderr: string } {
  const result = spawnSync(bin, args, {
    encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error || result.status !== 0) {
    const detail = String(result.error?.message ?? stderr ?? "unknown error");
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ObservationError("OBSERVATION_FFMPEG_MISSING", `${bin} is required for audiovisual observation`);
    }
    throw new ObservationError("OBSERVATION_MEDIA_FAILED", `${bin} failed: ${detail.trim().slice(0, 600)}`);
  }
  return { stdout, stderr };
}

function jsonProbe(path: string): { video?: Record<string, string>; audio?: Record<string, string>; format?: Record<string, string> } {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path,
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(out) as { streams?: Record<string, string>[]; format?: Record<string, string> };
    return {
      video: parsed.streams?.find((stream) => stream.codec_type === "video"),
      audio: parsed.streams?.find((stream) => stream.codec_type === "audio"),
      format: parsed.format,
    };
  } catch (error) {
    throw new ObservationError("OBSERVATION_PROBE_FAILED", `ffprobe could not read ${path}: ${(error as Error).message}`);
  }
}

/** Clamp final-output frames to what the actual file contains. */
function clampFrame(value: number, frameCount: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.trunc(value), Math.max(0, (frameCount ?? Math.round(value)) - 1)));
}

function detectCuts(path: string, startSeconds: number, duration: number, threshold: number): number[] {
  const { stderr } = run("ffmpeg", [
    "-hide_banner", "-nostdin", "-ss", startSeconds.toFixed(6), "-t", duration.toFixed(6), "-i", path,
    "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-",
  ]);
  const found = new Set<number>();
  for (const match of stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds > 0.10 && seconds < duration - 0.10) found.add(Math.round(seconds * 1000) / 1000);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Extract evidence for exactly the selected bindings of one scene. The cache key includes
 * the source hash, candidate content hash, selected binding IDs and extraction config, so a
 * retry returns the same evidence without touching FFmpeg again.
 */
export function extractObservationEvidence(input: {
  outDir: string;
  mediaRoots: string[];
  productionId: string;
  sceneId: string;
  candidate: Candidate;
  bindings: SceneRenderBinding[];
  outputPath: string;
  outputHash?: string;
  config?: Partial<ObservationEvidenceConfig>;
}): ObservationEvidenceBundle {
  const config = { ...DEFAULT_OBSERVATION_EVIDENCE_CONFIG, ...(input.config ?? {}) };
  if (!Number.isInteger(config.maxFrames) || config.maxFrames < 1 || config.maxFrames > 48) {
    throw new ObservationError("INVALID_OBSERVATION_CONFIG", "maxFrames must be between 1 and 48");
  }
  if (!Number.isInteger(config.visualFrames) || config.visualFrames < 1 || config.visualFrames > 9) {
    throw new ObservationError("INVALID_OBSERVATION_CONFIG", "visualFrames must be between 1 and 9");
  }
  if (!(config.sampleIntervalSeconds >= 0.25)) throw new ObservationError("INVALID_OBSERVATION_CONFIG", "sampleIntervalSeconds must be at least 0.25");
  if (!(config.sceneThreshold > 0 && config.sceneThreshold < 1)) throw new ObservationError("INVALID_OBSERVATION_CONFIG", "sceneThreshold must be between 0 and 1");
  if (!input.bindings.length) throw new ObservationError("OBSERVATION_NO_BINDING", "Select at least one scene binding");
  if (new Set(input.bindings.map((binding) => binding.sceneId)).size !== 1 || input.bindings[0].sceneId !== input.sceneId) {
    throw new ObservationError("OBSERVATION_BINDING_SCOPE", "Every selected binding must belong to the requested scene");
  }

  const source = resolveMediaPath(input.outputPath, input.mediaRoots);
  const sourceHash = hashFile(source);
  const expectedHash = input.outputHash || input.candidate.outputs.find((output) => output.path === source)?.hash || input.bindings.find((binding) => binding.outputHash)?.outputHash;
  if (expectedHash && sourceHash !== expectedHash) {
    throw new ObservationError("OBSERVATION_HASH_MISMATCH", "The candidate media hash does not match the immutable candidate/binding hash");
  }

  const probe = jsonProbe(source);
  const legacyProbe = probeMedia(source);
  const fps = Number(probe.video?.avg_frame_rate ? frameRate(probe.video.avg_frame_rate) : 0)
    || Number(input.bindings[0]?.fps ?? 0) || legacyProbe.fps || 24;
  const frameCount = Number(probe.video?.nb_frames) || legacyProbe.frameCount
    || (Number(probe.video?.duration) && fps ? Math.round(Number(probe.video?.duration) * fps) : undefined);
  const duration = Number(probe.format?.duration) || Number(probe.video?.duration) || legacyProbe.duration || (frameCount ? frameCount / fps : 0);
  if (!(fps > 0) || !(duration > 0)) throw new ObservationError("OBSERVATION_MEDIA_INVALID", "The selected output has no countable video timeline");

  const cacheKey = createHash("sha256").update(JSON.stringify({
    schema: 1, sceneId: input.sceneId, candidateHash: input.candidate.contentHash, sourceHash,
    bindingIds: input.bindings.map((binding) => binding.id).sort(), config,
  })).digest("hex").slice(0, 32);
  const dir = join(input.outDir, "observations", "evidence", input.productionId, input.sceneId, cacheKey);
  const manifestFile = join(dir, "manifest.json");
  if (existsSync(manifestFile)) {
    try {
      const cached = JSON.parse(readFileSync(manifestFile, "utf8")) as EvidenceManifest;
      if (cached.complete && cached.sourceHash === sourceHash) {
        return {
          ...cached,
          dir,
          frames: cached.frames.map((frame) => ({ ...frame, path: join(dir, frame.file) })),
          audio: cached.audio.map((clip) => ({ ...clip, path: join(dir, clip.file) })),
          source: { ...cached.source, path: source, verified: cached.source.verified },
        };
      }
    } catch { /* incomplete/corrupt cache: extract again */ }
  }

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "frames"), { recursive: true });
  if (config.includeAudio) mkdirSync(join(dir, "audio"), { recursive: true });

  const nativeBoundaries = input.bindings.map((binding) => {
    const start = clampFrame(binding.timelineStartFrame, frameCount);
    const end = Math.min(clampFrame(binding.timelineEndFrame, frameCount), frameCount ?? binding.timelineEndFrame);
    if (end <= start) throw new ObservationError("OBSERVATION_BINDING_INVALID", `Binding ${binding.id} is empty after clamping to the source`);
    return { bindingId: binding.id, segmentIndex: binding.segmentIndex, startFrame: start, endFrame: end, startSeconds: start / fps, endSeconds: end / fps };
  });

  const frames: ObservationEvidence[] = [];
  const shots: ObservationShot[] = [];
  const frameByTime = new Map<number, ObservationEvidence>();
  let frameNumber = 0;

  const addFrame = (timestampSeconds: number, kind: ObservationEvidence["kind"], bindingId: string, shotId?: string) => {
    const frame = Math.max(0, Math.min(Math.round(timestampSeconds * fps), Math.max(0, (frameCount ?? Math.round(timestampSeconds * fps)) - 1)));
    const key = Math.round(frame);
    if (frameByTime.has(key)) return frameByTime.get(key)!;
    const file = `frames/frame-${String(++frameNumber).padStart(4, "0")}.jpg`;
    run("ffmpeg", [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-ss", (frame / fps).toFixed(6), "-i", source, "-frames:v", "1", "-q:v", "3", join(dir, file),
    ], 60_000);
    const evidence: ObservationEvidence = {
      id: `frame-${String(frameNumber).padStart(4, "0")}`, kind, file,
      timestampSeconds: +(frame / fps).toFixed(4), frame,
      bindingId, ...(shotId ? { shotId } : {}), mime: "image/jpeg",
    };
    evidence.hash = hashFile(join(dir, file));
    frames.push(evidence);
    frameByTime.set(key, evidence);
    return evidence;
  };

  for (const boundary of nativeBoundaries) {
    const binding = input.bindings.find((item) => item.id === boundary.bindingId)!;
    const durationSeconds = boundary.endSeconds - boundary.startSeconds;
    const cuts = detectCuts(source, boundary.startSeconds, durationSeconds, config.sceneThreshold);
    const points = [0, ...cuts, boundary.endSeconds - boundary.startSeconds]
      .filter((value, index, list) => index === 0 || value > list[index - 1] + 0.05)
      .map((value) => Math.max(0, Math.min(durationSeconds, value)));
    for (let index = 0; index < points.length - 1; index += 1) {
      const startSeconds = boundary.startSeconds + points[index];
      const endSeconds = boundary.startSeconds + points[index + 1];
      if (endSeconds - startSeconds < 0.12) continue;
      const shotId = `${boundary.bindingId}-shot-${String(shots.length + 1).padStart(2, "0")}`;
      const opening = addFrame(startSeconds + 1 / fps, "opening_frame", boundary.bindingId, shotId);
      const closing = addFrame(Math.max(startSeconds, endSeconds - 1 / fps), "closing_frame", boundary.bindingId, shotId);
      const middle = addFrame((startSeconds + endSeconds) / 2, "shot_frame", boundary.bindingId, shotId);
      shots.push({
        id: shotId, bindingId: boundary.bindingId, segmentIndex: boundary.segmentIndex,
        startFrame: Math.round(startSeconds * fps), endFrame: Math.round(endSeconds * fps),
        startSeconds: +startSeconds.toFixed(4), endSeconds: +endSeconds.toFixed(4),
        detector: cuts.length ? "ffmpeg-scene" : "native-segment",
        evidenceIds: [opening.id, middle.id, closing.id],
      });
    }
  }

  // Configurable extra samples are bounded; opening/closing/shot evidence wins first.
  for (const boundary of nativeBoundaries) {
    if (frames.length >= config.maxFrames) break;
    for (let seconds = boundary.startSeconds + config.sampleIntervalSeconds; seconds < boundary.endSeconds; seconds += config.sampleIntervalSeconds) {
      if (frames.length >= config.maxFrames) break;
      addFrame(seconds, "sample_frame", boundary.bindingId);
    }
  }

  const audio: ObservationEvidence[] = [];
  if (config.includeAudio && probe.audio) {
    for (const [index, boundary] of nativeBoundaries.entries()) {
      const file = `audio/binding-${String(index + 1).padStart(2, "0")}.wav`;
      run("ffmpeg", [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-ss", boundary.startSeconds.toFixed(6), "-i", source, "-t", (boundary.endSeconds - boundary.startSeconds).toFixed(6),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", join(dir, file),
      ], 120_000);
      const evidence: ObservationEvidence = {
        id: `audio-${String(index + 1).padStart(2, "0")}`, kind: "audio", file,
        timestampSeconds: +boundary.startSeconds.toFixed(4), frame: boundary.startFrame,
        bindingId: boundary.bindingId, mime: "audio/wav",
      };
      evidence.hash = hashFile(join(dir, file));
      audio.push(evidence);
    }
  }

  // Coverage-aware selection: one representative per detected shot, then the opening of
  // the first shot and the closing of the last shot, then additional evidence. With the
  // benchmark's 7 visual slots and 5 shots this yields 5 shot frames + opening + closing.
  const selectedVisual: ObservationEvidence[] = [];
  const addVisual = (frame: ObservationEvidence | undefined) => {
    if (!frame || selectedVisual.some((item) => item.id === frame.id) || selectedVisual.length >= config.visualFrames) return;
    selectedVisual.push(frame);
  };
  const shotFrames = (shotId: string) => frames.filter((frame) => frame.shotId === shotId);
  for (const shot of shots) {
    const candidates = shotFrames(shot.id);
    addVisual(candidates.find((frame) => frame.kind === "shot_frame") ?? candidates[0]);
  }
  addVisual(frames.find((frame) => frame.kind === "opening_frame"));
  addVisual([...frames].reverse().find((frame) => frame.kind === "closing_frame"));
  for (const frame of [...frames].sort((a, b) => (a.timestampSeconds ?? 0) - (b.timestampSeconds ?? 0))) addVisual(frame);
  const visualFrameIds = selectedVisual.slice(0, config.visualFrames).map((frame) => frame.id);

  const technical: ObservationTechnical = {
    sourcePath: source, sourceHash, sourceVerified: !expectedHash || sourceHash === expectedHash,
    ...(Number(probe.video?.width) ? { width: Number(probe.video?.width) } : {}),
    ...(Number(probe.video?.height) ? { height: Number(probe.video?.height) } : {}),
    fps, ...(frameCount ? { frameCount } : {}), duration,
    ...(probe.video?.codec_name ? { videoCodec: probe.video.codec_name } : {}),
    audioStreams: probe.audio ? [{
      ...(probe.audio.codec_name ? { codec: probe.audio.codec_name } : {}),
      ...(Number(probe.audio.sample_rate) ? { sampleRate: Number(probe.audio.sample_rate) } : {}),
      ...(Number(probe.audio.channels) ? { channels: Number(probe.audio.channels) } : {}),
      ...(Number(probe.audio.duration) ? { duration: Number(probe.audio.duration) } : {}),
    }] : [],
    sceneStartFrame: Math.min(...nativeBoundaries.map((boundary) => boundary.startFrame)),
    sceneEndFrame: Math.max(...nativeBoundaries.map((boundary) => boundary.endFrame)),
    sceneStartSeconds: Math.min(...nativeBoundaries.map((boundary) => boundary.startSeconds)),
    sceneEndSeconds: Math.max(...nativeBoundaries.map((boundary) => boundary.endSeconds)),
  };

  const manifest: EvidenceManifest = {
    schemaVersion: 1, complete: true, createdAt: new Date().toISOString(), cacheKey,
    source: { path: source, hash: sourceHash, ...(expectedHash ? { expectedHash } : {}), verified: technical.sourceVerified },
    technical, nativeBoundaries, shots, frames, audio, visualFrameIds, config, sourceHash,
  };
  atomicWrite(manifestFile, manifest);
  return { ...manifest, dir, frames: frames.map((frame) => ({ ...frame, path: join(dir, frame.file) })), audio: audio.map((clip) => ({ ...clip, path: join(dir, clip.file) })) };
}
