import { getI18n } from "react-i18next";

export const USER_FILE_ALLOWED_EXTENSIONS = [
  ".txt",
  ".md",
  ".rst",
  ".org",
  ".json",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".xml",
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
] as const;

/** Chat images: stored as a canonical copy and sent to models that accept images. */
export const USER_IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
] as const;
/**
 * Image formats people try that the server cannot read. The chat composer
 * refuses them by name before Uppy's type restriction applies.
 */
export const UNSUPPORTED_IMAGE_EXTENSIONS = [".heic", ".heif"] as const;

export const USER_FILE_UPLOAD_ACCEPT = [
  ...USER_FILE_ALLOWED_EXTENSIONS,
  ...USER_IMAGE_EXTENSIONS,
].join(",");
export const MAX_USER_FILE_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_USER_IMAGE_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;

export const USER_FILE_UPLOAD_RESTRICTIONS = {
  allowedFileTypes: [...USER_FILE_ALLOWED_EXTENSIONS, ...USER_IMAGE_EXTENSIONS],
  maxFileSize: MAX_USER_FILE_UPLOAD_SIZE_BYTES,
};

/** The lower-case extension of a file name, with its dot, or an empty string. */
export function fileNameExtension(name: string | null | undefined): string {
  const match = /\.[^./\\]+$/.exec(name ?? "");
  return match ? match[0].toLowerCase() : "";
}

/** Whether a file name names a chat image format the server accepts. */
export function isUserImageFileName(name: string | null | undefined): boolean {
  return (USER_IMAGE_EXTENSIONS as readonly string[]).includes(
    fileNameExtension(name),
  );
}

/**
 * Uppy's messages for the upload restrictions, worded in the UI Locale. Uppy
 * fills its own `%{…}` placeholders, so the catalog receives them as values.
 */
export function userFileUploadLocale(): { strings: Record<string, string> } {
  const t = getI18n().getFixedT(null, "app");
  return {
    strings: {
      exceedsSize: t("uploads.restrictions.tooLarge", {
        file: "%{file}",
        size: "%{size}",
      }),
      youCanOnlyUploadFileTypes: t("uploads.restrictions.fileTypes", {
        types: "%{types}",
      }),
      noDuplicates: t("uploads.restrictions.duplicate", {
        file: "%{fileName}",
      }),
      unnamed: t("uploads.restrictions.unnamed"),
    },
  };
}

export const USER_FILE_PROCESSING_STATUSES = new Set([
  "pending_upload",
  "processing",
]);

export const USER_FILE_ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

export function getUserFileErrorMessage(
  error: unknown,
  fallback = "Operation failed.",
) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}
