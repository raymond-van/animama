import { getI18n } from "react-i18next";

import type {
  PyContentDependency,
  PyExactContentSource,
} from "@/lib/content/catalogTypes";
import { WordedError } from "@/lib/errors/apiError";
import {
  REACTION_INTENSITIES,
  type EmotionReactionIntensity,
} from "@/lib/avatar/reactionPools";
import {
  parseAnimaPoseClip,
  type AnimaPoseClipV2,
} from "@/lib/avatar/poses/animaPoseClip";
import type { ActionComponentType } from "./actionDependencies";
import {
  actionNameSlug,
  normalizeActionDocument,
  type ActionDocument,
  type ActionIntent,
} from "./actionDocument";
import { isRecord } from "@/lib/records";

export const ACTION_PROJECT_SCHEMA = "animamaActionProject/1.0" as const;

export type ActionProject = {
  schema: typeof ACTION_PROJECT_SCHEMA;
  intent: ActionIntent;
  name: string;
  aiDescription: string;
  semanticKey: string;
  suggestedEmotion: string;
  suggestedIntensity: EmotionReactionIntensity;
  notes: string;
  sequence: AnimaPoseClipV2;
  dependencies: PyContentDependency[];
};

export type ActionImport =
  | { kind: "clip"; sequence: AnimaPoseClipV2 }
  | { kind: "project"; project: ActionProject };

export type UnresolvedActionReference = {
  alias: string;
  contentType: ActionComponentType;
};

/** A non-empty string, or a failure worded by `missing`. */
function requiredString(value: unknown, missing: () => string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WordedError(missing());
  }
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseSource(value: unknown): PyExactContentSource {
  const t = getI18n().getFixedT(null, "actionEditor");
  if (!isRecord(value))
    throw new WordedError(t("project.errors.sourceInvalid"));
  if (
    value.type === "catalog" &&
    typeof value.catalog_item_id === "string" &&
    value.catalog_item_id
  ) {
    return {
      type: "catalog",
      catalog_item_id: value.catalog_item_id,
      logical_key:
        typeof value.logical_key === "string" ? value.logical_key : null,
    };
  }
  if (
    value.type === "builtin" &&
    typeof value.content_id === "string" &&
    value.content_id &&
    typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    value.version > 0
  ) {
    return {
      type: "builtin",
      content_id: value.content_id,
      version: value.version,
    };
  }
  throw new WordedError(t("project.errors.sourceUnavailable"));
}

const COMPONENT_TYPES = new Set<ActionComponentType>([
  "particle_effect",
  "avatar_effect",
  "scene_effect",
  "sound_effect",
]);

function parseDependencies(value: unknown): PyContentDependency[] {
  const t = getI18n().getFixedT(null, "actionEditor");
  if (!Array.isArray(value))
    throw new WordedError(t("project.errors.dependenciesNotArray"));
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!isRecord(raw))
      throw new WordedError(t("project.errors.dependencyInvalid"));
    const alias = requiredString(raw.alias, () =>
      t("project.errors.aliasRequired"),
    );
    if (seen.has(alias))
      throw new WordedError(t("project.errors.aliasRepeats", { alias }));
    seen.add(alias);
    if (!COMPONENT_TYPES.has(raw.content_type as ActionComponentType)) {
      throw new WordedError(t("project.errors.unsupportedType", { alias }));
    }
    return {
      alias,
      content_type: raw.content_type as ActionComponentType,
      source: parseSource(raw.source),
      ...(isRecord(raw.config) ? { config: structuredClone(raw.config) } : {}),
    };
  });
}

/** Serialize only portable authoring state, never React, Zustand, or save state. */
export function createActionProject(document: ActionDocument): ActionProject {
  if (document.implementation !== "anima_clip") {
    const t = getI18n().getFixedT(null, "actionEditor");
    throw new WordedError(t("project.errors.vrmaProject"));
  }
  const normalized = normalizeActionDocument({
    ...document,
    name: document.name.trim(),
  });
  return {
    schema: ACTION_PROJECT_SCHEMA,
    intent: normalized.intent,
    name: normalized.name,
    aiDescription: normalized.aiDescription,
    semanticKey: normalized.semanticKey,
    suggestedEmotion: normalized.suggestedEmotion,
    suggestedIntensity: normalized.suggestedIntensity,
    notes: normalized.notes,
    sequence: parseAnimaPoseClip(normalized.sequence),
    dependencies: structuredClone(normalized.dependencies),
  };
}

