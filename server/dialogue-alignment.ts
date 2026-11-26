// Deterministic dialogue alignment. This module never calls a model: it extracts
// intended utterances from the submitted production prompt, normalizes text, aligns
// tokens, and reports text, speaker, timing and audio-delivery dimensions separately.
import type { ObservationDialogue, ObservationUtterance } from "./production-types.ts";

export type IntendedUtterance = {
  id: string;
  text: string;
  normalized: string;
  speakerLabel?: string;
  startSeconds?: number;
  source: "candidate-prompt" | "scene";
};

export type IntendedShot = {
  index: number;
  text: string;
  dialogueIds: string[];
};

export type IntendedBrief = {
  source: "candidate-prompt" | "scene";
  sceneBrief?: string;
  shots: IntendedShot[];
  utterances: IntendedUtterance[];
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
  overlapSeconds?: number;
};

export type DialogueAlignmentMatch = {
  intendedId: string;
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
export function normalizeDialogue(text: string): string {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[’‘]/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
  const shotRegex = /\[Shot\s+(\d+)\]\s*([\s\S]*?)(?=\n\s*\[Shot\s+\d+\]|\n\s*overall_soundscape:|\n\s*non_diegetic_music:|$)/gi;
  for (const match of text.matchAll(shotRegex)) {
    const cleaned = String(match[2] ?? "")
      .replace(/<d>[\s\S]*?<\/d>/gi, "[dialogue]")
      .replace(/<Picture[^>]*>/gi, "<Picture>")
      .replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const dialogueIds = utterances.filter((utterance) => cleaned.includes("[dialogue]") && utterance.startSeconds === undefined).map((utterance) => utterance.id);
    shots.push({ index: Number(match[1]), text: cleaned.slice(0, 700), dialogueIds });
  }
  return {
    source: kind,
    ...(text.trim() ? { sceneBrief: text.trim().slice(0, 500) } : {}),
    shots,
    utterances,
    limitations: [
      "Intended dialogue is extracted mechanically from the submitted prompt; it is not evidence that the rendered clip contains it.",
      "Shot timing and speaker labels are parsed from prompt text and are not inferred from the rendered video.",
    ],
  };
}

export function alignDialogue(
  intended: IntendedUtterance[],
  transcript: ObservationDialogue | undefined,
): DialogueAlignment {
  const utterances = transcript?.utterances ?? [];
  const observed = utterances.map((utterance: ObservationUtterance) => ({
    id: utterance.id,
    utterance,
    tokens: dialogueTokens(utterance.text),
  }));
  const matches: DialogueAlignmentMatch[] = [];
  const usedTranscript = new Set<string>();
  for (const item of intended) {
    const intendedTokens = dialogueTokens(item.text);
    let best: { utterance: ObservationUtterance; tokens: string[]; score: number } | undefined;
    for (const candidate of observed) {
      const score = intendedTokens.length && candidate.tokens.length
        ? lcs(intendedTokens, candidate.tokens).length / Math.max(intendedTokens.length, candidate.tokens.length) : 0;
      if (!best || score > best.score) best = { utterance: candidate.utterance, tokens: candidate.tokens, score };
    }
    if (!best) {
      matches.push({
        intendedId: item.id, utteranceIds: [], textMatch: "mismatch",
        normalizedIntended: item.normalized, normalizedObserved: "",
        missingWords: intendedTokens, extraWords: [], repeatedWords: repeated(intendedTokens),
        hesitations: { intended: hesitations(intendedTokens), observed: [] },
        speaker: { status: "not_available", ...(item.speakerLabel ? { intendedLabel: item.speakerLabel } : {}) },
        timing: { status: "not_available", ...(item.startSeconds !== undefined ? { intendedStartSeconds: item.startSeconds } : {}) },
        audioDelivery: "not_observable", evidenceIds: [],
      });
      continue;
    }
    usedTranscript.add(best.utterance.id);
    const observedTokens = best.tokens;
    const difference = tokenDiff(intendedTokens, observedTokens);
    const intendedOnly = difference.missing;
    const observedOnly = difference.extra;
    const intendedLabel = item.speakerLabel;
    const observedLabel = best.utterance.speaker?.label;
    const attribution = best.utterance.speaker?.attribution;
    const speakerStatus: DialogueSpeakerMatch = !intendedLabel ? "not_available"
      : attribution === "unknown" || !attribution ? "unknown"
      : normalizeDialogue(intendedLabel) === normalizeDialogue(observedLabel ?? "") ? "same_label" : "different_label";
    let timing: DialogueTiming = {
      status: "not_available",
      ...(item.startSeconds !== undefined ? { intendedStartSeconds: item.startSeconds } : {}),
      observedStartSeconds: best.utterance.startSeconds,
      observedEndSeconds: best.utterance.endSeconds,
    };
    if (item.startSeconds !== undefined) {
      const delta = best.utterance.startSeconds - item.startSeconds;
      const overlap = Math.max(0, Math.min(best.utterance.endSeconds, item.startSeconds + 4) - Math.max(best.utterance.startSeconds, item.startSeconds));
      timing = { ...timing, status: Math.abs(delta) <= 2 ? "aligned" : "offset", startDeltaSeconds: +delta.toFixed(3), overlapSeconds: +overlap.toFixed(3) };
    }
    matches.push({
      intendedId: item.id,
      utteranceIds: [best.utterance.id],
      textMatch: textMatch(intendedTokens, best.tokens),
      normalizedIntended: item.normalized,
      normalizedObserved: normalizeDialogue(best.utterance.text),
      missingWords: intendedOnly,
      extraWords: observedOnly,
      repeatedWords: [...new Set([...repeated(intendedTokens), ...repeated(observedTokens)])],
      hesitations: { intended: [...new Set(hesitations(intendedTokens))], observed: [...new Set(hesitations(observedTokens))] },
      speaker: {
        status: speakerStatus,
        ...(intendedLabel ? { intendedLabel } : {}),
        ...(observedLabel ? { observedLabel } : {}),
        ...(attribution ? { observedAttribution: attribution } : {}),
      },
      timing,
      audioDelivery: "not_observable",
      evidenceIds: best.utterance.evidenceIds ?? [],
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
    unmatchedIntended: intended.filter((item) => !matches.some((match) => match.intendedId === item.id && match.utteranceIds.length)).map((item) => item.id),
    unmatchedTranscript: utterances.filter((utterance) => !usedTranscript.has(utterance.id)).map((utterance) => utterance.id),
    limitations: [
      "Punctuation and capitalization are normalized; text matching is deterministic.",
      "Speaker attribution is reported separately from text matching; Whisper has no diarization here.",
      "Timing is reported separately from text matching; ASR segment boundaries are not word-level alignment.",
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
