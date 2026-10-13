import { describe, expect, it } from "vitest";

import {
  compactContentLibrarySearch,
  contentLibrarySearchFromUrl,
  normalizeContentLibrarySearch,
  shouldReplaceContentLibrarySearch,
} from "./librarySearch";

describe("typed Library search", () => {
  it("round-trips an All subtype without changing the main section", () => {
    const search = contentLibrarySearchFromUrl(
      new URL(
        "https://app.test/library?type=poses&query=Salute&sort=updated&gestureMotion=vrma",
      ),
    );
    expect(search).toEqual({ type: "poses", query: "Salute", sort: "name" });
    expect(normalizeContentLibrarySearch(search)).toMatchObject({
      section: "all",
      type: "poses",
    });
    expect(shouldReplaceContentLibrarySearch({ type: "poses" })).toBe(false);
  });

  it("keeps relevant All gesture filters and drops its subtype when leaving All", () => {
    expect(
      compactContentLibrarySearch({
        type: "gestures",
        gestureMotion: "vrma",
        gestureStatus: "equipped",
      }),
    ).toEqual({
      type: "gestures",
      gestureMotion: "vrma",
      gestureStatus: "equipped",
    });
    expect(
      compactContentLibrarySearch({
        section: "fx",
        type: "gestures",
        gestureMotion: "vrma",
        fx: "scene",
      }),
    ).toEqual({ section: "fx", fx: "scene" });
    expect(compactContentLibrarySearch({ type: "all" })).toEqual({});
    expect(compactContentLibrarySearch({ type: "unsupported" })).toEqual({});
  });

  it("round-trips Poses and discards Gesture-only filters", () => {
    const search = contentLibrarySearchFromUrl(
      new URL(
        "https://app.test/a/library?section=actions&action=poses&gestureMotion=vrma&gestureStatus=equipped&gestureUpdatesOnly=true&gestureSort=name-desc&showStarters=false&query=Salute&sort=updated",
      ),
    );
    expect(search).toEqual({
      section: "actions",
      action: "poses",
      showStarters: false,
      query: "Salute",
      sort: "name",
    });
    expect(normalizeContentLibrarySearch(search).action).toBe("poses");
  });

  it("uses product-domain defaults", () => {
    expect(normalizeContentLibrarySearch({})).toMatchObject({
      section: "all",
      action: "all",
      gestureMotion: "all",
      showStarters: true,
      gestureUpdatesOnly: false,
      gestureStatus: "all",
      gestureSort: "custom-first",
      fx: "all",
      sort: "name",
    });
  });

  it("normalizes the Gesture motion filter", () => {
    expect(
      normalizeContentLibrarySearch({
        section: "actions",
        gestureMotion: "vrma",
      }).gestureMotion,
    ).toBe("vrma");
    expect(
      normalizeContentLibrarySearch({ gestureMotion: "unsupported" })
        .gestureMotion,
    ).toBe("all");
  });

  it("normalizes Starter visibility plus Gesture-only status and sort filters", () => {
    expect(
      normalizeContentLibrarySearch({
        showStarters: "false",
        gestureUpdatesOnly: "true",
        gestureStatus: "equipped",
        gestureSort: "name-desc",
      }),
    ).toMatchObject({
      showStarters: false,
      gestureUpdatesOnly: true,
      gestureStatus: "equipped",
      gestureSort: "name-desc",
    });
    expect(
      normalizeContentLibrarySearch({ origin: "owned" }).showStarters,
    ).toBe(true);
    expect(
      normalizeContentLibrarySearch({ gestureShowStarters: "false" })
        .showStarters,
    ).toBe(true);
    expect(
      normalizeContentLibrarySearch({
        gestureStatus: "unsupported",
        gestureSort: "unsupported",
      }),
    ).toMatchObject({
      gestureStatus: "all",
      gestureSort: "custom-first",
    });
  });

  it("ignores removed query parameters", () => {
    expect(
      contentLibrarySearchFromUrl(
        new URL("https://app.test/a/library?tab=assets&category=motion"),
      ),
    ).toEqual({});
  });

  it("omits defaults from the canonical URL state", () => {
    expect(compactContentLibrarySearch({})).toEqual({});
    expect(
      compactContentLibrarySearch(normalizeContentLibrarySearch({})),
    ).toEqual({});
  });

  it("keeps only meaningful filters for the active section", () => {
    expect(
      compactContentLibrarySearch({
        section: "fx",
        fx: "scene",
        action: "gestures",
        gestureStatus: "equipped",
        uploadStatus: "processing",
      }),
    ).toEqual({ section: "fx", fx: "scene" });

    expect(
      compactContentLibrarySearch({
        section: "actions",
        action: "gestures",
        gestureMotion: "vrma",
        gestureStatus: "equipped",
        gestureSort: "name-asc",
        fx: "scene",
      }),
    ).toEqual({
      section: "actions",
      action: "gestures",
      gestureMotion: "vrma",
      gestureStatus: "equipped",
      gestureSort: "name-asc",
    });

    expect(
      compactContentLibrarySearch({
        section: "chat-uploads",
        query: "gesture",
        uploadQuery: "notes",
        uploadStatus: "processing",
      }),
    ).toEqual({
      section: "chat-uploads",
      uploadQuery: "notes",
      uploadStatus: "processing",
    });
  });

  it("uses the query-aware sort default", () => {
    expect(
      compactContentLibrarySearch({ query: "wave", sort: "relevance" }),
    ).toEqual({ query: "wave" });
    expect(
      compactContentLibrarySearch({ query: "wave", sort: "name" }),
    ).toEqual({ query: "wave", sort: "name" });
  });

  it("keeps filters URL-backed and replaces history only for text", () => {
    expect(
      normalizeContentLibrarySearch({
        section: "fx",
        fx: "sound",
        showStarters: false,
        query: "  chime  ",
      }),
    ).toMatchObject({
      section: "fx",
      fx: "sound",
      showStarters: false,
      query: "chime",
    });
    expect(shouldReplaceContentLibrarySearch({ query: "wave" })).toBe(true);
    expect(shouldReplaceContentLibrarySearch({ section: "avatars" })).toBe(
      false,
    );
  });
});