/**
 * Accept either a direct `animaPoseClip/2.0` clip or Animama's
 * exact-dependency envelope around one. Any other clip format, including the
 * retired 1.0, throws `UnsupportedAnimaPoseClipFormatError`.
 */
export function parseActionImport(
  value: unknown,
  expectedIntent: ActionIntent,
): ActionImport {
  const t = getI18n().getFixedT(null, "actionEditor");
  if (!isRecord(value)) throw new WordedError(t("project.errors.notObject"));
  if (value.schema !== ACTION_PROJECT_SCHEMA) {
    return { kind: "clip", sequence: parseAnimaPoseClip(value) };
  }
  if (value.intent !== expectedIntent) {
    // The project's own intent is file data, shown as written.
    const found = String(value.intent);
    throw new WordedError(
      expectedIntent === "gesture"
        ? t("project.errors.wrongEditor.gesture", { found })
        : t("project.errors.wrongEditor.reaction", { found }),
    );
  }
  const intensity = REACTION_INTENSITIES.find(
    (level) => level === Number(value.suggestedIntensity ?? 1),
  );
  if (!intensity) {
    throw new WordedError(t("project.errors.intensity"));
  }
  return {
    kind: "project",
    project: {
      schema: ACTION_PROJECT_SCHEMA,
      intent: expectedIntent,
      name: requiredString(value.name, () => t("project.errors.nameRequired")),
      // A legacy project's `description` stands in for a missing AI description.
      aiDescription:
        optionalString(value.aiDescription) ||
        optionalString(value.description),
      semanticKey: optionalString(value.semanticKey),
      suggestedEmotion: optionalString(value.suggestedEmotion),
      suggestedIntensity: intensity,
      notes: optionalString(value.notes),
      sequence: parseAnimaPoseClip(value.sequence),
      dependencies: parseDependencies(value.dependencies),
    },
  };
}

function referenceForEvent(value: unknown): UnresolvedActionReference | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === "particle_vfx" &&
    typeof value.effectId === "string" &&
    value.effectId
  ) {
    return { alias: value.effectId, contentType: "particle_effect" };
  }
  if (
    value.kind === "avatar_vfx" &&
    typeof value.effectId === "string" &&
    value.effectId
  ) {
    return { alias: value.effectId, contentType: "avatar_effect" };
  }
  if (
    value.kind === "scene_vfx" &&
    typeof value.presetId === "string" &&
    value.presetId
  ) {
    return { alias: value.presetId, contentType: "scene_effect" };
  }
  if (value.kind === "sfx" && typeof value.cueId === "string" && value.cueId) {
    return { alias: value.cueId, contentType: "sound_effect" };
  }
  return null;
}

/** Return unresolved aliases with the component family implied by each event. */
export function unresolvedActionReferences(
  sequence: Record<string, unknown>,
  dependencies: readonly PyContentDependency[],
): UnresolvedActionReference[] {
  const t = getI18n().getFixedT(null, "actionEditor");
  const declared = new Set(dependencies.map((value) => value.alias));
  const unresolved = new Map<string, UnresolvedActionReference>();
  const events = Array.isArray(sequence.events) ? sequence.events : [];
  for (const event of events) {
    const reference = referenceForEvent(event);
    if (!reference || declared.has(reference.alias)) continue;
    const existing = unresolved.get(reference.alias);
    if (existing && existing.contentType !== reference.contentType) {
      throw new WordedError(
        t("project.errors.aliasTypeConflict", {
          alias: reference.alias,
        }),
      );
    }
    unresolved.set(reference.alias, reference);
  }
  return [...unresolved.values()].sort((left, right) =>
    left.alias.localeCompare(right.alias),
  );
}

export function actionJsonFilename(
  name: string,
  kind: "clip" | "project",
): string {
  const base = actionNameSlug(name);
  return `${base}${kind === "project" ? ".project" : ""}.json`;
}
