import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Eraser, Play, RefreshCw, RotateCcw, Square } from "lucide-react";

import type {
  AnimaPose,
  AnimaPoseClipV2,
  AvatarPoseClipSnapshot,
  AvatarPoseSnapshot,
  BounceProceduralAnimationParams,
  BreathingProceduralAnimationParams,
  CursorLookAtProceduralAnimationParams,
  EmotionPostureGroup,
  EmotionPostureLevel,
  EmotionPostureProceduralAnimationParams,
  EmotionPostureTarget,
  HeadNodProceduralAnimationParams,
  HeadSideTiltProceduralAnimationParams,
  AvatarPlannerDebugSnapshot,
  AvatarPlannerPendingEventDebugSnapshot,
  AvatarPlannerPoseClip,
  AvatarPlannerProceduralStint,
  AvatarPlannerVrmaDebugSnapshot,
  ParticleVFXAnchor,
  ParticleVFXControllerSnapshot,
  ParticleVFXTransformAxisTriple,
  ProceduralAnimationLayerSnapshot,
  ReactionClipPlayerSnapshot,
  SpringBoneSemantic,
  SpringBonePhysicsParams,
  SpringBonePhysicsSnapshot,
  SwayProceduralAnimationParams,
  TalkingHandsProceduralAnimationParams,
} from "@/lib/avatar";
import {
  AVATAR_POSE_IDS,
  AVATAR_PARTICLE_VFX_CATALOG,
  PARTICLE_VFX_ANCHORS,
  RELAXED_REST_POSE_ID,
  analyzeAnimaPoseClipChannels,
  cloneParticleVFXTransform,
  createDefaultParticleVFXTransform,
  SUPPORTED_EMOTION_POSTURE_GROUPS,
  countAnimaPoseClipEventsByKind,
  getAnimaPoseClipTimelineDuration,
  getParticleVFXCatalogEntryById,
  getResolvedAvatarPose,
  type AnimaPoseClipChannelAnalysis,
  type AnimaPoseClipEventKindCounts,
  type AnimaPoseClipPlayback,
} from "@/lib/avatar";
import { BUILT_IN_AVATAR_MOTION_CATALOG } from "@/lib/avatar/motion/AvatarMotionCatalog";
import {
  REACTION_INTENSITIES,
  type EmotionReactionIntensity,
} from "@/lib/avatar/reactionPools";
import {
  formatReactionClipCells,
  reactionClipCells,
  reactionClipMatchesFilters,
  type ReactionClipCell,
} from "./reactionClipCatalog";
import { startPlannerGestureDebugRun } from "@/lib/avatar/planner/startPlannerGestureDebugRun";
import { createLogger } from "@/lib/logger";
import {
  EMOTION_GROUPS,
  EMOTION_GROUP_MEMBERS,
  TRACKED_EMOTIONS,
  formatEmotionGroupLabel,
  formatTrackedEmotionLabel,
  groupForEmotion,
  type EmotionGroup,
  type TrackedEmotion,
} from "@/lib/emotion";
import { useAnimationDebugStore } from "@/stores/animation-debug-store";
import { useAvatarRuntimeStore } from "@/stores/avatar-runtime-store";
import { Button } from "@/ui/components/button";
import { SectionedModalFrame } from "@/ui/components/sectioned-modal-frame";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import { Slider } from "@/ui/components/slider";
import { Switch } from "@/ui/components/switch";
import {
  BodyCell,
  EmptyState,
  HeaderCell,
  KeyValueGrid,
  NumberInputControl,
  Panel,
  Table,
} from "./vrm-editor/controls";

const sections = [
  "Breathing",
  "Sway",
  "Bounce",
  "Head Nods",
  "Head Side Tilt",
  "Cursor Look At",
  "Talking Hands",
  "Emotion Posture",
  "Spring Bones",
  "PoseController",
  "PoseController Clips",
  "Reactions",
  "Avatar Planner",
  "Particle VFX",
  "Runtime",
] as const;

const logger = createLogger("AnimationDebugModal");

type AnimationDebugSection = (typeof sections)[number];
type BreathingSliderKey =
  | "weight"
  | Exclude<keyof BreathingProceduralAnimationParams, "enabled">;
type SwaySliderKey =
  | "weight"
  | Exclude<keyof SwayProceduralAnimationParams, "enabled">;
type BounceSliderKey =
  | "weight"
  | Exclude<keyof BounceProceduralAnimationParams, "enabled">;
type HeadNodSliderKey =
  | "weight"
  | Exclude<keyof HeadNodProceduralAnimationParams, "enabled">;
type HeadSideTiltSliderKey =
  | "weight"
  | Exclude<keyof HeadSideTiltProceduralAnimationParams, "enabled">;
type CursorLookAtSliderKey =
  | "weight"
  | Exclude<keyof CursorLookAtProceduralAnimationParams, "enabled">;
type TalkingHandsSliderKey =
  | "weight"
  | Exclude<
      keyof TalkingHandsProceduralAnimationParams,
      "enabled" | "microTwistMode" | "secondaryMicroTwistAxis"
    >;
type EmotionPostureSliderKey = Exclude<
  keyof EmotionPostureProceduralAnimationParams,
  | "enabled"
  | "plannerEnabled"
  | "debugModeEnabled"
  | "debugGroup"
  | "debugLevel"
  | "presets"
>;
type EmotionPostureDebugLevelOption = `${EmotionPostureLevel}`;
type EmotionPostureTargetKey = keyof EmotionPostureTarget;
type EmotionPosturePresetDraft =
  EmotionPostureProceduralAnimationParams["presets"][EmotionPostureGroup];
type SpringBoneSliderKey = Exclude<
  keyof SpringBonePhysicsParams,
  "enabled" | "gusts" | "helpersVisible"
>;

const talkingHandsMicroTwistModeOptions = [
  { value: "forearmRoll", label: "Forearm roll" },
  { value: "forearmRollWithHandFollow", label: "Forearm + hand" },
  { value: "handOnly", label: "Hand only" },
] as const satisfies ReadonlyArray<{
  value: TalkingHandsProceduralAnimationParams["microTwistMode"];
  label: string;
}>;

const talkingHandsSecondaryMicroTwistAxisOptions = [
  { value: "x", label: "Local X" },
  { value: "y", label: "Local Y" },
  { value: "z", label: "Local Z" },
] as const satisfies ReadonlyArray<{
  value: TalkingHandsProceduralAnimationParams["secondaryMicroTwistAxis"];
  label: string;
}>;

const emotionPostureGroupOptions = SUPPORTED_EMOTION_POSTURE_GROUPS.map(
  (group) => ({
    value: group,
    label: formatEmotionGroupLabel(group),
  }),
) satisfies ReadonlyArray<{ value: EmotionPostureGroup; label: string }>;

const emotionPostureLevelOptions = [
  { value: "1", label: "Level 1" },
  { value: "2", label: "Level 2" },
  { value: "3", label: "Level 3" },
] as const satisfies ReadonlyArray<{
  value: EmotionPostureDebugLevelOption;
  label: string;
}>;

const breathingSliders: Array<{
  key: BreathingSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  {
    key: "weight",
    label: "Layer weight",
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => value.toFixed(2),
  },
  {
    key: "intensity",
    label: "Intensity",
    min: 0,
    max: 2,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "bpm",
    label: "BPM",
    min: 6,
    max: 24,
    step: 1,
    format: (value) => Math.round(value).toString(),
  },
  {
    key: "chest",
    label: "Chest",
    min: 0,
    max: 4,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "spine",
    label: "Spine",
    min: 0,
    max: 3,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "shoulder",
    label: "Shoulders",
    min: 0,
    max: 3,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "head",
    label: "Head",
    min: 0,
    max: 2,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "sway",
    label: "Sway",
    min: 0,
    max: 3,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "lag",
    label: "Lag",
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => value.toFixed(2),
  },
];

const swaySliders: Array<{
  key: SwaySliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  {
    key: "weight",
    label: "Layer weight",
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => value.toFixed(2),
  },
  {
    key: "intensity",
    label: "Intensity",
    min: 0,
    max: 2,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "cpm",
    label: "CPM",
    min: 3,
    max: 18,
    step: 1,
    format: (value) => Math.round(value).toString(),
  },
  {
    key: "idleActiveSec",
    label: "Idle active",
    min: 0,
    max: 60,
    step: 0.5,
    format: formatSeconds,
  },
  {
    key: "idleIntervalSec",
    label: "Idle interval",
    min: 1,
    max: 120,
    step: 1,
    format: formatSeconds,
  },
  {
    key: "idleEnterBlendSec",
    label: "Idle enter blend",
    min: 0,
    max: 4,
    step: 0.05,
    format: formatSeconds,
  },
  {
    key: "idleExitBlendSec",
    label: "Idle exit blend",
    min: 0,
    max: 6,
    step: 0.05,
    format: formatSeconds,
  },
  {
    key: "sideShift",
    label: "Side shift",
    min: 0,
    max: 4,
    step: 0.1,
    format: formatCentimeters,
  },
  {
    key: "torsoLean",
    label: "Torso lean",
    min: 0,
    max: 4,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "headFollowTilt",
    label: "Head follow tilt",
    min: -20,
    max: 20,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "neckFollowTilt",
    label: "Neck follow tilt",
    min: -10,
    max: 10,
    step: 0.05,
    format: formatDegrees,
  },
  {
    key: "shoulderDrift",
    label: "Shoulder drift",
    min: 0,
    max: 2,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "lag",
    label: "Lag",
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => value.toFixed(2),
  },
];

const bounceSliders: Array<{
  key: BounceSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  {
    key: "weight",
    label: "Layer weight",
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => value.toFixed(2),
  },
  {
    key: "intensity",
    label: "Intensity",
    min: 0,
    max: 2,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "bpm",
    label: "BPM",
    min: 30,
    max: 140,
    step: 1,
    format: (value) => Math.round(value).toString(),
  },
  {
    key: "pauseMinSec",
    label: "Pause min",
    min: 0,
    max: 4,
    step: 0.05,
    format: formatSeconds,
  },
  {
    key: "pauseMaxSec",
    label: "Pause max",
    min: 0,
    max: 6,
    step: 0.05,
    format: formatSeconds,
  },
  {
    key: "bodyLift",
    label: "Body lift",
    min: 0,
    max: 8,
    step: 0.1,
    format: formatCentimeters,
  },
  {
    key: "footFlexion",
    label: "Foot flexion",
    min: 0,
    max: 30,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "headNod",
    label: "Head nod",
    min: 0,
    max: 6,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "lag",
    label: "Lag",
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => value.toFixed(2),
  },
];

