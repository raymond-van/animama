import type { TFunction } from "i18next";
import { getI18n } from "react-i18next";

import { withNameHash } from "@/lib/content/nameIdentifiers";
import { ANIMA_POSE_CLIP_V2_SCHEMA } from "@/lib/avatar/poses/animaPoseClip/schemaV2";
import { RELAXED_REST_POSE_ID } from "@/lib/avatar/poses/catalog";
import type { PyContentDependency } from "@/lib/content/catalogTypes";
import type { EmotionReactionIntensity } from "@/lib/avatar/reactionPools";
import { isRecord } from "@/lib/records";

export type ActionIntent = "gesture" | "reaction";
export type ActionImplementation = "anima_clip" | "vrma";

export type ActionDocument = {
  schema: 1;
  intent: ActionIntent;
  name: string;
  aiDescription: string;
  semanticKey: string;
  implementation: ActionImplementation;
  suggestedEmotion: string;
  suggestedIntensity: EmotionReactionIntensity;
  notes: string;
  sequence: Record<string, unknown>;
  dependencies: PyContentDependency[];
};

export type ActionAuthoringSnapshot = Pick<
  ActionDocument,
  "sequence" | "dependencies"
>;

const ACTION_SLUG_MAX_LENGTH = 120;

/** Convert a display name into the stable ASCII slug used by Action files and clips. */
export function actionNameSlug(name: string, fallback = "action"): string {
  const value = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ACTION_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return value || fallback;
}

/** Derive the embedded Anima Pose Clip ID from its owning Action name. */
export function actionClipId(name: string, intent: ActionIntent): string {
  return actionNameSlug(name, `new-${intent}`);
}

/** Capture only undoable creator content, excluding metadata and save state. */
export function actionAuthoringSnapshot(
  document: ActionDocument,
): ActionAuthoringSnapshot {
  const normalized = normalizeActionDocument(document);
  return {
    sequence: structuredClone(normalized.sequence),
    dependencies: structuredClone(normalized.dependencies),
  };
}

export function applyActionAuthoringSnapshot(
  document: ActionDocument,
  snapshot: ActionAuthoringSnapshot,
): ActionDocument {
  return normalizeActionDocument({
    ...document,
    sequence: structuredClone(snapshot.sequence),
    dependencies: structuredClone(snapshot.dependencies),
  });
}

