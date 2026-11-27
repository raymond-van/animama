import { getI18n } from "react-i18next";

import { isNonPortable } from "@/lib/content/portability";
import { WordedError } from "@/lib/errors/apiError";
import type {
  PyContentDependency,
  PyCatalogViewItem,
  PyGesture,
  PyActionPreview,
  PyReaction,
} from "@/lib/content/catalogTypes";
import {
  MAX_ANIMA_POSE_CLIP_BYTES,
  parseAnimaPoseClip,
} from "@/lib/avatar/poses/animaPoseClip";
import { BUILT_IN_AVATAR_MOTION_CATALOG } from "@/lib/avatar/motion/AvatarMotionCatalog";
import {
  REACTION_INTENSITIES,
  type EmotionReactionIntensity,
} from "@/lib/avatar/reactionPools";
import { fetchContentPreviewFile } from "@/lib/content/contentPreview";
import { actionClosure } from "@/lib/content-preview/ActionPreviewSession";
import { readBoundedJsonResponse } from "@/lib/runtime-content/runtimeContentDelivery";
import { gestureSemanticKey, normalizeActionDocument } from "./actionDocument";
import type { ActionDocument, ActionIntent } from "./actionDocument";

type ActionItem = PyGesture | PyReaction;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The suggested Reaction intensity, or Mild when it names none. */
function selectedIntensity(value: unknown): EmotionReactionIntensity {
  return REACTION_INTENSITIES.find((level) => level === Number(value)) ?? 1;
}

function dependenciesFromPreview(
  preview: PyActionPreview,
): PyContentDependency[] {
  const closure = actionClosure(preview);
  const supports = new Map(
    closure.supports.map((support) => [String(support.runtime_id), support]),
  );
  const resolved = Object.entries(object(closure.root.reference_map)).flatMap(
    ([alias, runtimeId]) => {
      const support = supports.get(String(runtimeId));
      const source = support?.source;
      const contentType = support?.content_type;
      // A licensed built-in sound stays with built-in content.
      if (isNonPortable(support)) return [];
      return source &&
        typeof source === "object" &&
        [
          "particle_effect",
          "avatar_effect",
          "scene_effect",
          "sound_effect",
        ].includes(String(contentType))
        ? [
            {
              alias,
              content_type: contentType as PyContentDependency["content_type"],
              source: source as PyContentDependency["source"],
            },
          ]
        : [];
    },
  );
  if (resolved.length) return resolved;
  const authored = Array.isArray(closure.root.dependencies)
    ? closure.root.dependencies
    : [];
  const removed = object(closure.root.missing_references);
  return authored.flatMap((raw) => {
    const value = object(raw);
    // A removed Included effect is not declared again; its events surface
    // as unresolved for the person to map or remove.
    if (typeof value.alias === "string" && Object.hasOwn(removed, value.alias))
      return [];
    const source = object(value.source);
    const contentType = value.content_type;
    const declaredRef = value.ref;
    const exactSource =
      source.type === "catalog" || source.type === "builtin"
        ? source
        : typeof declaredRef === "string" && declaredRef.startsWith("builtin:")
          ? {
              type: "builtin",
              content_id: declaredRef,
              // Included descriptors predate explicit source objects. Their
              // catalog contract is currently version 1, so reconstruct the
              // same exact source that the component catalog exposes.
              version:
                typeof value.version === "number" && value.version > 0
                  ? value.version
                  : 1,
            }
          : null;
    return typeof value.alias === "string" &&
      [
        "particle_effect",
        "avatar_effect",
        "scene_effect",
        "sound_effect",
      ].includes(String(contentType)) &&
      exactSource
      ? [
          {
            alias: value.alias,
            content_type: contentType as PyContentDependency["content_type"],
            source: exactSource as PyContentDependency["source"],
            config: object(value.config),
          },
        ]
      : [];
  });
}

