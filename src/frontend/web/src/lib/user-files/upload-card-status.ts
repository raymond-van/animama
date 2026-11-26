import { getI18n } from "react-i18next";

import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import { apiErrorLine, uncodedErrorText } from "@/lib/errors/apiError";
import { isUserImageFile } from "@/lib/user-files/chat-images";

/**
 * Frontend-only upload stages stored in transient Uppy file metadata.
 *
 * These values describe what the browser/upload hook currently knows before
 * backend polling has caught up. They are not stored by the backend and are not
 * public API statuses.
 *
 * - `preparing`: Uppy accepted the selected file locally, but Anima upload
 *   initialization has not started yet.
 * - `initializing`: the hook is calling `POST /v1/files/uploads` so the
 *   backend can create a `pending_upload` row and return a private PUT target.
 * - `uploading`: Uppy is uploading bytes directly from the browser to object
 *   local private storage through FastAPI's bounded upload route.
 * - `finalizing`: Uppy reported direct upload success, and the hook is calling
 *   `POST /v1/files/{file_id}:finalize` so the backend can verify the local file
 *   exists, size matches, and the row can become durable.
 * - `uploaded`: the original is durable but processing has not been queued
 *   yet, or processing is turned off. This is not a failure.
 * - `queued`: the process enqueue request returned a queued processing job.
 *   The durable upload exists, but the worker has not claimed the job yet.
 * - `processing`: the process enqueue request returned a processing/running
 *   state, or the tray is waiting for backend polling to report the latest
 *   worker state.
 * - `failed`: a hook-level step failed before an authoritative backend file
 *   status was available, such as init, direct upload, or finalize failure,
 *   or the processing enqueue failed after the original was saved.
 */
export type UserFileUploadStage =
  | "preparing"
  | "initializing"
  | "uploading"
  | "finalizing"
  | "uploaded"
  | "queued"
  | "processing"
  | "failed";

/**
 * Display statuses used by chat composer upload cards.
 *
 * This union intentionally mixes two sources:
 *
 * Frontend-only transient states from `UserFileUploadStage` cover gaps before
 * `/v1/files` polling can return a row.
 *
 * Backend-authoritative file statuses win when present:
 *
 * - `uploaded`: backend finalized the direct upload. The object exists and
 *   passed ownership/size checks, but it is not chat-readable context. A
 *   browser failure wins over this row: the row cannot record that the
 *   processing enqueue failed.
 * - `ready`: backend worker stored chunks and embeddings. The file is
 *   searchable by semantic and keyword debug search and can be attached to
 *   `chat:sse` through its backend file id.
 * - `ready_keyword_only`: backend worker stored chunks but embeddings were
 *   unavailable or failed. The file is keyword-searchable and can still be
 *   attached to `chat:sse`.
 *
 * Other backend file statuses also exist but are either hidden by normal list
 * APIs or collapsed for this tray:
 *
 * - `pending_upload`: backend row exists, but local byte upload/finalize is not
 *   complete. The tray generally shows frontend `initializing`/`uploading`.
 * - `processing`: backend has at least one processing job enqueued; mapped to
 *   the display `processing` state.
 * - `failed`: backend finalize or worker processing failed; mapped to the
 *   display `failed` state.
 * - `aborted`: pending upload was canceled before finalize; normal composer
 *   removal is local and does not call abort today.
 * - `delete_pending`: object cleanup failed after delete; normal list/search
 *   should hide or ignore this row.
 * - `deleted`: tombstoned row, hidden from normal list APIs.
 *
 * Backend processing-job statuses are exposed separately as `jobStatus`:
 * `queued`, `running`, `succeeded`, `failed`, or `canceled`.
 */
export type UserFileUploadCardStatusId =
  | UserFileUploadStage
  | "uploaded"
  | "ready"
  | "ready_keyword_only";

export type UserFileUploadCardTone =
  | "muted"
  | "active"
  | "success"
  | "warning"
  | "destructive";

export type UserFileUploadStatusFile = {
  name?: string;
  error?: string | null;
  meta?: {
    file_id?: string;
    anima_stage?: UserFileUploadStage;
    anima_error?: string | null;
    anima_process_job_id?: string;
    anima_process_job_status?: string | null;
  };
  progress?: {
    bytesTotal?: number | null;
    bytesUploaded?: number | false;
    percentage?: number;
    uploadComplete?: boolean;
    uploadStarted?: number | null;
  };
};

export type UserFileUploadCardStatus = {
  id: UserFileUploadCardStatusId;
  label: string;
  tone: UserFileUploadCardTone;
  active: boolean;
  progress: number | null;
  error: string | null;
  backendStatus: string | null;
  jobStatus: string | null;
};

type ResolveUserFileUploadCardStatusArgs = {
  uppyFile: UserFileUploadStatusFile;
  backendFile?: PyUserFileResponse | null;
};

