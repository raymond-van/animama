import { afterEach, describe, expect, it } from "vitest";

import {
  bumpAvatarPortraitVersion,
  useAvatarPortraitVersionStore,
  versionedPortraitUrl,
} from "./avatar-portrait-version-store";

afterEach(() => useAvatarPortraitVersionStore.setState({ versions: {} }));

describe("Avatar portrait versions", () => {
  it("keeps a portrait URL until that Avatar's portrait is saved again", () => {
    const url = "/v1/content/files/portrait-ref";
    const version = () =>
      useAvatarPortraitVersionStore.getState().versions["item-7"];

    expect(versionedPortraitUrl(url, version())).toBe(url);

    bumpAvatarPortraitVersion("item-7");
    expect(versionedPortraitUrl(url, version())).toBe(`${url}?portrait=1`);

    // Each save names a new URL, so an image showing the last one reloads.
    bumpAvatarPortraitVersion("item-7");
    expect(versionedPortraitUrl(url, version())).toBe(`${url}?portrait=2`);
    expect(useAvatarPortraitVersionStore.getState().versions).toEqual({
      "item-7": 2,
    });
  });

  it("adds to an existing query and leaves a missing portrait missing", () => {
    expect(versionedPortraitUrl("/files/x?a=1", 3)).toBe(
      "/files/x?a=1&portrait=3",
    );
    expect(versionedPortraitUrl(null, 3)).toBeNull();
  });
});
