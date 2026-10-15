"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";

import {
  normalizeManifestGestureId,
  normalizeLoopType,
  type ManifestAnimation,
  type ManifestAnimationInventoryItem,
} from "@/lib/avatar/animationManifest";
import {
  buildAvatarExpressionDraftKey,
  clampAvatarExpressionValue,
  formatAvatarExpressionValue,
  readAvailableAvatarExpressions,
  readAvatarExpressionOverrideValue,
  readAvatarExpressionValue,
} from "@/lib/avatar/expressionUtils";
import {
  EMOTION_EXPRESSION_INTENSITIES,
  EMOTION_INTENSITY_MAP,
  type EmotionExpressionComposition,
} from "@/lib/avatar/emotionExpressionPresets";
import {
  EMOTION_GROUPS,
  EMOTION_GROUP_MEMBERS,
  EMOTION_MAX_VALUE,
  EMOTION_MIN_VALUE,
  TRACKED_EMOTIONS,
  formatEmotionGroupLabel,
  formatTrackedEmotionLabel,
  normalizeEmotionStateMap,
  type EmotionStateMap,
} from "@/lib/emotion";
import { usePocketTtsRuntime } from "@/hooks/use-pocket-tts-runtime";
import { cn } from "@/lib/utils";
import { useUpdateAnimaEmotionalState } from "@/query/mutations/useUpdateAnimaEmotionalState";
import { Button } from "@/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/components/card";
import {
  DEBUG_SECTION_KEYS,
  DEFAULT_ANIMAMA_DEBUG_SECTION_OPEN_STATE,
  ENABLED_ANIMAMA_DEBUG_SECTION_KEYS,
  isAnimaDebugProducerEnabled,
  isAnimaDebugSectionAvailable,
  type DebugSectionKey,
} from "@/ui/debug/animaDebugPanelConfig";
import {
  useDebugMainThreadHealthMetrics,
  useDebugMemoryMetrics,
  useDebugRuntimeCapabilities,
} from "@/ui/debug/useDebugSystemMetrics";
import { useAvatarLipSyncBridgeStore } from "@/stores/avatar-lipsync-bridge-store";
import { LipSyncDebugSection } from "@/ui/debug/LipSyncDebugSection";
import { AvatarShaderDebugSection } from "@/ui/debug/AvatarShaderDebugSection";
import { useAvatarRuntimeStore } from "@/stores/avatar-runtime-store";
import {
  useAnimaAnimationDebugStore,
  type AnimaAnimationActionDebug,
} from "@/stores/anima-animation-debug-store";
import {
  useVoiceVadDebugStore,
  type SmartTurnDebugAudio,
  type SmartTurnEventDebug,
  type SmartTurnLatestDecisionDebug,
  type VadDebugEvent,
  type VadDebugStatus,
  type VadFrameDebug,
  type VadGateDecisionDebug,
} from "@/stores/voice-vad-debug-store";

type AnimaDebugPanelProps = {
  className?: string;
};

type DebugRowProps = {
  label: string;
  value: ReactNode;
  title?: string;
  mono?: boolean;
};

type ActionWeightTrend = "increasing" | "decreasing" | "stable";

const ACTION_WEIGHT_TREND_EPS = 0.005;
const EMPTY_ACTIVE_ACTIONS: AnimaAnimationActionDebug[] = [];
const EMPTY_PLANNER_EVENTS: ReturnType<
  typeof useAvatarRuntimeStore.getState
>["plannerEvents"] = [];
const EMPTY_EXPRESSION_NAMES: string[] = [];
const EMPTY_VAD_EVENTS: VadDebugEvent[] = [];
const EMPTY_VAD_GATE_DECISIONS: VadGateDecisionDebug[] = [];
const EMPTY_SMART_TURN_EVENTS: SmartTurnEventDebug[] = [];
const EMPTY_VAD_STATUS: VadDebugStatus = "idle";
const EMPTY_VAD_FRAME: VadFrameDebug | null = null;
const EMPTY_SMART_TURN_DECISION: SmartTurnLatestDecisionDebug | null = null;
const EMPTY_INTERACTION_PHASE =
  useAvatarRuntimeStore.getState().interactionPhase;
const EMPTY_EMOTIONAL_STATE = useAvatarRuntimeStore.getState().emotionalState;
type EmotionPresetLabel = keyof typeof EMOTION_INTENSITY_MAP;
const EMOTION_PRESET_LABELS = Object.keys(
  EMOTION_INTENSITY_MAP,
) as EmotionPresetLabel[];

function DebugRow({ label, value, title, mono = false }: DebugRowProps) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-foreground min-w-0 text-right",
          mono ? "text-2xs font-mono" : "",
        )}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

function Section({
  title,
  children,
  isOpen,
  onToggle,
  disabled = false,
}: {
  title: string;
  children: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  if (disabled) return null;

  return (
    <section className="border-border/60 space-y-2 border-t pt-2">
      <button
        type="button"
        onClick={onToggle}
        className="text-muted-foreground hover:bg-muted/40 text-2xs flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left font-semibold tracking-wide uppercase transition"
        aria-expanded={isOpen}
      >
        <span className="truncate">{title}</span>
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
      </button>
      {isOpen ? <div className="space-y-1.5">{children}</div> : null}
    </section>
  );
}

function formatSeconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}s`;
}

function formatDuration(value: number | null | undefined): string {
  if (typeof value !== "number") return "-";
  if (!Number.isFinite(value) || value < 0) return "∞";
  return `${value.toFixed(1)}s`;
}

function formatMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${Math.round(value)}ms`;
}

function formatMsPrecise(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}ms`;
}

function formatNumber(value: number | null | undefined, digits = 1): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let unitIndex = 0;
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024;
    unitIndex += 1;
  }
  const digits = next >= 100 ? 0 : next >= 10 ? 1 : 2;
  return `${next.toFixed(digits)} ${units[unitIndex]}`;
}

function formatBytesDelta(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${prefix}${formatBytes(Math.abs(value))}`;
}

