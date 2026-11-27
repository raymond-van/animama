import {
  listAvatarContents,
  type Client,
} from "@animama/runtime-contracts/sdk";
import type { PyAvatarContent } from "@animama/runtime-contracts/api-types";

import type { IncludedAvatarBytes } from "@/lib/avatar/motion-authoring/draftChecksClient";
import {
  INCLUDED_AVATAR_FILES,
  type IncludedAvatarId,
} from "@/lib/avatar/motion-authoring/headlessVrm";
import {
  VerifiedByteLoader,
  type VerifiedByteMember,
} from "@/lib/runtime-content/VerifiedByteLoader";

/**
 * The two Included Avatars' VRM files, for the draft checks and the review
 * sheets. Checks and sheets may use these Avatars and no other (threat T4:
 * the person's own Avatar never leaves the preview), so this module resolves
 * exactly the ids in `INCLUDED_AVATAR_FILES`, only from catalog items whose
 * source is Included, and reads their bytes only at the digest-keyed content
 * URL, which the backend answers for Included files alone (ADR 0033).
 */

/** The catalog fields this module reads. */
export type IncludedAvatarCatalogItem = Pick<PyAvatarContent, "source"> & {
  files?: Pick<
    NonNullable<PyAvatarContent["files"]>[number],
    "file_ref" | "filename" | "media_type" | "size_bytes" | "sha256"
  >[];
};

/** Whether `value` names one of the Included Avatars checks and sheets use. */
export function isIncludedAvatarId(value: unknown): value is IncludedAvatarId {
  return (
    typeof value === "string" && Object.hasOwn(INCLUDED_AVATAR_FILES, value)
  );
}

/**
 * The verified-byte descriptor of an Included Avatar's VRM file, or `null`
 * when `id` is not one of the two or the catalog lists no Included item with
 * that file. A Local item is never chosen, whatever its file is called. The
 * URL is built here rather than taken from the listing: it names the file's
 * digest, and the backend serves that path only for an Included file with
 * exactly those bytes.
 */
export function includedAvatarFile(
  id: string,
  items: readonly IncludedAvatarCatalogItem[],
): VerifiedByteMember | null {
  if (!isIncludedAvatarId(id)) return null;
  const filename = INCLUDED_AVATAR_FILES[id];
  for (const item of items) {
    if (item.source !== "included") continue;
    const file = item.files?.find((entry) => entry.filename === filename);
    if (!file || !/^[0-9a-f]{64}$/.test(file.sha256)) continue;
    return {
      file_ref: file.file_ref,
      url: `/v1/content/files/${encodeURIComponent(file.file_ref)}/sha256/${file.sha256}`,
      media_type: file.media_type,
      size_bytes: file.size_bytes,
      sha256: file.sha256,
    };
  }
  return null;
}

/**
 * A reader of the Included Avatars' bytes. The catalog is listed once and
 * kept; each read fetches the file through the content byte route and
 * verifies its size and digest. A failed listing is tried again by the next
 * read. The bytes themselves are not kept here: an Included file's reply is
 * immutable, so the browser serves repeated reads from its cache.
 */
export function createIncludedAvatarFiles(
  apiClient: Client,
  options: { fetcher?: typeof fetch; apiBaseUrl?: string } = {},
): IncludedAvatarBytes {
  const loader = new VerifiedByteLoader(options);
  let listing: Promise<PyAvatarContent[]> | null = null;
  const list = () => {
    listing ??= listAvatarContents({
      client: apiClient,
      responseValidator: undefined,
      throwOnError: true,
    }).then(
      ({ data }) => data.items,
      (error: unknown) => {
        listing = null;
        throw error;
      },
    );
    return listing;
  };
  return async (id) => {
    // Checked before any request, so no other id reaches the catalog.
    if (!isIncludedAvatarId(id))
      throw new Error("Only the Included Avatars can be read here.");
    const file = includedAvatarFile(id, await list());
    if (!file)
      throw new Error(`The Included Avatar ${id} is not in the catalog.`);
    return (await loader.load(file)).blob.arrayBuffer();
  };
}
