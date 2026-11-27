import type { ActionComponentType } from "@/query/hooks/useEffects";

const componentTypes = new Set<ActionComponentType>([
  "particle_effect",
  "avatar_effect",
  "scene_effect",
  "sound_effect",
]);

/**
 * The new-Gesture route's search. `component` with `componentType` starts the
 * Gesture with an effect. `draft` with `conversation` opens a content
 * assistant draft in the creator ("Open in creator"): a draft is read with
 * its conversation, so the link names both, and one without the other is
 * ignored.
 */
export type NewGestureSearch = {
  component?: string;
  componentType?: ActionComponentType;
  draft?: string;
  conversation?: string;
};

export function parseNewGestureSearch(
  search: Record<string, unknown>,
): NewGestureSearch {
  const draft =
    typeof search.draft === "string" &&
    search.draft &&
    typeof search.conversation === "string" &&
    search.conversation
      ? { draft: search.draft, conversation: search.conversation }
      : {};
  return {
    ...(typeof search.component === "string"
      ? { component: search.component }
      : {}),
    ...(componentTypes.has(search.componentType as ActionComponentType)
      ? { componentType: search.componentType as ActionComponentType }
      : {}),
    ...draft,
  };
}
