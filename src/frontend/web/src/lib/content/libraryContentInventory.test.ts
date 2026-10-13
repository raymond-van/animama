import { describe, expect, it } from "vitest";
import { contentInventoryGroups } from "./libraryContentInventory";
import { normalizeContentLibrarySearch } from "./librarySearch";

describe("typed Library inventory", () => {
  it.each([
    "avatars",
    "gestures",
    "reactions",
    "poses",
    "idle-styles",
    "particle",
    "avatar-effects",
    "scene",
    "sound",
  ])("filters All to %s without moving to another section", (type) => {
    const search = normalizeContentLibrarySearch({ type });
    expect(search.section).toBe("all");
    expect(contentInventoryGroups(search)).toEqual([type]);
  });

  it("includes Poses in Actions All and limits the Poses view to its family", () => {
    expect(
      contentInventoryGroups(
        normalizeContentLibrarySearch({ section: "actions" }),
      ),
    ).toEqual(["gestures", "reactions", "poses", "idle-styles"]);
    expect(
      contentInventoryGroups(
        normalizeContentLibrarySearch({ section: "actions", action: "poses" }),
      ),
    ).toEqual(["poses"]);
  });
  it("keeps Idle Styles searchable as their own Actions family", () => {
    const search = normalizeContentLibrarySearch({
      section: "actions",
      action: "idle-styles",
      query: "calm",
    });
    expect(search.action).toBe("idle-styles");
    expect(contentInventoryGroups(search)).toEqual(["idle-styles"]);
  });
  it("groups real product types without a generic row", () => {
    expect(
      contentInventoryGroups(normalizeContentLibrarySearch({ section: "all" })),
    ).toEqual([
      "avatars",
      "gestures",
      "reactions",
      "poses",
      "idle-styles",
      "particle",
      "avatar-effects",
      "scene",
      "sound",
    ]);
  });
});
