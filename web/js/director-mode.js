// Shared mode resolution for Director controls, validation and native timeline preparation.
export function directorConditioningMode(values) {
  if (values.flex_mode === "ref2va" || values.flex_mode === "fl2va") return values.flex_mode;
  if (values.flex_mode === "auto") {
    let spec;
    try { spec = typeof values.segment_windows === "string" ? JSON.parse(values.segment_windows) : values.segment_windows; } catch {}
    if (spec?.windows?.some(w => Number.isInteger(w.first_frame) || Number.isInteger(w.last_frame))) return "fl2va";
    return Object.entries(values).some(([key, value]) => /^(image|video)\d+$/.test(key) && value) ? "ref2va" : "fl2va";
  }
  return /fl2va/i.test(String(values.unet_name ?? values.model_name ?? "")) ? "fl2va" : "ref2va";
}