/** The built-in sound ref prefix; sounds are left behind, never "removed effects". */
const BUILTIN_SOUND_PREFIX = "builtin:sound-effect:";

/**
 * Clip aliases of the sounds an opened Action can't carry into owner content:
 * licensed built-in sounds, and optional pack sounds this build doesn't
 * install. Their `sfx` events are left out of the copy, as a built-in effect's
 * sound is (ADR 0022).
 */
function soundsLeftBehind(preview: PyActionPreview): Set<string> {
  const closure = actionClosure(preview);
  const supports = new Map(
    closure.supports.map((support) => [String(support.runtime_id), support]),
  );
  const licensed = Object.entries(object(closure.root.reference_map))
    .filter(([, runtimeId]) => isNonPortable(supports.get(String(runtimeId))))
    .map(([alias]) => alias);
  const omitted = Object.entries(object(closure.root.missing_references))
    .filter(([, ref]) => String(ref).startsWith(BUILTIN_SOUND_PREFIX))
    .map(([alias]) => alias);
  return new Set([...licensed, ...omitted]);
}

function withoutSoundEvents(
  sequence: Record<string, unknown>,
  aliases: Set<string>,
): Record<string, unknown> {
  if (!aliases.size || !Array.isArray(sequence.events)) return sequence;
  return {
    ...sequence,
    events: sequence.events.filter((raw) => {
      const event = object(raw);
      return !(
        event.kind === "sfx" &&
        typeof event.cueId === "string" &&
        aliases.has(event.cueId)
      );
    }),
  };
}

async function ownedSequence(
  preview: PyActionPreview,
  root: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const t = getI18n().getFixedT(null, "actionEditor");
  const sequenceFile = (Array.isArray(root.files) ? root.files : []).find(
    (raw) => object(raw).role === "sequence",
  );
  const fileRef = object(sequenceFile).file_ref;
  if (typeof fileRef !== "string" || !fileRef) {
    throw new WordedError(t("loader.noSequence"));
  }
  const response = await fetchContentPreviewFile(preview, {
    file_ref: fileRef,
  });
  if (!response.ok) {
    throw new WordedError(t("loader.downloadFailed"));
  }
  return (await readBoundedJsonResponse(
    response,
    MAX_ANIMA_POSE_CLIP_BYTES,
  )) as Record<string, unknown>;
}

function builtinSequence(
  intent: ActionIntent,
  root: Record<string, unknown>,
): Record<string, unknown> {
  const t = getI18n().getFixedT(null, "actionEditor");
  const technical = object(object(root.implementation).technical_source);
  const key =
    technical.type === "runtime_catalog"
      ? technical.key
      : technical.type === "content_dependency"
        ? technical.ref
        : null;
  if (typeof key !== "string") {
    throw new WordedError(t("page.load.starterOnly"));
  }
  const clip =
    intent === "gesture"
      ? BUILT_IN_AVATAR_MOTION_CATALOG.getPoseClip(key)
      : BUILT_IN_AVATAR_MOTION_CATALOG.getReactionClip(key);
  if (!clip) throw new WordedError(t("loader.starterUnavailable"));
  return structuredClone(clip) as unknown as Record<string, unknown>;
}

/**
 * The removed Included effects an opened Action names, by clip alias: it
 * plays without them until their events are mapped to other content or
 * removed.
 */
export function removedActionEffects(
  preview: PyActionPreview,
): { alias: string; ref: string }[] {
  return Object.entries(object(actionClosure(preview).root.missing_references))
    .map(([alias, ref]) => ({ alias, ref: String(ref) }))
    .filter(({ ref }) => !ref.startsWith(BUILTIN_SOUND_PREFIX));
}

