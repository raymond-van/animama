import type { PyTypedContentFile } from "@animama/runtime-contracts/api-types";
import { describe, expect, it } from "vitest";
import {
  contentThumbnailUrl,
  particleThumbnailSource,
} from "./contentThumbnail";

const DIGEST = "a".repeat(64);

function file(
  ordinal: number,
  media_type: string,
  file_ref: string,
  role = "image",
): PyTypedContentFile {
  return {
    ordinal,
    media_type,
    file_ref,
    role,
    filename: "asset",
    logical_path: `asset-${ordinal}`,
    size_bytes: 1,
    sha256: DIGEST,
    // The server names an Included file by its digest (ADR 0033).
    url: `/v1/content/files/${encodeURIComponent(file_ref)}/sha256/${DIGEST}`,
  };
}

describe("content thumbnails", () => {
  it("requests the Library-sized variant of the first image in registered order without changing the input", () => {
    const files = [
      file(3, "image/png", "later"),
      file(1, "application/json", "manifest"),
      file(2, "image/svg+xml", "first / image"),
    ];
    expect(contentThumbnailUrl(files)).toBe(
      `/v1/content/files/first%20%2F%20image/sha256/${DIGEST}?variant=thumbnail`,
    );
    expect(files.map((item) => item.ordinal)).toEqual([3, 1, 2]);
  });

  it("keeps an owner's registration URL as the server names it", () => {
    const owned = {
      ...file(1, "image/webp", "mine"),
      url: "/v1/content/files/mine",
    };
    expect(contentThumbnailUrl([owned])).toBe(
      "/v1/content/files/mine?variant=thumbnail",
    );
  });

  it("reads a particle effect's tint from the manifest URL the server names", () => {
    const manifest = file(1, "application/json", "manifest", "manifest");
    const texture = file(2, "image/png", "texture");
    expect(
      particleThumbnailSource([texture, manifest], "r".repeat(64)),
    ).toEqual({
      manifestUrl: manifest.url,
      texturePath: texture.logical_path,
      revision: "r".repeat(64),
    });
  });

  it("leaves procedural effects and unsupported resources without a thumbnail", () => {
    expect(contentThumbnailUrl([])).toBeNull();
    expect(
      contentThumbnailUrl([
        file(1, "application/json", "manifest"),
        file(2, "text/html", "page"),
      ]),
    ).toBeNull();
  });
});