const headNodSliders: Array<{
  key: HeadNodSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  {
    key: "weight",
    label: "Layer weight",
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => value.toFixed(2),
  },
  {
    key: "intensity",
    label: "Intensity",
    min: 0,
    max: 2,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "pauseMinSec",
    label: "Pause min",
    min: 0.2,
    max: 5,
    step: 0.1,
    format: formatSeconds,
  },
  {
    key: "pauseMaxSec",
    label: "Pause max",
    min: 0.5,
    max: 10,
    step: 0.1,
    format: formatSeconds,
  },
  {
    key: "amplitudeMin",
    label: "Amplitude min",
    min: 0,
    max: 6,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "amplitudeMax",
    label: "Amplitude max",
    min: 1,
    max: 16,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "smallNodMaxCount",
    label: "Small count",
    min: 1,
    max: 6,
    step: 1,
    format: formatInteger,
  },
  {
    key: "largeNodMaxCount",
    label: "Large count",
    min: 1,
    max: 3,
    step: 1,
    format: formatInteger,
  },
  {
    key: "upNodChance",
    label: "Up chance",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "upDownChance",
    label: "Up-down chance",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "torsoFollow",
    label: "Torso follow",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "sideTilt",
    label: "Side tilt",
    min: 0,
    max: 4,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "speed",
    label: "Speed",
    min: 0.5,
    max: 2,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
];

const headSideTiltSliders: Array<{
  key: HeadSideTiltSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  {
    key: "weight",
    label: "Layer weight",
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => value.toFixed(2),
  },
  {
    key: "intensity",
    label: "Intensity",
    min: 0,
    max: 2,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "pauseMinSec",
    label: "Pause min",
    min: 0.2,
    max: 6,
    step: 0.1,
    format: formatSeconds,
  },
  {
    key: "pauseMaxSec",
    label: "Pause max",
    min: 0.5,
    max: 10,
    step: 0.1,
    format: formatSeconds,
  },
  {
    key: "tiltMin",
    label: "Tilt min",
    min: 0,
    max: 8,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "tiltMax",
    label: "Tilt max",
    min: 1,
    max: 18,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "downPitch",
    label: "Down pitch",
    min: 0,
    max: 8,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "yawAmount",
    label: "Yaw amount",
    min: 0,
    max: 6,
    step: 0.1,
    format: formatDegrees,
  },
  {
    key: "holdMinSec",
    label: "Hold min",
    min: 0,
    max: 1.5,
    step: 0.05,
    format: formatSeconds,
  },
  {
    key: "holdMaxSec",
    label: "Hold max",
    min: 0.05,
    max: 3,
    step: 0.05,
    format: formatSeconds,
  },
  {
    key: "transitionMinSec",
    label: "Transition min",
    min: 0.15,
    max: 2,
    step: 0.05,
    format: formatSeconds,
  },
  {
    key: "transitionMaxSec",
    label: "Transition max",
    min: 0.2,
    max: 3,
    step: 0.05,
    format: formatSeconds,
  },
  {
    key: "torsoFollow",
    label: "Torso follow",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "alternateSideChance",
    label: "Alternate chance",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "speed",
    label: "Speed",
    min: 0.5,
    max: 2,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
];

const cursorLookAtSliders: Array<{
  key: CursorLookAtSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  {
    key: "weight",
    label: "Layer weight",
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => value.toFixed(2),
  },
  {
    key: "intensity",
    label: "Intensity",
    min: 0,
    max: 2,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "durationMinSec",
    label: "Track min",
    min: 1,
    max: 20,
    step: 0.1,
    format: formatSeconds,
  },
  {
    key: "durationMaxSec",
    label: "Track max",
    min: 1,
    max: 30,
    step: 0.1,
    format: formatSeconds,
  },
  {
    key: "pauseMinSec",
    label: "Pause min",
    min: 0,
    max: 20,
    step: 0.1,
    format: formatSeconds,
  },
  {
    key: "pauseMaxSec",
    label: "Pause max",
    min: 0,
    max: 30,
    step: 0.1,
    format: formatSeconds,
  },
  {
    key: "eyeLookAtStrength",
    label: "Eye look strength",
    min: 0,
    max: 1,
    step: 0.01,
    format: formatRatio,
  },
  {
    key: "headFollowStrength",
    label: "Head follow",
    min: 0,
    max: 1,
    step: 0.01,
    format: formatRatio,
  },
  {
    key: "neckFollowStrength",
    label: "Neck follow",
    min: 0,
    max: 1,
    step: 0.01,
    format: formatRatio,
  },
  {
    key: "torsoFollowStrength",
    label: "Torso follow",
    min: 0,
    max: 1,
    step: 0.01,
    format: formatRatio,
  },
  {
    key: "driftAmount",
    label: "Drift amount",
    min: 0,
    max: 0.4,
    step: 0.01,
    format: (value) => `${value.toFixed(2)}m`,
  },
  {
    key: "driftSpeed",
    label: "Drift speed",
    min: 0,
    max: 2,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
];

const talkingHandsSliders: Array<{
  key: TalkingHandsSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  {
    key: "weight",
    label: "Layer weight",
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => value.toFixed(2),
  },
  {
    key: "intensity",
    label: "Intensity",
    min: 0,
    max: 2,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "elbowSideDriftMin",
    label: "Elbow side drift min",
    min: -60,
    max: 0,
    step: 1,
    format: formatDegrees,
  },
  {
    key: "elbowSideDriftMax",
    label: "Elbow side drift max",
    min: 0,
    max: 60,
    step: 1,
    format: formatDegrees,
  },
  {
    key: "palmDirectionRange",
    label: "Palm direction range",
    min: 0,
    max: 90,
    step: 1,
    format: formatDegrees,
  },
  {
    key: "shoulderBeat",
    label: "Shoulder beat",
    min: -30,
    max: 30,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "shoulderForward",
    label: "Shoulder forward",
    min: -60,
    max: 60,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "asymmetry",
    label: "Asymmetry",
    min: 0,
    max: 0.5,
    step: 0.01,
    format: formatRatio,
  },
  {
    key: "gestureDurationSec",
    label: "Manual group duration",
    min: 0.1,
    max: 4,
    step: 0.05,
    format: formatSeconds,
  },
  {
    key: "speechGestureEntrySec",
    label: "Speech gesture entry",
    min: 0.05,
    max: 1.2,
    step: 0.01,
    format: formatSeconds,
  },
  {
    key: "speechGestureEntryGraceSec",
    label: "Speech entry grace",
    min: 0,
    max: 0.3,
    step: 0.01,
    format: formatSeconds,
  },
  {
    key: "speechGestureReturnSec",
    label: "Speech gesture return",
    min: 0.05,
    max: 1.2,
    step: 0.01,
    format: formatSeconds,
  },
  {
    key: "speechBeatMinSpacingSec",
    label: "Speech beat spacing",
    min: 0.05,
    max: 0.8,
    step: 0.01,
    format: formatSeconds,
  },
  {
    key: "speechBeatPulseAttackSec",
    label: "Speech beat attack",
    min: 0.02,
    max: 0.4,
    step: 0.01,
    format: formatSeconds,
  },
  {
    key: "speechBeatPulseReleaseSec",
    label: "Speech beat release",
    min: 0.02,
    max: 0.4,
    step: 0.01,
    format: formatSeconds,
  },
  {
    key: "speechChunkSkipChance",
    label: "Speech chunk skip",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "elbowBendMin",
    label: "Elbow bend min",
    min: -160,
    max: 160,
    step: 1,
    format: formatDegrees,
  },
  {
    key: "elbowBendMax",
    label: "Elbow bend max",
    min: -160,
    max: 160,
    step: 1,
    format: formatDegrees,
  },
  {
    key: "elbowBendAsymmetry",
    label: "Elbow bend asymmetry",
    min: 0,
    max: 45,
    step: 1,
    format: formatDegrees,
  },
  {
    key: "microBendCount",
    label: "Micro bend count",
    min: 0,
    max: 8,
    step: 1,
    format: formatInteger,
  },
  {
    key: "microBendAmount",
    label: "Micro bend amount",
    min: -45,
    max: 45,
    step: 1,
    format: formatDegrees,
  },
  {
    key: "microBendPauseChance",
    label: "Micro pause chance",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "microBendPauseMinSec",
    label: "Micro pause min",
    min: 0,
    max: 0.5,
    step: 0.01,
    format: formatSeconds,
  },
  {
    key: "microBendPauseMaxSec",
    label: "Micro pause max",
    min: 0,
    max: 0.8,
    step: 0.01,
    format: formatSeconds,
  },
  {
    key: "restThumbCurlOffset",
    label: "Rest thumb curl",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "restThumbMetacarpalCurlOffset",
    label: "Rest thumb metacarpal curl",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "restThumbProximalCurlOffset",
    label: "Rest thumb proximal curl",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "restThumbDistalCurlOffset",
    label: "Rest thumb distal curl",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "restThumbSpreadOffset",
    label: "Rest thumb spread",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "restIndexFingerCurlOffset",
    label: "Rest index curl",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "restMiddleFingerCurlOffset",
    label: "Rest middle curl",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "restRingFingerCurlOffset",
    label: "Rest ring curl",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "restLittleFingerCurlOffset",
    label: "Rest little curl",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "restFingerCurlJitter",
    label: "Rest curl jitter",
    min: 0,
    max: 15,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "microFingerUncurlAmount",
    label: "Micro finger uncurl",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "microFingerUncurlVariance",
    label: "Finger uncurl variance",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "microThumbUncurlAmount",
    label: "Micro thumb uncurl",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "microThumbUncurlVariance",
    label: "Thumb uncurl variance",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "microThumbUnspreadAmount",
    label: "Micro thumb unsplay",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "microHandFlexAmount",
    label: "Micro hand flex",
    min: -45,
    max: 45,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "microHeadNodAmount",
    label: "Micro head nod",
    min: -20,
    max: 20,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "microEntryBlend",
    label: "First micro settle",
    min: 0.25,
    max: 4,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "armLagSec",
    label: "Arm lag",
    min: 0,
    max: 0.35,
    step: 0.005,
    format: (value) => `${value.toFixed(2)}s`,
  },
  {
    key: "palmLagSec",
    label: "Palm/twist lag",
    min: 0,
    max: 0.45,
    step: 0.005,
    format: (value) => `${value.toFixed(2)}s`,
  },
  {
    key: "fingerLagSec",
    label: "Finger lag",
    min: 0,
    max: 0.6,
    step: 0.005,
    format: (value) => `${value.toFixed(2)}s`,
  },
  {
    key: "fingerCascadeLag",
    label: "Finger cascade lag",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "microTwistAmount",
    label: "Micro twist amount",
    min: -90,
    max: 90,
    step: 1,
    format: formatDegrees,
  },
  {
    key: "secondaryMicroTwistMin",
    label: "Secondary micro twist min",
    min: -90,
    max: 90,
    step: 1,
    format: formatDegrees,
  },
  {
    key: "secondaryMicroTwistMax",
    label: "Secondary micro twist max",
    min: -90,
    max: 90,
    step: 1,
    format: formatDegrees,
  },
  {
    key: "oneHandChance",
    label: "One hand chance",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "bothHandsChance",
    label: "Both hands chance",
    min: 0,
    max: 1,
    step: 0.05,
    format: formatRatio,
  },
  {
    key: "speed",
    label: "Speed",
    min: 0,
    max: 1.0,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
];

const emotionPostureSliders: Array<{
  key: EmotionPostureSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  {
    key: "enterBlendSec",
    label: "Enter blend",
    min: 0,
    max: 3,
    step: 0.05,
    format: formatSeconds,
  },
  {
    key: "exitBlendSec",
    label: "Exit blend",
    min: 0,
    max: 3,
    step: 0.05,
    format: formatSeconds,
  },
];

const emotionPostureTargetSliders: Array<{
  key: EmotionPostureTargetKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  {
    key: "hipsPitchDeg",
    label: "Hips pitch",
    min: -20,
    max: 20,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "spinePitchDeg",
    label: "Spine pitch",
    min: -25,
    max: 25,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "chestPitchDeg",
    label: "Chest pitch",
    min: -30,
    max: 30,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "upperChestPitchDeg",
    label: "Upper chest",
    min: -30,
    max: 30,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "neckPitchDeg",
    label: "Neck pitch",
    min: -25,
    max: 25,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "headPitchDeg",
    label: "Head pitch",
    min: -30,
    max: 30,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "headYawDeg",
    label: "Head yaw",
    min: -30,
    max: 30,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "headRollDeg",
    label: "Head roll",
    min: -30,
    max: 30,
    step: 0.5,
    format: formatDegrees,
  },
  {
    key: "shoulderLiftCm",
    label: "Shoulders",
    min: -8,
    max: 8,
    step: 0.25,
    format: (value) => `${value.toFixed(1)}cm`,
  },
];

const springBoneSliders: Array<{
  key: SpringBoneSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  {
    key: "gravityMultiplier",
    label: "Gravity",
    min: 0,
    max: 3,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "dragMultiplier",
    label: "Drag",
    min: 0,
    max: 3,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "windStrength",
    label: "Wind",
    min: 0,
    max: 3,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "windDirectionDeg",
    label: "Wind direction",
    min: 0,
    max: 360,
    step: 1,
    format: (value) => `${Math.round(value)}deg`,
  },
  {
    key: "updraftStrength",
    label: "Updraft",
    min: 0,
    max: 3,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
  {
    key: "updraftRadius",
    label: "Updraft radius",
    min: 0.1,
    max: 2,
    step: 0.05,
    format: (value) => `${value.toFixed(2)}m`,
  },
  {
    key: "fluctuation",
    label: "Fluctuation",
    min: 0,
    max: 1,
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
];

type PoseCatalogOption = {
  id: string;
  name: string;
  humanoidCount: number;
  expressionCount: number;
};

type PoseClipCatalogOption = {
  id: string;
  name: string;
  durationSec: number;
  loop: boolean;
  keyframeCount: number;
  eventKindCounts: AnimaPoseClipEventKindCounts;
};

type ReactionClipCatalogOption = PoseClipCatalogOption & {
  /** The cells whose pools hold this clip; empty when none does. */
  cells: ReactionClipCell[];
  lifetimeSummary: string;
  channelAnalysis: AnimaPoseClipChannelAnalysis;
  channelSummary: string;
};

const allReactionFilterValue = "all" as const;
type ReactionFilterValue = typeof allReactionFilterValue;
type ReactionGroupFilter = EmotionGroup | ReactionFilterValue;
type ReactionEmotionFilter = TrackedEmotion | ReactionFilterValue;
type ReactionIntensityFilter =
  | `${EmotionReactionIntensity}`
  | ReactionFilterValue;

const reactionGroupFilterOptions: ReadonlyArray<{
  value: ReactionGroupFilter;
  label: string;
}> = [
  { value: allReactionFilterValue, label: "All groups" },
  ...EMOTION_GROUPS.map((group) => ({
    value: group,
    label: formatEmotionGroupLabel(group),
  })),
];

const reactionEmotionFilterOptions: ReadonlyArray<{
  value: ReactionEmotionFilter;
  label: string;
  group: EmotionGroup | null;
}> = [
  { value: allReactionFilterValue, label: "All emotions", group: null },
  ...TRACKED_EMOTIONS.map((emotion) => ({
    value: emotion,
    label: formatTrackedEmotionLabel(emotion),
    group: groupForEmotion(emotion),
  })),
];

const reactionIntensityFilterOptions: ReadonlyArray<{
  value: ReactionIntensityFilter;
  label: string;
}> = [
  { value: allReactionFilterValue, label: "All levels" },
  ...REACTION_INTENSITIES.map((level) => ({
    value: `${level}` as const,
    label: `Level ${level}`,
  })),
];

const poseCatalogOptions: PoseCatalogOption[] = AVATAR_POSE_IDS.map(
  (poseId) => {
    const pose = getResolvedAvatarPose(poseId);
    return {
      id: poseId,
      name: pose.name,
      humanoidCount: Object.keys(pose.humanoid ?? {}).length,
      expressionCount: Object.keys(pose.expressions ?? {}).length,
    };
  },
);

const builtInPoseClipCatalogOptions: PoseClipCatalogOption[] =
  BUILT_IN_AVATAR_MOTION_CATALOG.listPoseClips().map((descriptor) =>
    createPoseClipCatalogOption(
      descriptor.runtimeId,
      descriptor.displayName,
      BUILT_IN_AVATAR_MOTION_CATALOG.getPoseClip(descriptor.runtimeId),
    ),
  );

const defaultSelectedPoseClipId = builtInPoseClipCatalogOptions[0]?.id ?? "";

const builtInReactionClipCells = reactionClipCells(
  BUILT_IN_AVATAR_MOTION_CATALOG.listReactionPools(),
);
const builtInReactionClipCatalogOptions: ReactionClipCatalogOption[] =
  BUILT_IN_AVATAR_MOTION_CATALOG.listReactionClips().map((descriptor) =>
    createReactionClipCatalogOption(
      descriptor.runtimeId,
      descriptor.displayName,
      builtInReactionClipCells.get(descriptor.runtimeId) ?? [],
      BUILT_IN_AVATAR_MOTION_CATALOG.getReactionClip(descriptor.runtimeId),
    ),
  );

const defaultSelectedReactionClipId =
  builtInReactionClipCatalogOptions[0]?.id ?? "";
const particleVFXCatalogOptions = [...AVATAR_PARTICLE_VFX_CATALOG];
const defaultParticleVFXEntry = particleVFXCatalogOptions[0] ?? null;
const defaultSelectedParticleVFXEffectId =
  particleVFXCatalogOptions[0]?.id ?? "";
type ParticleVFXDebugLifetimeMode = "duration" | "manual";

function getDebugParticleVFXAppliedId(effectId: string): string {
  return `debug:particle-vfx:${effectId}`;
}

function cloneParticleVFXAxisTriple(
  value: ParticleVFXTransformAxisTriple,
): ParticleVFXTransformAxisTriple {
  return {
    x: value.x,
    y: value.y,
    z: value.z,
  };
}

function createPoseClipCatalogOption(
  id: string,
  fallbackName: string,
  clip: AnimaPoseClipV2 | null,
): PoseClipCatalogOption {
  return {
    id,
    name: clip?.name ?? fallbackName,
    durationSec: clip ? getAnimaPoseClipTimelineDuration(clip) : 0,
    loop: clip?.loop === true,
    keyframeCount: clip?.beats.length ?? 0,
    eventKindCounts: countAnimaPoseClipEventsByKind(clip),
  };
}

function createReactionClipCatalogOption(
  id: string,
  fallbackName: string,
  cells: ReactionClipCell[],
  clip: AnimaPoseClipV2 | null,
): ReactionClipCatalogOption {
  const channelAnalysis = clip
    ? analyzeAnimaPoseClipChannels(clip, (poseId) => {
        try {
          return BUILT_IN_AVATAR_MOTION_CATALOG.getResolvedPose(poseId);
        } catch {
          return null;
        }
      })
    : {
        humanoid: false,
        expressions: false,
        avatarVfx: false,
        sceneVfx: false,
        particleVfx: false,
        sfx: false,
      };
  return {
    ...createPoseClipCatalogOption(id, fallbackName, clip),
    cells,
    lifetimeSummary: clip ? formatClipPlaybackLifetime(clip.playback) : "lazy",
    channelAnalysis,
    channelSummary: clip ? formatClipChannelAnalysis(channelAnalysis) : "lazy",
  };
}

export function AnimationDebugModal({ animaLabel }: { animaLabel?: string }) {
  const open = useAnimationDebugStore((state) => state.isOpen);
  const setOpen = useAnimationDebugStore((state) => state.setOpen);
  const target = useAnimationDebugStore((state) => state.target);
  const breathingDraft = useAnimationDebugStore(
    (state) => state.breathingDraft,
  );
  const swayDraft = useAnimationDebugStore((state) => state.swayDraft);
  const bounceDraft = useAnimationDebugStore((state) => state.bounceDraft);
  const headNodDraft = useAnimationDebugStore((state) => state.headNodDraft);
  const headSideTiltDraft = useAnimationDebugStore(
    (state) => state.headSideTiltDraft,
  );
  const cursorLookAtDraft = useAnimationDebugStore(
    (state) => state.cursorLookAtDraft,
  );
  const talkingHandsDraft = useAnimationDebugStore(
    (state) => state.talkingHandsDraft,
  );
  const emotionPostureDraft = useAnimationDebugStore(
    (state) => state.emotionPostureDraft,
  );
  const playTalkingHandsGroup = useAnimationDebugStore(
    (state) => state.playTalkingHandsGroup,
  );
  const replayLastTalkingHandsSpeechGroup = useAnimationDebugStore(
    (state) => state.replayLastTalkingHandsSpeechGroup,
  );
  const springBoneDraft = useAnimationDebugStore(
    (state) => state.springBoneDraft,
  );
  const springBoneProfileDrafts = useAnimationDebugStore(
    (state) => state.springBoneProfileDrafts,
  );
  const automaticAnimationPlaybackEnabled = useAnimationDebugStore(
    (state) => state.automaticAnimationPlaybackEnabled,
  );
  const vrmaRootedPlaybackEnabled = useAnimationDebugStore(
    (state) => state.vrmaRootedPlaybackEnabled,
  );
  const idleStintQuietIntervalSec = useAnimationDebugStore(
    (state) => state.idleStintQuietIntervalSec,
  );
  const syncFromAvatar = useAnimationDebugStore(
    (state) => state.syncFromAvatar,
  );
  const updateBreathingParams = useAnimationDebugStore(
    (state) => state.updateBreathingParams,
  );
  const updateBreathingWeight = useAnimationDebugStore(
    (state) => state.updateBreathingWeight,
  );
  const resetBreathingDefaults = useAnimationDebugStore(
    (state) => state.resetBreathingDefaults,
  );
  const updateSwayParams = useAnimationDebugStore(
    (state) => state.updateSwayParams,
  );
  const updateSwayWeight = useAnimationDebugStore(
    (state) => state.updateSwayWeight,
  );
  const resetSwayDefaults = useAnimationDebugStore(
    (state) => state.resetSwayDefaults,
  );
  const updateBounceParams = useAnimationDebugStore(
    (state) => state.updateBounceParams,
  );
  const updateBounceWeight = useAnimationDebugStore(
    (state) => state.updateBounceWeight,
  );
  const resetBounceDefaults = useAnimationDebugStore(
    (state) => state.resetBounceDefaults,
  );
  const updateHeadNodParams = useAnimationDebugStore(
    (state) => state.updateHeadNodParams,
  );
  const updateHeadNodWeight = useAnimationDebugStore(
    (state) => state.updateHeadNodWeight,
  );
  const resetHeadNodDefaults = useAnimationDebugStore(
    (state) => state.resetHeadNodDefaults,
  );
  const updateHeadSideTiltParams = useAnimationDebugStore(
    (state) => state.updateHeadSideTiltParams,
  );
  const updateHeadSideTiltWeight = useAnimationDebugStore(
    (state) => state.updateHeadSideTiltWeight,
  );
  const resetHeadSideTiltDefaults = useAnimationDebugStore(
    (state) => state.resetHeadSideTiltDefaults,
  );
  const updateCursorLookAtParams = useAnimationDebugStore(
    (state) => state.updateCursorLookAtParams,
  );
  const updateCursorLookAtWeight = useAnimationDebugStore(
    (state) => state.updateCursorLookAtWeight,
  );
  const resetCursorLookAtDefaults = useAnimationDebugStore(
    (state) => state.resetCursorLookAtDefaults,
  );
  const updateTalkingHandsParams = useAnimationDebugStore(
    (state) => state.updateTalkingHandsParams,
  );
  const updateTalkingHandsWeight = useAnimationDebugStore(
    (state) => state.updateTalkingHandsWeight,
  );
  const resetTalkingHandsDefaults = useAnimationDebugStore(
    (state) => state.resetTalkingHandsDefaults,
  );
  const updateEmotionPostureParams = useAnimationDebugStore(
    (state) => state.updateEmotionPostureParams,
  );
  const resetEmotionPostureDefaults = useAnimationDebugStore(
    (state) => state.resetEmotionPostureDefaults,
  );
  const updateSpringBoneParams = useAnimationDebugStore(
    (state) => state.updateSpringBoneParams,
  );
  const updateSpringBoneProfileOverride = useAnimationDebugStore(
    (state) => state.updateSpringBoneProfileOverride,
  );
  const resetSpringBoneProfileDefaults = useAnimationDebugStore(
    (state) => state.resetSpringBoneProfileDefaults,
  );
  const resetSpringBoneDefaults = useAnimationDebugStore(
    (state) => state.resetSpringBoneDefaults,
  );
  const setAutomaticAnimationPlaybackEnabled = useAnimationDebugStore(
    (state) => state.setAutomaticAnimationPlaybackEnabled,
  );
  const setVrmaRootedPlaybackEnabled = useAnimationDebugStore(
    (state) => state.setVrmaRootedPlaybackEnabled,
  );
  const arkitLipSyncEnabled = useAnimationDebugStore(
    (state) => state.arkitLipSyncEnabled,
  );
  const arkitLipSyncAvailable = useAnimationDebugStore(
    (state) => state.arkitLipSyncAvailable,
  );
  const setArkitLipSyncEnabled = useAnimationDebugStore(
    (state) => state.setArkitLipSyncEnabled,
  );
  const setIdleStintQuietIntervalSec = useAnimationDebugStore(
    (state) => state.setIdleStintQuietIntervalSec,
  );
  const clearActiveOffsets = useAnimationDebugStore(
    (state) => state.clearActiveOffsets,
  );
  const activeRunId = useAvatarRuntimeStore((state) => state.activeRunId);
  const [activeSection, setActiveSection] =
    useState<AnimationDebugSection>("Breathing");
  const [selectedPoseId, setSelectedPoseId] =
    useState<string>(RELAXED_REST_POSE_ID);
  const [poseSnapshot, setPoseSnapshot] =
    useState<AvatarPoseSnapshot<AnimaPose> | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string>(
    defaultSelectedPoseClipId,
  );
  const [selectedReactionClipId, setSelectedReactionClipId] = useState<string>(
    defaultSelectedReactionClipId,
  );
  const [reactionGroupFilter, setReactionGroupFilter] =
    useState<ReactionGroupFilter>(allReactionFilterValue);
  const [reactionEmotionFilter, setReactionEmotionFilter] =
    useState<ReactionEmotionFilter>(allReactionFilterValue);
  const [reactionIntensityFilter, setReactionIntensityFilter] =
    useState<ReactionIntensityFilter>(allReactionFilterValue);
  const [selectedClipSnapshot, setSelectedClipSnapshot] =
    useState<AvatarPoseClipSnapshot | null>(null);
  const [activeClipSnapshot, setActiveClipSnapshot] =
    useState<AvatarPoseClipSnapshot | null>(null);
  const [reactionClipSnapshot, setReactionClipSnapshot] =
    useState<ReactionClipPlayerSnapshot | null>(null);
  const [avatarPlannerSnapshot, setAvatarPlannerSnapshot] =
    useState<AvatarPlannerDebugSnapshot | null>(null);
  const [selectedPlannerGestureId, setSelectedPlannerGestureId] =
    useState<string>("");
  const [lastPlannerDebugRunId, setLastPlannerDebugRunId] = useState<
    string | null
  >(null);
  const [selectedParticleVFXEffectId, setSelectedParticleVFXEffectId] =
    useState<string>(defaultSelectedParticleVFXEffectId);
  const [selectedParticleVFXAnchor, setSelectedParticleVFXAnchor] =
    useState<ParticleVFXAnchor>(
      defaultParticleVFXEntry?.defaultAnchor ?? "head",
    );
  const [particleVFXOffset, setParticleVFXOffset] =
    useState<ParticleVFXTransformAxisTriple>(() =>
      cloneParticleVFXAxisTriple(
        defaultParticleVFXEntry?.defaultTransform.offset ??
          createDefaultParticleVFXTransform().offset,
      ),
    );
  const [particleVFXDepthOffset, setParticleVFXDepthOffset] = useState<number>(
    defaultParticleVFXEntry?.defaultTransform.depthOffset ?? 0,
  );
  const [particleVFXDurationSec, setParticleVFXDurationSec] = useState<number>(
    defaultParticleVFXEntry?.defaultDurationSec ?? 2,
  );
  const [particleVFXLifetimeMode, setParticleVFXLifetimeMode] =
    useState<ParticleVFXDebugLifetimeMode>("duration");
  const [particleVFXSnapshot, setParticleVFXSnapshot] =
    useState<ParticleVFXControllerSnapshot | null>(null);

  const targetKey =
    target?.sourceKey ??
    target?.sourceUrl ??
    target?.avatar.sourceKey ??
    target?.avatar.scene?.uuid ??
    null;

  // The Avatar keeps its identity while optional motion entries arrive. Read
  // its current inventory instead of memoizing the initial empty catalog.
  const motionAnimations = target?.avatar.getMotionAnimations();
  const plannerGestureOptions = useMemo(() => {
    const byId = new Map<
      string,
      { id: string; name: string; type: "VRMA" | "Anima Pose Clip" }
    >();
    for (const entry of motionAnimations ?? []) {
      if (entry.animation_type !== "gesture") continue;
      const id = (entry.id ?? entry.file).trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        name: entry.name || id,
        type: entry.type === "animaPoseClip" ? "Anima Pose Clip" : "VRMA",
      });
    }
    return Array.from(byId.values()).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }, [motionAnimations]);

  useEffect(() => {
    if (
      selectedPlannerGestureId &&
      plannerGestureOptions.some(
        (option) => option.id === selectedPlannerGestureId,
      )
    ) {
      return;
    }
    setSelectedPlannerGestureId(plannerGestureOptions[0]?.id ?? "");
  }, [plannerGestureOptions, selectedPlannerGestureId]);

  useEffect(() => {
    if (open) {
      syncFromAvatar();
    }
  }, [open, syncFromAvatar, targetKey]);

  useEffect(() => {
    if (!target) {
      setPoseSnapshot(null);
      return;
    }
    setPoseSnapshot(target.avatar.getPoseSnapshot(selectedPoseId));
  }, [selectedPoseId, target, targetKey]);

  useEffect(() => {
    if (!target || !open) {
      setSelectedClipSnapshot(null);
      setActiveClipSnapshot(null);
      return;
    }

    const syncClipSnapshots = () => {
      setSelectedClipSnapshot(
        selectedClipId
          ? target.avatar.getClipSnapshot(selectedClipId)
          : target.avatar.getClipSnapshot(),
      );
      setActiveClipSnapshot(target.avatar.getClipSnapshot());
    };

    syncClipSnapshots();
    if (!target.avatar.isClipActive()) {
      return;
    }

    const interval = window.setInterval(syncClipSnapshots, 100);
    return () => window.clearInterval(interval);
  }, [activeClipSnapshot?.playing, open, selectedClipId, target, targetKey]);

  useEffect(() => {
    if (!target || !open) {
      setAvatarPlannerSnapshot(null);
      return;
    }

    const syncAvatarPlannerSnapshot = () => {
      setAvatarPlannerSnapshot(target.avatar.getAvatarPlannerDebugSnapshot());
    };

    syncAvatarPlannerSnapshot();
    const interval = window.setInterval(syncAvatarPlannerSnapshot, 500);
    return () => window.clearInterval(interval);
  }, [open, target, targetKey]);

  useEffect(() => {
    if (!target || !open) {
      setReactionClipSnapshot(null);
      return;
    }

    const syncReactionClipSnapshot = () => {
      setReactionClipSnapshot(target.avatar.getReactionClipSnapshot());
    };

    syncReactionClipSnapshot();
    const interval = window.setInterval(syncReactionClipSnapshot, 100);
    return () => window.clearInterval(interval);
  }, [open, target, targetKey]);

  useEffect(() => {
    if (!target || !open) {
      setParticleVFXSnapshot(null);
      return;
    }

    const syncParticleVFXSnapshot = () => {
      setParticleVFXSnapshot(
        target.avatar.particleVFXController?.getSnapshot() ?? null,
      );
    };

    syncParticleVFXSnapshot();
    const interval = window.setInterval(syncParticleVFXSnapshot, 250);
    return () => window.clearInterval(interval);
  }, [open, target, targetKey]);

  const snapshot = target?.avatar.getProceduralAnimationSnapshot() ?? null;
  const globalRestSnapshot =
    target?.avatar.getPoseSnapshot(RELAXED_REST_POSE_ID) ?? null;
  const springBoneSnapshot =
    target?.avatar.getSpringBonePhysicsSnapshot() ?? null;
  const breathingLayer = snapshot?.layers.find(isBreathingLayer) ?? null;
  const swayLayer = snapshot?.layers.find(isSwayLayer) ?? null;
  const bounceLayer = snapshot?.layers.find(isBounceLayer) ?? null;
  const headNodLayer = snapshot?.layers.find(isHeadNodLayer) ?? null;
  const headSideTiltLayer = snapshot?.layers.find(isHeadSideTiltLayer) ?? null;
  const cursorLookAtLayer = snapshot?.layers.find(isCursorLookAtLayer) ?? null;
  const talkingHandsLayer = snapshot?.layers.find(isTalkingHandsLayer) ?? null;
  const emotionPostureLayer =
    snapshot?.layers.find(isEmotionPostureLayer) ?? null;
  const emotionPostureDebug = emotionPostureLayer?.emotionPosture ?? null;
  const talkingHandsSpeechPlan = talkingHandsLayer?.speechPlan ?? null;
  const poseClipCatalogOptions = target
    ? target.avatar
        .getMotionPoseClips()
        .map((descriptor) =>
          createPoseClipCatalogOption(
            descriptor.runtimeId,
            descriptor.displayName,
            target.avatar.getLoadedMotionPoseClip(descriptor.runtimeId),
          ),
        )
    : builtInPoseClipCatalogOptions;
  // A live Anima's Reactions are listed by the cells whose pools hold them.
  const liveReactionClipCells = target
    ? reactionClipCells(target.avatar.getMotionReactionPools())
    : null;
  const reactionClipCatalogOptions =
    target && liveReactionClipCells
      ? target.avatar
          .getMotionReactionClips()
          .map((descriptor) =>
            createReactionClipCatalogOption(
              descriptor.runtimeId,
              descriptor.displayName,
              liveReactionClipCells.get(descriptor.runtimeId) ?? [],
              target.avatar.getLoadedMotionReactionClip(descriptor.runtimeId),
            ),
          )
      : builtInReactionClipCatalogOptions;
  const poseRows = target
    ? poseCatalogOptions.map((option) => ({
        ...option,
        snapshot: target.avatar.getPoseSnapshot(option.id),
      }))
    : [];
  const activePoseRow = poseRows.find((row) => row.snapshot.applied) ?? null;
  const selectedPoseOption =
    poseCatalogOptions.find((option) => option.id === selectedPoseId) ?? null;
  const selectedPoseSnapshot =
    poseRows.find((row) => row.id === selectedPoseId)?.snapshot ??
    (poseSnapshot?.params.id === selectedPoseId ? poseSnapshot : null);
  const selectedClipOption =
    poseClipCatalogOptions.find((option) => option.id === selectedClipId) ??
    null;
  const filteredReactionEmotionOptions = useMemo(
    () =>
      reactionEmotionFilterOptions.filter(
        (option) =>
          option.value === allReactionFilterValue ||
          reactionGroupFilter === allReactionFilterValue ||
          option.group === reactionGroupFilter,
      ),
    [reactionGroupFilter],
  );
  const filteredReactionClipCatalogOptions = reactionClipCatalogOptions.filter(
    (option) =>
      reactionClipMatchesFilters(option.cells, {
        group: reactionGroupFilter,
        emotion: reactionEmotionFilter,
        intensity: reactionIntensityFilter,
      }),
  );
  const selectedReactionClipOption =
    reactionClipCatalogOptions.find(
      (option) => option.id === selectedReactionClipId,
    ) ?? null;
  const selectedParticleVFXOption = getParticleVFXCatalogEntryById(
    selectedParticleVFXEffectId,
  );
  const canUseManualParticleVFX =
    selectedParticleVFXOption?.performanceBudget.loopingAllowed === true;
  const selectedParticleVFXLifetimeMode =
    particleVFXLifetimeMode === "manual" && canUseManualParticleVFX
      ? "manual"
      : "duration";
  const selectedParticleVFXAppliedId = selectedParticleVFXEffectId
    ? getDebugParticleVFXAppliedId(selectedParticleVFXEffectId)
    : "";
  const activeClipId =
    activeClipSnapshot?.playing && activeClipSnapshot.clipId
      ? activeClipSnapshot.clipId
      : null;
  const activeReactionClipId =
    reactionClipSnapshot?.active && reactionClipSnapshot.clipId
      ? reactionClipSnapshot.clipId
      : null;
  const firstPoseClipId = poseClipCatalogOptions[0]?.id ?? "";
  const selectedPoseClipAvailable = poseClipCatalogOptions.some(
    (option) => option.id === selectedClipId,
  );
  const firstFilteredReactionClipId =
    filteredReactionClipCatalogOptions[0]?.id ?? "";
  const selectedFilteredReactionClipAvailable =
    filteredReactionClipCatalogOptions.some(
      (option) => option.id === selectedReactionClipId,
    );

  useEffect(() => {
    if (!firstPoseClipId) {
      if (selectedClipId) setSelectedClipId("");
      return;
    }
    if (!selectedPoseClipAvailable) {
      setSelectedClipId(firstPoseClipId);
    }
  }, [firstPoseClipId, selectedClipId, selectedPoseClipAvailable]);

  useEffect(() => {
    if (
      reactionGroupFilter === allReactionFilterValue ||
      reactionEmotionFilter === allReactionFilterValue
    ) {
      return;
    }
    if (
      !(
        EMOTION_GROUP_MEMBERS[reactionGroupFilter] as readonly string[]
      ).includes(reactionEmotionFilter)
    ) {
      setReactionEmotionFilter(allReactionFilterValue);
    }
  }, [reactionEmotionFilter, reactionGroupFilter]);

  useEffect(() => {
    if (!firstFilteredReactionClipId) {
      if (selectedReactionClipId) {
        setSelectedReactionClipId("");
      }
      return;
    }
    if (!selectedFilteredReactionClipAvailable) {
      setSelectedReactionClipId(firstFilteredReactionClipId);
    }
  }, [
    firstFilteredReactionClipId,
    selectedFilteredReactionClipAvailable,
    selectedReactionClipId,
  ]);

  const handleSliderChange = (key: BreathingSliderKey, value: number) => {
    if (key === "weight") {
      updateBreathingWeight(value);
      return;
    }
    updateBreathingParams({
      [key]: value,
    } as Partial<BreathingProceduralAnimationParams>);
  };

  const handleSwaySliderChange = (key: SwaySliderKey, value: number) => {
    if (key === "weight") {
      updateSwayWeight(value);
      return;
    }
    updateSwayParams({
      [key]: value,
    } as Partial<SwayProceduralAnimationParams>);
  };

  const handleBounceSliderChange = (key: BounceSliderKey, value: number) => {
    if (key === "weight") {
      updateBounceWeight(value);
      return;
    }
    updateBounceParams({
      [key]: value,
    } as Partial<BounceProceduralAnimationParams>);
  };

  const handleHeadNodSliderChange = (key: HeadNodSliderKey, value: number) => {
    if (key === "weight") {
      updateHeadNodWeight(value);
      return;
    }
    updateHeadNodParams({
      [key]: value,
    } as Partial<HeadNodProceduralAnimationParams>);
  };

  const handleHeadSideTiltSliderChange = (
    key: HeadSideTiltSliderKey,
    value: number,
  ) => {
    if (key === "weight") {
      updateHeadSideTiltWeight(value);
      return;
    }
    updateHeadSideTiltParams({
      [key]: value,
    } as Partial<HeadSideTiltProceduralAnimationParams>);
  };

  const handleCursorLookAtSliderChange = (
    key: CursorLookAtSliderKey,
    value: number,
  ) => {
    if (key === "weight") {
      updateCursorLookAtWeight(value);
      return;
    }
    updateCursorLookAtParams({
      [key]: value,
    } as Partial<CursorLookAtProceduralAnimationParams>);
  };

  const handleTalkingHandsSliderChange = (
    key: TalkingHandsSliderKey,
    value: number,
  ) => {
    if (key === "weight") {
      updateTalkingHandsWeight(value);
      return;
    }
    updateTalkingHandsParams({
      [key]: value,
    } as Partial<TalkingHandsProceduralAnimationParams>);
  };

  const handleEmotionPostureSliderChange = (
    key: EmotionPostureSliderKey,
    value: number,
  ) => {
    updateEmotionPostureParams({
      [key]: value,
    } as Partial<EmotionPostureProceduralAnimationParams>);
  };

  const updateEmotionPosturePreset = (
    group: EmotionPostureGroup,
    preset: EmotionPosturePresetDraft,
  ) => {
    updateEmotionPostureParams({
      presets: {
        ...emotionPostureDraft.presets,
        [group]: preset,
      },
    });
  };

  const handleEmotionPosturePresetEnabledChange = (
    group: EmotionPostureGroup,
    enabled: boolean,
  ) => {
    updateEmotionPosturePreset(group, {
      ...emotionPostureDraft.presets[group],
      enabled,
    });
  };

  const handleEmotionPosturePresetIntensityChange = (
    group: EmotionPostureGroup,
    level: EmotionPostureLevel,
    intensity: number,
  ) => {
    const preset = emotionPostureDraft.presets[group];
    updateEmotionPosturePreset(group, {
      ...preset,
      intensityByLevel: {
        ...preset.intensityByLevel,
        [level]: intensity,
      },
    });
  };

  const handleEmotionPostureDebugModeChange = (enabled: boolean) => {
    updateEmotionPostureParams({
      debugModeEnabled: enabled,
      enabled,
    });
  };

  const handleEmotionPostureDebugGroupChange = (group: EmotionPostureGroup) => {
    updateEmotionPostureParams({
      debugGroup: group,
    });
  };

  const handleEmotionPostureDebugLevelChange = (
    level: EmotionPostureDebugLevelOption,
  ) => {
    updateEmotionPostureParams({
      debugLevel: Number(level) as EmotionPostureLevel,
    });
  };

  const handleEmotionPostureTargetChange = (
    group: EmotionPostureGroup,
    key: EmotionPostureTargetKey,
    value: number,
  ) => {
    const preset = emotionPostureDraft.presets[group];
    updateEmotionPosturePreset(group, {
      ...preset,
      target: {
        ...preset.target,
        [key]: value,
      },
    });
  };

  const handleTalkingHandsMicroTwistModeChange = (
    value: TalkingHandsProceduralAnimationParams["microTwistMode"],
  ) => {
    updateTalkingHandsParams({
      microTwistMode: value,
    });
  };

  const handleTalkingHandsSecondaryMicroTwistAxisChange = (
    value: TalkingHandsProceduralAnimationParams["secondaryMicroTwistAxis"],
  ) => {
    updateTalkingHandsParams({
      secondaryMicroTwistAxis: value,
    });
  };

  const handleSpringBoneSliderChange = (
    key: SpringBoneSliderKey,
    value: number,
  ) => {
    updateSpringBoneParams({
      [key]: value,
    } as Partial<SpringBonePhysicsParams>);
  };

  const handleSpringBoneProfileIntensityChange = (
    semantic: SpringBoneSemantic,
    value: number,
  ) => {
    updateSpringBoneProfileOverride(semantic, {
      intensityScale: value,
    });
  };

  const handleSpringBoneProfileSliderChange = (
    semantic: SpringBoneSemantic,
    key: SpringBoneSliderKey,
    value: number,
  ) => {
    updateSpringBoneProfileOverride(semantic, {
      params: {
        [key]: value,
      } as Partial<SpringBonePhysicsParams>,
    });
  };

  const handlePoseSelectionChange = (poseId: string) => {
    setSelectedPoseId(poseId);
    if (target) {
      setPoseSnapshot(target.avatar.getPoseSnapshot(poseId));
    }
  };

  const handleApplySelectedPose = () => {
    if (!target) return;
    setPoseSnapshot(
      target.avatar.applyPose(selectedPoseId, {
        preserveProceduralOffsets: true,
      }),
    );
    setSelectedClipSnapshot(
      selectedClipId
        ? target.avatar.getClipSnapshot(selectedClipId)
        : target.avatar.getClipSnapshot(),
    );
    setActiveClipSnapshot(target.avatar.getClipSnapshot());
  };

  const handleApplyPose = (poseId: string) => {
    if (!target) return;
    setSelectedPoseId(poseId);
    setPoseSnapshot(
      target.avatar.applyPose(poseId, {
        preserveProceduralOffsets: true,
      }),
    );
    setSelectedClipSnapshot(
      selectedClipId
        ? target.avatar.getClipSnapshot(selectedClipId)
        : target.avatar.getClipSnapshot(),
    );
    setActiveClipSnapshot(target.avatar.getClipSnapshot());
  };

  const handleClearActivePose = () => {
    if (!target || !activePoseRow) return;
    target.avatar.clearPose(activePoseRow.id);
    setPoseSnapshot(target.avatar.getPoseSnapshot(selectedPoseId));
  };

  const handleClipSelectionChange = (clipId: string) => {
    setSelectedClipId(clipId);
    if (target) {
      setSelectedClipSnapshot(target.avatar.getClipSnapshot(clipId));
      setActiveClipSnapshot(target.avatar.getClipSnapshot());
    }
  };

  const handlePlaySelectedClip = async () => {
    if (!target || !selectedClipId) return;
    try {
      const snapshot = await target.avatar.loadAndPlayClip(selectedClipId, {
        preserveProceduralOffsets: true,
      });
      setSelectedClipSnapshot(snapshot);
      setActiveClipSnapshot(target.avatar.getClipSnapshot());
      syncFromAvatar();
    } catch (error) {
      logger.warn("PoseClip", "Failed to play runtime pose clip", {
        clipId: selectedClipId,
        error,
      });
    }
  };

  const handleRestartSelectedClip = async () => {
    await handlePlaySelectedClip();
  };

  const handlePlayClip = async (clipId: string) => {
    if (!target) return;
    setSelectedClipId(clipId);
    try {
      const snapshot = await target.avatar.loadAndPlayClip(clipId, {
        preserveProceduralOffsets: true,
      });
      setSelectedClipSnapshot(snapshot);
      setActiveClipSnapshot(target.avatar.getClipSnapshot());
      syncFromAvatar();
    } catch (error) {
      logger.warn("PoseClip", "Failed to play runtime pose clip", {
        clipId,
        error,
      });
    }
  };

  const handleStopActiveClip = () => {
    if (!target) return;
    target.avatar.stopClip({ preserveProceduralOffsets: true });
    setSelectedClipSnapshot(
      selectedClipId
        ? target.avatar.getClipSnapshot(selectedClipId)
        : target.avatar.getClipSnapshot(),
    );
    setActiveClipSnapshot(target.avatar.getClipSnapshot());
    syncFromAvatar();
  };

  const handleReactionClipSelectionChange = (clipId: string) => {
    setSelectedReactionClipId(clipId);
    if (target) {
      setReactionClipSnapshot(target.avatar.getReactionClipSnapshot());
    }
  };

  const handlePlaySelectedReactionClip = async () => {
    if (!target || !selectedReactionClipId) return;
    await target.avatar.playDebugReactionClip(selectedReactionClipId);
    setReactionClipSnapshot(target.avatar.getReactionClipSnapshot());
    setAvatarPlannerSnapshot(target.avatar.getAvatarPlannerDebugSnapshot());
  };

  const handleRestartSelectedReactionClip = async () => {
    if (!target || !selectedReactionClipId) return;
    await target.avatar.restartDebugReactionClip(selectedReactionClipId);
    setReactionClipSnapshot(target.avatar.getReactionClipSnapshot());
    setAvatarPlannerSnapshot(target.avatar.getAvatarPlannerDebugSnapshot());
  };

  const handlePlayReactionClip = async (clipId: string) => {
    if (!target) return;
    setSelectedReactionClipId(clipId);
    await target.avatar.playDebugReactionClip(clipId);
    setReactionClipSnapshot(target.avatar.getReactionClipSnapshot());
    setAvatarPlannerSnapshot(target.avatar.getAvatarPlannerDebugSnapshot());
  };

  const handleClearReactionClip = () => {
    if (!target) return;
    target.avatar.clearDebugReactionClip();
    setReactionClipSnapshot(target.avatar.getReactionClipSnapshot());
    setAvatarPlannerSnapshot(target.avatar.getAvatarPlannerDebugSnapshot());
  };

  const handleParticleVFXSelectionChange = (effectId: string) => {
    setSelectedParticleVFXEffectId(effectId);
    const entry = getParticleVFXCatalogEntryById(effectId);
    if (!entry) return;
    const transform = cloneParticleVFXTransform(entry.defaultTransform);
    setSelectedParticleVFXAnchor(entry.defaultAnchor);
    setParticleVFXOffset(cloneParticleVFXAxisTriple(transform.offset));
    setParticleVFXDepthOffset(transform.depthOffset);
    setParticleVFXDurationSec(entry.defaultDurationSec);
    setParticleVFXLifetimeMode("duration");
  };

  const handleParticleVFXOffsetChange = (
    axis: keyof ParticleVFXTransformAxisTriple,
    value: number | undefined,
  ) => {
    setParticleVFXOffset((current) => ({
      ...current,
      [axis]: value ?? 0,
    }));
  };

  const handlePlaySelectedParticleVFX = async () => {
    if (
      !target ||
      !selectedParticleVFXOption ||
      !target.avatar.particleVFXController
    ) {
      return;
    }

    await target.avatar.particleVFXController.playEffect({
      effectId: selectedParticleVFXOption.id,
      appliedId: selectedParticleVFXAppliedId,
      ownerId: "debug",
      anchor: selectedParticleVFXAnchor,
      lifetime:
        selectedParticleVFXLifetimeMode === "manual"
          ? { kind: "manual" }
          : { kind: "duration", durationSec: particleVFXDurationSec },
      transform: {
        offset: particleVFXOffset,
        depthOffset: particleVFXDepthOffset,
      },
      followAnchor: true,
    });
    setParticleVFXSnapshot(target.avatar.particleVFXController.getSnapshot());
  };

  const handleClearSelectedParticleVFX = () => {
    if (
      !target?.avatar.particleVFXController ||
      !selectedParticleVFXAppliedId
    ) {
      return;
    }
    target.avatar.particleVFXController.clearEffect(
      selectedParticleVFXAppliedId,
    );
    setParticleVFXSnapshot(target.avatar.particleVFXController.getSnapshot());
  };

  const handleClearAllParticleVFX = () => {
    if (!target?.avatar.particleVFXController) return;
    target.avatar.particleVFXController.clearAll();
    setParticleVFXSnapshot(target.avatar.particleVFXController.getSnapshot());
  };

  const headerMeta = target ? (
    <p className="text-muted-foreground mt-2 text-xs">
      {target.sourceKey ?? target.sourceUrl ?? target.animaId ?? "Live avatar"}
    </p>
  ) : null;

  const renderContent = () => {
    if (!target) {
      return (
        <EmptyState
          title="No avatar target"
          description="Load a anima avatar to tune procedural animation."
        />
      );
    }

    if (activeSection === "PoseController") {
      return (
        <div className="space-y-4">
          <Panel
            title="PoseController"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleClearActivePose}
                disabled={!activePoseRow}
              >
                <Eraser className="h-4 w-4" />
                Clear
              </Button>
            }
          >
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Select
                value={selectedPoseId}
                onValueChange={handlePoseSelectionChange}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label="Select catalog pose"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {poseCatalogOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name} ({option.id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" size="sm" onClick={handleApplySelectedPose}>
                <Play className="h-4 w-4" />
                Apply
              </Button>
            </div>

            <div className="mt-4">
              <KeyValueGrid
                rows={[
                  {
                    label: "Selected",
                    value: selectedPoseOption
                      ? `${selectedPoseOption.name} (${selectedPoseOption.id})`
                      : selectedPoseId,
                  },
                  {
                    label: "Active",
                    value: activePoseRow
                      ? `${activePoseRow.name} (${activePoseRow.id})`
                      : "None",
                  },
                  {
                    label: "Ready",
                    value: selectedPoseSnapshot?.ready ? "Yes" : "No",
                  },
                  {
                    label: "Applied",
                    value: selectedPoseSnapshot?.applied ? "Yes" : "No",
                  },
                  {
                    label: "Humanoid bones",
                    value: formatList(selectedPoseSnapshot?.resolvedBones),
                  },
                  {
                    label: "Missing bones",
                    value: formatList(selectedPoseSnapshot?.missingBones),
                  },
                  {
                    label: "Expressions",
                    value: formatList(
                      selectedPoseSnapshot?.resolvedExpressions,
                    ),
                  },
                  {
                    label: "Missing expressions",
                    value: formatList(selectedPoseSnapshot?.missingExpressions),
                  },
                ]}
              />
            </div>
          </Panel>

          <Panel title="Catalog poses">
            <Table>
              <thead>
                <tr>
                  <HeaderCell>Pose</HeaderCell>
                  <HeaderCell>Status</HeaderCell>
                  <HeaderCell className="text-right">Bones</HeaderCell>
                  <HeaderCell className="text-right">Expressions</HeaderCell>
                  <HeaderCell className="text-right">Action</HeaderCell>
                </tr>
              </thead>
              <tbody className="divide-border/60 divide-y">
                {poseRows.map((row) => (
                  <tr
                    key={row.id}
                    className={row.snapshot.applied ? "bg-primary/5" : ""}
                  >
                    <BodyCell>
                      <span className="block font-medium">{row.name}</span>
                      <span className="text-muted-foreground block text-xs">
                        {row.id}
                      </span>
                    </BodyCell>
                    <BodyCell>
                      {row.snapshot.applied
                        ? "Active"
                        : row.snapshot.enabled
                          ? "Ready"
                          : "Disabled"}
                    </BodyCell>
                    <BodyCell className="text-right">
                      {row.humanoidCount}
                    </BodyCell>
                    <BodyCell className="text-right">
                      {row.expressionCount}
                    </BodyCell>
                    <BodyCell className="text-right">
                      <Button
                        type="button"
                        variant={row.snapshot.applied ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => handleApplyPose(row.id)}
                      >
                        <Play className="h-4 w-4" />
                        Apply
                      </Button>
                    </BodyCell>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        </div>
      );
    }

    if (activeSection === "PoseController Clips") {
      return (
        <div className="space-y-4">
          <Panel
            title="PoseController clips"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleStopActiveClip}
                disabled={!activeClipSnapshot?.playing}
              >
                <Square className="h-4 w-4" />
                Stop
              </Button>
            }
          >
            {poseClipCatalogOptions.length > 0 ? (
              <>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                  <Select
                    value={selectedClipId}
                    onValueChange={handleClipSelectionChange}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="Select catalog clip"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {poseClipCatalogOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.name} ({option.id})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handlePlaySelectedClip}
                    disabled={!selectedClipOption}
                  >
                    <Play className="h-4 w-4" />
                    Play
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleRestartSelectedClip}
                    disabled={!selectedClipOption}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Restart
                  </Button>
                </div>

                <div className="mt-4">
                  <KeyValueGrid
                    rows={[
                      {
                        label: "Selected",
                        value: selectedClipOption
                          ? `${selectedClipOption.name} (${selectedClipOption.id})`
                          : selectedClipId || "-",
                      },
                      {
                        label: "Active",
                        value: activeClipId ?? "None",
                      },
                      {
                        label: "Ready",
                        value: selectedClipSnapshot?.ready ? "Yes" : "No",
                      },
                      {
                        label: "Playing",
                        value: activeClipSnapshot?.playing ? "Yes" : "No",
                      },
                      {
                        label: "Applied",
                        value: activeClipSnapshot?.applied ? "Yes" : "No",
                      },
                      {
                        label: "Elapsed",
                        value:
                          activeClipSnapshot?.playing ||
                          activeClipSnapshot?.applied
                            ? formatClipPlaybackTime(activeClipSnapshot)
                            : "-",
                      },
                      {
                        label: "Duration",
                        value: selectedClipSnapshot
                          ? formatPreciseSeconds(
                              selectedClipSnapshot.durationSec,
                            )
                          : "-",
                      },
                      {
                        label: "Loop",
                        value: selectedClipSnapshot?.loop ? "Yes" : "No",
                      },
                      {
                        label: "Humanoid bones",
                        value: formatList(activeClipSnapshot?.resolvedBones),
                      },
                      {
                        label: "Missing bones",
                        value: formatList(activeClipSnapshot?.missingBones),
                      },
                      {
                        label: "Expressions",
                        value: formatList(
                          activeClipSnapshot?.resolvedExpressions,
                        ),
                      },
                      {
                        label: "Missing expressions",
                        value: formatList(
                          activeClipSnapshot?.missingExpressions,
                        ),
                      },
                      {
                        label: "Missing pose refs",
                        value: formatList(activeClipSnapshot?.missingPoseRefs),
                      },
                      {
                        label: "Events",
                        value: selectedClipSnapshot
                          ? formatClipEventKindCounts(
                              selectedClipSnapshot.eventKindCounts,
                            )
                          : "0 events",
                      },
                      {
                        label: "Runtime events",
                        value:
                          activeClipSnapshot &&
                          activeClipSnapshot.eventCount > 0
                            ? `${activeClipSnapshot.firedEventCount}/${activeClipSnapshot.eventCount} fired, ${activeClipSnapshot.activeEventCount} active`
                            : "-",
                      },
                      {
                        label: "Event dispatch",
                        value: activeClipSnapshot?.eventDispatchAvailable
                          ? "Available"
                          : "Unavailable",
                      },
                      {
                        label: "Event skips",
                        value: String(
                          activeClipSnapshot?.skippedEventCount ?? 0,
                        ),
                      },
                      {
                        label: "Event errors",
                        value: activeClipSnapshot?.lastEventError
                          ? `${activeClipSnapshot.eventErrorCount}: ${activeClipSnapshot.lastEventError}`
                          : String(activeClipSnapshot?.eventErrorCount ?? 0),
                      },
                      {
                        label: "Particle runtime",
                        value:
                          formatParticleVFXRuntimeSummary(particleVFXSnapshot),
                      },
                      {
                        label: "Particle ids",
                        value:
                          formatParticleVFXActiveAppliedIds(
                            particleVFXSnapshot,
                          ),
                      },
                    ]}
                  />
                </div>
              </>
            ) : (
              <EmptyState
                title="No catalog clips"
                description="Equip an animaPoseClip for this Anima to invoke it from debug."
              />
            )}
          </Panel>

          <Panel title="Catalog clips">
            {poseClipCatalogOptions.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <HeaderCell>Clip</HeaderCell>
                    <HeaderCell>Status</HeaderCell>
                    <HeaderCell className="text-right">Duration</HeaderCell>
                    <HeaderCell className="text-right">Loop</HeaderCell>
                    <HeaderCell className="text-right">Beats</HeaderCell>
                    <HeaderCell className="text-right">Events</HeaderCell>
                    <HeaderCell className="text-right">Action</HeaderCell>
                  </tr>
                </thead>
                <tbody className="divide-border/60 divide-y">
                  {poseClipCatalogOptions.map((row) => {
                    const isActive = activeClipId === row.id;
                    return (
                      <tr
                        key={row.id}
                        className={isActive ? "bg-primary/5" : ""}
                      >
                        <BodyCell>
                          <span className="block font-medium">{row.name}</span>
                          <span className="text-muted-foreground block text-xs">
                            {row.id}
                          </span>
                        </BodyCell>
                        <BodyCell>
                          {isActive
                            ? "Playing"
                            : selectedClipId === row.id
                              ? "Selected"
                              : "Ready"}
                        </BodyCell>
                        <BodyCell className="text-right">
                          {formatPreciseSeconds(row.durationSec)}
                        </BodyCell>
                        <BodyCell className="text-right">
                          {row.loop ? "Yes" : "No"}
                        </BodyCell>
                        <BodyCell className="text-right">
                          {row.keyframeCount}
                        </BodyCell>
                        <BodyCell className="text-right">
                          {formatClipEventKindCounts(row.eventKindCounts)}
                        </BodyCell>
                        <BodyCell className="text-right">
                          <Button
                            type="button"
                            variant={isActive ? "secondary" : "outline"}
                            size="sm"
                            onClick={() => handlePlayClip(row.id)}
                          >
                            <Play className="h-4 w-4" />
                            Play
                          </Button>
                        </BodyCell>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            ) : (
              <EmptyState
                title="No catalog clips"
                description="Equip an animaPoseClip for this Anima to invoke it from debug."
              />
            )}
          </Panel>
        </div>
      );
    }

    if (activeSection === "Reactions") {
      const plannerSnapshot = avatarPlannerSnapshot;
      const activePlannerReactionClip =
        plannerSnapshot?.activeReactionClip ?? null;

      return (
        <div className="space-y-4">
          <Panel
            title="Reactions"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleClearReactionClip}
                disabled={!reactionClipSnapshot?.active}
              >
                <Square className="h-4 w-4" />
                Clear
              </Button>
            }
          >
            {reactionClipCatalogOptions.length > 0 ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Select
                    value={reactionGroupFilter}
                    onValueChange={(value) =>
                      setReactionGroupFilter(value as ReactionGroupFilter)
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="Filter reaction group"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {reactionGroupFilterOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={reactionEmotionFilter}
                    onValueChange={(value) =>
                      setReactionEmotionFilter(value as ReactionEmotionFilter)
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="Filter reaction emotion"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredReactionEmotionOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={reactionIntensityFilter}
                    onValueChange={(value) =>
                      setReactionIntensityFilter(
                        value as ReactionIntensityFilter,
                      )
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="Filter reaction intensity"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {reactionIntensityFilterOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                  <Select
                    value={selectedReactionClipId}
                    onValueChange={handleReactionClipSelectionChange}
                    disabled={filteredReactionClipCatalogOptions.length === 0}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="Select reaction clip"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredReactionClipCatalogOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.name} ({option.id})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handlePlaySelectedReactionClip}
                    disabled={!selectedReactionClipOption}
                  >
                    <Play className="h-4 w-4" />
                    Play
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleRestartSelectedReactionClip}
                    disabled={!selectedReactionClipOption}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Restart
                  </Button>
                </div>

                <div className="mt-4">
                  <KeyValueGrid
                    rows={[
                      {
                        label: "Visible",
                        value: `${filteredReactionClipCatalogOptions.length}/${reactionClipCatalogOptions.length}`,
                      },
                      {
                        label: "Selected",
                        value: selectedReactionClipOption
                          ? `${selectedReactionClipOption.name} (${selectedReactionClipOption.id})`
                          : selectedReactionClipId || "-",
                      },
                      {
                        label: "Active",
                        value: activeReactionClipId ?? "None",
                      },
                      {
                        label: "Ready",
                        value: reactionClipSnapshot?.ready ? "Yes" : "No",
                      },
                      {
                        label: "Phase",
                        value: reactionClipSnapshot?.phase ?? "-",
                      },
                      {
                        label: "Owner",
                        value: reactionClipSnapshot?.ownerId ?? "-",
                      },
                      {
                        label: "Run",
                        value: reactionClipSnapshot?.runId ?? "-",
                      },
                      {
                        label: "Source event",
                        value: reactionClipSnapshot?.sourceEventId ?? "-",
                      },
                      {
                        label: "Emotion event",
                        value: reactionClipSnapshot?.emotionEventId ?? "-",
                      },
                      {
                        label: "Elapsed",
                        value:
                          reactionClipSnapshot?.active === true
                            ? formatReactionClipPlaybackTime(
                                reactionClipSnapshot,
                              )
                            : "-",
                      },
                      {
                        label: "Timeline",
                        value: selectedReactionClipOption
                          ? formatPreciseSeconds(
                              selectedReactionClipOption.durationSec,
                            )
                          : "-",
                      },
                      {
                        label: "Fade",
                        value:
                          reactionClipSnapshot?.active === true
                            ? formatReactionClipFade(reactionClipSnapshot)
                            : "-",
                      },
                      {
                        label: "Lifetime",
                        value:
                          selectedReactionClipOption?.lifetimeSummary ?? "-",
                      },
                      {
                        label: "Channels",
                        value:
                          selectedReactionClipOption?.channelSummary ?? "-",
                      },
                      {
                        label: "Events",
                        value: selectedReactionClipOption
                          ? formatClipEventKindCounts(
                              selectedReactionClipOption.eventKindCounts,
                            )
                          : "0 events",
                      },
                      {
                        label: "Runtime events",
                        value:
                          reactionClipSnapshot &&
                          reactionClipSnapshot.eventCount > 0
                            ? `${reactionClipSnapshot.firedEventCount}/${reactionClipSnapshot.eventCount} fired, ${reactionClipSnapshot.activeEventCount} active`
                            : "-",
                      },
                      {
                        label: "Event dispatch",
                        value: reactionClipSnapshot?.eventDispatchAvailable
                          ? "Available"
                          : "Unavailable",
                      },
                      {
                        label: "Expressions",
                        value: formatList(reactionClipSnapshot?.expressionKeys),
                      },
                      {
                        label: "Particle runtime",
                        value:
                          formatParticleVFXRuntimeSummary(particleVFXSnapshot),
                      },
                      {
                        label: "Particle ids",
                        value:
                          formatParticleVFXActiveAppliedIds(
                            particleVFXSnapshot,
                          ),
                      },
                    ]}
                  />
                </div>
              </>
            ) : (
              <EmptyState
                title="No reaction clips"
                description="Add Reactions under content/included/reactions to invoke them from debug."
              />
            )}
          </Panel>

          <Panel title="Reaction catalog">
            {reactionClipCatalogOptions.length > 0 ? (
              filteredReactionClipCatalogOptions.length > 0 ? (
                <Table>
                  <thead>
                    <tr>
                      <HeaderCell>Clip</HeaderCell>
                      <HeaderCell>Status</HeaderCell>
                      <HeaderCell>Group</HeaderCell>
                      <HeaderCell>Cells</HeaderCell>
                      <HeaderCell>Lifetime</HeaderCell>
                      <HeaderCell>Channels</HeaderCell>
                      <HeaderCell className="text-right">Keys</HeaderCell>
                      <HeaderCell className="text-right">Events</HeaderCell>
                      <HeaderCell className="text-right">Action</HeaderCell>
                    </tr>
                  </thead>
                  <tbody className="divide-border/60 divide-y">
                    {filteredReactionClipCatalogOptions.map((row) => {
                      const isActive = activeReactionClipId === row.id;
                      return (
                        <tr
                          key={row.id}
                          className={isActive ? "bg-primary/5" : ""}
                        >
                          <BodyCell>
                            <span className="block font-medium">
                              {row.name}
                            </span>
                            <span className="text-muted-foreground block text-xs">
                              {row.id}
                            </span>
                          </BodyCell>
                          <BodyCell>
                            {isActive
                              ? "Playing"
                              : selectedReactionClipId === row.id
                                ? "Selected"
                                : "Ready"}
                          </BodyCell>
                          <BodyCell>
                            {[
                              ...new Set(
                                row.cells.map((cell) =>
                                  formatEmotionGroupLabel(cell.group),
                                ),
                              ),
                            ].join(", ") || "-"}
                          </BodyCell>
                          <BodyCell>
                            {formatReactionClipCells(row.cells)}
                          </BodyCell>
                          <BodyCell>{row.lifetimeSummary}</BodyCell>
                          <BodyCell>{row.channelSummary}</BodyCell>
                          <BodyCell className="text-right">
                            {row.keyframeCount}
                          </BodyCell>
                          <BodyCell className="text-right">
                            {formatClipEventKindCounts(row.eventKindCounts)}
                          </BodyCell>
                          <BodyCell className="text-right">
                            <Button
                              type="button"
                              variant={isActive ? "secondary" : "outline"}
                              size="sm"
                              onClick={() => handlePlayReactionClip(row.id)}
                            >
                              <Play className="h-4 w-4" />
                              Play
                            </Button>
                          </BodyCell>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              ) : (
                <EmptyState
                  title="No matching reaction clips"
                  description="Adjust the reaction group, emotion, or intensity filters."
                />
              )
            ) : (
              <EmptyState
                title="No reaction clips"
                description="Add Reactions under content/included/reactions to invoke them from debug."
              />
            )}
          </Panel>

          <Panel title="Planner reaction diagnostics">
            {!plannerSnapshot ? (
              <EmptyState
                title="No planner snapshot"
                description="The avatar has not produced an avatar planner frame yet."
              />
            ) : (
              <KeyValueGrid
                rows={[
                  {
                    label: "Interaction phase",
                    value: plannerSnapshot.interactionPhase,
                  },
                  {
                    label: "Active run",
                    value: plannerSnapshot.activeRunId ?? "-",
                  },
                  {
                    label: "Active planner reaction",
                    value: formatPlannerReactionClip(activePlannerReactionClip),
                  },
                  {
                    label: "Owner",
                    value: activePlannerReactionClip?.ownerId ?? "-",
                  },
                  {
                    label: "Source event",
                    value: activePlannerReactionClip?.sourceEventId ?? "-",
                  },
                  {
                    label: "Emotion event",
                    value: activePlannerReactionClip?.emotionEventId ?? "-",
                  },
                  {
                    label: "Tone/intensity",
                    value: activePlannerReactionClip
                      ? `${activePlannerReactionClip.emotionalTone ?? "-"} / ${activePlannerReactionClip.emotionalIntensity}`
                      : "-",
                  },
                  {
                    label: "Started",
                    value: activePlannerReactionClip
                      ? formatPlannerTimestamp(
                          activePlannerReactionClip.startedAtMs,
                        )
                      : "-",
                  },
                  {
                    label: "Pending reactions",
                    value: formatPlannerPendingReactionEvents(
                      plannerSnapshot.pendingReactionClipEvents,
                    ),
                  },
                  {
                    label: "Pending count",
                    value: formatInteger(
                      plannerSnapshot.pendingReactionClipEventCount,
                    ),
                  },
                  {
                    label: "Last event key",
                    value: plannerSnapshot.lastReactionClipEventKey ?? "-",
                  },
                ]}
              />
            )}
          </Panel>
        </div>
      );
    }

    if (activeSection === "Avatar Planner") {
      const plannerSnapshot = avatarPlannerSnapshot;
      if (!plannerSnapshot) {
        return (
          <Panel
            title="Avatar Planner"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setAvatarPlannerSnapshot(
                    target.avatar.getAvatarPlannerDebugSnapshot(),
                  )
                }
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
            }
          >
            <EmptyState
              title="No planner snapshot"
              description="The avatar has not produced an avatar planner frame yet."
            />
          </Panel>
        );
      }

      const activePoseClip = plannerSnapshot.activePoseClip;

      return (
        <div className="space-y-4">
          <Panel title="Chat-path Gesture trigger">
            <div className="space-y-3">
              <p className="text-muted-foreground text-sm">
                Queues a Gesture through the mounted runtime store and Avatar
                Planner. It does not bypass chat arbitration or replace an
                active run.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={selectedPlannerGestureId}
                  onValueChange={setSelectedPlannerGestureId}
                  disabled={plannerGestureOptions.length === 0}
                >
                  <SelectTrigger className="min-w-64 flex-1">
                    <SelectValue placeholder="Select a mounted Gesture" />
                  </SelectTrigger>
                  <SelectContent>
                    {plannerGestureOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.name} · {option.type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="sm"
                  disabled={!selectedPlannerGestureId || Boolean(activeRunId)}
                  onClick={() => {
                    const runId = startPlannerGestureDebugRun(
                      selectedPlannerGestureId,
                    );
                    setLastPlannerDebugRunId(runId);
                  }}
                >
                  <Play className="h-4 w-4" />
                  Trigger through planner
                </Button>
              </div>
              <KeyValueGrid
                rows={[
                  {
                    label: "Mounted Gestures",
                    value: formatInteger(plannerGestureOptions.length),
                  },
                  {
                    label: "Current run",
                    value: activeRunId ?? "None",
                  },
                  {
                    label: "Last debug run",
                    value: lastPlannerDebugRunId ?? "None",
                  },
                ]}
              />
            </div>
          </Panel>

          <Panel
            title="Avatar Planner"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setAvatarPlannerSnapshot(
                    target.avatar.getAvatarPlannerDebugSnapshot(),
                  )
                }
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
            }
          >
            <KeyValueGrid
              rows={[
                {
                  label: "Evaluated",
                  value: formatPlannerTimestamp(plannerSnapshot.evaluatedAtMs),
                },
                {
                  label: "Interaction phase",
                  value: plannerSnapshot.interactionPhase,
                },
                {
                  label: "Base state",
                  value: plannerSnapshot.baseState,
                },
                {
                  label: "Avatar state",
                  value: plannerSnapshot.avatarState,
                },
                {
                  label: "Active run",
                  value: plannerSnapshot.activeRunId ?? "-",
                },
                {
                  label: "Phase dwell",
                  value: formatPlannerElapsed(
                    plannerSnapshot.phaseEnteredAtMs,
                    plannerSnapshot.evaluatedAtMs,
                  ),
                },
                {
                  label: "Emotion",
                  value: `${plannerSnapshot.emotionKey} (${formatRatio(
                    plannerSnapshot.emotionIntensity,
                  )})`,
                },
                {
                  label: "Random rolls",
                  value: formatInteger(plannerSnapshot.randomRollsConsumed),
                },
              ]}
            />
          </Panel>

          <Panel title="Idle VRMA stints">
            <div className="space-y-5">
              <SliderRow
                label="Quiet interval"
                value={idleStintQuietIntervalSec}
                min={0}
                max={180}
                step={1}
                formattedValue={formatSeconds(idleStintQuietIntervalSec)}
                onChange={setIdleStintQuietIntervalSec}
              />
              <KeyValueGrid
                rows={[
                  {
                    label: "Phase",
                    value: plannerSnapshot.idleStint.phase,
                  },
                  {
                    label: "Quiet started",
                    value: formatPlannerTimestamp(
                      plannerSnapshot.idleStint.quietStartedAtMs,
                    ),
                  },
                  {
                    label: "Active started",
                    value: formatPlannerTimestamp(
                      plannerSnapshot.idleStint.activeStartedAtMs,
                    ),
                  },
                  {
                    label: "Next due",
                    value:
                      plannerSnapshot.idleStint.nextDueAtMs !== null
                        ? formatPlannerDueTime(
                            plannerSnapshot.idleStint.nextDueAtMs,
                            plannerSnapshot.evaluatedAtMs,
                          )
                        : "-",
                  },
                  {
                    label: "Eligible",
                    value: formatInteger(
                      plannerSnapshot.idleStint.eligibleCandidateCount,
                    ),
                  },
                  {
                    label: "Selected",
                    value: formatIdleStintCandidate(
                      plannerSnapshot.idleStint.selectedCandidate,
                    ),
                  },
                ]}
              />
              {plannerSnapshot.idleStint.candidates.length > 0 ? (
                <Table>
                  <thead>
                    <tr>
                      <HeaderCell>Clip</HeaderCell>
                      <HeaderCell>Status</HeaderCell>
                      <HeaderCell>Match</HeaderCell>
                      <HeaderCell className="text-right">Weight</HeaderCell>
                      <HeaderCell className="text-right">Loop</HeaderCell>
                      <HeaderCell className="text-right">Duration</HeaderCell>
                    </tr>
                  </thead>
                  <tbody className="divide-border/60 divide-y">
                    {plannerSnapshot.idleStint.candidates.map((candidate) => (
                      <tr
                        key={candidate.key}
                        className={candidate.eligible ? "bg-primary/5" : ""}
                      >
                        <BodyCell>
                          <span className="block font-medium">
                            {candidate.name || candidate.file || "-"}
                          </span>
                          <span className="text-muted-foreground block text-xs">
                            {candidate.file || candidate.type}
                          </span>
                        </BodyCell>
                        <BodyCell>
                          {candidate.eligible
                            ? "Eligible"
                            : (candidate.exclusionReason ?? "Excluded")}
                        </BodyCell>
                        <BodyCell>
                          {candidate.neutral
                            ? "neutral"
                            : candidate.matchedEmotion
                              ? `${candidate.matchedEmotion} L${candidate.matchedLevel}`
                              : "-"}
                        </BodyCell>
                        <BodyCell className="text-right">
                          {candidate.weight.toFixed(2)}
                        </BodyCell>
                        <BodyCell className="text-right">
                          {formatIdleCandidateLoop(candidate)}
                        </BodyCell>
                        <BodyCell className="text-right">
                          {candidate.effectiveDurationSec !== null
                            ? formatPreciseSeconds(
                                candidate.effectiveDurationSec,
                              )
                            : "-"}
                        </BodyCell>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState
                  title="No idle candidates"
                  description="manifest.json has no idle entries to evaluate."
                />
              )}
            </div>
          </Panel>

          <Panel title="Planner-owned VRMA">
            <KeyValueGrid
              rows={[
                {
                  label: "Base loop",
                  value: formatPlannerVrma(plannerSnapshot.activeBaseVrma),
                },
                {
                  label: "Gesture",
                  value: formatPlannerVrma(plannerSnapshot.activeGestureVrma),
                },
                {
                  label: "Base key",
                  value: plannerSnapshot.activeBaseVrmaKey ?? "-",
                },
                {
                  label: "Gesture key",
                  value: plannerSnapshot.activeGestureVrmaKey ?? "-",
                },
                {
                  label: "Resolved gesture",
                  value: formatPlannerResolvedGesture(
                    plannerSnapshot.resolvedGesture,
                  ),
                },
                {
                  label: "Talking source",
                  value: plannerSnapshot.talkingMotionSource,
                },
                {
                  label: "Talking arbitration",
                  value: formatPlannerTalkingMotionArbitration(
                    plannerSnapshot.talkingMotionArbitration,
                  ),
                },
                {
                  label: "Hands bypassed",
                  value: plannerSnapshot.talkingHandsBypassed ? "yes" : "no",
                },
                {
                  label: "Active actions",
                  value: formatList(plannerSnapshot.activeVrmaActionNames),
                },
                {
                  label: "Pending gestures",
                  value: formatInteger(
                    plannerSnapshot.pendingGestureEventCount,
                  ),
                },
              ]}
            />
          </Panel>

          <Panel title="Planner-owned pose clip">
            <KeyValueGrid
              rows={[
                {
                  label: "Active clip",
                  value: formatPlannerPoseClip(activePoseClip),
                },
                {
                  label: "Owner",
                  value: activePoseClip?.ownerId ?? "-",
                },
                {
                  label: "Request",
                  value: activePoseClip?.requestId ?? "-",
                },
                {
                  label: "Source",
                  value: activePoseClip?.source ?? "-",
                },
                {
                  label: "Gesture id",
                  value: activePoseClip?.manifestGestureId ?? "-",
                },
                {
                  label: "Gesture type",
                  value: activePoseClip?.manifestGestureType ?? "-",
                },
                {
                  label: "Run",
                  value: activePoseClip?.runId ?? "-",
                },
                {
                  label: "Requested",
                  value: activePoseClip
                    ? formatPlannerTimestamp(activePoseClip.requestedAtMs)
                    : "-",
                },
                {
                  label: "Eligible",
                  value: activePoseClip
                    ? formatPlannerDueTime(
                        activePoseClip.eligibleAtMs,
                        plannerSnapshot.evaluatedAtMs,
                      )
                    : "-",
                },
                {
                  label: "Started",
                  value: activePoseClip?.startedAtMs
                    ? formatPlannerTimestamp(activePoseClip.startedAtMs)
                    : "-",
                },
                {
                  label: "Expires",
                  value:
                    activePoseClip?.expiresAtMs !== null &&
                    activePoseClip?.expiresAtMs !== undefined
                      ? formatPlannerDueTime(
                          activePoseClip.expiresAtMs,
                          plannerSnapshot.evaluatedAtMs,
                        )
                      : "-",
                },
                {
                  label: "Priority",
                  value: activePoseClip
                    ? formatInteger(activePoseClip.priority)
                    : "-",
                },
              ]}
            />
          </Panel>

          <Panel title="Planner-owned procedural">
            <KeyValueGrid
              rows={[
                {
                  label: "Planner layers",
                  value: formatList(
                    plannerSnapshot.activePlannerProceduralLayerIds,
                  ),
                },
                {
                  label: "Manual layers",
                  value: formatList(plannerSnapshot.manualProceduralLayerIds),
                },
                {
                  label: "Stints",
                  value: formatPlannerProceduralStints(
                    plannerSnapshot.proceduralStints,
                    plannerSnapshot.evaluatedAtMs,
                  ),
                },
                {
                  label: "Last cancellation",
                  value: plannerSnapshot.lastCancellationReason ?? "-",
                },
              ]}
            />
          </Panel>

          <Panel title="Planner queue and diagnostics">
            <KeyValueGrid
              rows={[
                {
                  label: "Pending events",
                  value: formatPlannerPendingEvents(
                    plannerSnapshot.pendingEvents,
                  ),
                },
                {
                  label: "Pending count",
                  value: formatInteger(plannerSnapshot.pendingEventCount),
                },
                {
                  label: "Action types",
                  value: formatList(plannerSnapshot.actionTypes),
                },
                {
                  label: "Consumed events",
                  value: formatList(plannerSnapshot.consumedPlannerEventIds),
                },
                {
                  label: "Ignored reasons",
                  value: formatList(plannerSnapshot.ignoredEventReasons),
                },
              ]}
            />
          </Panel>
        </div>
      );
    }

    if (activeSection === "Particle VFX") {
      const controllerAvailable = Boolean(target.avatar.particleVFXController);
      const snapshot =
        particleVFXSnapshot ??
        target.avatar.particleVFXController?.getSnapshot() ??
        null;
      const activeAppliedIds =
        snapshot?.activeInstances.map((instance) => instance.appliedId) ?? [];

      return (
        <div className="space-y-4">
          <Panel
            title="Particle VFX"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleClearAllParticleVFX}
                disabled={!controllerAvailable || !snapshot?.activeCount}
              >
                <Eraser className="h-4 w-4" />
                Clear All
              </Button>
            }
          >
            {particleVFXCatalogOptions.length > 0 ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Select
                    value={selectedParticleVFXEffectId}
                    onValueChange={handleParticleVFXSelectionChange}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="Select particle VFX effect"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {particleVFXCatalogOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label} ({option.id})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={selectedParticleVFXLifetimeMode}
                    onValueChange={(value) =>
                      setParticleVFXLifetimeMode(
                        value as ParticleVFXDebugLifetimeMode,
                      )
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="Select particle VFX lifetime"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="duration">Timed</SelectItem>
                      <SelectItem
                        value="manual"
                        disabled={!canUseManualParticleVFX}
                      >
                        Manual
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={selectedParticleVFXAnchor}
                    onValueChange={(value) =>
                      setSelectedParticleVFXAnchor(value as ParticleVFXAnchor)
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="Select particle VFX anchor"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PARTICLE_VFX_ANCHORS.map((anchor) => (
                        <SelectItem key={anchor} value={anchor}>
                          {anchor}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-5">
                  <FieldControl label="Offset X">
                    <NumberInputControl
                      value={particleVFXOffset.x}
                      onChange={(value) =>
                        handleParticleVFXOffsetChange("x", value)
                      }
                      step="0.01"
                    />
                  </FieldControl>
                  <FieldControl label="Offset Y">
                    <NumberInputControl
                      value={particleVFXOffset.y}
                      onChange={(value) =>
                        handleParticleVFXOffsetChange("y", value)
                      }
                      step="0.01"
                    />
                  </FieldControl>
                  <FieldControl label="Offset Z">
                    <NumberInputControl
                      value={particleVFXOffset.z}
                      onChange={(value) =>
                        handleParticleVFXOffsetChange("z", value)
                      }
                      step="0.01"
                    />
                  </FieldControl>
                  <FieldControl label="Depth">
                    <NumberInputControl
                      value={particleVFXDepthOffset}
                      onChange={(value) =>
                        setParticleVFXDepthOffset(value ?? 0)
                      }
                      step="0.01"
                    />
                  </FieldControl>
                  <FieldControl label="Duration">
                    <NumberInputControl
                      value={particleVFXDurationSec}
                      onChange={(value) =>
                        setParticleVFXDurationSec(Math.max(0.05, value ?? 2))
                      }
                      step="0.1"
                      disabled={selectedParticleVFXLifetimeMode === "manual"}
                    />
                  </FieldControl>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={handlePlaySelectedParticleVFX}
                    disabled={
                      !controllerAvailable || !selectedParticleVFXOption
                    }
                  >
                    <Play className="h-4 w-4" />
                    Play
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleClearSelectedParticleVFX}
                    disabled={
                      !controllerAvailable || !selectedParticleVFXAppliedId
                    }
                  >
                    <Square className="h-4 w-4" />
                    Clear Selected
                  </Button>
                </div>

                <div className="mt-4">
                  <KeyValueGrid
                    rows={[
                      {
                        label: "Controller",
                        value: controllerAvailable
                          ? "Available"
                          : "Unavailable",
                      },
                      {
                        label: "Selected",
                        value: selectedParticleVFXOption
                          ? `${selectedParticleVFXOption.label} (${selectedParticleVFXOption.id})`
                          : selectedParticleVFXEffectId || "-",
                      },
                      {
                        label: "Applied id",
                        value: selectedParticleVFXAppliedId || "-",
                      },
                      {
                        label: "Lifetime",
                        value:
                          selectedParticleVFXLifetimeMode === "manual"
                            ? "Manual"
                            : "Timed",
                      },
                      {
                        label: "Active",
                        value: formatInteger(snapshot?.activeCount ?? 0),
                      },
                      {
                        label: "Loaded",
                        value: formatInteger(snapshot?.loadedCount ?? 0),
                      },
                      {
                        label: "Active ids",
                        value: formatList(activeAppliedIds),
                      },
                      {
                        label: "Last error",
                        value: snapshot?.lastError ?? "-",
                      },
                      {
                        label: "Warnings",
                        value: formatList(snapshot?.warnings),
                      },
                    ]}
                  />
                </div>
              </>
            ) : (
              <EmptyState
                title="No particle effects"
                description="Add particle VFX catalog entries to invoke them from debug."
              />
            )}
          </Panel>

          <Panel title="Active particle instances">
            {snapshot && snapshot.activeInstances.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <HeaderCell>Instance</HeaderCell>
                    <HeaderCell>Anchor</HeaderCell>
                    <HeaderCell className="text-right">Elapsed</HeaderCell>
                    <HeaderCell className="text-right">Lifetime</HeaderCell>
                    <HeaderCell className="text-right">Depth</HeaderCell>
                  </tr>
                </thead>
                <tbody className="divide-border/60 divide-y">
                  {snapshot.activeInstances.map((instance) => (
                    <tr key={instance.appliedId}>
                      <BodyCell>
                        <span className="block font-medium">
                          {instance.effectLabel}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {instance.appliedId}
                        </span>
                      </BodyCell>
                      <BodyCell>
                        <span className="block">{instance.anchor}</span>
                        <span className="text-muted-foreground block text-xs">
                          {instance.boneName
                            ? `${instance.resolvedAnchor} / ${instance.boneName}`
                            : instance.resolvedAnchor}
                        </span>
                      </BodyCell>
                      <BodyCell className="text-right">
                        {formatPreciseSeconds(instance.elapsedSec)}
                      </BodyCell>
                      <BodyCell className="text-right">
                        {formatParticleVFXLifetime(instance)}
                      </BodyCell>
                      <BodyCell className="text-right">
                        {formatMeters(instance.transform.depthOffset)}
                      </BodyCell>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState
                title="No active particles"
                description="Play a particle effect to inspect its active runtime instance."
              />
            )}
          </Panel>

          <Panel title="Particle catalog">
            <Table>
              <thead>
                <tr>
                  <HeaderCell>Effect</HeaderCell>
                  <HeaderCell>Anchor</HeaderCell>
                  <HeaderCell className="text-right">Duration</HeaderCell>
                  <HeaderCell className="text-right">Depth</HeaderCell>
                  <HeaderCell className="text-right">Action</HeaderCell>
                </tr>
              </thead>
              <tbody className="divide-border/60 divide-y">
                {particleVFXCatalogOptions.map((row) => (
                  <tr
                    key={row.id}
                    className={
                      selectedParticleVFXEffectId === row.id
                        ? "bg-primary/5"
                        : ""
                    }
                  >
                    <BodyCell>
                      <span className="block font-medium">{row.label}</span>
                      <span className="text-muted-foreground block text-xs">
                        {row.id}
                      </span>
                    </BodyCell>
                    <BodyCell>{row.defaultAnchor}</BodyCell>
                    <BodyCell className="text-right">
                      {formatPreciseSeconds(row.defaultDurationSec)}
                    </BodyCell>
                    <BodyCell className="text-right">
                      {formatMeters(row.defaultTransform.depthOffset)}
                    </BodyCell>
                    <BodyCell className="text-right">
                      <Button
                        type="button"
                        variant={
                          selectedParticleVFXEffectId === row.id
                            ? "secondary"
                            : "outline"
                        }
                        size="sm"
                        onClick={() => handleParticleVFXSelectionChange(row.id)}
                      >
                        Select
                      </Button>
                    </BodyCell>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        </div>
      );
    }

    if (activeSection === "Runtime") {
      return (
        <Panel
          title="Procedural runtime"
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={syncFromAvatar}
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          }
        >
          <div className="border-border/60 bg-background/70 mb-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-foreground text-sm font-medium">
                  Automatic VRMA playback
                </p>
                <p className="text-muted-foreground text-xs">
                  {automaticAnimationPlaybackEnabled ? "ON" : "OFF"}
                </p>
              </div>
              <Switch
                checked={automaticAnimationPlaybackEnabled}
                onCheckedChange={setAutomaticAnimationPlaybackEnabled}
                aria-label="Toggle automatic VRMA animation playback"
              />
            </div>
          </div>
          <div className="border-border/60 bg-background/70 mb-4 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-foreground text-sm font-medium">
                  Root VRMA playback
                </p>
                <p className="text-muted-foreground text-xs">
                  {vrmaRootedPlaybackEnabled ? "ON" : "OFF"}
                </p>
              </div>
              <Switch
                checked={vrmaRootedPlaybackEnabled}
                onCheckedChange={setVrmaRootedPlaybackEnabled}
                aria-label="Toggle rooted VRMA animation playback"
              />
            </div>
          </div>
          <div className="border-border/60 bg-background/70 mb-4 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-foreground text-sm font-medium">
                  ARKit lip-sync shaping
                </p>
                <p className="text-muted-foreground text-xs">
                  {arkitLipSyncAvailable
                    ? arkitLipSyncEnabled
                      ? "ON: vowels play as ARKit mouth mixes"
                      : "OFF: vowels play the viseme presets"
                    : "Unavailable: the Avatar lacks ARKit vowel shapes"}
                </p>
              </div>
              <Switch
                checked={arkitLipSyncEnabled}
                disabled={!arkitLipSyncAvailable}
                onCheckedChange={setArkitLipSyncEnabled}
                aria-label="Toggle ARKit lip-sync shaping"
              />
            </div>
          </div>
          <KeyValueGrid
            rows={[
              { label: "Anima", value: animaLabel ?? target.animaId },
              {
                label: "Automatic VRMA",
                value: automaticAnimationPlaybackEnabled
                  ? "Enabled"
                  : "Disabled",
              },
              {
                label: "Root VRMA",
                value: vrmaRootedPlaybackEnabled ? "Enabled" : "Disabled",
              },
              {
                label: "Global rest",
                value: globalRestSnapshot?.enabled ? "Enabled" : "Disabled",
              },
              {
                label: "Global rest applied",
                value: globalRestSnapshot?.applied ? "Yes" : "No",
              },
              {
                label: "Global rest bones",
                value: formatList(globalRestSnapshot?.resolvedBones),
              },
              {
                label: "Global rest missing",
                value: formatList(globalRestSnapshot?.missingBones),
              },
              {
                label: "Controller",
                value: snapshot?.ready ? "Ready" : "Unavailable",
              },
              {
                label: "Elapsed",
                value: snapshot ? `${snapshot.elapsedSec.toFixed(2)}s` : "-",
              },
              {
                label: "Max delta",
                value: snapshot ? `${snapshot.maxDeltaSec.toFixed(3)}s` : "-",
              },
              {
                label: "Layers",
                value:
                  snapshot?.layers.map((layer) => layer.id).join(", ") ?? "-",
              },
              {
                label: "Breathing bones",
                value: formatList(breathingLayer?.resolvedBones),
              },
              {
                label: "Breathing missing",
                value: formatList(breathingLayer?.missingBones),
              },
              {
                label: "Sway bones",
                value: formatList(swayLayer?.resolvedBones),
              },
              {
                label: "Sway missing",
                value: formatList(swayLayer?.missingBones),
              },
              {
                label: "Bounce bones",
                value: formatList(bounceLayer?.resolvedBones),
              },
              {
                label: "Bounce missing",
                value: formatList(bounceLayer?.missingBones),
              },
              {
                label: "Head nod bones",
                value: formatList(headNodLayer?.resolvedBones),
              },
              {
                label: "Head nod missing",
                value: formatList(headNodLayer?.missingBones),
              },
              {
                label: "Head tilt bones",
                value: formatList(headSideTiltLayer?.resolvedBones),
              },
              {
                label: "Head tilt missing",
                value: formatList(headSideTiltLayer?.missingBones),
              },
              {
                label: "Cursor lookAt target",
                value: formatList(cursorLookAtLayer?.resolvedBones),
              },
              {
                label: "Cursor lookAt missing",
                value: formatList(cursorLookAtLayer?.missingBones),
              },
              {
                label: "Talking hands bones",
                value: formatList(talkingHandsLayer?.resolvedBones),
              },
              {
                label: "Talking hands missing",
                value: formatList(talkingHandsLayer?.missingBones),
              },
              {
                label: "Emotion posture bones",
                value: formatList(emotionPostureLayer?.resolvedBones),
              },
              {
                label: "Emotion posture missing",
                value: formatList(emotionPostureLayer?.missingBones),
              },
              {
                label: "Spring manager",
                value: springBoneSnapshot?.hasManager ? "Available" : "Missing",
              },
              {
                label: "Spring joints",
                value: springBoneSnapshot?.jointCount ?? "-",
              },
              {
                label: "Spring colliders",
                value: springBoneSnapshot?.colliderCount ?? "-",
              },
              {
                label: "Spring override",
                value: springBoneSnapshot?.overridingSettings
                  ? "Active"
                  : "Inactive",
              },
              {
                label: "Spring helpers",
                value: springBoneSnapshot
                  ? `${springBoneSnapshot.helperCount} / ${
                      springBoneSnapshot.helpersVisible ? "visible" : "hidden"
                    }`
                  : "-",
              },
              {
                label: "Spring semantics",
                value: springBoneSnapshot?.semanticProfileReady
                  ? "Ready"
                  : "Unavailable",
              },
              {
                label: "Semantic joints",
                value: formatSemanticCounts(
                  springBoneSnapshot?.semanticJointCounts,
                ),
              },
              {
                label: "Gust offsets",
                value: springBoneSnapshot
                  ? `${springBoneSnapshot.gustStrengthOffset.toFixed(
                      2,
                    )}, ${springBoneSnapshot.gustDirectionOffsetDeg.toFixed(
                      1,
                    )}deg`
                  : "-",
              },
              {
                label: "Source",
                value: target.sourceUrl ?? target.avatar.sourceUrl ?? "-",
              },
            ]}
          />
        </Panel>
      );
    }

    if (activeSection === "Sway") {
      return (
        <div className="space-y-4">
          <Panel
            title="Sway"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearActiveOffsets}
                >
                  <Eraser className="h-4 w-4" />
                  Clear Offsets
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={resetSwayDefaults}
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset Defaults
                </Button>
              </div>
            }
          >
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-foreground text-sm font-medium">Enabled</p>
                <p className="text-muted-foreground text-xs">
                  {swayDraft.enabled ? "ON" : "OFF"}
                </p>
              </div>
              <Switch
                checked={swayDraft.enabled}
                onCheckedChange={(checked) =>
                  updateSwayParams({ enabled: checked })
                }
                aria-label="Toggle sway procedural animation"
              />
            </div>
            <div className="space-y-5">
              {swaySliders.map((slider) => (
                <SliderRow
                  key={slider.key}
                  label={slider.label}
                  value={swayDraft[slider.key]}
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  formattedValue={slider.format(swayDraft[slider.key])}
                  onChange={(value) =>
                    handleSwaySliderChange(slider.key, value)
                  }
                />
              ))}
            </div>
          </Panel>
          <LayerSnapshotPanel title="Current sway snapshot" layer={swayLayer} />
        </div>
      );
    }

    if (activeSection === "Bounce") {
      return (
        <div className="space-y-4">
          <Panel
            title="Bounce"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearActiveOffsets}
                >
                  <Eraser className="h-4 w-4" />
                  Clear Offsets
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={resetBounceDefaults}
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset Defaults
                </Button>
              </div>
            }
          >
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-foreground text-sm font-medium">Enabled</p>
                <p className="text-muted-foreground text-xs">
                  {bounceDraft.enabled ? "ON" : "OFF"}
                </p>
              </div>
              <Switch
                checked={bounceDraft.enabled}
                onCheckedChange={(checked) =>
                  updateBounceParams({ enabled: checked })
                }
                aria-label="Toggle bounce procedural animation"
              />
            </div>
            <div className="space-y-5">
              {bounceSliders.map((slider) => (
                <SliderRow
                  key={slider.key}
                  label={slider.label}
                  value={bounceDraft[slider.key]}
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  formattedValue={slider.format(bounceDraft[slider.key])}
                  onChange={(value) =>
                    handleBounceSliderChange(slider.key, value)
                  }
                />
              ))}
            </div>
          </Panel>
          <LayerSnapshotPanel
            title="Current bounce snapshot"
            layer={bounceLayer}
          />
        </div>
      );
    }

    if (activeSection === "Head Nods") {
      return (
        <div className="space-y-4">
          <Panel
            title="Head nods"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearActiveOffsets}
                >
                  <Eraser className="h-4 w-4" />
                  Clear Offsets
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={resetHeadNodDefaults}
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset Defaults
                </Button>
              </div>
            }
          >
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-foreground text-sm font-medium">Enabled</p>
                <p className="text-muted-foreground text-xs">
                  {headNodDraft.enabled ? "ON" : "OFF"}
                </p>
              </div>
              <Switch
                checked={headNodDraft.enabled}
                onCheckedChange={(checked) =>
                  updateHeadNodParams({ enabled: checked })
                }
                aria-label="Toggle head nod procedural animation"
              />
            </div>
            <div className="space-y-5">
              {headNodSliders.map((slider) => (
                <SliderRow
                  key={slider.key}
                  label={slider.label}
                  value={headNodDraft[slider.key]}
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  formattedValue={slider.format(headNodDraft[slider.key])}
                  onChange={(value) =>
                    handleHeadNodSliderChange(slider.key, value)
                  }
                />
              ))}
            </div>
          </Panel>
          <LayerSnapshotPanel
            title="Current head nod snapshot"
            layer={headNodLayer}
          />
        </div>
      );
    }

    if (activeSection === "Head Side Tilt") {
      return (
        <div className="space-y-4">
          <Panel
            title="Head side tilt"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearActiveOffsets}
                >
                  <Eraser className="h-4 w-4" />
                  Clear Offsets
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={resetHeadSideTiltDefaults}
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset Defaults
                </Button>
              </div>
            }
          >
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-foreground text-sm font-medium">Enabled</p>
                <p className="text-muted-foreground text-xs">
                  {headSideTiltDraft.enabled ? "ON" : "OFF"}
                </p>
              </div>
              <Switch
                checked={headSideTiltDraft.enabled}
                onCheckedChange={(checked) =>
                  updateHeadSideTiltParams({ enabled: checked })
                }
                aria-label="Toggle head side tilt procedural animation"
              />
            </div>
            <div className="space-y-5">
              {headSideTiltSliders.map((slider) => (
                <SliderRow
                  key={slider.key}
                  label={slider.label}
                  value={headSideTiltDraft[slider.key]}
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  formattedValue={slider.format(headSideTiltDraft[slider.key])}
                  onChange={(value) =>
                    handleHeadSideTiltSliderChange(slider.key, value)
                  }
                />
              ))}
            </div>
          </Panel>
          <LayerSnapshotPanel
            title="Current head side tilt snapshot"
            layer={headSideTiltLayer}
          />
        </div>
      );
    }

    if (activeSection === "Cursor Look At") {
      return (
        <div className="space-y-4">
          <Panel
            title="Cursor look at"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearActiveOffsets}
                >
                  <Eraser className="h-4 w-4" />
                  Clear Offsets
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={resetCursorLookAtDefaults}
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset Defaults
                </Button>
              </div>
            }
          >
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-foreground text-sm font-medium">Enabled</p>
                <p className="text-muted-foreground text-xs">
                  {cursorLookAtDraft.enabled ? "ON" : "OFF"}
                </p>
              </div>
              <Switch
                checked={cursorLookAtDraft.enabled}
                onCheckedChange={(checked) =>
                  updateCursorLookAtParams({ enabled: checked })
                }
                aria-label="Toggle cursor look-at procedural animation"
              />
            </div>
            <div className="space-y-5">
              {cursorLookAtSliders.map((slider) => (
                <SliderRow
                  key={slider.key}
                  label={slider.label}
                  value={cursorLookAtDraft[slider.key]}
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  formattedValue={slider.format(cursorLookAtDraft[slider.key])}
                  onChange={(value) =>
                    handleCursorLookAtSliderChange(slider.key, value)
                  }
                />
              ))}
            </div>
          </Panel>
          <LayerSnapshotPanel
            title="Current cursor look-at snapshot"
            layer={cursorLookAtLayer}
          />
        </div>
      );
    }

    if (activeSection === "Talking Hands") {
      return (
        <div className="space-y-4">
          <Panel
            title="Talking hands"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearActiveOffsets}
                >
                  <Eraser className="h-4 w-4" />
                  Clear Offsets
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!talkingHandsSpeechPlan?.replayRequest}
                  onClick={replayLastTalkingHandsSpeechGroup}
                >
                  <Play className="h-4 w-4" />
                  Replay TTS
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={resetTalkingHandsDefaults}
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset Defaults
                </Button>
              </div>
            }
          >
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-foreground text-sm font-medium">
                  One-shot group
                </p>
                <p className="text-muted-foreground text-xs">
                  {formatSeconds(talkingHandsDraft.gestureDurationSec)}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={playTalkingHandsGroup}
              >
                <Play className="h-4 w-4" />
                Play
              </Button>
            </div>
            <div className="space-y-5">
              <SelectRow
                label="Micro twist mode"
                value={talkingHandsDraft.microTwistMode}
                options={talkingHandsMicroTwistModeOptions}
                onChange={handleTalkingHandsMicroTwistModeChange}
              />
              <SelectRow
                label="Secondary twist axis"
                value={talkingHandsDraft.secondaryMicroTwistAxis}
                options={talkingHandsSecondaryMicroTwistAxisOptions}
                onChange={handleTalkingHandsSecondaryMicroTwistAxisChange}
              />
              {talkingHandsSliders.map((slider) => (
                <SliderRow
                  key={slider.key}
                  label={slider.label}
                  value={talkingHandsDraft[slider.key]}
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  formattedValue={slider.format(talkingHandsDraft[slider.key])}
                  onChange={(value) =>
                    handleTalkingHandsSliderChange(slider.key, value)
                  }
                />
              ))}
            </div>
          </Panel>
          <LayerSnapshotPanel
            title="Current talking hands snapshot"
            layer={talkingHandsLayer}
          />
          <TalkingHandsSpeechPlanPanel
            plan={talkingHandsSpeechPlan}
            onReplay={replayLastTalkingHandsSpeechGroup}
          />
        </div>
      );
    }

    if (activeSection === "Emotion Posture") {
      return (
        <div className="space-y-4">
          <Panel
            title="Emotion posture"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearActiveOffsets}
                >
                  <Eraser className="h-4 w-4" />
                  Clear Offsets
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={resetEmotionPostureDefaults}
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset Defaults
                </Button>
              </div>
            }
          >
            <div className="mb-5 grid gap-3 sm:grid-cols-3">
              <SwitchRow
                label="Planner gate"
                value={emotionPostureDraft.plannerEnabled}
                onChange={(checked) =>
                  updateEmotionPostureParams({ plannerEnabled: checked })
                }
              />
              <SwitchRow
                label="Runtime enabled"
                value={emotionPostureDraft.enabled}
                onChange={(checked) =>
                  updateEmotionPostureParams({ enabled: checked })
                }
              />
              <SwitchRow
                label="Debug mode"
                value={emotionPostureDraft.debugModeEnabled}
                onChange={handleEmotionPostureDebugModeChange}
              />
            </div>
            {emotionPostureDraft.debugModeEnabled ? (
              <div className="mb-5 grid gap-5 sm:grid-cols-2">
                <SelectRow
                  label="Debug group"
                  value={emotionPostureDraft.debugGroup}
                  options={emotionPostureGroupOptions}
                  onChange={handleEmotionPostureDebugGroupChange}
                />
                <SelectRow
                  label="Debug level"
                  value={
                    `${emotionPostureDraft.debugLevel}` as EmotionPostureDebugLevelOption
                  }
                  options={emotionPostureLevelOptions}
                  onChange={handleEmotionPostureDebugLevelChange}
                />
              </div>
            ) : null}
            <div className="space-y-5">
              {emotionPostureSliders.map((slider) => (
                <SliderRow
                  key={slider.key}
                  label={slider.label}
                  value={emotionPostureDraft[slider.key]}
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  formattedValue={slider.format(
                    emotionPostureDraft[slider.key],
                  )}
                  onChange={(value) =>
                    handleEmotionPostureSliderChange(slider.key, value)
                  }
                />
              ))}
            </div>
          </Panel>

          <Panel title="Resolved posture">
            <KeyValueGrid
              rows={[
                {
                  label: "Group",
                  value: emotionPostureDebug
                    ? formatEmotionGroupLabelForDebug(
                        emotionPostureDebug.resolvedGroup,
                      )
                    : "-",
                },
                {
                  label: "Level",
                  value: emotionPostureDebug?.resolvedLevel ?? "-",
                },
                {
                  label: "Primary",
                  value: emotionPostureDebug?.primaryEmotion ?? "-",
                },
                {
                  label: "Reason",
                  value: emotionPostureDebug?.reason ?? "-",
                },
                {
                  label: "Preset",
                  value: emotionPostureDebug?.presetEnabled
                    ? "Enabled"
                    : "Disabled",
                },
                {
                  label: "Level intensity",
                  value: emotionPostureDebug
                    ? emotionPostureDebug.levelIntensity.toFixed(2)
                    : "-",
                },
                {
                  label: "Effective intensity",
                  value: emotionPostureDebug
                    ? emotionPostureDebug.effectiveIntensity.toFixed(2)
                    : "-",
                },
                {
                  label: "Active target",
                  value: formatEmotionPostureTarget(
                    emotionPostureDebug?.activeTarget,
                  ),
                },
                {
                  label: "Current target",
                  value: formatEmotionPostureTarget(
                    emotionPostureDebug?.currentTarget,
                  ),
                },
              ]}
            />
          </Panel>

          <Panel title="Group presets">
            <div className="space-y-4">
              {SUPPORTED_EMOTION_POSTURE_GROUPS.map((group) => {
                const preset = emotionPostureDraft.presets[group];
                return (
                  <div
                    key={group}
                    className="border-border/60 bg-background/70 rounded-lg border p-3"
                  >
                    <div className="mb-3 flex items-center justify-between gap-4">
                      <div>
                        <p className="text-foreground text-sm font-medium">
                          {formatEmotionGroupLabel(group)}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {preset.enabled ? "ON" : "OFF"}
                        </p>
                      </div>
                      <Switch
                        checked={preset.enabled}
                        onCheckedChange={(checked) =>
                          handleEmotionPosturePresetEnabledChange(
                            group,
                            checked,
                          )
                        }
                        aria-label={`Toggle ${group} emotion posture preset`}
                      />
                    </div>
                    <div className="space-y-4">
                      {([1, 2, 3] as const).map((level) => (
                        <SliderRow
                          key={`${group}-intensity-${level}`}
                          label={`Level ${level} intensity`}
                          value={preset.intensityByLevel[level]}
                          min={0}
                          max={1}
                          step={0.05}
                          formattedValue={preset.intensityByLevel[
                            level
                          ].toFixed(2)}
                          onChange={(value) =>
                            handleEmotionPosturePresetIntensityChange(
                              group,
                              level,
                              value,
                            )
                          }
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel title="Posture targets">
            <div className="space-y-5">
              {SUPPORTED_EMOTION_POSTURE_GROUPS.map((group) => (
                <div
                  key={group}
                  className="border-border/60 bg-background/70 rounded-lg border p-3"
                >
                  <p className="text-foreground mb-4 text-sm font-medium">
                    {formatEmotionGroupLabel(group)}
                  </p>
                  <div className="space-y-5">
                    {emotionPostureTargetSliders.map((slider) => {
                      const value =
                        emotionPostureDraft.presets[group].target[slider.key];
                      return (
                        <SliderRow
                          key={`${group}-${slider.key}`}
                          label={slider.label}
                          value={value}
                          min={slider.min}
                          max={slider.max}
                          step={slider.step}
                          formattedValue={slider.format(value)}
                          onChange={(nextValue) =>
                            handleEmotionPostureTargetChange(
                              group,
                              slider.key,
                              nextValue,
                            )
                          }
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <LayerSnapshotPanel
            title="Current emotion posture snapshot"
            layer={emotionPostureLayer}
          />
        </div>
      );
    }

    if (activeSection === "Spring Bones") {
      return (
        <div className="space-y-4">
          <Panel
            title="Spring bones"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={resetSpringBoneDefaults}
              >
                <RotateCcw className="h-4 w-4" />
                Reset Authored
              </Button>
            }
          >
            <div className="mb-5 grid gap-4 sm:grid-cols-3">
              <SwitchRow
                label="Enabled"
                value={springBoneDraft.enabled}
                onChange={(checked) =>
                  updateSpringBoneParams({ enabled: checked })
                }
              />
              <SwitchRow
                label="Helpers"
                value={springBoneDraft.helpersVisible}
                onChange={(checked) =>
                  updateSpringBoneParams({ helpersVisible: checked })
                }
              />
              <SwitchRow
                label="Gusts"
                value={springBoneDraft.gusts}
                onChange={(checked) =>
                  updateSpringBoneParams({ gusts: checked })
                }
              />
            </div>
            <div className="space-y-5">
              {springBoneSliders.map((slider) => (
                <SliderRow
                  key={slider.key}
                  label={slider.label}
                  value={springBoneDraft[slider.key]}
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  formattedValue={slider.format(springBoneDraft[slider.key])}
                  onChange={(value) =>
                    handleSpringBoneSliderChange(slider.key, value)
                  }
                />
              ))}
            </div>
          </Panel>
          <SpringBoneProfileControlsPanel
            profiles={springBoneProfileDrafts}
            onIntensityChange={handleSpringBoneProfileIntensityChange}
            onParamChange={handleSpringBoneProfileSliderChange}
            onResetProfile={resetSpringBoneProfileDefaults}
          />
          <SpringBoneSnapshotPanel snapshot={springBoneSnapshot} />
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <Panel
          title="Breathing"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={clearActiveOffsets}
              >
                <Eraser className="h-4 w-4" />
                Clear Offsets
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={resetBreathingDefaults}
              >
                <RotateCcw className="h-4 w-4" />
                Reset Defaults
              </Button>
            </div>
          }
        >
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <p className="text-foreground text-sm font-medium">Enabled</p>
              <p className="text-muted-foreground text-xs">
                {breathingDraft.enabled ? "ON" : "OFF"}
              </p>
            </div>
            <Switch
              checked={breathingDraft.enabled}
              onCheckedChange={(checked) =>
                updateBreathingParams({ enabled: checked })
              }
              aria-label="Toggle breathing procedural animation"
            />
          </div>
          <div className="space-y-5">
            {breathingSliders.map((slider) => (
              <SliderRow
                key={slider.key}
                label={slider.label}
                value={breathingDraft[slider.key]}
                min={slider.min}
                max={slider.max}
                step={slider.step}
                formattedValue={slider.format(breathingDraft[slider.key])}
                onChange={(value) => handleSliderChange(slider.key, value)}
              />
            ))}
          </div>
        </Panel>
        <LayerSnapshotPanel
          title="Current breathing snapshot"
          layer={breathingLayer}
        />
      </div>
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-transparent" />
        <SectionedModalFrame
          title="Animation debug"
          description="Tune procedural avatar animation values for the active avatar."
          closeLabel="Close animation debug"
          sidebarLabel="Animation Debug"
          sidebarTitle={animaLabel ?? target?.animaId ?? "Procedural"}
          sections={sections}
          activeSection={activeSection}
          onSectionChange={setActiveSection}
          headerTitle={activeSection}
          headerDescription={SectionDescription(activeSection)}
          headerMeta={headerMeta}
          dialogClassName="top-0 right-0 left-auto h-screen max-h-screen w-[min(98vw,760px)] translate-x-0 rounded-none rounded-l-2xl border-y-0 border-r-0 md:top-0 md:h-screen md:w-[min(760px,56vw)] md:translate-y-0 md:rounded-none md:rounded-l-2xl"
          gridClassName="md:grid-cols-[210px_minmax(0,1fr)]"
        >
          {renderContent()}
        </SectionedModalFrame>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FieldControl({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  formattedValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  formattedValue: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_4.5rem] sm:items-center">
      <p className="text-foreground text-sm font-medium">{label}</p>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(values) => {
          const [nextValue] = values;
          if (typeof nextValue === "number") {
            onChange(nextValue);
          }
        }}
        aria-label={label}
      />
      <p className="text-muted-foreground font-mono text-xs tabular-nums sm:text-right">
        {formattedValue}
      </p>
    </div>
  );
}

function SelectRow<TValue extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: TValue;
  options: ReadonlyArray<{ value: TValue; label: string }>;
  onChange: (value: TValue) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_4.5rem] sm:items-center">
      <p className="text-foreground text-sm font-medium">{label}</p>
      <Select
        value={value}
        onValueChange={(nextValue) => onChange(nextValue as TValue)}
      >
        <SelectTrigger className="w-full sm:col-span-2" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SwitchRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="border-border/60 bg-background/70 flex items-center justify-between gap-3 rounded-lg border p-3">
      <div>
        <p className="text-foreground text-sm font-medium">{label}</p>
        <p className="text-muted-foreground text-xs">{value ? "ON" : "OFF"}</p>
      </div>
      <Switch
        checked={value}
        onCheckedChange={onChange}
        aria-label={`Toggle ${label.toLowerCase()}`}
      />
    </div>
  );
}

function SectionDescription(section: AnimationDebugSection): string {
  switch (section) {
    case "Breathing":
      return "Live breathing layer controls for the active avatar.";
    case "Sway":
      return "Live full-body idle sway controls for the active avatar.";
    case "Bounce":
      return "Live happy/giddy foot-flexion bounce controls for the active avatar.";
    case "Head Nods":
      return "Live listening head-nod controls for the active avatar.";
    case "Head Side Tilt":
      return "Live curious head-side-tilt controls for the active avatar.";
    case "Cursor Look At":
      return "Live idle cursor look-at controls for the active avatar.";
    case "Talking Hands":
      return "Live talking hands controls for the active avatar.";
    case "Emotion Posture":
      return "Live emotion-driven posture controls for the active avatar.";
    case "Spring Bones":
      return "Wind, updraft, and spring-bone helper controls for the active avatar.";
    case "PoseController":
      return "Catalog pose invocation for the active avatar.";
    case "PoseController Clips":
      return "Catalog clip playback for the active avatar.";
    case "Reactions":
      return "Reaction clip playback, catalog, and planner diagnostics.";
    case "Avatar Planner":
      return "Live planner-owned VRMA, pose clip, procedural, and queue diagnostics.";
    case "Particle VFX":
      return "Manual three.quarks particle playback and diagnostics.";
    case "Runtime":
      return "Current procedural and spring-bone runtime state.";
    default:
      return "";
  }
}

function formatDegrees(value: number): string {
  return `${value.toFixed(1)}deg`;
}

function formatCentimeters(value: number): string {
  return `${value.toFixed(1)}cm`;
}

function formatMeters(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}m`;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(1)}s`;
}

function formatPlanSeconds(value: number): string {
  return `${value.toFixed(3)}s`;
}

function formatSignedPlanSeconds(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}s`;
}

function formatPreciseSeconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

function formatClipEventKindCounts(
  counts: AnimaPoseClipEventKindCounts,
): string {
  return `${counts.total} total / ${counts.avatarVFX} avatar / ${counts.sceneVFX} scene / ${counts.particleVFX} particles / ${counts.sfx} SFX`;
}

function formatClipPlaybackLifetime(
  playback: AnimaPoseClipPlayback | undefined,
): string {
  if (!playback) return "duration";
  const lifetime = playback.lifetime;
  const scope = lifetime.scope ? ` / ${lifetime.scope}` : "";
  if (lifetime.kind === "whileInteractionPhase") {
    return `phase: ${lifetime.phases.join(", ")}${scope}`;
  }
  return `state: ${lifetime.states.join(", ")}${scope}`;
}

function formatClipChannelAnalysis(
  analysis: AnimaPoseClipChannelAnalysis,
): string {
  const channels: string[] = [];
  if (analysis.humanoid) channels.push("body");
  if (analysis.expressions) channels.push("expression");
  if (analysis.avatarVfx) channels.push("avatar VFX");
  if (analysis.sceneVfx) channels.push("scene VFX");
  if (analysis.particleVfx) channels.push("particle VFX");
  if (analysis.sfx) channels.push("SFX");
  return channels.length > 0 ? channels.join(" / ") : "none";
}

function formatParticleVFXRuntimeSummary(
  snapshot: ParticleVFXControllerSnapshot | null,
): string {
  if (!snapshot) return "Unavailable";
  const manualCount = snapshot.activeInstances.filter(
    (instance) => instance.lifetime.kind === "manual",
  ).length;
  const manualSummary = manualCount > 0 ? ` / ${manualCount} manual` : "";
  const lastIssue = snapshot.lastError
    ? ` / error: ${snapshot.lastError}`
    : snapshot.warnings.length > 0
      ? ` / warning: ${snapshot.warnings[snapshot.warnings.length - 1]}`
      : "";
  return `${snapshot.activeCount} active${manualSummary} / ${snapshot.loadedCount} loaded${lastIssue}`;
}

function formatParticleVFXActiveAppliedIds(
  snapshot: ParticleVFXControllerSnapshot | null,
): string {
  return formatList(
    snapshot?.activeInstances.map((instance) => instance.appliedId),
  );
}

function formatParticleVFXLifetime(
  instance: ParticleVFXControllerSnapshot["activeInstances"][number],
): string {
  if (instance.lifetime.kind === "manual") return "Manual";
  return formatPreciseSeconds(
    instance.durationSec ?? instance.lifetime.durationSec,
  );
}

function formatClipPlaybackTime(snapshot: AvatarPoseClipSnapshot): string {
  return `${formatPreciseSeconds(snapshot.elapsedSec)} / ${formatPreciseSeconds(
    snapshot.durationSec,
  )}`;
}

function formatReactionClipPlaybackTime(
  snapshot: ReactionClipPlayerSnapshot,
): string {
  return `${formatPreciseSeconds(snapshot.elapsedSec)} / ${formatPreciseSeconds(
    snapshot.timelineDurationSec,
  )}`;
}

function formatReactionClipFade(snapshot: ReactionClipPlayerSnapshot): string {
  if (snapshot.phase === "fadeIn") {
    return `in ${formatPreciseSeconds(snapshot.fadeElapsedSec)} / ${formatPreciseSeconds(snapshot.fadeInDurationSec)}`;
  }
  if (snapshot.phase === "fadeOut") {
    return `out ${formatPreciseSeconds(snapshot.fadeElapsedSec)} / ${formatPreciseSeconds(snapshot.fadeOutDurationSec)}`;
  }
  return `in ${formatPreciseSeconds(snapshot.fadeInDurationSec)} / out ${formatPreciseSeconds(snapshot.fadeOutDurationSec)}`;
}

function formatInteger(value: number): string {
  return Math.round(value).toString();
}

function formatRatio(value: number): string {
  return value.toFixed(2);
}

function formatList(items: readonly string[] | null | undefined): string {
  return items && items.length > 0 ? items.join(", ") : "-";
}

function formatEmotionGroupLabelForDebug(
  group: EmotionGroup | "neutral",
): string {
  return group === "neutral" ? "Neutral" : formatEmotionGroupLabel(group);
}

function formatEmotionPostureTarget(
  target: EmotionPostureTarget | null | undefined,
): string {
  if (!target) return "-";
  return [
    `hips ${formatDegrees(target.hipsPitchDeg)}`,
    `spine ${formatDegrees(target.spinePitchDeg)}`,
    `chest ${formatDegrees(target.chestPitchDeg)}`,
    `upper ${formatDegrees(target.upperChestPitchDeg)}`,
    `neck ${formatDegrees(target.neckPitchDeg)}`,
    `head ${formatDegrees(target.headPitchDeg)}`,
    `yaw ${formatDegrees(target.headYawDeg)}`,
    `roll ${formatDegrees(target.headRollDeg)}`,
    `shoulders ${formatCentimeters(target.shoulderLiftCm)}`,
  ].join(" / ");
}

function formatPlannerTimestamp(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleTimeString();
}

function formatPlannerElapsed(
  startedAtMs: number | null | undefined,
  nowMs: number,
): string {
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) {
    return "-";
  }
  return formatPreciseSeconds(Math.max(0, nowMs - startedAtMs) / 1000);
}

function formatPlannerDueTime(dueAtMs: number, nowMs: number): string {
  const deltaSec = (dueAtMs - nowMs) / 1000;
  const absolute = formatPlannerTimestamp(dueAtMs);
  if (deltaSec > 0) {
    return `${absolute} (${formatPreciseSeconds(deltaSec)} remaining)`;
  }
  return `${absolute} (${formatPreciseSeconds(Math.abs(deltaSec))} ago)`;
}

function formatPlannerVrma(
  plan: AvatarPlannerVrmaDebugSnapshot | null,
): string {
  if (!plan) return "-";
  const clipLabel = plan.clipName ?? plan.clipUrl ?? "unresolved clip";
  const duration =
    plan.effectiveDurationSec !== null
      ? formatPreciseSeconds(plan.effectiveDurationSec)
      : "continuous";
  const nextEval =
    plan.nextEvalMs !== null
      ? `next ${formatPreciseSeconds(plan.nextEvalMs / 1000)}`
      : "no scheduled eval";
  const source = plan.sourceEmotionEventId
    ? ` | source ${plan.sourceEmotionEventId}`
    : plan.sourceMotionEventId
      ? ` | event ${plan.sourceMotionEventId}`
      : "";
  return `${plan.key} | ${clipLabel} | ${plan.loopType} | ${duration} | ${nextEval}${source}`;
}

function formatIdleStintCandidate(
  candidate: AvatarPlannerDebugSnapshot["idleStint"]["selectedCandidate"],
): string {
  if (!candidate) return "-";
  const match = candidate.neutral
    ? "neutral"
    : candidate.matchedEmotion
      ? `${candidate.matchedEmotion} L${candidate.matchedLevel}`
      : "unmatched";
  const duration =
    candidate.effectiveDurationSec !== null
      ? formatPreciseSeconds(candidate.effectiveDurationSec)
      : "unknown";
  return `${candidate.name || candidate.file} | ${match} | ${candidate.weight.toFixed(2)} | ${duration}`;
}

function formatIdleCandidateLoop(
  candidate: AvatarPlannerDebugSnapshot["idleStint"]["candidates"][number],
): string {
  const loopCount =
    typeof candidate.loopCount === "number" ? ` x${candidate.loopCount}` : "";
  return `${candidate.loopType}${loopCount} @${candidate.timeScale.toFixed(2)}`;
}

function formatPlannerPoseClip(poseClip: AvatarPlannerPoseClip | null): string {
  if (!poseClip) return "-";
  return `${poseClip.clipId} (${poseClip.status})`;
}

function formatPlannerReactionClip(
  reactionClip: AvatarPlannerDebugSnapshot["activeReactionClip"],
): string {
  if (!reactionClip) return "-";
  return `${reactionClip.clipId} | ${reactionClip.emotionalTone ?? "-"} L${reactionClip.emotionalIntensity} | run ${reactionClip.runId}`;
}

function formatPlannerResolvedGesture(
  gesture: AvatarPlannerDebugSnapshot["resolvedGesture"],
): string {
  if (!gesture) return "-";
  return `${gesture.id} | ${gesture.type} | ${gesture.source} | ${gesture.clipId ?? "-"}`;
}

function formatPlannerTalkingMotionArbitration(
  arbitration: AvatarPlannerDebugSnapshot["talkingMotionArbitration"],
): string {
  const runId = arbitration.runId ?? "-";
  const hint = arbitration.animationHint ?? "-";
  const source =
    arbitration.sourceEmotionEventId ?? arbitration.sourceMotionEventId ?? "-";
  return `${arbitration.status} | run ${runId} | hint ${hint} | source ${source}`;
}

function formatPlannerProceduralStints(
  stints: readonly AvatarPlannerProceduralStint[],
  nowMs: number,
): string {
  if (stints.length === 0) return "-";
  return stints
    .map((stint) => {
      const layer = stint.layerId ?? "none";
      const enabled = stint.enabled ? "enabled" : "disabled";
      const age = formatPlannerElapsed(stint.startedAtMs, nowMs);
      return `${stint.policy}:${layer}:${enabled}:${age}`;
    })
    .join(", ");
}

function formatPlannerPendingEvents(
  events: readonly AvatarPlannerPendingEventDebugSnapshot[],
): string {
  if (events.length === 0) return "-";
  return events.map(formatPlannerPendingEvent).join(", ");
}

function formatPlannerPendingReactionEvents(
  events: AvatarPlannerDebugSnapshot["pendingReactionClipEvents"],
): string {
  if (events.length === 0) return "-";
  return events
    .map(
      (event) =>
        `${event.emotional_tone ?? "neutral"}:${event.emotional_intensity}:run ${event.runId ?? "-"}`,
    )
    .join(", ");
}

function formatPlannerPendingEvent(
  event: AvatarPlannerPendingEventDebugSnapshot,
): string {
  if (event.type === "runStarted") {
    const dwell =
      event.thinkingPoseDwellMs !== null
        ? `${event.thinkingPoseDwellMs}ms`
        : "default dwell";
    return `runStarted:${event.runId}:${event.inputTextLength} chars:${dwell}`;
  }
  if (event.type === "gestureRequested") {
    const source = event.sourceEmotionEventId
      ? ` from ${event.sourceEmotionEventId}`
      : "";
    return `gesture:${event.requestId}:${event.animationHint ?? "emotion"}${source}`;
  }
  return `emotion:${event.emotionEventId ?? "unknown"}:${event.runId ?? "no run"}:${event.animationHint ?? "no hint"}`;
}

function formatSemanticCounts(
  counts: SpringBonePhysicsSnapshot["semanticJointCounts"] | null | undefined,
): string {
  return counts
    ? [
        `${counts.total} total`,
        `${counts.hair} hair`,
        `${counts.cloth} cloth`,
        `${counts.accessory} accessory`,
        `${counts.tail} tail`,
        `${counts.ear} ear`,
        `${counts.chest} chest`,
        `${counts.unprofiled} unprofiled`,
        `${counts.unmapped} unmapped`,
        `${counts.lowConfidence} low confidence`,
      ].join(" / ")
    : "-";
}

function formatNamedSemanticCounts(
  counts: SpringBonePhysicsSnapshot["semanticJointCounts"] | null | undefined,
): string {
  return counts
    ? [
        `${counts.hair} hair`,
        `${counts.cloth} cloth`,
        `${counts.accessory} accessory`,
        `${counts.tail} tail`,
        `${counts.ear} ear`,
        `${counts.chest} chest`,
      ].join(" / ")
    : "-";
}

const springBoneHelperColorLegend = [
  { label: "Hair", color: "#facc15" },
  { label: "Cloth", color: "#38bdf8" },
  { label: "Accessory", color: "#f472b6" },
  { label: "Tail", color: "#4ade80" },
  { label: "Ear", color: "#22d3ee" },
  { label: "Chest", color: "#fb923c" },
  { label: "Unprofiled", color: "#94a3b8" },
  { label: "Unmapped", color: "#ef4444" },
  { label: "Colliders", color: "#d946ef" },
] as const;

function LayerSnapshotPanel({
  title,
  layer,
}: {
  title: string;
  layer: ProceduralAnimationLayerSnapshot | null;
}) {
  return (
    <Panel title={title}>
      <KeyValueGrid
        rows={[
          {
            label: "Enabled",
            value: layer?.enabled ? "true" : "false",
          },
          {
            label: "Weight",
            value:
              typeof layer?.weight === "number" ? layer.weight.toFixed(2) : "-",
          },
          {
            label: "Resolved bones",
            value: formatList(layer?.resolvedBones),
          },
          {
            label: "Missing bones",
            value: formatList(layer?.missingBones),
          },
        ]}
      />
    </Panel>
  );
}

function TalkingHandsSpeechPlanPanel({
  plan,
  onReplay,
}: {
  plan: ProceduralAnimationLayerSnapshot<"talkingHands">["speechPlan"] | null;
  onReplay: () => void;
}) {
  const diagnostics = plan?.diagnostics ?? null;
  const chunkDiagnostics = plan?.chunks ?? [];
  const pulseApexes = diagnostics?.pulseApexes ?? [];
  const skippedBeats = diagnostics?.skippedBeats ?? [];

  return (
    <Panel
      title="Last TTS speech plan"
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!plan?.replayRequest}
          onClick={onReplay}
        >
          <Play className="h-4 w-4" />
          Replay
        </Button>
      }
    >
      {!plan || !diagnostics ? (
        <EmptyState
          title="No speech plan"
          description="No TTS plan has been captured for this avatar."
        />
      ) : (
        <div className="space-y-4">
          <KeyValueGrid
            rows={[
              { label: "Status", value: plan.status },
              { label: "Scope", value: diagnostics.scope },
              { label: "Reason", value: plan.reason ?? "-" },
              { label: "Run", value: diagnostics.runId },
              { label: "Chunks", value: chunkDiagnostics.length },
              {
                label: "Duration",
                value: formatPlanSeconds(diagnostics.utteranceDurationSec),
              },
              {
                label: "Window end",
                value: formatPlanSeconds(diagnostics.windowEndSec),
              },
              {
                label: "Elapsed at plan",
                value: formatPlanSeconds(diagnostics.elapsedSec),
              },
              {
                label: "Remaining at plan",
                value: formatPlanSeconds(diagnostics.remainingSec),
              },
              {
                label: "Return start",
                value: formatPlanSeconds(diagnostics.returnStartSec),
              },
              {
                label: "Min spacing",
                value: formatPlanSeconds(diagnostics.minSpacingSec),
              },
              {
                label: "Gesture entry",
                value: formatPlanSeconds(diagnostics.gestureEntrySec),
              },
              {
                label: "Entry grace",
                value: formatPlanSeconds(diagnostics.gestureEntryGraceSec),
              },
              {
                label: "Gesture return",
                value: formatPlanSeconds(diagnostics.gestureReturnSec),
              },
              {
                label: "Pulse attack",
                value: formatPlanSeconds(diagnostics.pulseAttackSec),
              },
              {
                label: "Pulse release",
                value: formatPlanSeconds(diagnostics.pulseReleaseSec),
              },
              {
                label: "Selected side",
                value: diagnostics.selectedSide ?? "-",
              },
              {
                label: "Selected beats",
                value: diagnostics.selectedBeats.length,
              },
              {
                label: "Skipped beats",
                value: diagnostics.skippedBeats.length,
              },
              {
                label: "Max pulse count",
                value: diagnostics.maxPulseCount,
              },
            ]}
          />
          {chunkDiagnostics.length > 0 ? (
            <details
              className="border-border/60 bg-background/70 rounded-lg border p-3"
              open
            >
              <summary className="text-foreground cursor-pointer text-sm font-medium">
                TTS chunks
              </summary>
              <div className="mt-3 max-h-80 overflow-y-auto pr-1">
                <Table>
                  <thead>
                    <tr>
                      <HeaderCell>Chunk</HeaderCell>
                      <HeaderCell>Status</HeaderCell>
                      <HeaderCell>Side</HeaderCell>
                      <HeaderCell>Words</HeaderCell>
                      <HeaderCell>Beats</HeaderCell>
                    </tr>
                  </thead>
                  <tbody className="divide-border/60 divide-y">
                    {chunkDiagnostics.map((chunk) => (
                      <tr key={chunk.chunkId}>
                        <BodyCell>
                          <span className="block">
                            #{chunk.index} {chunk.isExclamation ? "!" : ""}
                          </span>
                          <span className="text-muted-foreground block max-w-72 truncate text-xs">
                            {chunk.preview || "-"}
                          </span>
                          <span className="text-muted-foreground block text-xs">
                            {chunk.boundaryType}
                          </span>
                        </BodyCell>
                        <BodyCell>
                          {chunk.status}
                          {chunk.skipReason ? (
                            <span className="text-muted-foreground block text-xs">
                              {chunk.skipReason}
                            </span>
                          ) : null}
                        </BodyCell>
                        <BodyCell>{chunk.selectedSide ?? "-"}</BodyCell>
                        <BodyCell>
                          {chunk.wordStartIndex}-{chunk.wordEndIndex}
                        </BodyCell>
                        <BodyCell>
                          {chunk.selectedBeats.length}/{chunk.beatCount}
                          {chunk.pulseApexes.length > 0 ? (
                            <span className="text-muted-foreground block text-xs">
                              apex{" "}
                              {formatPlanSeconds(
                                chunk.pulseApexes[0]!.apexTimeSec,
                              )}
                            </span>
                          ) : null}
                        </BodyCell>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </details>
          ) : null}
          {pulseApexes.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <HeaderCell>Beat</HeaderCell>
                  <HeaderCell>Apex</HeaderCell>
                  <HeaderCell>Drift</HeaderCell>
                  <HeaderCell>Syllable</HeaderCell>
                </tr>
              </thead>
              <tbody className="divide-border/60 divide-y">
                {pulseApexes.map((pulse, index) => (
                  <tr
                    key={`${pulse.beat.wordIndex}:${pulse.beat.unitIndex}:${pulse.beatTimeSec}:${index}`}
                  >
                    <BodyCell>{formatPlanSeconds(pulse.beatTimeSec)}</BodyCell>
                    <BodyCell>{formatPlanSeconds(pulse.apexTimeSec)}</BodyCell>
                    <BodyCell>
                      {formatSignedPlanSeconds(pulse.driftSec)}
                    </BodyCell>
                    <BodyCell>
                      word {pulse.beat.wordIndex}, unit {pulse.beat.unitIndex}
                    </BodyCell>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState
              title="No pulse apexes"
              description="The last plan did not select playable pulse beats."
            />
          )}
          {skippedBeats.length > 0 ? (
            <details className="border-border/60 bg-background/70 rounded-lg border p-3">
              <summary className="text-foreground cursor-pointer text-sm font-medium">
                Skipped beats
              </summary>
              <div className="mt-3 max-h-72 overflow-y-auto pr-1">
                <Table>
                  <thead>
                    <tr>
                      <HeaderCell>Beat</HeaderCell>
                      <HeaderCell>Reason</HeaderCell>
                      <HeaderCell>Syllable</HeaderCell>
                    </tr>
                  </thead>
                  <tbody className="divide-border/60 divide-y">
                    {skippedBeats.map((beat, index) => (
                      <tr
                        key={`${beat.wordIndex}:${beat.unitIndex}:${beat.timeSec}:${beat.reason}:${index}`}
                      >
                        <BodyCell>{formatPlanSeconds(beat.timeSec)}</BodyCell>
                        <BodyCell>{beat.reason}</BodyCell>
                        <BodyCell>
                          word {beat.wordIndex}, unit {beat.unitIndex}
                        </BodyCell>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </details>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function SpringBoneProfileControlsPanel({
  profiles,
  onIntensityChange,
  onParamChange,
  onResetProfile,
}: {
  profiles: SpringBonePhysicsSnapshot["semanticProfiles"];
  onIntensityChange: (semantic: SpringBoneSemantic, value: number) => void;
  onParamChange: (
    semantic: SpringBoneSemantic,
    key: SpringBoneSliderKey,
    value: number,
  ) => void;
  onResetProfile: (semantic?: SpringBoneSemantic) => void;
}) {
  return (
    <Panel title="Semantic profile controls">
      {profiles.length > 0 ? (
        <div className="space-y-3">
          {profiles.map((profile) => (
            <details
              key={profile.semantic}
              className="border-border/60 bg-background/70 rounded-lg border p-3"
            >
              <summary className="text-foreground flex cursor-pointer items-center justify-between gap-3 text-sm font-medium">
                <span className="capitalize">{profile.semantic}</span>
                <span className="text-muted-foreground text-xs font-normal">
                  intensity {profile.intensityScale.toFixed(2)}
                  {profile.overriddenParamKeys.length > 0 ||
                  profile.intensityOverridden
                    ? " · overridden"
                    : " · inherited"}
                </span>
              </summary>
              <div className="mt-4 space-y-5">
                <SliderRow
                  label="Intensity"
                  value={profile.intensityScale}
                  min={0}
                  max={1.5}
                  step={0.05}
                  formattedValue={`${profile.intensityScale.toFixed(2)}${
                    profile.intensityOverridden ? "" : " default"
                  }`}
                  onChange={(value) =>
                    onIntensityChange(profile.semantic, value)
                  }
                />
                {springBoneSliders.map((slider) => (
                  <SliderRow
                    key={slider.key}
                    label={slider.label}
                    value={profile.params[slider.key]}
                    min={slider.min}
                    max={slider.max}
                    step={slider.step}
                    formattedValue={`${slider.format(
                      profile.params[slider.key],
                    )}${
                      profile.overriddenParamKeys.includes(slider.key)
                        ? ""
                        : " inherited"
                    }`}
                    onChange={(value) =>
                      onParamChange(profile.semantic, slider.key, value)
                    }
                  />
                ))}
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onResetProfile(profile.semantic)}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Reset Profile
                  </Button>
                </div>
              </div>
            </details>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No semantic profiles"
          description="Load an avatar with spring bones to inspect profile controls."
        />
      )}
    </Panel>
  );
}

function SpringBoneSnapshotPanel({
  snapshot,
}: {
  snapshot: SpringBonePhysicsSnapshot | null;
}) {
  return (
    <Panel title="Current spring-bone snapshot">
      <KeyValueGrid
        rows={[
          {
            label: "Manager",
            value: snapshot?.hasManager ? "available" : "missing",
          },
          {
            label: "Joints",
            value: snapshot?.jointCount ?? "-",
          },
          {
            label: "Colliders",
            value: snapshot?.colliderCount ?? "-",
          },
          {
            label: "Cached joints",
            value: snapshot?.cachedJointCount ?? "-",
          },
          {
            label: "Overriding",
            value: snapshot?.overridingSettings ? "true" : "false",
          },
          {
            // Off for Mochiya and MMD conversions: wind, updraft and gust do nothing.
            label: "Ambient forces",
            value: snapshot
              ? snapshot.ambientForces
                ? "on"
                : "off (converted Avatar)"
              : "-",
          },
          {
            label: "Helpers",
            value: snapshot
              ? `${snapshot.helperCount} / ${
                  snapshot.helpersVisible ? "visible" : "hidden"
                }`
              : "-",
          },
          {
            label: "Helper host",
            value: snapshot?.helperHostAttached ? "attached" : "missing",
          },
          {
            label: "Foot bones",
            value: formatList(snapshot?.footBonesResolved),
          },
          {
            label: "Missing feet",
            value: formatList(snapshot?.footBonesMissing),
          },
          {
            label: "Semantic profile",
            value: snapshot?.semanticProfileReady ? "ready" : "unavailable",
          },
          {
            label: "Semantic joints",
            value: formatSemanticCounts(snapshot?.semanticJointCounts),
          },
          {
            label: "Semantic assignments",
            value: snapshot?.semanticAssignmentCount ?? "-",
          },
          {
            label: "Semantic warnings",
            value: formatList(snapshot?.semanticWarnings),
          },
          {
            label: "Next gust",
            value:
              typeof snapshot?.nextGustChangeInSec === "number"
                ? `${snapshot.nextGustChangeInSec.toFixed(2)}s`
                : "-",
          },
          {
            label: "Warnings",
            value: formatList(snapshot?.warnings),
          },
        ]}
      />
      <SpringBoneSemanticProfilePanel snapshot={snapshot} />
      {snapshot?.semanticAssignments.length ? (
        <details className="border-border/60 bg-background/70 mt-4 rounded-lg border p-3">
          <summary className="text-foreground cursor-pointer text-sm font-medium">
            Spring bone assignments
          </summary>
          <div className="mt-3 max-h-80 overflow-y-auto pr-1">
            <Table>
              <thead>
                <tr>
                  <HeaderCell>Profile</HeaderCell>
                  <HeaderCell>Spring</HeaderCell>
                  <HeaderCell>Runtime bone</HeaderCell>
                  <HeaderCell>Root nodes</HeaderCell>
                  <HeaderCell>Joint nodes</HeaderCell>
                  <HeaderCell>Source</HeaderCell>
                </tr>
              </thead>
              <tbody className="divide-border/60 divide-y">
                {snapshot.semanticAssignments.map((assignment) => (
                  <tr
                    key={assignment.id}
                    className={
                      assignment.confidence < 0.5
                        ? "bg-destructive/5"
                        : undefined
                    }
                  >
                    <BodyCell>
                      {assignment.semantic ?? "unprofiled"}
                      <span className="text-muted-foreground block text-xs">
                        intensity {assignment.intensityScale.toFixed(2)} ·
                        confidence {assignment.confidence.toFixed(2)}
                      </span>
                    </BodyCell>
                    <BodyCell>
                      {assignment.springName ?? assignment.comment ?? "-"}
                    </BodyCell>
                    <BodyCell>
                      {assignment.runtimeBoneName ??
                        formatRuntimeNodeIndex(assignment.runtimeNodeIndex)}
                    </BodyCell>
                    <BodyCell>{formatList(assignment.rootNodeNames)}</BodyCell>
                    <BodyCell>{formatList(assignment.jointNodeNames)}</BodyCell>
                    <BodyCell>{assignment.source}</BodyCell>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </details>
      ) : null}
    </Panel>
  );
}

function SpringBoneSemanticProfilePanel({
  snapshot,
}: {
  snapshot: SpringBonePhysicsSnapshot | null;
}) {
  const counts = snapshot?.semanticJointCounts;
  return (
    <div className="mt-4">
      <h3 className="text-foreground mb-2 text-sm font-medium">
        Semantic profile diagnostics
      </h3>
      <KeyValueGrid
        rows={[
          {
            label: "State",
            value: snapshot?.semanticProfileReady ? "ready" : "unavailable",
          },
          {
            label: "Total joints",
            value: counts?.total ?? "-",
          },
          {
            label: "Named profiles",
            value: formatNamedSemanticCounts(counts),
          },
          {
            label: "Unprofiled",
            value: counts?.unprofiled ?? "-",
          },
          {
            label: "Unmapped",
            value: counts?.unmapped ?? "-",
          },
          {
            label: "Low confidence",
            value: counts?.lowConfidence ?? "-",
          },
          {
            label: "Fallback intensity",
            value: "0.50",
          },
        ]}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {springBoneHelperColorLegend.map((entry) => (
          <span
            key={entry.label}
            className="border-border/60 bg-background/70 text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
          >
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function formatRuntimeNodeIndex(nodeIndex: number | null): string {
  return typeof nodeIndex === "number" ? `node ${nodeIndex}` : "-";
}

function isBreathingLayer(
  layer: ProceduralAnimationLayerSnapshot,
): layer is ProceduralAnimationLayerSnapshot<"breathing"> {
  return layer.id === "breathing";
}

function isSwayLayer(
  layer: ProceduralAnimationLayerSnapshot,
): layer is ProceduralAnimationLayerSnapshot<"sway"> {
  return layer.id === "sway";
}

function isBounceLayer(
  layer: ProceduralAnimationLayerSnapshot,
): layer is ProceduralAnimationLayerSnapshot<"bounce"> {
  return layer.id === "bounce";
}

function isHeadNodLayer(
  layer: ProceduralAnimationLayerSnapshot,
): layer is ProceduralAnimationLayerSnapshot<"headNod"> {
  return layer.id === "headNod";
}

function isHeadSideTiltLayer(
  layer: ProceduralAnimationLayerSnapshot,
): layer is ProceduralAnimationLayerSnapshot<"headSideTilt"> {
  return layer.id === "headSideTilt";
}

function isCursorLookAtLayer(
  layer: ProceduralAnimationLayerSnapshot,
): layer is ProceduralAnimationLayerSnapshot<"cursorLookAt"> {
  return layer.id === "cursorLookAt";
}

function isTalkingHandsLayer(
  layer: ProceduralAnimationLayerSnapshot,
): layer is ProceduralAnimationLayerSnapshot<"talkingHands"> {
  return layer.id === "talkingHands";
}

function isEmotionPostureLayer(
  layer: ProceduralAnimationLayerSnapshot,
): layer is ProceduralAnimationLayerSnapshot<"emotionPosture"> {
  return layer.id === "emotionPosture";
}
