import type { PyGenerationReferences } from "@animama/runtime-contracts/api-types";

import type { PyGesture } from "@/lib/content/catalogTypes";
import { isNonPortable } from "@/lib/content/portability";
import { isRecord } from "@/lib/records";

/**
 * What a request to the content assistant carries besides its words: Library
 * Gestures (one to start from, some as examples of the feel) and the person's
 * own images. Each is named by id for the backend, which reads it itself;
 * names and sizes are kept beside the ids only so the conversation can show
 * what a turn carried.
 */

/** The most Library Gestures one request names as examples of the feel. */
export const MAX_GENERATION_REFERENCE_EXAMPLES = 3;

/** A Library Gesture given with a request: its id, and its name for display. */
export type GenerationReferenceGesture = { itemId: string; name: string };

/** One of the person's uploaded images given with a request. */
export type GenerationReferenceImage = {
  /** The user file's id. */
  fileId: string;
  name: string;
  /** `video_frames` is one strip of frames sampled from a video. */
  kind: "image" | "video_frames";
  width?: number;
  height?: number;
};

export type GenerationRunReferences = {
  /** The Gesture a new Gesture draft starts as a copy of. */
  startingPoint: GenerationReferenceGesture | null;
  /** Gestures shown to the model as examples of the feel. */
  examples: readonly GenerationReferenceGesture[];
  images: readonly GenerationReferenceImage[];
};

/** Whether a request carries any reference at all. */
export function hasGenerationReferences(
  references: GenerationRunReferences | null | undefined,
): references is GenerationRunReferences {
  return Boolean(
    references &&
    (references.startingPoint ||
      references.examples.length > 0 ||
      references.images.length > 0),
  );
}

/**
 * A request's references as the run route takes them: ids only, and only the
 * parts the request carries. `null` when it carries none, so nothing is sent.
 */
export function generationReferencesBody(
  references: GenerationRunReferences | null | undefined,
): PyGenerationReferences | null {
  if (!hasGenerationReferences(references)) return null;
  return {
    ...(references.startingPoint
      ? { starting_point: references.startingPoint.itemId }
      : {}),
    ...(references.examples.length > 0
      ? { examples: references.examples.map(({ itemId }) => itemId) }
      : {}),
    ...(references.images.length > 0
      ? {
          images: references.images.map(({ fileId, kind }) => ({
            file_id: fileId,
            kind,
          })),
        }
      : {}),
  };
}

/** A stored `{ item_id, name }`; `null` for an entry that names no Gesture. */
function storedGesture(value: unknown): GenerationReferenceGesture | null {
  if (!isRecord(value) || typeof value.item_id !== "string" || !value.item_id)
    return null;
  return {
    itemId: value.item_id,
    name: typeof value.name === "string" ? value.name : "",
  };
}

function storedImage(value: unknown): GenerationReferenceImage | null {
  if (!isRecord(value) || typeof value.file_id !== "string" || !value.file_id)
    return null;
  return {
    fileId: value.file_id,
    name: typeof value.name === "string" ? value.name : "",
    kind: value.kind === "video_frames" ? "video_frames" : "image",
    ...(typeof value.width === "number" ? { width: value.width } : {}),
    ...(typeof value.height === "number" ? { height: value.height } : {}),
  };
}

/**
 * The references a stored turn of the person carried, from its `data`
 * (`references` and `images`), read tolerantly: an entry that names nothing is
 * dropped. `null` for a turn without any.
 */
export function storedGenerationReferences(
  data: unknown,
): GenerationRunReferences | null {
  if (!isRecord(data)) return null;
  const named = isRecord(data.references) ? data.references : {};
  const references: GenerationRunReferences = {
    startingPoint: storedGesture(named.starting_point),
    examples: Array.isArray(named.examples)
      ? named.examples.flatMap((entry) => storedGesture(entry) ?? [])
      : [],
    images: Array.isArray(data.images)
      ? data.images.flatMap((entry) => storedImage(entry) ?? [])
      : [],
  };
  const read =
    isRecord(data.references) ||
    (Array.isArray(data.images) && data.images.length > 0);
  return read ? references : null;
}

/**
 * Whether the run's model was given the turn's images. `false` only when the
 * stored turn records that the model took none (`images_sent`).
 */
export function storedImagesSent(data: unknown): boolean {
  return !(isRecord(data) && data.images_sent === false);
}

/**
 * The Library Gestures a request may name: ready clip Gestures that are
 * portable, Local and Included apart. A non-portable Gesture is never
 * offered (the backend refuses it whatever is sent), and neither is an
 * imported animation, which has no clip to read.
 */
export function referenceGestureChoices(gestures: readonly PyGesture[]): {
  local: PyGesture[];
  included: PyGesture[];
} {
  const choices = gestures.filter(
    (gesture) =>
      gesture.state === "ready" &&
      Boolean(gesture.source) &&
      gesture.implementation_kind === "anima_clip" &&
      !isNonPortable(gesture),
  );
  return {
    local: choices.filter((gesture) => gesture.origin === "owned"),
    included: choices.filter((gesture) => gesture.origin === "builtin"),
  };
}
