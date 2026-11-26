import type { ChatDisplayImage } from "@animama/product-ui/chat";
import type { TFunction } from "i18next";

import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import {
  MAX_USER_IMAGE_UPLOAD_SIZE_BYTES,
  UNSUPPORTED_IMAGE_EXTENSIONS,
  fileNameExtension,
  isUserImageFileName,
} from "@/lib/user-files/uploads";

/** The server's limit on the images one message carries. */
export const MAX_CHAT_IMAGES_PER_MESSAGE = 4;

/** Why the composer refuses an image before uploading it. */
export type ChatImageRefusal =
  | "unsupported_format"
  | "too_large"
  | "too_many"
  | "model_unsupported";

/** Whether a stored user file is a chat image; the server records the kind. */
export function isUserImageFile(
  file: Pick<PyUserFileResponse, "metadata">,
): boolean {
  return file.metadata?.kind === "image";
}

/** A composer tray file: its Uppy id, its name and, once uploaded, its file id. */
export type ChatTrayFile = {
  id: string;
  name?: string | null;
  meta?: { file_id?: string };
};

/** The images a message would carry: tray uploads plus images chosen from the Library. */
export function attachedImageCount(
  trayFiles: Iterable<Pick<ChatTrayFile, "name">>,
  existingFiles: readonly Pick<PyUserFileResponse, "metadata">[],
): number {
  let count = existingFiles.filter(isUserImageFile).length;
  for (const file of trayFiles) {
    if (isUserImageFileName(file.name)) count += 1;
  }
  return count;
}

/**
 * The images to take out of the composer once a turn carrying `sentFileIds`
 * is accepted: tray uploads by their Uppy id, Library choices by file id.
 * Documents stay attached for later turns; an image goes with one message.
 */
export function sentChatImages({
  trayFiles,
  existingFiles,
  sentFileIds,
}: {
  trayFiles: Iterable<ChatTrayFile>;
  existingFiles: readonly Pick<PyUserFileResponse, "file_id" | "metadata">[];
  sentFileIds: readonly string[];
}): { trayFileIds: string[]; existingFileIds: string[] } {
  const sent = new Set(sentFileIds);
  const trayFileIds: string[] = [];
  for (const file of trayFiles) {
    const fileId = file.meta?.file_id;
    if (fileId && sent.has(fileId) && isUserImageFileName(file.name)) {
      trayFileIds.push(file.id);
    }
  }
  const existingFileIds = existingFiles
    .filter((file) => sent.has(file.file_id) && isUserImageFile(file))
    .map((file) => file.file_id);
  return { trayFileIds, existingFileIds };
}

/**
 * The images among a turn's attachments, in order, as its sent message shows
 * them: a file's row when the list has it, else its tray upload.
 */
export function attachedChatImages(
  fileIds: readonly string[],
  {
    trayFiles,
    rows,
  }: {
    trayFiles: Iterable<ChatTrayFile>;
    rows: readonly Pick<
      PyUserFileResponse,
      "file_id" | "original_filename" | "metadata"
    >[];
  },
): ChatDisplayImage[] {
  const rowsById = new Map(rows.map((row) => [row.file_id, row]));
  const trayByFileId = new Map<string, ChatTrayFile>();
  for (const file of trayFiles) {
    const fileId = file.meta?.file_id;
    if (fileId) trayByFileId.set(fileId, file);
  }
  const images: ChatDisplayImage[] = [];
  for (const fileId of fileIds) {
    const row = rowsById.get(fileId);
    const tray = trayByFileId.get(fileId);
    const isImage = row
      ? isUserImageFile(row)
      : isUserImageFileName(tray?.name);
    if (!isImage) continue;
    const facts = row?.metadata?.image;
    const size =
      facts && typeof facts === "object"
        ? (facts as { width?: unknown; height?: unknown })
        : {};
    images.push({
      fileId,
      name: row?.original_filename ?? tray?.name ?? "",
      ...(typeof size.width === "number" ? { width: size.width } : {}),
      ...(typeof size.height === "number" ? { height: size.height } : {}),
    });
  }
  return images;
}

/**
 * The image files a paste attaches. A clipboard that also carries text pastes
 * its text instead: spreadsheets and documents copy a picture of the
 * selection beside the text.
 */
export function pastedImageFiles(
  clipboard: Pick<DataTransfer, "files" | "getData">,
): File[] {
  if (clipboard.getData("text/plain").trim()) return [];
  return Array.from(clipboard.files).filter((file) =>
    file.type.startsWith("image/"),
  );
}

/**
 * Decide whether a file added to the composer may be uploaded as a chat image.
 *
 * Returns null for a file that is not an image (documents keep their own
 * rules) and for an image the composer accepts. HEIC and HEIF are refused by
 * name; the others mirror the server's limits so the person learns before
 * the upload.
 */
export function chatImageRefusal({
  name,
  size,
  imagesAttached,
  imagesAccepted,
}: {
  name: string | null | undefined;
  size: number | null | undefined;
  /** Images already in the composer for this message. */
  imagesAttached: number;
  /** False when the selected model is known not to take image input. */
  imagesAccepted: boolean;
}): ChatImageRefusal | null {
  if (
    (UNSUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(
      fileNameExtension(name),
    )
  ) {
    return "unsupported_format";
  }
  if (!isUserImageFileName(name)) return null;
  if (!imagesAccepted) return "model_unsupported";
  if (typeof size === "number" && size > MAX_USER_IMAGE_UPLOAD_SIZE_BYTES) {
    return "too_large";
  }
  if (imagesAttached >= MAX_CHAT_IMAGES_PER_MESSAGE) return "too_many";
  return null;
}

/**
 * Whether a model takes image input. A model the catalog has not loaded yet
 * counts as accepting: the server refuses images it cannot send.
 */
export function modelAcceptsImages(
  model: { accepts?: readonly string[] | null } | null | undefined,
): boolean {
  return model ? (model.accepts ?? []).includes("image") : true;
}

/** The composer's explanation of a refused image, in the UI Locale. */
export function chatImageRefusalMessage(
  t: TFunction<"chat">,
  refusal: ChatImageRefusal,
  name: string,
  maxSize: string,
): string {
  switch (refusal) {
    case "unsupported_format":
      return t("composer.images.unsupportedFormat", { name });
    case "too_large":
      return t("composer.images.tooLarge", { name, size: maxSize });
    case "too_many":
      return t("composer.images.tooMany", {
        count: MAX_CHAT_IMAGES_PER_MESSAGE,
      });
    case "model_unsupported":
      return t("composer.images.modelUnsupported");
  }
}