/** Label for a browser-side upload stage, in the active UI Locale. */
function transientStageLabel(
  stage: Exclude<UserFileUploadStage, "failed">,
): string {
  const t = getI18n().getFixedT(null, "library");
  switch (stage) {
    case "preparing":
      return t("uploads.status.preparing");
    case "initializing":
      return t("uploads.status.initializing");
    case "uploading":
      return t("uploads.status.uploading");
    case "finalizing":
      return t("uploads.status.finalizing");
    case "uploaded":
      return t("uploads.status.originalSaved");
    case "queued":
      return t("uploads.status.queued");
    case "processing":
      return t("uploads.status.processing");
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function uploadProgress(file: UserFileUploadStatusFile): number | null {
  const progress = file.progress;
  if (!progress) return null;
  if (finiteNumber(progress.percentage)) {
    return clampProgress(progress.percentage);
  }
  if (
    finiteNumber(progress.bytesUploaded) &&
    finiteNumber(progress.bytesTotal) &&
    progress.bytesTotal > 0
  ) {
    return clampProgress((progress.bytesUploaded / progress.bytesTotal) * 100);
  }
  return null;
}

function hasUploadStarted(file: UserFileUploadStatusFile): boolean {
  const progress = file.progress;
  if (!progress) return false;
  if (progress.uploadStarted !== null && progress.uploadStarted !== undefined) {
    return true;
  }
  return finiteNumber(progress.bytesUploaded) && progress.bytesUploaded > 0;
}

function localError(file: UserFileUploadStatusFile): string | null {
  const metaError = file.meta?.anima_error;
  if (typeof metaError === "string" && metaError.trim()) {
    return metaError;
  }
  const fileError = file.error;
  if (typeof fileError === "string" && fileError.trim()) {
    return fileError;
  }
  return null;
}

function status(
  id: UserFileUploadCardStatusId,
  label: string,
  tone: UserFileUploadCardTone,
  active: boolean,
  options?: Partial<
    Pick<
      UserFileUploadCardStatus,
      "progress" | "error" | "backendStatus" | "jobStatus"
    >
  >,
): UserFileUploadCardStatus {
  return {
    id,
    label,
    tone,
    active,
    progress: options?.progress ?? null,
    error: options?.error ?? null,
    backendStatus: options?.backendStatus ?? null,
    jobStatus: options?.jobStatus ?? null,
  };
}

/**
 * A stored processing error for an Upload. The English stays primary in
 * English and is secondary detail elsewhere, under a generic message that
 * matches the status: a keyword-only file is still usable.
 */
export function storedUploadErrorLine(file: PyUserFileResponse): string | null {
  const stored =
    file.last_error ?? file.latest_processing_job?.last_error ?? null;
  if (!stored) return null;
  const t = getI18n().getFixedT(null, "library");
  // An image is never processed: its error is the server's refusal at upload.
  const generic = isUserImageFile(file)
    ? t("uploads.imageRefused")
    : file.status === "ready_keyword_only"
      ? t("uploads.keywordOnly")
      : t("uploads.processingFailed");
  return apiErrorLine(uncodedErrorText(stored, generic));
}

function backendStatus(
  file: PyUserFileResponse,
): UserFileUploadCardStatus | null {
  const jobStatus = file.latest_processing_job?.status ?? null;
  const t = getI18n().getFixedT(null, "library");
  const common = {
    backendStatus: file.status,
    jobStatus,
  };

  switch (file.status) {
    case "ready":
      return status(
        "ready",
        t("uploads.status.ready"),
        "success",
        false,
        common,
      );
    case "ready_keyword_only":
      return status(
        "ready_keyword_only",
        t("uploads.status.readyKeywordOnly"),
        "warning",
        false,
        { ...common, error: storedUploadErrorLine(file) },
      );
    case "failed":
      return status(
        "failed",
        t("uploads.status.failed"),
        "destructive",
        false,
        { ...common, error: storedUploadErrorLine(file) },
      );
    case "processing":
      return status(
        "processing",
        t("uploads.status.processing"),
        "active",
        true,
        common,
      );
    case "uploaded":
      return status(
        "uploaded",
        t("uploads.status.uploaded"),
        "muted",
        false,
        common,
      );
    default:
      return null;
  }
}

export function resolveUserFileUploadCardStatus({
  uppyFile,
  backendFile,
}: ResolveUserFileUploadCardStatusArgs): UserFileUploadCardStatus {
  const t = getI18n().getFixedT(null, "library");
  const error = localError(uppyFile);
  const stage = uppyFile.meta?.anima_stage;
  const failedLocally = Boolean(error) || stage === "failed";
  const backend = backendFile ? backendStatus(backendFile) : null;
  // A saved original whose processing could not be queued stays `uploaded` on
  // the backend; only the browser knows it failed, and why.
  if (backend && !(backend.id === "uploaded" && failedLocally)) {
    return backend;
  }

  if (failedLocally) {
    return status("failed", t("uploads.status.failed"), "destructive", false, {
      error: error || t("uploads.failed"),
    });
  }

  if (stage) {
    return status(
      stage,
      transientStageLabel(stage),
      stage === "preparing" || stage === "uploaded" ? "muted" : "active",
      stage !== "preparing" && stage !== "uploaded",
      {
        progress: stage === "uploading" ? uploadProgress(uppyFile) : null,
        jobStatus:
          stage === "queued" || stage === "processing"
            ? (uppyFile.meta?.anima_process_job_status ?? null)
            : null,
      },
    );
  }

  if (hasUploadStarted(uppyFile) && !uppyFile.progress?.uploadComplete) {
    return status("uploading", t("uploads.status.uploading"), "active", true, {
      progress: uploadProgress(uppyFile),
    });
  }

  if (uppyFile.progress?.uploadComplete && uppyFile.meta?.file_id) {
    return status("finalizing", t("uploads.status.finalizing"), "active", true);
  }

  return status("preparing", t("uploads.status.preparing"), "muted", false);
}
