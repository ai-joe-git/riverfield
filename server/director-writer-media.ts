// @ts-ignore Shared browser/server mode resolver.
import { directorConditioningMode } from "../web/js/director-mode.js";
import { InputError } from "./input-error.ts";
import { isFileValue, type Values } from "./runner.ts";
import { writerHash, type WriterReference } from "./workspace-writer.ts";

export function directorWriterMedia(values: Values, window?: { images?: number[]; audios?: number[]; first_frame?: number; last_frame?: number }, assetIds: Record<string, string> = {}) {
  const media: Values = {};
  const references: WriterReference[] = [];
  const descriptions: string[] = [];
  const slotName = (kind: string, index: number) => kind + (index + 1);
  function assign(kind: "image" | "audio", slots: string[]) {
    if (new Set(slots).size !== slots.length) throw new InputError(`Duplicate ${kind} assignments in one Director segment.`);
    for (const [index, slot] of slots.entries()) {
      const file = values[slot];
      if (!isFileValue(file)) throw new InputError(`Director segment refers to missing ${slot}.`);
      if (kind === "image") media[slotName(kind, index)] = file;
      const assetId = assetIds[slot];
      references.push({ slot, ...(assetId ? { assetId } : {}), sha256: writerHash(file.bytes), kind });
      const label = assetId || file.name;
      descriptions.push(kind === "audio" && values.audio_mode === "locked"
        ? `Locked soundtrack (no Audio label): ${label}`
        : `<${kind === "image" ? "Picture" : "Audio"} ${index + 1}> = ${label}`);
    }
  }
  const imageSlots = Array.from({ length: 9 }, (_, i) => slotName("image", i)).filter(slot => values[slot] !== undefined);
  const audioSlots = Array.from({ length: 3 }, (_, i) => slotName("audio", i)).filter(slot => values[slot] !== undefined);
  const segmentFrames = window && directorConditioningMode(values) === "fl2va"
    ? (["first_frame", "last_frame"] as const).filter(key => Number.isInteger(window[key])) : [];
  const frames: string[] = segmentFrames.length ? [...segmentFrames]
    : (["first_frame", "image", "last_frame"] as const).filter(slot => isFileValue(values[slot]));
  if (frames.length && !window && imageSlots.length) throw new InputError("Explicit keyframes and a Picture bin cannot be combined for this writer.");
  if (frames.includes("first_frame") && frames.includes("image")) throw new InputError("Two assets are assigned to the first keyframe.");
  // Native Material Planner compacts the selected window's list, including an empty list.
  if (window && directorConditioningMode(values) === "fl2va") {
    // Endpoints are supplied to the installed I2VA/L2VA/FL2VA writer in first/last order.
    // The same file may deliberately anchor both endpoints.
    for (const [index, key] of segmentFrames.entries()) {
      const slot = slotName("image", window[key]!);
      const file = values[slot];
      if (!isFileValue(file)) throw new InputError(`Director ${key} refers to missing ${slot}.`);
      media[slotName("image", index)] = file;
      references.push({slot, ...(assetIds[slot] ? {assetId:assetIds[slot]} : {}), sha256:writerHash(file.bytes), kind:"image"});
      descriptions.push(`<Picture ${index+1}> = ${key === "first_frame" ? "First" : "Last"} frame: ${assetIds[slot] || file.name}`);
    }
  } else assign("image", frames.length ? frames : window ? (window.images ?? []).map(index => slotName("image", index)) : imageSlots);
  assign("audio", window ? ((window.audios ?? []).map(index => slotName("audio", index))) : audioSlots);
  for (const slot of ["video1", "video2", "video3"]) if (values[slot] !== undefined) media[slot] = values[slot];
  return { media, references, descriptions, pictures: references.filter(ref => ref.kind === "image").length,
    audios: references.filter(ref => ref.kind === "audio").length, frames };
}
