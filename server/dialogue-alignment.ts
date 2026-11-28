// Deterministic dialogue alignment. This module never calls a model: it extracts
// intended utterances from the submitted production prompt, normalizes text, aligns
// tokens, and reports text, speaker, timing and audio-delivery dimensions separately.
import type { Candidate, ObservationDialogue, ObservationUtterance, SceneRenderBinding } from "./production-types.ts";

export type IntendedUtterance = {
  id: string;
  text: string;
  normalized: string;
  segment?: number;
  speakerLabel?: string;
  startSeconds?: number;
  source: "candidate-prompt" | "scene";
};

export type IntendedShot = {
  index: number;
  segment?: number;
  text: string;
  dialogueIds: string[];
};

export type IntendedBrief = {
  source: "candidate-prompt" | "scene";
  sceneBrief?: string;
  shots: IntendedShot[];
  utterances: IntendedUtterance[];
  soundscape?: string;
  music?: string;
  limitations: string[];
};

export type DialogueTextMatch = "exact" | "partial" | "mismatch";
export type DialogueSpeakerMatch = "same_label" | "different_label" | "unknown" | "not_available";
export type DialogueTimingStatus = "aligned" | "offset" | "not_available";
export type AudioDeliveryStatus = "not_observable";

export type DialogueTiming = {
  status: DialogueTimingStatus;
  intendedStartSeconds?: number;
  observedStartSeconds?: number;
  observedEndSeconds?: number;
  startDeltaSeconds?: number;
  /** ASR segments are coarse; this is not a word-level onset measurement. */
  precision: "coarse-asr-segment";
};

export type DialogueAlignmentMatch = {
  intendedId: string;
  intendedIds: string[];
  grouping: "single" | "split-asr" | "merged-asr" | "grouped";
  utteranceIds: string[];
  textMatch: DialogueTextMatch;
  normalizedIntended: string;
  normalizedObserved: string;
  missingWords: string[];
  extraWords: string[];
  repeatedWords: string[];
  hesitations: { intended: string[]; observed: string[] };
  speaker: {
    status: DialogueSpeakerMatch;
    intendedLabel?: string;
    observedLabel?: string;
    observedAttribution?: string;
  };
  timing: DialogueTiming;
  audioDelivery: AudioDeliveryStatus;
  evidenceIds: string[];
};

export type DialogueAlignment = {
  intended: IntendedUtterance[];
  transcript: {
    id: string; startSeconds: number; endSeconds: number; text: string;
    speakerLabel?: string; attribution?: string; evidenceIds: string[];
  }[];
  matches: DialogueAlignmentMatch[];
  unmatchedIntended: string[];
  unmatchedTranscript: string[];
  limitations: string[];
};

const HESITATION = /^(?:uh|um|er|erm|ah|hmm|mmm|mm|huh|eh)$/i;

/** Normalize case and punctuation while retaining words and hesitations. */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

/** Normalize dialogue while preserving word order; numeric words and % are made comparable. */
export function normalizeDialogue(text: string): string {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[’‘]/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/%/g, " percent ")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((token) => token in NUMBER_WORDS ? String(NUMBER_WORDS[token]) : token)
    .join(" ");
}

export function dialogueTokens(text: string): string[] {
  const normalized = normalizeDialogue(text);
  return normalized ? normalized.split(" ") : [];
}

function contentTokens(tokens: string[]): string[] {
  return tokens.filter((token) => !HESITATION.test(token));
}

function hesitations(tokens: string[]): string[] {
  return tokens.filter((token) => HESITATION.test(token));
}

function lcs(a: string[], b: string[]): string[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  const out: string[] = [];
  let i = a.length, j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { out.push(a[i - 1]); i -= 1; j -= 1; }
    else if (table[i - 1][j] >= table[i][j - 1]) i -= 1;
    else j -= 1;
  }
  return out.reverse();
}

function tokenDiff(a: string[], b: string[]): { missing: string[]; extra: string[] } {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  const missing: string[] = [], extra: string[] = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { i -= 1; j -= 1; }
    else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) { extra.push(b[j - 1]); j -= 1; }
    else { missing.push(a[i - 1]); i -= 1; }
  }
  return { missing: missing.reverse(), extra: extra.reverse() };
}

function repeated(tokens: string[]): string[] {
  return tokens.filter((token, index) => index > 0 && token === tokens[index - 1] && !HESITATION.test(token));
}

