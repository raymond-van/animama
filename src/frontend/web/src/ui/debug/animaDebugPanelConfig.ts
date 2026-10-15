"use client";

export const DEBUG_SECTION_KEYS = [
  "avatarShader",
  "animation",
  "signals",
  "lipSync",
  "voiceVad",
  "emotion",
  "activeActions",
  "mainThreadHealth",
  "runtimeCapabilities",
  "memory",
  "workers",
  "onnxRuntime",
  "expressions",
  "manifestAnimations",
] as const;

export type DebugSectionKey = (typeof DEBUG_SECTION_KEYS)[number];

export const ANIMAMA_DEBUG_PANEL_PRODUCERS = {
  animationSnapshot: true,
  systemMetrics: false,
  voiceVad: true,
  pocketTts: true,
  // Copies each realtime reply's audio and timing while the panel is enabled.
  lipSyncCapture: true,
} as const;

export type AnimaDebugProducerKey = keyof typeof ANIMAMA_DEBUG_PANEL_PRODUCERS;

export const ANIMAMA_DEBUG_PANEL_SECTIONS = {
  avatarShader: true,
  animation: true,
  signals: true,
  lipSync: true,
  voiceVad: true,
  emotion: true,
  activeActions: true,
  mainThreadHealth: true,
  runtimeCapabilities: true,
  memory: true,
  workers: true,
  onnxRuntime: true,
  expressions: true,
  manifestAnimations: true,
} satisfies Record<DebugSectionKey, boolean>;

const SECTION_PRODUCER_BY_KEY: Partial<
  Record<DebugSectionKey, AnimaDebugProducerKey>
> = {
  animation: "animationSnapshot",
  lipSync: "lipSyncCapture",
  voiceVad: "voiceVad",
  activeActions: "animationSnapshot",
  mainThreadHealth: "systemMetrics",
  runtimeCapabilities: "systemMetrics",
  memory: "systemMetrics",
  workers: "pocketTts",
  onnxRuntime: "pocketTts",
};

export function isAnimaDebugProducerEnabled(
  key: AnimaDebugProducerKey,
): boolean {
  return ANIMAMA_DEBUG_PANEL_PRODUCERS[key];
}

export function isAnimaDebugSectionEnabled(key: DebugSectionKey): boolean {
  return ANIMAMA_DEBUG_PANEL_SECTIONS[key];
}

export function isAnimaDebugSectionAvailable(key: DebugSectionKey): boolean {
  if (!isAnimaDebugSectionEnabled(key)) return false;
  const producerKey = SECTION_PRODUCER_BY_KEY[key];
  return producerKey ? isAnimaDebugProducerEnabled(producerKey) : true;
}

export const DEFAULT_ANIMAMA_DEBUG_SECTION_OPEN_STATE = Object.fromEntries(
  DEBUG_SECTION_KEYS.map((key) => [key, false]),
) as Record<DebugSectionKey, boolean>;

export const ENABLED_ANIMAMA_DEBUG_SECTION_KEYS: DebugSectionKey[] =
  DEBUG_SECTION_KEYS.filter((key) => isAnimaDebugSectionAvailable(key));
