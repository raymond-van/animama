import { getI18n } from "react-i18next";

import { parseAnimaPoseClip } from "@/lib/avatar/poses/animaPoseClip";
import {
  ANIMA_POSE_CLIP_V2_FIELDS,
  ANIMA_POSE_CLIP_V2_SCHEMA,
} from "@/lib/avatar/poses/animaPoseClip/schemaV2";
import { WordedError } from "@/lib/errors/apiError";
import {
  actionAuthoringSnapshot,
  hasHumanoidTracks,
  normalizeActionDocument,
  renameActionDocument,
  type ActionDocument,
} from "./actionDocument";
import { ACTION_PROJECT_SCHEMA, parseActionImport } from "./actionProject";

/**
 * The creator's side of a content assistant run: what the creator sends as
 * the item open in it, and how the assistant's result becomes the creator's
 * document again.
 *
 * The assistant authors a clip's motion and face. It does not author timeline
 * events (effects and sounds), which need the item's dependencies, nor the
 * fields the creator itself only carries along (a Reaction's playback
 * lifetime and role, and any field the clip format does not define, such as
 * a tool's own metadata). Those stay the item's own: they are left out of
 * what is sent and put back on the result.
 */
const KEPT_FORMAT_FIELDS: ReadonlySet<string> = new Set([
  "events",
  "playback",
  "role",
]);
const FORMAT_FIELDS: ReadonlySet<string> = new Set(ANIMA_POSE_CLIP_V2_FIELDS);

/** Whether the assistant authors this clip field; the item keeps every other. */
function isAuthoredField(field: string): boolean {
  return FORMAT_FIELDS.has(field) && !KEPT_FORMAT_FIELDS.has(field);
}

function isEmptyTimeline(sequence: Record<string, unknown>): boolean {
  return (
    sequence.schema === ANIMA_POSE_CLIP_V2_SCHEMA &&
    Array.isArray(sequence.beats) &&
    sequence.beats.length === 0
  );
}

/** Whether the item plays effects or sounds, which the assistant leaves as they are. */
export function documentHasTimelineEvents(document: ActionDocument): boolean {
  return (
    Array.isArray(document.sequence.events) &&
    document.sequence.events.length > 0
  );
}

/**
 * The project a creator's run revises: the document as it stands, hand edits
 * included, without the fields the assistant does not author. `null` when
 * there is nothing to revise yet (no beat on the timeline), so the run writes
 * a new draft instead, and for a VRMA item, which has no timeline.
 */
export function assistantRunDocument(
  document: ActionDocument,
): Record<string, unknown> | null {
  if (document.implementation !== "anima_clip") return null;
  const normalized = normalizeActionDocument({
    ...document,
    name: document.name.trim(),
  });
  if (isEmptyTimeline(normalized.sequence)) return null;
  const sequence = Object.fromEntries(
    Object.entries(structuredClone(normalized.sequence)).filter(([field]) =>
      isAuthoredField(field),
    ),
  );
  return {
    schema: ACTION_PROJECT_SCHEMA,
    intent: normalized.intent,
    name: normalized.name,
    aiDescription: normalized.aiDescription,
    semanticKey: normalized.semanticKey,
    suggestedEmotion: normalized.suggestedEmotion,
    suggestedIntensity: normalized.suggestedIntensity,
    notes: "",
    sequence,
    dependencies: [],
  };
}

/**
 * The creator's document after the assistant's result (a draft's project).
 *
 * - The result's clip replaces the timeline; the item's own events, playback
 *   lifetime, role and dependencies are kept.
 * - The item's details stay the person's: its name, AI description, Selector
 *   ID and suggested emotion and intensity are filled from the result only
 *   where the item has none yet, so a saved item keeps its identity.
 *
 * Throws a worded error for a project the creator's Import would refuse, for
 * a Reaction result that moves the body, and for a result the kept events no
 * longer fit (one that ends before an effect starts, say).
 */
export function applyAssistantProject(
  current: ActionDocument,
  project: unknown,
  options: { identityExists: boolean },
): ActionDocument {
  const t = getI18n().getFixedT(null, "actionEditor");
  const imported = parseActionImport(project, current.intent);
  if (imported.kind !== "project")
    throw new WordedError(t("importDialog.failed"));
  const result = imported.project;
  const sequence: Record<string, unknown> = structuredClone(
    result.sequence as unknown as Record<string, unknown>,
  );
  // Checked before the document is normalized, which would strip the body
  // from a Reaction without a word.
  if (current.intent === "reaction" && hasHumanoidTracks(sequence))
    throw new WordedError(t("importDialog.reactionHumanoid"));
  for (const field of Object.keys(sequence))
    if (!isAuthoredField(field)) delete sequence[field];
  for (const [field, value] of Object.entries(current.sequence))
    if (!isAuthoredField(field)) sequence[field] = structuredClone(value);
  let next: ActionDocument = {
    ...current,
    implementation: "anima_clip",
    sequence,
  };
  if (!current.name.trim())
    next = renameActionDocument(next, result.name, !options.identityExists);
  if (current.intent === "gesture" && !current.aiDescription.trim())
    next = { ...next, aiDescription: result.aiDescription };
  if (current.intent === "reaction" && !current.suggestedEmotion)
    next = {
      ...next,
      suggestedEmotion: result.suggestedEmotion,
      suggestedIntensity: result.suggestedIntensity,
    };
  next = normalizeActionDocument(next);
  // The kept events must still fit the new timeline.
  parseAnimaPoseClip(next.sequence);
  return next;
}

/**
 * What the creator's history holds of a document (its timeline and
 * dependencies), as text to compare. The clip's own name and id follow the
 * item's name, which is no edit of the timeline, so they are left out.
 */
export function assistantDocumentFingerprint(document: ActionDocument): string {
  const { sequence, dependencies } = actionAuthoringSnapshot(document);
  const timeline = { ...sequence };
  delete timeline.id;
  delete timeline.name;
  return JSON.stringify({ timeline, dependencies });
}