function textMatch(intended: string[], observed: string[]): DialogueTextMatch {
  if (intended.join(" ") === observed.join(" ")) return "exact";
  const common = lcs(intended, observed).length;
  const coverage = common / Math.max(1, Math.max(intended.length, observed.length));
  const contentIntended = contentTokens(intended);
  const contentObserved = contentTokens(observed);
  if (contentIntended.join(" ") === contentObserved.join(" ")) return "partial";
  if (coverage >= 0.5) return "partial";
  return "mismatch";
}

function parseTimestamp(value: string): number | undefined {
  const clock = /(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/.exec(value);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) + Number(`0.${clock[3] ?? "0"}`);
  const seconds = /(\d+(?:\.\d+)?)\s*(?:seconds?|s)\b/i.exec(value);
  return seconds ? Number(seconds[1]) : undefined;
}

/**
 * Extract `<d>[language] text</d>` dialogue spans and the nearest speaker/timestamp
 * that precedes each span. No natural-language interpretation is involved.
 */
export function extractIntendedUtterances(source: string | undefined, kind: "candidate-prompt" | "scene" = "candidate-prompt"): IntendedUtterance[] {
  if (!source) return [];
  const out: IntendedUtterance[] = [];
  const regex = /<d>(?:\s*\[([^\]]+)\])?\s*([\s\S]*?)<\/d>/gi;
  for (const match of source.matchAll(regex)) {
    const index = match.index ?? 0;
    const before = source.slice(0, index);
    const speakers = [...before.matchAll(/\(([A-Za-z0-9_-]+)\)/g)];
    const speakerLabel = speakers.at(-1)?.[1];
    const timestamps = [...before.matchAll(/(?:At\s+)?(\d{1,2}:\d{2}(?:\.\d{1,3})?|\d+(?:\.\d+)?\s*(?:seconds?|s))/gi)];
    const timestamp = timestamps.at(-1)?.[0];
    const text = String(match[2] ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    out.push({
      id: `intended-${String(out.length + 1).padStart(3, "0")}`,
      text,
      normalized: normalizeDialogue(text),
      ...(speakerLabel ? { speakerLabel } : {}),
      ...(timestamp ? { startSeconds: parseTimestamp(timestamp) } : {}),
      source: kind,
    });
  }
  return out;
}

export function extractIntendedBrief(source: string | undefined, kind: "candidate-prompt" | "scene" = "candidate-prompt"): IntendedBrief {
  const text = String(source ?? "");
  const utterances = extractIntendedUtterances(text, kind);
  const shots: IntendedShot[] = [];
  const shotRegex = /(?:^|\n)\s*\[Shot\s+(\d+)\]\s*([\s\S]*?)(?=\n\s*\[Shot\s+\d+\]|\n\s*overall_soundscape:|\n\s*non_diegetic_music:|$)/gi;
  for (const match of text.matchAll(shotRegex)) {
    const cleaned = String(match[2] ?? "")
      .replace(/<d>[\s\S]*?<\/d>/gi, "[dialogue]")
      .replace(/<Picture[^>]*>/gi, "<Picture>")
      .replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const dialogueIds = utterances.filter((utterance) => cleaned.includes("[dialogue]") && utterance.startSeconds === undefined).map((utterance) => utterance.id);
    shots.push({ index: Number(match[1]), text: cleaned.slice(0, 700), dialogueIds });
  }
  const soundscape = /(?:^|\n)\s*overall_soundscape\s*:\s*([\s\S]*?)(?=\n\s*non_diegetic_music\s*:|$)/i.exec(text)?.[1]?.trim();
  const music = /(?:^|\n)\s*non_diegetic_music\s*:\s*([\s\S]*)$/i.exec(text)?.[1]?.trim();
  return {
    source: kind,
    ...(text.trim() ? { sceneBrief: text.trim().slice(0, 500) } : {}),
    shots,
    utterances,
    ...(soundscape ? { soundscape: soundscape.slice(0, 900) } : {}),
    ...(music ? { music: music.slice(0, 900) } : {}),
    limitations: [
      "Intended dialogue is extracted mechanically from the submitted prompt; it is not evidence that the rendered clip contains it.",
      "Shot timing and speaker labels are parsed from prompt text and are not inferred from the rendered video.",
    ],
  };
}

