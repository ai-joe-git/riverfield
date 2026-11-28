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

export const H3_ENDPOINT_CAPACITY = 128; // two endpoints for each of the existing 64 windows
export const isH3Director = app => app.inputs?.some(i => i.id === "segment_count");
export const libraryImageSlot = slot => /^image[1-9]\d{0,5}$/.test(slot);

/** Only selected endpoints enter a render. The editable library keeps its original indices. */
export function compactEndpointLibrary(values, files) {
  if (directorConditioningMode({...values,...files}) !== "fl2va") return {values,files};
  let spec;
  try { spec = typeof values.segment_windows === "string" ? JSON.parse(values.segment_windows) : values.segment_windows; } catch { return {values,files}; }
  if (!Array.isArray(spec?.windows)) return {values,files};
  const selected = new Map();
  const renderFiles = Object.fromEntries(Object.entries(files).filter(([slot]) => !libraryImageSlot(slot)));
  const windows = spec.windows.map(window => {
    const out = {...window, images:[]};
    for (const key of ["first_frame","last_frame"]) {
      const index = window[key];
      if (index === undefined || index === null) continue;
      if (!Number.isSafeInteger(index) || index < 0 || !files[`image${index+1}`]) throw new Error(`Missing ${key} image in the Director library.`);
      if (!selected.has(index)) {
        if (selected.size >= H3_ENDPOINT_CAPACITY) throw new Error("Too many endpoint assignments for one Director timeline.");
        selected.set(index,selected.size);
        renderFiles[`image${selected.size}`] = files[`image${index+1}`];
      }
      out[key] = selected.get(index);
    }
    return out;
  });
  return {values:{...values,segment_windows:JSON.stringify({...spec,windows,conditioning_mode:"fl2va"})},files:renderFiles};
}

/** Virtual render slots are created only for FL2VA; Ref2VA retains its manifest capacity. */
export function endpointInput(app, slot, values) {
  const index = /^image([1-9]\d*)$/.exec(slot)?.[1];
  if (!isH3Director(app) || !index || Number(index)>H3_ENDPOINT_CAPACITY || directorConditioningMode(values)!=="fl2va") return null;
  return {id:slot,type:"image",label:`Endpoint image ${index}`,hidden:true,required:false,bind:[{node:"rfplan",field:slot}]};
}
