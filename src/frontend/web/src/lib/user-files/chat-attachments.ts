import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import { isUserImageFile } from "@/lib/user-files/chat-images";

const CHAT_SEARCHABLE_USER_FILE_STATUSES = new Set([
  "ready",
  "ready_keyword_only",
]);

/**
 * Return installation uploads a message can attach: searchable documents and
 * ready images. Images have no chunks; the model sees them instead.
 */
export function selectableChatUserFiles(
  files: readonly PyUserFileResponse[],
): PyUserFileResponse[] {
  return files.filter((file) =>
    isUserImageFile(file)
      ? file.status === "ready"
      : CHAT_SEARCHABLE_USER_FILE_STATUSES.has(file.status) &&
        (file.chunk_count ?? 0) > 0,
  );
}

/** Merge transient Uppy IDs with prior-upload selections in stable order. */
export function mergeChatAttachedFileIds(
  uppyFileIds: readonly (string | null | undefined)[],
  existingFileIds: readonly string[],
): string[] {
  const normalized = [...uppyFileIds, ...existingFileIds]
    .filter((fileId): fileId is string => typeof fileId === "string")
    .map((fileId) => fileId.trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}