export function extractCandidateBrief(candidate: Candidate, bindings: SceneRenderBinding[], sceneSummary?: string): IntendedBrief {
  const segments = (candidate.provenance?.segments ?? []).filter(segment => segment.prompt.trim() && bindings.some(binding =>
    segment.startFrame === undefined || segment.endFrame === undefined ? binding.segmentIndex === segment.index
      : segment.startFrame < binding.timelineEndFrame && segment.endFrame > binding.timelineStartFrame,
  )).sort((a, b) => a.index - b.index);
  if (!segments.length) return extractIntendedBrief(candidate.prompt || sceneSummary, candidate.prompt ? "candidate-prompt" : "scene");
  const briefs = segments.map(segment => ({ index: segment.index + 1, brief: extractIntendedBrief(segment.prompt) }));
  function soundNotes(field: "soundscape" | "music") {
    return briefs.filter(({ brief }) => brief[field]).map(({ index, brief }) => `Segment ${index}: ${brief[field]}`).join("\n");
  }
  return {
    source: "candidate-prompt",
    sceneBrief: candidate.provenance?.brief || sceneSummary,
    shots: briefs.flatMap(({ index, brief }) => {
      const prefix = `segment-${index}-`;
      return brief.shots.map(shot => ({ ...shot, segment: index, dialogueIds: shot.dialogueIds.map(id => prefix + id) }));
    }),
    utterances: briefs.flatMap(({ index, brief }) => brief.utterances.map(utterance =>
      ({ ...utterance, id: `segment-${index}-${utterance.id}`, segment: index }))),
    soundscape: soundNotes("soundscape"),
    music: soundNotes("music"),
    limitations: briefs[0].brief.limitations,
  };
}