export function actionAuthoringSnapshotsEqual(
  left: ActionAuthoringSnapshot,
  right: ActionAuthoringSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Generate the stable, model-facing selector proposed for a new Gesture. Names
 * in other scripts get a name hash so different names never share a selector.
 */
export function gestureSemanticKey(name: string): string {
  const folded = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return withNameHash(name, folded, {
    separator: "_",
    stem: "gesture",
    empty: "new_gesture",
    maxLength: 64,
  });
}

/** An empty `animaPoseClip/2.0` clip: no beats or events yet. Its name is stored data. */
function defaultSequence(intent: ActionIntent): Record<string, unknown> {
  return {
    schema: ANIMA_POSE_CLIP_V2_SCHEMA,
    id: actionClipId("", intent),
    name: `New ${intent === "gesture" ? "Gesture" : "Reaction"}`,
    duration: 2,
    ...(intent === "gesture" ? { basePose: RELAXED_REST_POSE_ID } : {}),
    beats: [],
    events: [],
  };
}

/** Create a product-specific editor document without exposing a role selector. */
export function createActionDocument(intent: ActionIntent): ActionDocument {
  // New editors show the content type as a placeholder instead of persisting a
  // fake display name that the creator must remember to replace.
  const name = "";
  return {
    schema: 1,
    intent,
    name,
    aiDescription: "",
    semanticKey: intent === "gesture" ? gestureSemanticKey(name) : "",
    implementation: "anima_clip",
    suggestedEmotion: "",
    suggestedIntensity: 1,
    notes: "",
    sequence: defaultSequence(intent),
    dependencies: [],
  };
}

/**
 * Rename a document while keeping brand-new Gesture selectors name-coupled.
 * Customized Starter Gestures intentionally carry a distinct selector, so a
 * display-name edit must not replace that collision-safe identity.
 */
export function renameActionDocument(
  document: ActionDocument,
  name: string,
  syncNewGestureSelector: boolean,
): ActionDocument {
  const selectorFollowsName =
    document.intent === "gesture" &&
    document.semanticKey === gestureSemanticKey(document.name);
  return normalizeActionDocument({
    ...document,
    name,
    semanticKey:
      syncNewGestureSelector && selectorFollowsName
        ? gestureSemanticKey(name)
        : document.semanticKey,
  });
}

/**
 * Remove motion-only channels that the shared pose workspace can synthesize
 * while editing a Reaction. Reactions intentionally own expression, VFX, and
 * SFX timing only; their documents must never inherit the preview Avatar's
 * neutral humanoid pose or an external base-pose reference.
 */
export function sanitizeReactionSequence(
  sequence: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = structuredClone(sequence);
  delete sanitized.basePose;
  // Reactions never run body layers through the Gesture lane; mutes are
  // Gesture-only and would otherwise be stored with no control to change them.
  delete sanitized.mutedProceduralLayers;
  // Reactions keep their beats, expression tracks and events.
  for (const field of REACTION_BODY_FIELDS) delete sanitized[field];
  return sanitized;
}

/** Enforce the product capabilities whenever a document crosses editor state. */
export function normalizeActionDocument(
  document: ActionDocument,
): ActionDocument {
  // The blank new-document state needs a schema-valid timeline placeholder.
  // Once the required Action name exists, it is the sole clip-name authority.
  const clipName =
    document.name.trim() ||
    `New ${document.intent === "gesture" ? "Gesture" : "Reaction"}`;
  const sequence = {
    ...document.sequence,
    id: actionClipId(clipName, document.intent),
    name: clipName,
  };
  return document.intent === "reaction"
    ? { ...document, sequence: sanitizeReactionSequence(sequence) }
    : { ...document, sequence };
}

export type ActionDocumentIssue = {
  field: string;
  message: string;
};

/**
 * Validate editor-only invariants before previewing or saving. Messages are
 * worded in the UI Locale with `t` (default: the active locale).
 */
export function validateActionDocument(
  document: ActionDocument,
  t: TFunction<"actionEditor"> = getI18n().getFixedT(null, "actionEditor"),
): ActionDocumentIssue[] {
  const issues: ActionDocumentIssue[] = [];
  if (!document.name.trim())
    issues.push({ field: "name", message: t("validation.nameRequired") });
  if (document.intent === "gesture" && !document.aiDescription.trim())
    issues.push({
      field: "aiDescription",
      message: t("validation.aiDescriptionRequired"),
    });
  if (document.intent === "gesture" && !document.semanticKey.trim())
    issues.push({
      field: "semanticKey",
      message: t("validation.selectorRequired"),
    });
  if (document.intent === "reaction" && document.implementation === "vrma")
    issues.push({
      field: "implementation",
      message: t("validation.reactionTimelinesOnly"),
    });
  const aliases = new Set(document.dependencies.map((value) => value.alias));
  for (const alias of referencedAliases(document.sequence)) {
    if (!aliases.has(alias)) {
      issues.push({
        field: "dependencies",
        message: t("validation.unknownEvent", { alias }),
      });
    }
  }
  if (document.intent === "reaction" && hasHumanoidTracks(document.sequence)) {
    issues.push({
      field: "sequence",
      message: t("validation.reactionHumanoid"),
    });
  }
  return issues;
}

export function referencedAliases(sequence: Record<string, unknown>): string[] {
  const events = Array.isArray(sequence.events) ? sequence.events : [];
  const aliases = events.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const event = raw as Record<string, unknown>;
    const value = event.effectId ?? event.presetId ?? event.cueId;
    return typeof value === "string" && value ? [value] : [];
  });
  return [...new Set(aliases)].sort();
}

export function hasHumanoidTracks(sequence: Record<string, unknown>): boolean {
  return ["joints", "rotations", "hipsPosition", "hands"].some(
    (field) =>
      isRecord(sequence[field]) &&
      Object.keys(sequence[field] as Record<string, unknown>).length > 0,
  );
}

/** Clip fields that move the body, which Reactions never carry. */
const REACTION_BODY_FIELDS = [
  "joints",
  "rotations",
  "hipsPosition",
  "hands",
  "contacts",
  "plantFeet",
] as const;
