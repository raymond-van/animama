import type { PyTypedContentFile } from "@animama/runtime-contracts/api-types";

const IMAGE_TYPES = new Set([
  "image/png",
  "image/svg+xml",
  "image/jpeg",
  "image/webp",
]);

/**
 * Keep tint lookup tied to the same registered texture as the thumbnail. The
 * manifest is read at the URL the server names, which for Included content
 * carries its digest so the browser keeps it (ADR 0033).
 */
export function particleThumbnailSource(
  files: readonly PyTypedContentFile[],
  revision: string,
) {
  const ordered = [...files].sort((a, b) => a.ordinal - b.ordinal);
  const texture = ordered.find((file) => IMAGE_TYPES.has(file.media_type));
  const manifest = ordered.find((file) => file.role === "manifest");
  return texture && manifest
    ? {
        manifestUrl: manifest.url,
        texturePath: texture.logical_path,
        revision,
      }
    : undefined;
}

/**
 * Use the first registered image, never an arbitrary URL from effect JSON. The
 * thumbnail variant is a small WebP of that image, so a Library tile never
 * downloads full-size art or a whole flipbook sheet. An Included image's URL
 * names its digest, so a later visit reuses the kept thumbnail (ADR 0033).
 */
export function contentThumbnailUrl(
  files: readonly PyTypedContentFile[],
): string | null {
  const image = files
    .filter((file) => IMAGE_TYPES.has(file.media_type))
    .sort((left, right) => left.ordinal - right.ordinal)[0];
  return image ? `${image.url}?variant=thumbnail` : null;
}