export function alignDialogue(
  intended: IntendedUtterance[],
  transcript: ObservationDialogue | undefined,
): DialogueAlignment {
  if (transcript?.provider === "halogen-npu" && !transcript.utterances.length) {
    return {
      intended, transcript: [], matches: [], unmatchedIntended: [], unmatchedTranscript: [],
      limitations: [...transcript.limitations, "Transcript text is available for review. Missing lines, speaker and timing are unverified without aligned segments."],
    };
  }
  const utterances = transcript?.utterances ?? [];
  const intendedTokens = intended.map((item) => dialogueTokens(item.text));
  const observedTokens = utterances.map((utterance) => dialogueTokens(utterance.text));
  type Group = { i: number; n: number; j: number; m: number; score: number };
  const memo = new Map<string, { score: number; groups: Group[] }>();
  const solve = (i: number, j: number): { score: number; groups: Group[] } => {
    const key = `${i}:${j}`;
    const cached = memo.get(key);
    if (cached) return cached;
    if (i >= intended.length || j >= utterances.length) return { score: 0, groups: [] };
    let best: { score: number; groups: Group[] } = { score: 0, groups: [] };
    // Skip an unmatched intended utterance or transcript segment.
    const skipIntended = solve(i + 1, j);
    if (skipIntended.score > best.score) best = skipIntended;
    const skipObserved = solve(i, j + 1);
    if (skipObserved.score > best.score) best = skipObserved;
    for (let n = 1; i + n <= intended.length; n += 1) {
      const a = intendedTokens.slice(i, i + n).flat();
      for (let m = 1; j + m <= utterances.length; m += 1) {
        const b = observedTokens.slice(j, j + m).flat();
        const coverage = lcs(a, b).length / Math.max(1, Math.max(a.length, b.length));
        if (coverage < 0.35) continue;
        const rest = solve(i + n, j + m);
        // Favor one-to-one alignment when it is equally supported. Grouping is used
        // only when it explains a split/merged ASR segment better.
        const score = coverage * Math.min(n, m) - 0.05 * (n + m - 2) + rest.score;
        if (score > best.score + 1e-9) best = { score, groups: [{ i, n, j, m, score: coverage }, ...rest.groups] };
      }
    }
    memo.set(key, best);
    return best;
  };
  const solution = solve(0, 0);
  const usedIntended = new Set<number>();
  const usedTranscript = new Set<string>();
  const matches: DialogueAlignmentMatch[] = [];
  for (const group of solution.groups) {
    const intendedGroup = intended.slice(group.i, group.i + group.n);
    const transcriptGroup = utterances.slice(group.j, group.j + group.m);
    intendedGroup.forEach((item) => usedIntended.add(intended.indexOf(item)));
    transcriptGroup.forEach((utterance) => usedTranscript.add(utterance.id));
    const a = intendedTokens.slice(group.i, group.i + group.n).flat();
    const b = observedTokens.slice(group.j, group.j + group.m).flat();
    const difference = tokenDiff(a, b);
    const intendedLabels = [...new Set(intendedGroup.map((item) => item.speakerLabel).filter(Boolean))];
    const attribution = transcriptGroup.find((utterance) => utterance.speaker?.attribution)?.speaker?.attribution;
    const observedLabel = transcriptGroup[0]?.speaker?.label;
    const speakerStatus: DialogueSpeakerMatch = !intendedLabels.length ? "not_available"
      : attribution === "unknown" || !attribution ? "unknown"
      : intendedLabels.length === 1 && normalizeDialogue(intendedLabels[0]!) === normalizeDialogue(observedLabel ?? "") ? "same_label" : "different_label";
    const intendedStart = intendedGroup[0]?.startSeconds;
    const observedStart = transcriptGroup[0]?.startSeconds;
    const observedEnd = transcriptGroup.at(-1)?.endSeconds;
    const timing: DialogueTiming = {
      status: intendedStart === undefined || observedStart === undefined ? "not_available" : Math.abs(observedStart - intendedStart) <= 2 ? "aligned" : "offset",
      ...(intendedStart !== undefined ? { intendedStartSeconds: intendedStart } : {}),
      ...(observedStart !== undefined ? { observedStartSeconds: observedStart } : {}),
      ...(observedEnd !== undefined ? { observedEndSeconds: observedEnd } : {}),
      ...(intendedStart !== undefined && observedStart !== undefined ? { startDeltaSeconds: +(observedStart - intendedStart).toFixed(3) } : {}),
      precision: "coarse-asr-segment",
    };
    const grouping = group.n === 1 && group.m === 1 ? "single" : group.n === 1 ? "split-asr" : group.m === 1 ? "merged-asr" : "grouped";
    matches.push({
      intendedId: intendedGroup[0]!.id, intendedIds: intendedGroup.map((item) => item.id), grouping,
      utteranceIds: transcriptGroup.map((utterance) => utterance.id),
      textMatch: textMatch(a, b),
      normalizedIntended: normalizeDialogue(intendedGroup.map((item) => item.text).join(" ")),
      normalizedObserved: normalizeDialogue(transcriptGroup.map((utterance) => utterance.text).join(" ")),
      missingWords: difference.missing, extraWords: difference.extra,
      repeatedWords: [...new Set([...repeated(a), ...repeated(b)])],
      hesitations: { intended: [...new Set(hesitations(a))], observed: [...new Set(hesitations(b))] },
      speaker: {
        status: speakerStatus, ...(intendedLabels.length ? { intendedLabel: intendedLabels.join(", ") } : {}),
        ...(observedLabel ? { observedLabel } : {}), ...(attribution ? { observedAttribution: attribution } : {}),
      },
      timing, audioDelivery: "not_observable", evidenceIds: [...new Set(transcriptGroup.flatMap((utterance) => utterance.evidenceIds ?? []))],
    });
  }
  return {
    intended,
    transcript: utterances.map((utterance) => ({
      id: utterance.id, startSeconds: utterance.startSeconds, endSeconds: utterance.endSeconds,
      text: utterance.text, ...(utterance.speaker?.label ? { speakerLabel: utterance.speaker.label } : {}),
      ...(utterance.speaker?.attribution ? { attribution: utterance.speaker.attribution } : {}),
      evidenceIds: utterance.evidenceIds ?? [],
    })),
    matches,
    unmatchedIntended: intended.filter((item, index) => !usedIntended.has(index)).map((item) => item.id),
    unmatchedTranscript: utterances.filter((utterance) => !usedTranscript.has(utterance.id)).map((utterance) => utterance.id),
    limitations: [
      "Punctuation and capitalization are normalized; text matching is deterministic.",
      "Speaker attribution is reported separately from text matching; Whisper has no diarization here.",
      "Timing is coarse ASR-segment metadata, not verified dialogue onset or lip synchronization.",
      "Audio delivery (prosody, voice quality, acting) is marked not_observable because Whisper Turbo does not measure it.",
      "Missing/extra words are computed by longest common subsequence; no semantic rewriting or repair is performed.",
    ],
  };
}

export function dialogueAlignmentMarkdown(alignment: DialogueAlignment): string {
  const lines = ["# Deterministic dialogue alignment", ""];
  for (const match of alignment.matches) {
    lines.push(`- ${match.intendedId}: ${match.textMatch}; speaker ${match.speaker.status}; timing ${match.timing.status}; audio delivery ${match.audioDelivery}`);
    if (match.missingWords.length) lines.push(`  missing: ${match.missingWords.join(" ")}`);
    if (match.extraWords.length) lines.push(`  extra: ${match.extraWords.join(" ")}`);
    if (match.repeatedWords.length) lines.push(`  repeated: ${match.repeatedWords.join(" ")}`);
  }
  if (alignment.unmatchedIntended.length) lines.push(`Unmatched intended: ${alignment.unmatchedIntended.join(", ")}`);
  if (alignment.unmatchedTranscript.length) lines.push(`Unmatched transcript: ${alignment.unmatchedTranscript.join(", ")}`);
  return lines.join("\n");
}