/** Return whether one catalog row is an editable built-in Anima Pose Clip. */
export function isCustomizableStarterAction(
  item: PyCatalogViewItem,
  intent: ActionIntent,
): item is PyGesture | PyReaction {
  if (item.origin !== "builtin" || isNonPortable(item)) return false;
  const contentId = item.logical_key;
  if (typeof contentId !== "string") return false;
  const prefix = `builtin:${intent}:`;
  if (!contentId.startsWith(prefix)) return false;
  const runtimeId = contentId.slice(prefix.length);
  return Boolean(
    intent === "gesture"
      ? BUILT_IN_AVATAR_MOTION_CATALOG.getPoseClip(runtimeId)
      : BUILT_IN_AVATAR_MOTION_CATALOG.getReactionClip(runtimeId),
  );
}

/** Create a collision-resistant model selector for a private Starter fork. */
export function starterGestureSemanticKey(
  original: string,
  suffix: string,
): string {
  const normalizedSuffix = gestureSemanticKey(suffix).slice(0, 8);
  const tail = `_custom_${normalizedSuffix}`;
  const base = gestureSemanticKey(original).slice(0, 64 - tail.length);
  return `${base}${tail}`;
}

/**
 * Reconstruct editor state from an exact ready preview. Built-ins are returned
 * as unsaved private templates; owned items retain their logical identity.
 * Throws for a sequence that is not a valid `animaPoseClip/2.0` clip
 * (`UnsupportedAnimaPoseClipFormatError` for the retired 1.0 format).
 */
export async function actionDocumentFromPreview(args: {
  intent: ActionIntent;
  item: ActionItem;
  preview: PyActionPreview;
  base: ActionDocument;
  customizeStarter?: boolean;
  semanticSuffix?: string;
}): Promise<ActionDocument> {
  const { intent, item, preview, base } = args;
  const closure = actionClosure(preview);
  const root = closure.root;
  const implementation = object(root.implementation);
  const isBuiltin = root.catalog_source === "included";
  // Included and Local Actions both own registered sequences after conversion.
  const hasOwnedSequence =
    Array.isArray(root.files) &&
    root.files.some((file) => object(file).role === "sequence");
  const implementationKind =
    implementation.kind === "vrma" ? "vrma" : "anima_clip";
  const sequence =
    implementationKind === "anima_clip"
      ? withoutSoundEvents(
          hasOwnedSequence || !isBuiltin
            ? await ownedSequence(preview, root)
            : builtinSequence(intent, root),
          isBuiltin ? soundsLeftBehind(preview) : new Set(),
        )
      : base.sequence;
  // Only `animaPoseClip/2.0` clips open: a retired 1.0 or invalid clip throws
  // its reason instead of opening as an empty timeline.
  if (implementationKind === "anima_clip") parseAnimaPoseClip(sequence);
  const placement = object(root.placement_hint);
  // A customized Starter is new owner content, so its default name and notes
  // follow the UI Locale.
  const t = getI18n().getFixedT(null, "actionEditor");
  const customName = args.customizeStarter
    ? t("load.customName", { name: item.name })
    : item.name;
  const semanticKey =
    intent === "gesture"
      ? args.customizeStarter
        ? starterGestureSemanticKey(
            String(root.semantic_key ?? item.name),
            args.semanticSuffix ?? crypto.randomUUID(),
          )
        : String(
            root.semantic_key ??
              ("semantic_key" in item ? item.semantic_key : ""),
          )
      : "";
  return normalizeActionDocument({
    ...base,
    name: customName,
    // The projected description is the AI selection description (or its
    // legacy fallback), the Action's one text.
    aiDescription: String(root.description ?? item.description ?? ""),
    semanticKey,
    implementation: implementationKind,
    suggestedEmotion: String(placement.emotion ?? ""),
    suggestedIntensity: selectedIntensity(placement.intensity),
    notes: args.customizeStarter
      ? t("load.customNotes", { name: item.name })
      : String(object(item.metadata).notes ?? ""),
    sequence:
      args.customizeStarter && implementationKind === "anima_clip"
        ? { ...sequence, name: customName }
        : sequence,
    dependencies: dependenciesFromPreview(preview),
  });
}
