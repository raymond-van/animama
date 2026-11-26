import type { ChatAttachmentHold } from "@animama/product-ui/chat";

import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import {
  resolveUserFileUploadCardStatus,
  type UserFileUploadStatusFile,
} from "@/lib/user-files/upload-card-status";
import { isUserImageFileName } from "@/lib/user-files/uploads";

/**
 * Whether the composer tray's new uploads let a turn be sent, from each
 * card's status (spec R5):
 *
 * - `waiting` while any is still preparing, uploading, finalizing, queued or
 *   processing, or saved but not yet queued while processing is on;
 * - `blocked` while any failed, or is a saved document that will not be
 *   processed because processing is off; the person must remove it;
 * - `none` once every one is `ready` or `ready_keyword_only`.
 *
 * `blocked` wins over `waiting`: waiting alone would never release the send.
 * An image is never processed: finalize makes it `ready`, so a saved image
 * waits for its row whether or not processing is on.
 * Files chosen from the Library are not passed in and never hold a send,
 * because the picker offers only readable files.
 */
export function resolveChatAttachmentHold({
  files,
  backendFiles = [],
  processingEnabled,
}: {
  /** The tray's Uppy files. */
  files: readonly UserFileUploadStatusFile[];
  /** The latest `useUserFiles` rows; a file's row wins over its browser stage. */
  backendFiles?: readonly PyUserFileResponse[];
  /** `user_file_processing.enabled` from the runtime capabilities. */
  processingEnabled: boolean;
}): ChatAttachmentHold {
  const rowsById = new Map(backendFiles.map((row) => [row.file_id, row]));
  let waiting = false;
  for (const file of files) {
    const fileId = file.meta?.file_id?.trim();
    const { id } = resolveUserFileUploadCardStatus({
      uppyFile: file,
      backendFile: fileId ? rowsById.get(fileId) : null,
    });
    switch (id) {
      case "ready":
      case "ready_keyword_only":
        break;
      case "failed":
        return "blocked";
      case "uploaded":
        if (!processingEnabled && !isUserImageFileName(file.name)) {
          return "blocked";
        }
        waiting = true;
        break;
      default:
        waiting = true;
    }
  }
  return waiting ? "waiting" : "none";
}
