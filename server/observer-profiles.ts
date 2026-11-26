// Selectable observer profiles. A profile only supplies deterministic defaults to the
// existing configurable observer; custom model selection and inference controls remain
// available. No profile changes the human approval boundary.
export type ObserverProfileId = "custom" | "fast" | "detailed" | "senior" | "experimental-av";

export type ObserverProfile = {
  id: ObserverProfileId;
  label: string;
  description: string;
  experimental: boolean;
  reuseObservation: boolean;
  visualModel: string;
  comparisonModel: string;
  nativeVideo: boolean;
  nativeAudio: boolean;
  visual: boolean;
  asr: boolean;
  comparison: boolean;
  audioClaimsUnverified: boolean;
};

const FAST = "gemma4-12b-heretic-w4a8";
const DETAILED = "qwen3.8-27b-w4a8";

export const OBSERVER_PROFILES: ObserverProfile[] = [
  {
    id: "custom", label: "Custom", experimental: false, reuseObservation: false,
    description: "Use the explicit model and inference controls without a profile preset.",
    visualModel: FAST, comparisonModel: FAST, nativeVideo: false, nativeAudio: false,
    visual: true, asr: true, comparison: true, audioClaimsUnverified: false,
  },
  {
    id: "fast", label: "Fast Review", experimental: false, reuseObservation: false,
    description: "Gemma 4 12B visual + comparison, Whisper Turbo ASR and deterministic evidence alignment.",
    visualModel: FAST, comparisonModel: FAST, nativeVideo: false, nativeAudio: false,
    visual: true, asr: true, comparison: true, audioClaimsUnverified: false,
  },
  {
    id: "detailed", label: "Detailed Review", experimental: false, reuseObservation: false,
    description: "Qwen3.8 27B visual + comparison, Whisper Turbo ASR and deterministic evidence alignment.",
    visualModel: DETAILED, comparisonModel: DETAILED, nativeVideo: false, nativeAudio: false,
    visual: true, asr: true, comparison: true, audioClaimsUnverified: false,
  },
  {
    id: "senior", label: "Senior Review", experimental: false, reuseObservation: true,
    description: "Qwen3.8 27B reviews an existing observation and its relevant evidence without repeating extraction, ASR or the visual pass.",
    visualModel: DETAILED, comparisonModel: DETAILED, nativeVideo: false, nativeAudio: false,
    visual: false, asr: false, comparison: true, audioClaimsUnverified: false,
  },
  {
    id: "experimental-av", label: "Experimental Audiovisual Review", experimental: true, reuseObservation: false,
    description: "Compatible Gemma checkpoint with native scene video and audio. Audio, synchronization and voice-quality claims remain unverified model observations.",
    visualModel: FAST, comparisonModel: FAST, nativeVideo: true, nativeAudio: true,
    visual: true, asr: true, comparison: true, audioClaimsUnverified: true,
  },
];

export function observerProfile(id: string | undefined): ObserverProfile {
  const profile = OBSERVER_PROFILES.find((item) => item.id === id) ?? OBSERVER_PROFILES.find((item) => item.id === "custom")!;
  return profile;
}

export function isObserverProfileId(value: string | undefined): value is ObserverProfileId {
  return Boolean(value && OBSERVER_PROFILES.some((profile) => profile.id === value));
}

export function profileDefaults(profile: ObserverProfile) {
  return {
    visualModel: profile.visualModel, comparisonModel: profile.comparisonModel,
    nativeVideo: profile.nativeVideo, nativeAudio: profile.nativeAudio,
    visual: profile.visual, asr: profile.asr, comparison: profile.comparison,
  };
}
