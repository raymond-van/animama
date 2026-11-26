import { getI18n } from "react-i18next";

import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import type { LibraryUploadStatus } from "@/lib/content/librarySearch";
import { isUserImageFile } from "@/lib/user-files/chat-images";
import { storedUploadErrorLine } from "@/lib/user-files/upload-card-status";
import {
  USER_FILE_ACTIVE_JOB_STATUSES,
  USER_FILE_PROCESSING_STATUSES,
} from "@/lib/user-files/uploads";

export const LIBRARY_UPLOAD_PAGE_SIZE = 48;
export const LIBRARY_UPLOAD_POLL_INTERVAL_MS = 3000;

export type LibraryUploadStatusTone =
  | "active"
  | "destructive"
  | "muted"
  | "success"
  | "warning";

export type LibraryUploadListRow = {
  key: string;
  name: string;
  /** Upper-case extension, or `null` when the file has none. */
  extension: string | null;
  /** Stored (else declared) size; format it with `useFormatters().fileSize`. */
  sizeBytes: number | null;
  contentType: string | null;
  /** ISO timestamp; format it with `useFormatters()`. */
  createdAt: string | null;
  chunkCount: number;
  status: string;
  statusLabel: string;
  statusTone: LibraryUploadStatusTone;
  active: boolean;
  error: string | null;
  /** A ready chat image's file id, for its thumbnail; null for anything else. */
  imageFileId: string | null;
};

export type LibraryUploadViewState =
  | "loading"
  | "error"
  | "empty"
  | "no_results"
  | "ready";

function extensionLabel(value: string): string | null {
  const normalized = value.trim().replace(/^\./, "");
  return normalized ? normalized.toLocaleUpperCase() : null;
}

/**
 * Display label for a stored Upload status (also the Library status filter).
 * An unknown future status shows as sent.
 */
export function libraryUploadStatusLabel(status: string): string {
  const t = getI18n().getFixedT(null, "library");
  switch (status) {
    case "pending_upload":
      return t("uploads.status.pendingUpload");
    case "uploaded":
      return t("uploads.status.uploaded");
    case "processing":
      return t("uploads.status.processing");
    case "ready":
      return t("uploads.status.ready");
    case "ready_keyword_only":
      return t("uploads.status.readyKeywordOnly");
    case "failed":
      return t("uploads.status.failed");
    case "aborted":
      return t("uploads.status.aborted");
    case "delete_pending":
      return t("uploads.status.deletePending");
    case "deleted":
      return t("uploads.status.deleted");
    default:
      return status.replaceAll("_", " ");
  }
}

function uploadStatusPresentation(
  file: PyUserFileResponse,
): Pick<LibraryUploadListRow, "active" | "statusLabel" | "statusTone"> {
  const t = getI18n().getFixedT(null, "library");
  const jobStatus = file.latest_processing_job?.status;
  if (jobStatus === "queued") {
    const statusLabel = t("uploads.status.queued");
    return { active: true, statusLabel, statusTone: "active" };
  }
  if (jobStatus === "running") {
    const statusLabel = libraryUploadStatusLabel("processing");
    return { active: true, statusLabel, statusTone: "active" };
  }

  const statusLabel = libraryUploadStatusLabel(file.status);
  switch (file.status) {
    case "ready":
      return { active: false, statusLabel, statusTone: "success" };
    case "ready_keyword_only":
      return { active: false, statusLabel, statusTone: "warning" };
    case "failed":
      return { active: false, statusLabel, statusTone: "destructive" };
    case "pending_upload":
    case "processing":
      return { active: true, statusLabel, statusTone: "active" };
    default:
      return { active: false, statusLabel, statusTone: "muted" };
  }
}

/** Project one native Upload into compact, presentation-safe Library data. */
export function presentLibraryUpload(
  file: PyUserFileResponse,
): LibraryUploadListRow {
  const status = uploadStatusPresentation(file);
  return {
    key: `upload:${file.file_id}`,
    name: file.original_filename,
    extension: extensionLabel(file.normalized_extension),
    sizeBytes: file.stored_size_bytes ?? file.declared_size_bytes ?? null,
    contentType:
      file.detected_content_type ?? file.declared_content_type ?? null,
    createdAt: file.created_at ?? null,
    chunkCount: file.chunk_count ?? 0,
    status: file.status,
    statusLabel: status.statusLabel,
    statusTone: status.statusTone,
    active: status.active,
    error: storedUploadErrorLine(file),
    imageFileId:
      isUserImageFile(file) && file.status === "ready" ? file.file_id : null,
  };
}

/** Filter the complete installation Upload list by its own native lifecycle. */
export function filterLibraryUploads(
  files: readonly PyUserFileResponse[],
  options: {
    query?: string;
    status: LibraryUploadStatus;
  },
): PyUserFileResponse[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  return files.filter((file) => {
    if (options.status !== "all" && file.status !== options.status) {
      return false;
    }
    if (!query) return true;
    return [
      file.original_filename,
      file.normalized_extension,
      file.detected_content_type,
      file.declared_content_type,
    ].some((value) => value?.toLocaleLowerCase().includes(query));
  });
}

const PROCESSABLE_STATUSES = new Set([
  "uploaded",
  "failed",
  "ready",
  "ready_keyword_only",
]);

/**
 * Whether the debug panel offers Process or Reprocess for an upload. A chat
 * image is never processed: `:process` only completes one left at `uploaded`
 * by an interrupted finalize, which the processing switch does not govern.
 */
export function canProcessLibraryUpload(
  file: PyUserFileResponse,
  { processingEnabled }: { processingEnabled: boolean },
): boolean {
  const jobStatus = file.latest_processing_job?.status;
  if (jobStatus && USER_FILE_ACTIVE_JOB_STATUSES.has(jobStatus)) return false;
  if (isUserImageFile(file)) return file.status === "uploaded";
  return processingEnabled && PROCESSABLE_STATUSES.has(file.status);
}

/** True while backend file or processing-job state still needs polling. */
export function hasActiveLibraryUpload(
  files: readonly PyUserFileResponse[],
): boolean {
  return files.some((file) => {
    if (USER_FILE_PROCESSING_STATUSES.has(file.status)) return true;
    const jobStatus = file.latest_processing_job?.status;
    return Boolean(jobStatus && USER_FILE_ACTIVE_JOB_STATUSES.has(jobStatus));
  });
}

/** Keep the existing three-second poll only while active work exists. */
export function libraryUploadRefetchInterval(
  files: readonly PyUserFileResponse[],
  pollActive: boolean,
): number | false {
  return pollActive && hasActiveLibraryUpload(files)
    ? LIBRARY_UPLOAD_POLL_INTERVAL_MS
    : false;
}

/** Resolve mutually exclusive list states for predictable empty/error copy. */
export function libraryUploadViewState(options: {
  isPending: boolean;
  isError: boolean;
  totalCount: number;
  filteredCount: number;
}): LibraryUploadViewState {
  if (options.isPending) return "loading";
  if (options.isError) return "error";
  if (options.totalCount === 0) return "empty";
  if (options.filteredCount === 0) return "no_results";
  return "ready";
}
