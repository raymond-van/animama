import { describe, expect, it } from "vitest";

import { parseNewGestureSearch } from "./gestureSearch";

describe("parseNewGestureSearch", () => {
  it("accepts an assistant draft with its conversation", () => {
    expect(
      parseNewGestureSearch({
        draft: "draft-1",
        conversation: "conversation-1",
      }),
    ).toEqual({ draft: "draft-1", conversation: "conversation-1" });
  });

  it("ignores a draft without its conversation, and malformed values", () => {
    for (const search of [
      { draft: "draft-1" },
      { conversation: "conversation-1" },
      { draft: "", conversation: "conversation-1" },
      { draft: 7, conversation: "conversation-1" },
      { draft: ["draft-1"], conversation: "conversation-1" },
    ])
      expect(parseNewGestureSearch(search)).toEqual({});
  });

  it("keeps the effect handoff parameters as before", () => {
    expect(
      parseNewGestureSearch({
        component: "item-3",
        componentType: "particle_effect",
      }),
    ).toEqual({ component: "item-3", componentType: "particle_effect" });
    expect(
      parseNewGestureSearch({ component: 3, componentType: "gesture" }),
    ).toEqual({});
    expect(parseNewGestureSearch({})).toEqual({});
  });
});