function formatEmotionPresetLabel(label: EmotionPresetLabel): string {
  return label
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function areEmotionStateMapsEqual(
  left: EmotionStateMap,
  right: EmotionStateMap,
): boolean {
  return TRACKED_EMOTIONS.every((emotion) => left[emotion] === right[emotion]);
}

function formatEmotionPresetComposition(
  composition: EmotionExpressionComposition,
): string {
  return Object.entries(composition)
    .map(([name, value]) => `${name}: ${formatAvatarExpressionValue(value)}`)
    .join(", ");
}

function formatLatencySummary(args: {
  lastMs?: number | null;
  avgMs?: number | null;
  p95Ms?: number | null;
}): string {
  const last = formatMsPrecise(args.lastMs);
  const avg = formatMsPrecise(args.avgMs);
  const p95 = formatMsPrecise(args.p95Ms);
  return `${last} / ${avg} / ${p95}`;
}

function formatBool(value: boolean): string {
  return value ? "true" : "false";
}

function formatPlayhead(args: {
  playheadSec?: number | null;
  clipDurationSec?: number | null;
}): string {
  const left = formatSeconds(args.playheadSec);
  const right = formatDuration(args.clipDurationSec);
  return `${left} / ${right}`;
}

function formatMaybeText(value: string | null | undefined): string {
  if (!value) return "-";
  const trimmed = value.trim();
  return trimmed || "-";
}

function truncateMiddle(value: string, max = 40): string {
  if (value.length <= max) return value;
  const head = Math.max(8, Math.floor((max - 1) / 2));
  const tail = Math.max(8, max - head - 1);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function getActionWeightTrend(
  previousWeight: number | undefined,
  nextWeight: number,
): ActionWeightTrend {
  if (typeof previousWeight !== "number" || !Number.isFinite(previousWeight)) {
    return "stable";
  }
  const delta = nextWeight - previousWeight;
  if (delta > ACTION_WEIGHT_TREND_EPS) return "increasing";
  if (delta < -ACTION_WEIGHT_TREND_EPS) return "decreasing";
  return "stable";
}

function clampManifestAnimationWeight(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function getManifestAnimationDefaultWeight(
  entry: ManifestAnimationInventoryItem,
): number {
  return clampManifestAnimationWeight(
    typeof entry.weight === "number" ? entry.weight : 1,
  );
}

function getManifestAnimationRowKey(
  entry: ManifestAnimationInventoryItem,
): string {
  return `${entry.source}:${entry.file}:${entry.name}`;
}

/** Build the debugger inventory from the active Avatar rather than globals. */
function buildActiveMotionInventory(
  entries: readonly ManifestAnimation[],
): ManifestAnimationInventoryItem[] {
  return entries
    .map(
      (entry) =>
        ({
          ...entry,
          source: entry.animation_type === "idle" ? "idle" : "gesture",
          disabled: entry.disabled === true,
        }) satisfies ManifestAnimationInventoryItem,
    )
    .sort((left, right) => {
      const leftLabel = (left.name || left.file).toLocaleLowerCase();
      const rightLabel = (right.name || right.file).toLocaleLowerCase();
      return leftLabel.localeCompare(rightLabel);
    });
}

function getManifestAnimationRuntimeId(
  entry: ManifestAnimationInventoryItem,
): string {
  return normalizeManifestGestureId(entry.id ?? entry.file);
}

function hasPlayableSmartTurnAudio(
  audio: SmartTurnDebugAudio | null | undefined,
): audio is SmartTurnDebugAudio {
  return Boolean(audio && audio.samples.length > 0);
}

function getSmartTurnAudioDurationSec(
  audio: SmartTurnDebugAudio | null | undefined,
): number | null {
  if (!audio || audio.samples.length <= 0) return null;
  const sampleRateHz =
    Number.isFinite(audio.sampleRateHz) && audio.sampleRateHz > 0
      ? audio.sampleRateHz
      : 16000;
  return audio.samples.length / sampleRateHz;
}

function toAnimationBlendMode(
  value: string | null | undefined,
): "normal" | "additive" {
  return value === "additive" ? "additive" : "normal";
}

export function AnimaDebugPanel({ className }: AnimaDebugPanelProps) {
  const isOpen = useAnimaAnimationDebugStore((state) => state.isOpen);
  if (!isOpen) return null;
  return <AnimaDebugPanelContent className={className} />;
}

function AnimaDebugPanelContent({ className }: AnimaDebugPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const setDebugPanelOpen = useAnimaAnimationDebugStore(
    (state) => state.setOpen,
  );
  const [sectionOpen, setSectionOpen] = useState<
    Record<DebugSectionKey, boolean>
  >(DEFAULT_ANIMAMA_DEBUG_SECTION_OPEN_STATE);
  const [allEmotionsOpen, setAllEmotionsOpen] = useState(false);
  const [emotionDraftValues, setEmotionDraftValues] = useState<EmotionStateMap>(
    () => normalizeEmotionStateMap(null),
  );
  const [emotionDraftBaseline, setEmotionDraftBaseline] =
    useState<EmotionStateMap>(() => normalizeEmotionStateMap(null));
  const [emotionDraftAnimaId, setEmotionDraftAnimaId] = useState<string | null>(
    null,
  );
  const animationSectionEnabled = isAnimaDebugSectionAvailable("animation");
  const signalsSectionEnabled = isAnimaDebugSectionAvailable("signals");
  const voiceVadSectionEnabled = isAnimaDebugSectionAvailable("voiceVad");
  const lipSyncSectionEnabled = isAnimaDebugSectionAvailable("lipSync");
  const emotionSectionEnabled = isAnimaDebugSectionAvailable("emotion");
  const activeActionsSectionEnabled =
    isAnimaDebugSectionAvailable("activeActions");
  const mainThreadHealthSectionEnabled =
    isAnimaDebugSectionAvailable("mainThreadHealth");
  const runtimeCapabilitiesSectionEnabled = isAnimaDebugSectionAvailable(
    "runtimeCapabilities",
  );
  const memorySectionEnabled = isAnimaDebugSectionAvailable("memory");
  const workersSectionEnabled = isAnimaDebugSectionAvailable("workers");
  const onnxRuntimeSectionEnabled = isAnimaDebugSectionAvailable("onnxRuntime");
  const expressionsSectionEnabled = isAnimaDebugSectionAvailable("expressions");
  const manifestAnimationsSectionEnabled =
    isAnimaDebugSectionAvailable("manifestAnimations");
  const animationSectionOpen = animationSectionEnabled && sectionOpen.animation;
  const activeActionsSectionOpen =
    activeActionsSectionEnabled && sectionOpen.activeActions;
  const mainThreadHealthSectionOpen =
    mainThreadHealthSectionEnabled && sectionOpen.mainThreadHealth;
  const runtimeCapabilitiesSectionOpen =
    runtimeCapabilitiesSectionEnabled && sectionOpen.runtimeCapabilities;
  const memorySectionOpen = memorySectionEnabled && sectionOpen.memory;
  const animationSnapshotProducerEnabled =
    isAnimaDebugProducerEnabled("animationSnapshot");
  const systemMetricsProducerEnabled =
    isAnimaDebugProducerEnabled("systemMetrics");
  const animationSnapshotConsumerEnabled =
    animationSnapshotProducerEnabled &&
    (animationSectionOpen || activeActionsSectionOpen);
  const mainThreadHealthMetricsEnabled =
    systemMetricsProducerEnabled && mainThreadHealthSectionOpen;
  const runtimeCapabilitiesMetricsEnabled =
    systemMetricsProducerEnabled && runtimeCapabilitiesSectionOpen;
  const memoryMetricsEnabled =
    systemMetricsProducerEnabled && memorySectionOpen;
  const pocketTtsDebugEnabled =
    isAnimaDebugProducerEnabled("pocketTts") &&
    (workersSectionEnabled || onnxRuntimeSectionEnabled);
  const setAnimationSnapshotDemand = useAnimaAnimationDebugStore(
    (state) => state.setAnimationSnapshotDemand,
  );

  useEffect(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest('[aria-label="Toggle anima debug panel"]')
      ) {
        return;
      }
      setDebugPanelOpen(false);
    };

    document.addEventListener("click", handleDocumentClick);
    return () => {
      document.removeEventListener("click", handleDocumentClick);
    };
  }, [setDebugPanelOpen]);

  useEffect(() => {
    setAnimationSnapshotDemand(animationSnapshotConsumerEnabled);
    return () => {
      setAnimationSnapshotDemand(false);
    };
  }, [animationSnapshotConsumerEnabled, setAnimationSnapshotDemand]);

  const mainThreadHealth = useDebugMainThreadHealthMetrics(
    mainThreadHealthMetricsEnabled,
  );
  const memory = useDebugMemoryMetrics(memoryMetricsEnabled);
  const runtimeCapabilities = useDebugRuntimeCapabilities(
    runtimeCapabilitiesMetricsEnabled,
  );
  const previousSnapshot = useAnimaAnimationDebugStore((state) =>
    animationSnapshotConsumerEnabled && activeActionsSectionOpen
      ? state.previousSnapshot
      : null,
  );
  const snapshot = useAnimaAnimationDebugStore((state) =>
    animationSnapshotConsumerEnabled ? state.snapshot : null,
  );
  const avatar = useAvatarLipSyncBridgeStore((state) =>
    expressionsSectionEnabled || manifestAnimationsSectionEnabled
      ? state.avatar
      : null,
  );
  const avatarAnimaId = useAvatarLipSyncBridgeStore((state) =>
    expressionsSectionEnabled ? state.avatarAnimaId : null,
  );
  const runtimeAnimaId = useAvatarRuntimeStore((state) =>
    signalsSectionEnabled || expressionsSectionEnabled || emotionSectionEnabled
      ? state.animaId
      : null,
  );
  const runtimeActiveRunId = useAvatarRuntimeStore((state) =>
    signalsSectionEnabled ? state.activeRunId : null,
  );
  const runtimeActiveSpeechRunId = useAvatarRuntimeStore((state) =>
    signalsSectionEnabled ? state.activeSpeechRunId : null,
  );
  const runtimeInteractionPhase = useAvatarRuntimeStore((state) =>
    signalsSectionEnabled ? state.interactionPhase : EMPTY_INTERACTION_PHASE,
  );
  const runtimePlannerEvents = useAvatarRuntimeStore((state) =>
    signalsSectionEnabled ? state.plannerEvents : EMPTY_PLANNER_EVENTS,
  );
  const runtimeEmotionalState = useAvatarRuntimeStore((state) =>
    emotionSectionEnabled ? state.emotionalState : EMPTY_EMOTIONAL_STATE,
  );
  const setAnimaEmotionSnapshot = useAvatarRuntimeStore(
    (state) => state.setAnimaEmotionSnapshot,
  );
  const vadDebugStatus = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.status : EMPTY_VAD_STATUS,
  );
  const vadDebugError = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.error : null,
  );
  const vadDebugProvider = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.provider : null,
  );
  const vadDebugTurnId = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.turnId : null,
  );
  const vadDebugWindowId = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.windowId : null,
  );
  const vadDebugWindowIsRealSpeech = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.windowIsRealSpeech : false,
  );
  const vadDebugCommittedChars = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.committedChars : 0,
  );
  const vadDebugTentativeChars = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.tentativeChars : 0,
  );
  const vadDebugRollingAudioSamples = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.rollingAudioSamples : 0,
  );
  const vadDebugLatestFrame = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.latestFrame : EMPTY_VAD_FRAME,
  );
  const vadDebugEvents = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.events : EMPTY_VAD_EVENTS,
  );
  const vadDebugGateDecisions = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.gateDecisions : EMPTY_VAD_GATE_DECISIONS,
  );
  const smartTurnEnabled = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.smartTurnEnabled : false,
  );
  const smartTurnStatus = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.smartTurnStatus : "idle",
  );
  const smartTurnError = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.smartTurnError : null,
  );
  const smartTurnActiveJobId = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.smartTurnActiveJobId : null,
  );
  const smartTurnBufferedSamples = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.smartTurnBufferedSamples : 0,
  );
  const smartTurnBufferedAudio = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.smartTurnBufferedAudio : null,
  );
  const smartTurnSupersededJobs = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.smartTurnSupersededJobs : 0,
  );
  const smartTurnLatestDecision = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled
      ? state.smartTurnLatestDecision
      : EMPTY_SMART_TURN_DECISION,
  );
  const smartTurnEvents = useVoiceVadDebugStore((state) =>
    voiceVadSectionEnabled ? state.smartTurnEvents : EMPTY_SMART_TURN_EVENTS,
  );
  const pocketTts = usePocketTtsRuntime(pocketTtsDebugEnabled);
  const updateAnimaEmotionalState = useUpdateAnimaEmotionalState();

  const runtime = {
    animaId: runtimeAnimaId,
    activeRunId: runtimeActiveRunId,
    activeSpeechRunId: runtimeActiveSpeechRunId,
    interactionPhase: runtimeInteractionPhase,
    plannerEvents: runtimePlannerEvents,
    emotionalState: runtimeEmotionalState,
  };
  const vadAudioDurationSec = vadDebugRollingAudioSamples / 16000;
  const smartTurnBufferedDurationSec = smartTurnBufferedSamples / 16000;
  const recentVadEvents = vadDebugEvents.slice(0, 8);
  const recentVadGateDecisions = vadDebugGateDecisions.slice(0, 8);
  const recentSmartTurnEvents = smartTurnEvents.slice(0, 8);
  const pocketTtsWorkerRegistry = pocketTts.workerRegistryDebug;
  const pocketTtsWorkers = pocketTtsWorkerRegistry.workers;
  const pocketTtsOrtRuntime =
    pocketTts.onnxRuntimeDebug.find(
      (runtime) => runtime.runtimeId === "pocket-tts",
    ) ??
    pocketTts.onnxRuntimeDebug[0] ??
    null;
  const pocketTtsOrtSessions = [...(pocketTtsOrtRuntime?.sessions ?? [])].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const [applyingAnimationFile, setApplyingAnimationFile] = useState<
    string | null
  >(null);
  const [manifestAnimationWeights, setManifestAnimationWeights] = useState<
    Record<string, number>
  >({});
  const [activeSmartTurnPlaybackKey, setActiveSmartTurnPlaybackKey] = useState<
    string | null
  >(null);
  const [expressionDraftValues, setExpressionDraftValues] = useState<
    Record<string, number>
  >({});
  const smartTurnPlaybackAudioContextRef = useRef<AudioContext | null>(null);
  const smartTurnPlaybackSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const manifestAnimations = useMemo(
    () => buildActiveMotionInventory(avatar?.getMotionAnimations() ?? []),
    [avatar],
  );
  const expressionDraftScope =
    avatar?.scene?.uuid ??
    avatarAnimaId ??
    runtime.animaId ??
    snapshot?.animaId ??
    "__none__";
  const expressionNames = expressionsSectionEnabled
    ? readAvailableAvatarExpressions(avatar)
    : EMPTY_EXPRESSION_NAMES;
  const plan = animationSnapshotConsumerEnabled
    ? (snapshot?.plan ?? null)
    : null;
  const resolvedEmotionEditorAnimaId =
    runtime.animaId ?? snapshot?.animaId ?? null;
  const normalizedRuntimeEmotionValues = useMemo(
    () => normalizeEmotionStateMap(runtime.emotionalState.values),
    [runtime.emotionalState.values],
  );
  const isEmotionDraftDirty = !areEmotionStateMapsEqual(
    emotionDraftValues,
    emotionDraftBaseline,
  );
  const activeActions = animationSnapshotConsumerEnabled
    ? [...(snapshot?.activeActions ?? EMPTY_ACTIVE_ACTIONS)].sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
    : EMPTY_ACTIVE_ACTIONS;
  const currentAction = animationSnapshotConsumerEnabled
    ? (snapshot?.currentAction ??
      activeActions.find((action) => action.isCurrent) ??
      null)
    : null;
  const previousWeightsByActionName =
    animationSnapshotConsumerEnabled && activeActionsSectionEnabled
      ? new Map(
          (previousSnapshot?.activeActions ?? EMPTY_ACTIVE_ACTIONS).map(
            (action) => [action.name, action.weight],
          ),
        )
      : new Map<string, number>();
  const actionWeightTrends = new Map<string, ActionWeightTrend>();
  for (const action of activeActions) {
    actionWeightTrends.set(
      action.name,
      getActionWeightTrend(
        previousWeightsByActionName.get(action.name),
        action.weight,
      ),
    );
  }
  const smartTurnBufferPlaybackKey = "smart-turn-buffer";
  const hasSmartTurnBufferAudio = hasPlayableSmartTurnAudio(
    smartTurnBufferedAudio,
  );

  useEffect(() => {
    const animaChanged = emotionDraftAnimaId !== resolvedEmotionEditorAnimaId;
    if (!animaChanged && isEmotionDraftDirty) {
      return;
    }
    if (
      !animaChanged &&
      areEmotionStateMapsEqual(
        emotionDraftValues,
        normalizedRuntimeEmotionValues,
      ) &&
      areEmotionStateMapsEqual(
        emotionDraftBaseline,
        normalizedRuntimeEmotionValues,
      )
    ) {
      return;
    }
    setEmotionDraftValues(normalizedRuntimeEmotionValues);
    setEmotionDraftBaseline(normalizedRuntimeEmotionValues);
    setEmotionDraftAnimaId(resolvedEmotionEditorAnimaId);
  }, [
    emotionDraftBaseline,
    emotionDraftAnimaId,
    emotionDraftValues,
    isEmotionDraftDirty,
    normalizedRuntimeEmotionValues,
    resolvedEmotionEditorAnimaId,
  ]);

  const handleEmotionSliderChange = (
    emotion: keyof EmotionStateMap,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const nextValue = Math.max(
      EMOTION_MIN_VALUE,
      Math.min(EMOTION_MAX_VALUE, Math.round(Number(event.target.value))),
    );
    setEmotionDraftValues((current) => ({
      ...current,
      [emotion]: nextValue,
    }));
  };

  const handleUpdateAnimaEmotions = async () => {
    if (!resolvedEmotionEditorAnimaId) {
      return;
    }
    const nextEmotionalState = normalizeEmotionStateMap(emotionDraftValues);
    try {
      const updated = await updateAnimaEmotionalState.mutateAsync({
        animaId: resolvedEmotionEditorAnimaId,
        body: nextEmotionalState,
      });
      const normalizedUpdatedState = normalizeEmotionStateMap(
        updated.emotional_state,
      );
      if (runtime.animaId && updated.id === runtime.animaId) {
        setAnimaEmotionSnapshot(normalizedUpdatedState);
      }
      setEmotionDraftValues(normalizedUpdatedState);
      setEmotionDraftBaseline(normalizedUpdatedState);
      setEmotionDraftAnimaId(updated.id);
      toast.success("Anima emotions updated");
    } catch (error) {
      const description =
        error instanceof Error ? error.message : String(error);
      toast.error("Failed to update anima emotions", { description });
    }
  };

  const stopSmartTurnPlayback = (clearActivePlaybackKey = true) => {
    const source = smartTurnPlaybackSourceRef.current;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // noop
      }
      try {
        source.disconnect();
      } catch {
        // noop
      }
      smartTurnPlaybackSourceRef.current = null;
    }
    if (clearActivePlaybackKey) {
      setActiveSmartTurnPlaybackKey(null);
    }
  };

  const playSmartTurnAudio = async (args: {
    audio: SmartTurnDebugAudio;
    playbackKey: string;
  }) => {
    const { audio, playbackKey } = args;
    if (!hasPlayableSmartTurnAudio(audio)) return;
    if (typeof window === "undefined") return;

    const AudioContextConstructor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextConstructor) {
      toast.error("Audio playback unavailable", {
        description: "Web Audio API is not supported in this browser.",
      });
      return;
    }

    if (!smartTurnPlaybackAudioContextRef.current) {
      smartTurnPlaybackAudioContextRef.current = new AudioContextConstructor();
    }
    const audioContext = smartTurnPlaybackAudioContextRef.current;

    stopSmartTurnPlayback(false);

    const sampleRateHz =
      Number.isFinite(audio.sampleRateHz) && audio.sampleRateHz > 0
        ? audio.sampleRateHz
        : 16000;

    try {
      const playbackSamples = Float32Array.from(audio.samples);
      const buffer = audioContext.createBuffer(
        1,
        playbackSamples.length,
        sampleRateHz,
      );
      buffer.copyToChannel(playbackSamples, 0);

      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      source.onended = () => {
        if (smartTurnPlaybackSourceRef.current !== source) return;
        smartTurnPlaybackSourceRef.current = null;
        setActiveSmartTurnPlaybackKey((current) =>
          current === playbackKey ? null : current,
        );
      };
      smartTurnPlaybackSourceRef.current = source;
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      source.start(0);
      setActiveSmartTurnPlaybackKey(playbackKey);
    } catch (error) {
      stopSmartTurnPlayback(false);
      setActiveSmartTurnPlaybackKey(null);
      const description =
        error instanceof Error ? error.message : String(error);
      toast.error("Failed to play smart-turn audio", { description });
    }
  };

  const toggleSmartTurnAudioPlayback = (args: {
    audio: SmartTurnDebugAudio | null | undefined;
    playbackKey: string;
  }) => {
    const { audio, playbackKey } = args;
    if (!hasPlayableSmartTurnAudio(audio)) return;
    if (activeSmartTurnPlaybackKey === playbackKey) {
      stopSmartTurnPlayback();
      return;
    }
    void playSmartTurnAudio({
      audio,
      playbackKey,
    });
  };

  useEffect(() => {
    return () => {
      const source = smartTurnPlaybackSourceRef.current;
      if (source) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // noop
        }
        try {
          source.disconnect();
        } catch {
          // noop
        }
        smartTurnPlaybackSourceRef.current = null;
      }

      const audioContext = smartTurnPlaybackAudioContextRef.current;
      smartTurnPlaybackAudioContextRef.current = null;
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close();
      }
    };
  }, []);

  const setAllSections = (nextOpen: boolean) => {
    setSectionOpen((prev) => {
      const next = { ...prev };
      for (const key of DEBUG_SECTION_KEYS) {
        next[key] = isAnimaDebugSectionAvailable(key) ? nextOpen : false;
      }
      return next;
    });
  };

  const toggleSection = (key: DebugSectionKey) => {
    if (!isAnimaDebugSectionAvailable(key)) return;
    setSectionOpen((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const allSectionsExpanded = ENABLED_ANIMAMA_DEBUG_SECTION_KEYS.every(
    (key) => sectionOpen[key],
  );
  const allSectionsCollapsed = ENABLED_ANIMAMA_DEBUG_SECTION_KEYS.every(
    (key) => !sectionOpen[key],
  );
  const isSmartTurnBufferPlaying =
    activeSmartTurnPlaybackKey === smartTurnBufferPlaybackKey;

  const getExpressionSliderValue = (expressionName: string): number => {
    const draftKey = buildAvatarExpressionDraftKey(
      expressionDraftScope,
      expressionName,
    );
    const draftValue = expressionDraftValues[draftKey];
    if (typeof draftValue === "number" && Number.isFinite(draftValue)) {
      return clampAvatarExpressionValue(draftValue);
    }
    return readAvatarExpressionValue(avatar, expressionName);
  };

  const clearExpressionDraft = (expressionName: string) => {
    const draftKey = buildAvatarExpressionDraftKey(
      expressionDraftScope,
      expressionName,
    );
    setExpressionDraftValues((prev) => {
      if (!(draftKey in prev)) return prev;
      const next = { ...prev };
      delete next[draftKey];
      return next;
    });
  };

  const handleExpressionSliderChange = (
    expressionName: string,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    if (!avatar) return;
    const nextValue = clampAvatarExpressionValue(Number(event.target.value));
    const draftKey = buildAvatarExpressionDraftKey(
      expressionDraftScope,
      expressionName,
    );
    setExpressionDraftValues((prev) => ({
      ...prev,
      [draftKey]: nextValue,
    }));
    avatar.setExpression(expressionName, nextValue);
  };

  const handleExpressionSliderCommit = (expressionName: string) => {
    clearExpressionDraft(expressionName);
  };

  const handleClearExpressionOverride = (expressionName: string) => {
    if (!avatar) return;
    avatar.clearExpressionOverride(expressionName);
    clearExpressionDraft(expressionName);
  };

  const handleClearAllExpressionOverrides = () => {
    if (!avatar) return;
    avatar.clearAllExpressionOverrides();
    setExpressionDraftValues((prev) => {
      const next: Record<string, number> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (!key.startsWith(`${expressionDraftScope}::`)) {
          next[key] = value;
        }
      }
      return next;
    });
  };

  const handleApplyExpressionPreset = (
    label: EmotionPresetLabel,
    intensity: number,
  ) => {
    if (!avatar) return;
    avatar.applyEmotionPreset(label, intensity);
  };

  const handleApplyRuntimeEmotionPreset = () => {
    if (!avatar) return;
    avatar.applyEmotionPreset(
      dominantEmotion?.group ?? runtime.emotionalState.dominantGroup,
      dominantEmotion?.intensity ?? 1,
    );
  };

  const handleApplyManifestAnimation = async (
    entry: ManifestAnimationInventoryItem,
    weight: number,
  ) => {
    if (
      !avatar ||
      entry.disabled ||
      (entry.type !== "vrma" && entry.type !== "animaPoseClip")
    ) {
      return;
    }
    const loopType = normalizeLoopType(entry.loop_type);
    const loopCount =
      typeof entry.loop_count === "number" && Number.isFinite(entry.loop_count)
        ? entry.loop_count
        : undefined;
    const timeScale =
      typeof entry.time_scale === "number" && entry.time_scale > 0
        ? entry.time_scale
        : undefined;
    const blendMode = toAnimationBlendMode(entry.blend_mode);

    const rowKey = getManifestAnimationRowKey(entry);
    setApplyingAnimationFile(rowKey);
    try {
      if (entry.type === "vrma") {
        await avatar.playAnimationWithName(entry.file, entry.name, {
          loopType,
          loopCount,
          timeScale,
          weight: clampManifestAnimationWeight(weight),
          blendMode,
          keepExisting: false,
          fadeDuration: 0.25,
        });
      } else {
        const runtimeId = getManifestAnimationRuntimeId(entry);
        if (!runtimeId) throw new Error("Pose clip has no runtime ID");
        await avatar.loadAndPlayClip(runtimeId, {
          preserveProceduralOffsets: true,
        });
      }
    } catch (error) {
      const description =
        error instanceof Error ? error.message : String(error);
      toast.error("Failed to apply animation", { description });
    } finally {
      setApplyingAnimationFile((current) =>
        current === rowKey ? null : current,
      );
    }
  };

  const handleClearManifestAnimation = () => {
    if (!avatar) return;
    avatar.fadeOutAllAnimations(0.25);
    avatar.stopClip();
    setApplyingAnimationFile(null);
  };

  const handleManifestAnimationWeightChange = (
    rowKey: string,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const nextWeight = clampManifestAnimationWeight(Number(event.target.value));
    setManifestAnimationWeights((prev) => ({
      ...prev,
      [rowKey]: nextWeight,
    }));
  };

  const dominantEmotion = runtime.emotionalState.dominantEmotion;
  const updatedAtLabel = animationSnapshotConsumerEnabled
    ? snapshot
      ? new Date(snapshot.updatedAtMs).toLocaleTimeString()
      : "No data"
    : "Disabled";

  return (
    <div
      ref={panelRef}
      className={cn(
        "pointer-events-auto absolute top-3 right-3 z-20 w-[20rem] max-w-[calc(100vw-1rem)]",
        className,
      )}
    >
      <Card className="border-border/80 bg-background/90 supports-[backdrop-filter]:bg-background/75 shadow-lg backdrop-blur">
        <CardHeader className="space-y-1 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm">Anima Debug</CardTitle>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground text-2xs">
                {updatedAtLabel}
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Close anima debug panel"
                onClick={() => setDebugPanelOpen(false)}
                className="h-6 w-6"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            Avatar animation runtime
          </CardDescription>
          <div className="flex items-center justify-end gap-1 pt-0.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAllSections(false)}
              disabled={allSectionsCollapsed}
              className="text-2xs h-6 px-1.5"
            >
              Collapse all
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAllSections(true)}
              disabled={allSectionsExpanded}
              className="text-2xs h-6 px-1.5"
            >
              Expand all
            </Button>
          </div>
        </CardHeader>
        <CardContent className="max-h-[55vh] space-y-3 overflow-y-auto px-3 pt-1 pb-3 text-xs">
          {animationSnapshotConsumerEnabled && !snapshot ? (
            <div className="border-border/70 text-muted-foreground rounded-md border border-dashed p-2">
              Waiting for a live avatar snapshot. Switch to `avatar` or
              `avatar-chat` mode if the scene is hidden.
            </div>
          ) : null}

          <Section
            title="Avatar shader"
            isOpen={sectionOpen.avatarShader}
            onToggle={() => toggleSection("avatarShader")}
            disabled={!isAnimaDebugSectionAvailable("avatarShader")}
          >
            <AvatarShaderDebugSection />
          </Section>

          <Section
            title="Animation"
            isOpen={sectionOpen.animation}
            onToggle={() => toggleSection("animation")}
            disabled={!isAnimaDebugSectionAvailable("animation")}
          >
            <DebugRow
              label="Avatar state"
              value={snapshot?.avatarState ?? "-"}
              mono
            />
            <DebugRow label="Plan state" value={plan?.state ?? "-"} mono />
            <DebugRow
              label="Plan clip"
              value={formatMaybeText(plan?.clipName)}
              title={plan?.clipName ?? undefined}
              mono
            />
            <DebugRow
              label="Current action"
              value={currentAction?.name ?? "-"}
              title={currentAction?.name}
              mono
            />
            <DebugRow
              label="Loop type"
              value={plan?.loopType ?? currentAction?.loopType ?? "-"}
              mono
            />
            <DebugRow
              label="Playhead"
              value={formatPlayhead({
                playheadSec: currentAction?.playheadSec,
                clipDurationSec: currentAction?.clipDurationSec,
              })}
              mono
            />
            <DebugRow
              label="Effective dur"
              value={
                plan
                  ? formatDuration(plan.effectiveDurationSec)
                  : formatDuration(currentAction?.effectiveDurationSec)
              }
              mono
            />
            <DebugRow
              label="Plan type"
              value={plan ? (plan.isGesture ? "gesture" : "loop") : "-"}
              mono
            />
            <DebugRow
              label="Plan gesture"
              value={
                plan?.gestureRequestId
                  ? truncateMiddle(plan.gestureRequestId, 28)
                  : "-"
              }
              title={plan?.gestureRequestId ?? undefined}
              mono
            />
            <DebugRow
              label="Time scale"
              value={
                typeof plan?.timeScale === "number"
                  ? plan.timeScale.toFixed(2)
                  : typeof currentAction?.timeScale === "number"
                    ? currentAction.timeScale.toFixed(2)
                    : "-"
              }
              mono
            />
            <DebugRow
              label="Next eval"
              value={formatMs(plan?.nextEvalMs)}
              mono
            />
            <DebugRow
              label="Plan URL"
              value={
                <span className="block truncate">
                  {plan?.clipUrl ? truncateMiddle(plan.clipUrl, 34) : "-"}
                </span>
              }
              title={plan?.clipUrl ?? undefined}
              mono
            />
          </Section>

          <Section
            title="Signals"
            isOpen={sectionOpen.signals}
            onToggle={() => toggleSection("signals")}
            disabled={!isAnimaDebugSectionAvailable("signals")}
          >
            <DebugRow label="Anima" value={runtime.animaId ?? "-"} mono />
            <DebugRow label="Phase" value={runtime.interactionPhase} mono />
            <DebugRow
              label="Run"
              value={
                runtime.activeRunId
                  ? truncateMiddle(runtime.activeRunId, 28)
                  : "-"
              }
              title={runtime.activeRunId ?? undefined}
              mono
            />
            <DebugRow
              label="Speech run"
              value={
                runtime.activeSpeechRunId
                  ? truncateMiddle(runtime.activeSpeechRunId, 28)
                  : "-"
              }
              title={runtime.activeSpeechRunId ?? undefined}
              mono
            />
            <DebugRow
              label="Planner events"
              value={
                runtime.plannerEvents.length > 0
                  ? runtime.plannerEvents.length.toString()
                  : "0"
              }
              mono
            />
            <DebugRow
              label="Event head"
              value={
                runtime.plannerEvents[0]?.eventId
                  ? truncateMiddle(runtime.plannerEvents[0].eventId, 28)
                  : "-"
              }
              title={runtime.plannerEvents[0]?.eventId ?? undefined}
              mono
            />
            <DebugRow
              label="Event kind"
              value={
                runtime.plannerEvents[0]?.type
                  ? truncateMiddle(runtime.plannerEvents[0].type, 28)
                  : "-"
              }
              title={runtime.plannerEvents[0]?.type ?? undefined}
              mono
            />
          </Section>

          <Section
            title="Lip-sync"
            isOpen={sectionOpen.lipSync}
            onToggle={() => toggleSection("lipSync")}
            disabled={!lipSyncSectionEnabled}
          >
            <LipSyncDebugSection />
          </Section>

          <Section
            title="Voice / Acoustic VAD"
            isOpen={sectionOpen.voiceVad}
            onToggle={() => toggleSection("voiceVad")}
            disabled={!isAnimaDebugSectionAvailable("voiceVad")}
          >
            <DebugRow label="Status" value={vadDebugStatus} mono />
            <DebugRow label="Provider" value={vadDebugProvider ?? "-"} mono />
            <DebugRow
              label="Error"
              value={vadDebugError ? truncateMiddle(vadDebugError, 30) : "-"}
              title={vadDebugError ?? undefined}
              mono
            />
            <DebugRow
              label="Turn"
              value={vadDebugTurnId ? truncateMiddle(vadDebugTurnId, 28) : "-"}
              title={vadDebugTurnId ?? undefined}
              mono
            />
            <DebugRow
              label="Window"
              value={
                vadDebugWindowId ? truncateMiddle(vadDebugWindowId, 28) : "-"
              }
              title={vadDebugWindowId ?? undefined}
              mono
            />
            <DebugRow
              label="Real speech"
              value={formatBool(vadDebugWindowIsRealSpeech)}
              mono
            />
            <DebugRow
              label="Committed"
              value={vadDebugCommittedChars.toString()}
              mono
            />
            <DebugRow
              label="Tentative"
              value={vadDebugTentativeChars.toString()}
              mono
            />
            <DebugRow
              label="Audio"
              value={`${vadDebugRollingAudioSamples} / ${formatSeconds(vadAudioDurationSec)}`}
              title="samples / duration"
              mono
            />
            <DebugRow
              label="Frame probs"
              value={
                vadDebugLatestFrame
                  ? `${formatNumber(vadDebugLatestFrame.isSpeech, 3)} / ${formatNumber(vadDebugLatestFrame.notSpeech, 3)}`
                  : "-"
              }
              title="isSpeech / notSpeech"
              mono
            />
            <div className="border-border/50 mt-1 border-t pt-2">
              <DebugRow
                label="Smart turn"
                value={smartTurnEnabled ? "enabled" : "disabled"}
                mono
              />
              <DebugRow label="ST status" value={smartTurnStatus} mono />
              <DebugRow
                label="ST error"
                value={
                  smartTurnError ? truncateMiddle(smartTurnError, 30) : "-"
                }
                title={smartTurnError ?? undefined}
                mono
              />
              <DebugRow
                label="ST job"
                value={
                  smartTurnActiveJobId
                    ? truncateMiddle(smartTurnActiveJobId, 28)
                    : "-"
                }
                title={smartTurnActiveJobId ?? undefined}
                mono
              />
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-2">
                <span className="text-muted-foreground">ST buffer</span>
                <div className="flex items-center justify-end gap-1">
                  <span
                    className="text-foreground text-2xs min-w-0 text-right font-mono"
                    title="samples / duration"
                  >
                    {`${smartTurnBufferedSamples} / ${formatSeconds(smartTurnBufferedDurationSec)}`}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      toggleSmartTurnAudioPlayback({
                        audio: smartTurnBufferedAudio,
                        playbackKey: smartTurnBufferPlaybackKey,
                      })
                    }
                    disabled={!hasSmartTurnBufferAudio}
                    className="h-5 px-1 text-[9px]"
                  >
                    {isSmartTurnBufferPlaying ? "Stop" : "Play"}
                  </Button>
                </div>
              </div>
              <DebugRow
                label="ST superseded"
                value={smartTurnSupersededJobs.toString()}
                mono
              />
              <DebugRow
                label="ST decision"
                value={
                  smartTurnLatestDecision
                    ? `${smartTurnLatestDecision.decision} (${formatNumber(
                        smartTurnLatestDecision.probability ?? null,
                        3,
                      )})`
                    : "-"
                }
                title={
                  smartTurnLatestDecision
                    ? `latency=${formatMs(smartTurnLatestDecision.latencyMs)} threshold=${smartTurnLatestDecision.threshold.toFixed(
                        2,
                      )}`
                    : undefined
                }
                mono
              />
            </div>
            <div className="space-y-1">
              <div className="text-muted-foreground">VAD events</div>
              {recentVadEvents.length === 0 ? (
                <div className="border-border/60 text-muted-foreground text-2xs rounded border px-2 py-1 font-mono">
                  none
                </div>
              ) : (
                recentVadEvents.map((event) => (
                  <div
                    key={event.id}
                    className="border-border/60 text-2xs rounded border px-2 py-1 font-mono"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>{event.type}</span>
                      <span className="text-muted-foreground">
                        {new Date(event.createdAtMs).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      win:{" "}
                      {event.windowId
                        ? truncateMiddle(event.windowId, 20)
                        : "-"}
                      {" • "}audio:{" "}
                      {typeof event.audioSamples === "number"
                        ? event.audioSamples
                        : "-"}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="space-y-1">
              <div className="text-muted-foreground">Gate decisions</div>
              {recentVadGateDecisions.length === 0 ? (
                <div className="border-border/60 text-muted-foreground text-2xs rounded border px-2 py-1 font-mono">
                  none
                </div>
              ) : (
                recentVadGateDecisions.map((decision) => (
                  <div
                    key={decision.id}
                    className="border-border/60 text-2xs rounded border px-2 py-1 font-mono"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>{decision.decision}</span>
                      <span className="text-muted-foreground">
                        {decision.chars} ch
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      {decision.reason}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="space-y-1">
              <div className="text-muted-foreground">Smart-turn events</div>
              {recentSmartTurnEvents.length === 0 ? (
                <div className="border-border/60 text-muted-foreground text-2xs rounded border px-2 py-1 font-mono">
                  none
                </div>
              ) : (
                recentSmartTurnEvents.map((event) => (
                  <div
                    key={event.id}
                    className="border-border/60 text-2xs rounded border px-2 py-1 font-mono"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>{event.type}</span>
                      <span className="text-muted-foreground">
                        {new Date(event.createdAtMs).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="text-muted-foreground flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        job:{" "}
                        {event.jobId ? truncateMiddle(event.jobId, 20) : "-"}
                        {" • "}
                        {event.details ?? "-"}
                        {hasPlayableSmartTurnAudio(event.audio)
                          ? ` • audio: ${formatSeconds(getSmartTurnAudioDurationSec(event.audio))}`
                          : ""}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        {event.type === "job_completed" &&
                        typeof event.probability === "number" &&
                        Number.isFinite(event.probability) ? (
                          <span
                            className="text-foreground font-mono text-[9px]"
                            title="Smart-turn classifier probability"
                          >
                            p={event.probability.toFixed(3)}
                          </span>
                        ) : null}
                        {event.type === "job_completed" &&
                        hasPlayableSmartTurnAudio(event.audio) ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              toggleSmartTurnAudioPlayback({
                                audio: event.audio,
                                playbackKey: `smart-turn-event:${event.id}`,
                              })
                            }
                            className="h-5 px-1 text-[9px]"
                          >
                            {activeSmartTurnPlaybackKey ===
                            `smart-turn-event:${event.id}`
                              ? "Stop"
                              : "Play"}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Section>

          <Section
            title="Emotion"
            isOpen={sectionOpen.emotion}
            onToggle={() => toggleSection("emotion")}
            disabled={!isAnimaDebugSectionAvailable("emotion")}
          >
            <DebugRow
              label="Dominant"
              value={
                dominantEmotion
                  ? `${formatTrackedEmotionLabel(dominantEmotion.emotion)} (L${dominantEmotion.intensity})`
                  : "neutral"
              }
              mono
            />
            <DebugRow
              label="Group"
              value={runtime.emotionalState.dominantGroup}
              mono
            />
            <DebugRow
              label="Value"
              value={String(dominantEmotion?.value ?? 0)}
              mono
            />
            <div className="space-y-1">
              <div className="text-muted-foreground">Ranked groups</div>
              {runtime.emotionalState.rankedGroups.length === 0 ? (
                <div className="border-border/60 text-muted-foreground text-2xs rounded border px-2 py-1 font-mono">
                  none
                </div>
              ) : (
                runtime.emotionalState.rankedGroups.map((group) => (
                  <div
                    key={`${group.group}:${group.average}`}
                    className="border-border/60 text-2xs flex items-center justify-between rounded border px-2 py-1 font-mono"
                  >
                    <span>{formatEmotionPresetLabel(group.group)}</span>
                    <span>{`${group.average.toFixed(1)} avg · L${group.intensity}`}</span>
                  </div>
                ))
              )}
            </div>
            <div className="space-y-1">
              <div className="text-muted-foreground">Ranked emotions</div>
              {runtime.emotionalState.rankedEmotions.length === 0 ? (
                <div className="border-border/60 text-muted-foreground text-2xs rounded border px-2 py-1 font-mono">
                  none
                </div>
              ) : (
                runtime.emotionalState.rankedEmotions.map((emotion) => (
                  <div
                    key={`${emotion.emotion}:${emotion.intensity}`}
                    className="border-border/60 text-2xs flex items-center justify-between rounded border px-2 py-1 font-mono"
                  >
                    <span>{formatTrackedEmotionLabel(emotion.emotion)}</span>
                    <span>{`${emotion.value} · L${emotion.intensity} · ${emotion.group}`}</span>
                  </div>
                ))
              )}
            </div>
            <div className="border-border/60 space-y-2 rounded border p-2">
              <button
                type="button"
                onClick={() => setAllEmotionsOpen((current) => !current)}
                className="text-muted-foreground hover:bg-muted/40 text-2xs flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left font-semibold tracking-wide uppercase transition"
                aria-expanded={allEmotionsOpen}
              >
                <span className="truncate">All Emotions</span>
                {allEmotionsOpen ? (
                  <ChevronDown
                    className="h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                ) : (
                  <ChevronRight
                    className="h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                )}
              </button>
              {allEmotionsOpen ? (
                <div className="space-y-2">
                  {EMOTION_GROUPS.map((group) => (
                    <div
                      key={group}
                      className="border-border/60 space-y-2 rounded border p-2"
                    >
                      <div className="text-muted-foreground text-2xs font-semibold">
                        {formatEmotionGroupLabel(group)}
                      </div>
                      {EMOTION_GROUP_MEMBERS[group].map((emotion) => (
                        <div key={emotion} className="space-y-1">
                          <div className="text-2xs flex items-center justify-between gap-2 font-mono">
                            <span>{formatTrackedEmotionLabel(emotion)}</span>
                            <span>{emotionDraftValues[emotion]}</span>
                          </div>
                          <input
                            type="range"
                            min={EMOTION_MIN_VALUE}
                            max={EMOTION_MAX_VALUE}
                            step={1}
                            value={emotionDraftValues[emotion]}
                            onChange={(event) =>
                              handleEmotionSliderChange(emotion, event)
                            }
                            className="w-full"
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground text-2xs">
                      {resolvedEmotionEditorAnimaId
                        ? "Adjust values locally, then persist with Update."
                        : "No anima available for emotion updates."}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleUpdateAnimaEmotions()}
                      disabled={
                        !resolvedEmotionEditorAnimaId ||
                        updateAnimaEmotionalState.isPending ||
                        !isEmotionDraftDirty
                      }
                      className="text-2xs h-7 px-2"
                    >
                      {updateAnimaEmotionalState.isPending
                        ? "Updating..."
                        : "Update"}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </Section>

          <Section
            title={`Active Actions (${activeActions.length})`}
            isOpen={sectionOpen.activeActions}
            onToggle={() => toggleSection("activeActions")}
            disabled={!isAnimaDebugSectionAvailable("activeActions")}
          >
            {activeActions.length === 0 ? (
              <div className="border-border/60 text-muted-foreground rounded border px-2 py-1">
                No active animation actions
              </div>
            ) : (
              <div className="space-y-1.5">
                {activeActions.map((action) => {
                  // Weight trend highlights fade direction between snapshots.
                  // increasing => likely fading in, decreasing => likely fading out.
                  const weightTrend =
                    actionWeightTrends.get(action.name) ?? "stable";
                  const trendClass =
                    weightTrend === "increasing"
                      ? action.isCurrent
                        ? "border-emerald-500/60 bg-emerald-500/5"
                        : "border-emerald-500/40"
                      : weightTrend === "decreasing"
                        ? action.isCurrent
                          ? "border-rose-500/60 bg-rose-500/5"
                          : "border-rose-500/40"
                        : action.isCurrent
                          ? "border-primary/40 bg-primary/5"
                          : "border-border/60";

                  return (
                    <div
                      key={action.name}
                      className={cn("rounded border px-2 py-1.5", trendClass)}
                    >
                      <div className="text-2xs flex items-center justify-between gap-2 font-mono">
                        <span className="min-w-0 truncate" title={action.name}>
                          {action.name}
                        </span>
                        <span className="text-muted-foreground">
                          {action.isCurrent ? "current" : "active"}
                        </span>
                      </div>
                      <div className="text-muted-foreground text-2xs mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono">
                        <span>loop: {action.loopType}</span>
                        <span>
                          t:{" "}
                          {formatPlayhead({
                            playheadSec: action.playheadSec,
                            clipDurationSec: action.clipDurationSec,
                          })}
                        </span>
                        <span>w: {action.weight.toFixed(2)}</span>
                        <span>scale: {action.timeScale.toFixed(2)}</span>
                        <span>blend: {action.blendMode}</span>
                        <span>
                          dur: {formatDuration(action.effectiveDurationSec)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          <Section
            title="Main Thread Health"
            isOpen={sectionOpen.mainThreadHealth}
            onToggle={() => toggleSection("mainThreadHealth")}
            disabled={!isAnimaDebugSectionAvailable("mainThreadHealth")}
          >
            <DebugRow
              label="FPS (1s)"
              value={formatNumber(mainThreadHealth.fps1s, 1)}
              mono
            />
            <DebugRow
              label="FPS (5s)"
              value={formatNumber(mainThreadHealth.fps5s, 1)}
              mono
            />
            <DebugRow
              label="Frame avg"
              value={formatMsPrecise(mainThreadHealth.frameMs.avg)}
              mono
            />
            <DebugRow
              label="Frame p95"
              value={formatMsPrecise(mainThreadHealth.frameMs.p95)}
              mono
            />
            <DebugRow
              label="Frame max"
              value={formatMsPrecise(mainThreadHealth.frameMs.max)}
              mono
            />
            <DebugRow
              label="Lag avg"
              value={formatMsPrecise(mainThreadHealth.eventLoopLagMs.avg)}
              mono
            />
            <DebugRow
              label="Lag p95"
              value={formatMsPrecise(mainThreadHealth.eventLoopLagMs.p95)}
              mono
            />
            <DebugRow
              label="Lag max"
              value={formatMsPrecise(mainThreadHealth.eventLoopLagMs.max)}
              mono
            />
            <DebugRow
              label="Longtask API"
              value={formatBool(mainThreadHealth.longTaskObserverSupported)}
              mono
            />
            <DebugRow
              label="Long tasks 10s"
              value={`${mainThreadHealth.longTaskCount10s} / ${formatMsPrecise(mainThreadHealth.longTaskBlockedMs10s)}`}
              title="count / total blocked time in last 10s"
              mono
            />
            <DebugRow
              label="Long tasks total"
              value={`${mainThreadHealth.longTaskCountTotal} / ${formatMs(mainThreadHealth.longTaskBlockedMsTotal)}`}
              title="count / total blocked time since panel opened"
              mono
            />
          </Section>

          <Section
            title="Thread / Runtime"
            isOpen={sectionOpen.runtimeCapabilities}
            onToggle={() => toggleSection("runtimeCapabilities")}
            disabled={!isAnimaDebugSectionAvailable("runtimeCapabilities")}
          >
            <DebugRow
              label="HW threads"
              value={runtimeCapabilities.hardwareConcurrency?.toString() ?? "-"}
              mono
            />
            <DebugRow
              label="Device mem"
              value={
                typeof runtimeCapabilities.deviceMemoryGiB === "number"
                  ? `${runtimeCapabilities.deviceMemoryGiB} GiB`
                  : "-"
              }
              mono
            />
            <DebugRow
              label="COI"
              value={formatBool(runtimeCapabilities.crossOriginIsolated)}
              title="crossOriginIsolated"
              mono
            />
            <DebugRow
              label="SharedArrayBuf"
              value={formatBool(runtimeCapabilities.sharedArrayBuffer)}
              mono
            />
            <DebugRow
              label="Atomics"
              value={formatBool(runtimeCapabilities.atomics)}
              mono
            />
            <DebugRow
              label="Web Workers"
              value={formatBool(runtimeCapabilities.webWorkers)}
              mono
            />
            <DebugRow
              label="AudioWorklet"
              value={formatBool(runtimeCapabilities.audioWorklet)}
              mono
            />
            <DebugRow
              label="WebAssembly"
              value={formatBool(runtimeCapabilities.webAssembly)}
              mono
            />
            <DebugRow
              label="WASM threads"
              value={formatBool(runtimeCapabilities.wasmThreadsPrereqs)}
              title="Feature prerequisite proxy (WASM + SAB + Atomics + COI)"
              mono
            />
            <DebugRow
              label="Heap API"
              value={formatBool(runtimeCapabilities.jsHeapMemoryApi)}
              title="performance.memory"
              mono
            />
            <DebugRow
              label="UA mem API"
              value={formatBool(runtimeCapabilities.userAgentSpecificMemoryApi)}
              title="performance.measureUserAgentSpecificMemory"
              mono
            />
          </Section>

          <Section
            title="Memory"
            isOpen={sectionOpen.memory}
            onToggle={() => toggleSection("memory")}
            disabled={!isAnimaDebugSectionAvailable("memory")}
          >
            <DebugRow
              label="Heap API"
              value={memory.jsHeapSupported ? "available" : "unavailable"}
              mono
            />
            <DebugRow
              label="Heap used"
              value={formatBytes(memory.jsHeapUsedBytes)}
              mono
            />
            <DebugRow
              label="Heap total"
              value={formatBytes(memory.jsHeapTotalBytes)}
              mono
            />
            <DebugRow
              label="Heap limit"
              value={formatBytes(memory.jsHeapLimitBytes)}
              mono
            />
            <DebugRow
              label="Heap Δ10s"
              value={formatBytesDelta(memory.jsHeapDelta10sBytes)}
              mono
            />
            <DebugRow
              label="UA mem API"
              value={memory.uaMemorySupported ? "available" : "unavailable"}
              mono
            />
            <DebugRow
              label="UA memory"
              value={formatBytes(memory.uaMemoryBytes)}
              mono
            />
            <DebugRow
              label="UA breakdown"
              value={
                typeof memory.uaMemoryBreakdownCount === "number"
                  ? memory.uaMemoryBreakdownCount.toString()
                  : "-"
              }
              mono
            />
            <DebugRow
              label="UA error"
              value={
                memory.uaMemoryError
                  ? truncateMiddle(memory.uaMemoryError, 30)
                  : "-"
              }
              title={memory.uaMemoryError ?? undefined}
              mono
            />
          </Section>

          <Section
            title={`Workers (${pocketTtsWorkerRegistry.activeWorkers}/${pocketTtsWorkerRegistry.totalWorkers})`}
            isOpen={sectionOpen.workers}
            onToggle={() => toggleSection("workers")}
            disabled={!isAnimaDebugSectionAvailable("workers")}
          >
            <DebugRow
              label="Registry"
              value={
                pocketTtsWorkerRegistry.updatedAtMs
                  ? "active"
                  : "no worker telemetry yet"
              }
              mono
            />
            <DebugRow
              label="Total"
              value={`${pocketTtsWorkerRegistry.activeWorkers} active / ${pocketTtsWorkerRegistry.totalWorkers} total`}
              mono
            />
            {pocketTtsWorkers.length === 0 ? (
              <div className="border-border/60 text-muted-foreground rounded border px-2 py-1">
                No active worker instrumentation yet. Warm up Pocket TTS to
                instantiate the inference worker.
              </div>
            ) : (
              <div className="space-y-1.5">
                {pocketTtsWorkers.map((worker) => (
                  <div
                    key={worker.workerId}
                    className={cn(
                      "rounded border px-2 py-1",
                      worker.status === "error"
                        ? "border-rose-500/50 bg-rose-500/5"
                        : worker.status === "busy"
                          ? "border-amber-500/40 bg-amber-500/5"
                          : "border-border/60",
                    )}
                  >
                    <div className="text-2xs flex items-center justify-between gap-2 font-mono">
                      <span className="min-w-0 truncate" title={worker.name}>
                        {worker.name}
                      </span>
                      <span className="text-muted-foreground">
                        {worker.status}
                      </span>
                    </div>
                    <div className="text-muted-foreground text-2xs mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono">
                      <span>
                        q: {worker.inflightRequestCount} inflight /{" "}
                        {worker.pendingRequestCount} await
                      </span>
                      <span>
                        msg: {worker.messagesSent} tx /{" "}
                        {worker.messagesReceived} rx
                      </span>
                      <span>
                        task: {worker.currentTaskType ?? "-"}
                        {worker.currentTaskElapsedMs != null
                          ? ` (${formatMsPrecise(worker.currentTaskElapsedMs)})`
                          : ""}
                      </span>
                      <span>
                        gen-start:{" "}
                        {formatLatencySummary({
                          lastMs: worker.generateStartLatency.lastMs,
                          avgMs: worker.generateStartLatency.avgMs,
                          p95Ms: worker.generateStartLatency.p95Ms,
                        })}
                      </span>
                      <span className="col-span-2">
                        req rt (last/avg/p95):{" "}
                        {formatLatencySummary({
                          lastMs: worker.requestLatency.lastMs,
                          avgMs: worker.requestLatency.avgMs,
                          p95Ms: worker.requestLatency.p95Ms,
                        })}
                      </span>
                      <span
                        className="col-span-2 truncate"
                        title={worker.lastMessageType ?? undefined}
                      >
                        last: {worker.lastMessageType ?? "-"} · thread:{" "}
                        {worker.threadId ?? "-"}
                      </span>
                      {worker.lastError ? (
                        <span
                          className="col-span-2 truncate text-rose-600 dark:text-rose-300"
                          title={worker.lastError}
                        >
                          error: {truncateMiddle(worker.lastError, 44)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            title={`ONNX Runtime Web (${pocketTts.onnxRuntimeDebug.length})`}
            isOpen={sectionOpen.onnxRuntime}
            onToggle={() => toggleSection("onnxRuntime")}
            disabled={!isAnimaDebugSectionAvailable("onnxRuntime")}
          >
            <DebugRow label="Phase" value={pocketTts.phase} mono />
            <DebugRow label="Ready" value={formatBool(pocketTts.ready)} mono />
            <DebugRow
              label="Runtime"
              value={pocketTtsOrtRuntime?.runtimeName ?? "Pocket TTS"}
              mono
            />
            <DebugRow
              label="State"
              value={pocketTtsOrtRuntime?.state ?? "-"}
              mono
            />
            <DebugRow
              label="Stage"
              value={pocketTtsOrtRuntime?.stage ?? "-"}
              mono
            />
            <DebugRow
              label="Provider"
              value={pocketTtsOrtRuntime?.provider ?? "-"}
              mono
            />
            <DebugRow
              label="ORT ver"
              value={pocketTtsOrtRuntime?.version ?? "-"}
              mono
            />
            <DebugRow
              label="COI"
              value={
                pocketTtsOrtRuntime
                  ? formatBool(
                      pocketTtsOrtRuntime.wasm.crossOriginIsolated === true,
                    )
                  : "-"
              }
              mono
            />
            <DebugRow
              label="SIMD"
              value={
                pocketTtsOrtRuntime
                  ? pocketTtsOrtRuntime.wasm.simd == null
                    ? "-"
                    : formatBool(pocketTtsOrtRuntime.wasm.simd)
                  : "-"
              }
              mono
            />
            <DebugRow
              label="Threads"
              value={
                typeof pocketTtsOrtRuntime?.wasm.numThreads === "number"
                  ? pocketTtsOrtRuntime.wasm.numThreads.toString()
                  : "-"
              }
              mono
            />
            <DebugRow
              label="WASM paths"
              value={
                pocketTtsOrtRuntime?.wasm.wasmPaths ? (
                  <span className="block truncate">
                    {truncateMiddle(pocketTtsOrtRuntime.wasm.wasmPaths, 34)}
                  </span>
                ) : (
                  "-"
                )
              }
              title={pocketTtsOrtRuntime?.wasm.wasmPaths ?? undefined}
              mono
            />
            <DebugRow
              label="Graph opt"
              value={pocketTtsOrtRuntime?.graphOptimizationLevel ?? "-"}
              mono
            />
            <DebugRow
              label="TTFB"
              value={formatMsPrecise(pocketTts.metrics.ttfbMs)}
              mono
            />
            <DebugRow
              label="RTF x"
              value={formatNumber(pocketTts.metrics.rtfx, 2)}
              mono
            />
            <DebugRow
              label="RTF EMA"
              value={formatNumber(pocketTts.metrics.rtfEma, 2)}
              mono
            />
            <DebugRow
              label="Underruns"
              value={String(pocketTts.metrics.underruns)}
              mono
            />
            <DebugRow
              label="Buffer"
              value={formatMsPrecise(pocketTts.metrics.bufferLevelMs)}
              mono
            />
            <DebugRow
              label="Error"
              value={
                pocketTts.error ? truncateMiddle(pocketTts.error, 30) : "-"
              }
              title={pocketTts.error ?? undefined}
              mono
            />
            <div className="space-y-1">
              <div className="text-muted-foreground">
                Sessions ({pocketTtsOrtSessions.length})
              </div>
              {pocketTtsOrtSessions.length === 0 ? (
                <div className="border-border/60 text-muted-foreground text-2xs rounded border px-2 py-1 font-mono">
                  No ORT session telemetry yet
                </div>
              ) : (
                pocketTtsOrtSessions.map((session) => (
                  <div
                    key={session.name}
                    className={cn(
                      "text-2xs rounded border px-2 py-1 font-mono",
                      session.status === "error"
                        ? "border-rose-500/50 bg-rose-500/5"
                        : session.status === "loading"
                          ? "border-amber-500/40 bg-amber-500/5"
                          : session.status === "ready"
                            ? "border-emerald-500/35 bg-emerald-500/5"
                            : "border-border/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate" title={session.name}>
                        {session.name}
                      </span>
                      <span className="text-muted-foreground">
                        {session.status}
                      </span>
                    </div>
                    <div
                      className="text-muted-foreground mt-0.5 truncate"
                      title={session.modelUrl ?? undefined}
                    >
                      {session.modelUrl
                        ? truncateMiddle(session.modelUrl, 40)
                        : "-"}
                    </div>
                    {session.lastError ? (
                      <div
                        className="mt-0.5 truncate text-rose-600 dark:text-rose-300"
                        title={session.lastError}
                      >
                        {truncateMiddle(session.lastError, 44)}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </Section>

          <Section
            title={`Expressions (${expressionNames.length})`}
            isOpen={sectionOpen.expressions}
            onToggle={() => toggleSection("expressions")}
            disabled={!isAnimaDebugSectionAvailable("expressions")}
          >
            {!avatar ? (
              <div className="border-border/70 text-muted-foreground rounded border border-dashed px-2 py-1">
                Avatar not available. Switch to `avatar` or `avatar-chat` mode.
              </div>
            ) : expressionNames.length === 0 ? (
              <div className="border-border/60 text-muted-foreground rounded border px-2 py-1">
                No expressions detected on the loaded VRM.
              </div>
            ) : (
              <>
                <div className="border-border/60 space-y-1.5 rounded border px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-2xs font-medium">
                        Expression Presets
                      </div>
                      <div className="text-muted-foreground text-2xs">
                        Apply `EMOTION_INTENSITY_MAP` targets to the avatar
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={handleApplyRuntimeEmotionPreset}
                      className="text-2xs h-7 px-2"
                    >
                      Sync runtime
                    </Button>
                  </div>
                  <div className="space-y-1.5">
                    {EMOTION_PRESET_LABELS.map((label) => {
                      const presetMap = EMOTION_INTENSITY_MAP[label];
                      const isRuntimeLabel =
                        runtime.emotionalState.dominantGroup === label;

                      return (
                        <div
                          key={label}
                          className="border-border/60 rounded border px-2 py-1"
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="text-2xs font-medium">
                              {formatEmotionPresetLabel(label)}
                            </span>
                            <span className="text-muted-foreground text-[9px]">
                              {isRuntimeLabel
                                ? `runtime ${Math.round(
                                    dominantEmotion?.intensity ?? 0,
                                  )}`
                                : "manual"}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {EMOTION_EXPRESSION_INTENSITIES.map((intensity) => {
                              const composition = presetMap[intensity];
                              const isRuntimeMatch =
                                isRuntimeLabel &&
                                Math.round(dominantEmotion?.intensity ?? 0) ===
                                  intensity;

                              return (
                                <Button
                                  key={`${label}-${intensity}`}
                                  type="button"
                                  size="sm"
                                  variant={
                                    isRuntimeMatch ? "default" : "outline"
                                  }
                                  onClick={() =>
                                    handleApplyExpressionPreset(
                                      label,
                                      intensity,
                                    )
                                  }
                                  className="text-2xs h-6 px-2 font-mono"
                                  title={formatEmotionPresetComposition(
                                    composition,
                                  )}
                                >
                                  {label}:{intensity}
                                </Button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="border-border/60 flex items-center justify-between gap-2 rounded border px-2 py-1">
                  <div className="min-w-0">
                    <div className="text-2xs font-medium">Manual Overrides</div>
                    <div className="text-muted-foreground text-2xs">
                      Sliders persist over emotion/blink/lip-sync until cleared
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={handleClearAllExpressionOverrides}
                    className="text-2xs h-7 px-2"
                  >
                    Clear all
                  </Button>
                </div>
                <div className="space-y-1.5">
                  {expressionNames.map((expressionName) => {
                    const currentValue =
                      getExpressionSliderValue(expressionName);
                    const overrideValue = readAvatarExpressionOverrideValue(
                      avatar,
                      expressionName,
                    );
                    const hasOverride = overrideValue !== null;

                    return (
                      <div
                        key={expressionName}
                        className={cn(
                          "rounded border px-1.5 py-1",
                          hasOverride
                            ? "border-sky-500/40 bg-sky-500/5"
                            : "border-border/60",
                        )}
                      >
                        <div className="mb-0.5 flex items-center justify-between gap-1.5">
                          <span
                            className="text-2xs min-w-0 truncate font-mono"
                            title={expressionName}
                          >
                            {expressionName}
                          </span>
                          <div className="flex items-center gap-1">
                            <span className="text-muted-foreground font-mono text-[9px]">
                              {formatAvatarExpressionValue(currentValue)}
                            </span>
                            {hasOverride ? (
                              <span className="rounded border border-sky-500/40 px-1 py-0 text-[8px] leading-4 font-medium text-sky-700 dark:text-sky-300">
                                override
                              </span>
                            ) : null}
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                handleClearExpressionOverride(expressionName)
                              }
                              disabled={!hasOverride}
                              className="h-5 px-1 text-[9px]"
                            >
                              Clear
                            </Button>
                          </div>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={currentValue}
                          onChange={(event) =>
                            handleExpressionSliderChange(expressionName, event)
                          }
                          onPointerUp={() =>
                            handleExpressionSliderCommit(expressionName)
                          }
                          onBlur={() =>
                            handleExpressionSliderCommit(expressionName)
                          }
                          className="accent-primary h-3 w-full cursor-pointer"
                          aria-label={`Expression ${expressionName}`}
                        />
                        {hasOverride ? (
                          <div className="text-muted-foreground mt-0.5 text-right font-mono text-[9px]">
                            live:{" "}
                            {formatAvatarExpressionValue(
                              readAvatarExpressionValue(avatar, expressionName),
                            )}{" "}
                            · override:{" "}
                            {formatAvatarExpressionValue(overrideValue)}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </Section>

          <Section
            title={`Active Motion Catalog (${manifestAnimations.length})`}
            isOpen={sectionOpen.manifestAnimations}
            onToggle={() => toggleSection("manifestAnimations")}
            disabled={!isAnimaDebugSectionAvailable("manifestAnimations")}
          >
            {manifestAnimations.length === 0 ? (
              <div className="border-border/60 text-muted-foreground rounded border px-2 py-1">
                No equipped animations or pose clips are available.
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={handleClearManifestAnimation}
                    disabled={!avatar}
                    className="text-2xs h-6 gap-1 px-2"
                    aria-label="Clear active manifest animation"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    Clear animation
                  </Button>
                </div>
                {manifestAnimations.map((entry) => {
                  const rowKey = getManifestAnimationRowKey(entry);
                  const isDisabled =
                    entry.disabled ||
                    (entry.type !== "vrma" && entry.type !== "animaPoseClip");
                  const isApplying = applyingAnimationFile === rowKey;
                  const canApply = Boolean(avatar) && !isDisabled;
                  const selectedWeight =
                    manifestAnimationWeights[rowKey] ??
                    getManifestAnimationDefaultWeight(entry);
                  const loopType = normalizeLoopType(entry.loop_type);
                  const loopSummary =
                    typeof entry.loop_count === "number"
                      ? `${loopType} × ${entry.loop_count === -1 ? "∞" : entry.loop_count}`
                      : loopType;
                  const emotionKeys = Object.keys(entry.emotions);
                  const emotionSummary =
                    emotionKeys.length > 0
                      ? truncateMiddle(emotionKeys.join(", "), 24)
                      : "neutral";

                  return (
                    <div
                      key={rowKey}
                      className={cn(
                        "rounded border px-2 py-1.5",
                        isDisabled
                          ? "border-border/60 bg-muted/20 opacity-70"
                          : "border-border/60",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="text-2xs min-w-0 truncate font-mono"
                          title={entry.name}
                        >
                          {entry.name}
                        </span>
                        <div className="flex items-center gap-1">
                          <span className="border-border/60 text-muted-foreground rounded border px-1 py-0 font-mono text-[9px]">
                            {entry.source}
                          </span>
                          {isDisabled ? (
                            <span className="rounded border border-amber-500/40 px-1 py-0 font-mono text-[9px] text-amber-700 dark:text-amber-300">
                              unsupported
                            </span>
                          ) : null}
                          {entry.type === "animaPoseClip" ? (
                            <span className="border-primary/40 text-primary rounded border px-1 py-0 font-mono text-[9px]">
                              poseClip
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div
                        className="text-muted-foreground text-2xs mt-0.5 truncate font-mono"
                        title={entry.file}
                      >
                        {truncateMiddle(entry.file, 48)}
                      </div>
                      <div className="text-muted-foreground text-2xs mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono">
                        <span>type: {entry.animation_type ?? "-"}</span>
                        <span>emotion: {emotionSummary}</span>
                        <span>loop: {loopSummary}</span>
                        <span>scale: {formatNumber(entry.time_scale, 2)}</span>
                        <span>weight: {formatNumber(selectedWeight, 2)}</span>
                      </div>
                      {entry.type === "vrma" ? (
                        <div className="mt-1.5 grid grid-cols-[3rem_minmax(0,1fr)_2.25rem] items-center gap-1.5">
                          <span className="text-muted-foreground text-2xs font-mono">
                            weight
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={selectedWeight}
                            onChange={(event) =>
                              handleManifestAnimationWeightChange(rowKey, event)
                            }
                            disabled={!canApply || isApplying}
                            className="accent-primary h-3 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={`Animation weight for ${entry.name}`}
                          />
                          <span className="text-muted-foreground text-2xs text-right font-mono">
                            {formatNumber(selectedWeight, 2)}
                          </span>
                        </div>
                      ) : null}
                      <div className="mt-1.5 flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void handleApplyManifestAnimation(
                              entry,
                              selectedWeight,
                            )
                          }
                          disabled={!canApply || isApplying}
                          className="text-2xs h-6 px-2"
                        >
                          {isApplying ? "Applying..." : "Apply"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
        </CardContent>
      </Card>
    </div>
  );
}
