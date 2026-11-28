import type { PyGesture } from "@/lib/content/catalogTypes";

/**
 * The Included Gestures the Inspirations dialog offers as examples of the
 * feel (R8.6), by logical key: a short, fixed list of Animama's own
 * content, one for each of several moods, so a person who has made nothing
 * yet has something to point at. Each is a portable clip Gesture of the
 * repository's Included content (a test reads their descriptors).
 */
export const INCLUDED_INSPIRATION_KEYS = [
  // A friendly greeting.
  "builtin:gesture:wave-hello",
  // Shy and small.
  "builtin:gesture:small-shy-wave",
  // Joy with the whole body.
  "builtin:gesture:hearty-laugh",
  // Formal and respectful.
  "builtin:gesture:polite-bow",
  // Thoughtful, and held as a loop.
  "builtin:gesture:thinking-hand-on-chin-hold",
  // Startled.
  "builtin:gesture:surprise-gasp",
  // Sulky.
  "builtin:gesture:pout-huff",
  // Downcast.
  "builtin:gesture:deflated-sigh",
] as const;

/**
 * The listed Gestures this Library has, in the list's order. `included` is
 * the Included Gestures a request may name (`referenceGestureChoices`: ready,
 * portable clips), so a non-portable or missing one is never offered.
 */
export function includedInspirations(
  included: readonly PyGesture[],
): PyGesture[] {
  const byKey = new Map(
    included.flatMap((gesture) =>
      gesture.origin === "builtin" && gesture.logical_key
        ? [[gesture.logical_key, gesture] as const]
        : [],
    ),
  );
  return INCLUDED_INSPIRATION_KEYS.flatMap((key) => byKey.get(key) ?? []);
}
