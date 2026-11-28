// Pure defaults for the existing per-scene LTX editor.
export function blankSegment(app) {
  return {
    prompt: "",
    duration: Number(app.inputs.find(i=>i.id==="duration")?.default ?? 5),
    last: null,
    lastUrl: null,
    cut: true,
    cutStart: null,
    cutStartUrl: null,
    cutStartData: null,
    approved: false,
    running: false,
    jobId: null,
    videoUrl: null,
    videoFile: null,
    lastFrameUrl: null,
    lastFrameFile: null,
    lastData: null,
    stale: false,
    error: null,
  };
}

