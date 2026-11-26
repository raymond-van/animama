import { useProductApiClient } from "@animama/product-ui";

import Uppy from "@uppy/core";
import type { Meta, UppyFile } from "@uppy/core";
import { useEffect, useMemo, useRef } from "react";
import { getI18n } from "react-i18next";
import { toast } from "sonner";

import { useStrictModeSafeDestroy } from "@/hooks/useStrictModeSafeDestroy";
import {
  gatewayUploadHeaders,
  resolveApiUploadUrl,
} from "@/lib/content/contentUploads";
import { createLogger } from "@/lib/logger";
import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import { isUserImageFile } from "@/lib/user-files/chat-images";
import {
  storedUploadErrorLine,
  type UserFileUploadStage,
} from "@/lib/user-files/upload-card-status";
import {
  getUserFileErrorMessage,
  USER_FILE_UPLOAD_RESTRICTIONS,
  userFileUploadLocale,
  isUserImageFileName,
} from "@/lib/user-files/uploads";
import { useFinalizeUserFileUpload } from "@/query/mutations/useFinalizeUserFileUpload";
import { useInitUserFileUpload } from "@/query/mutations/useInitUserFileUpload";
import { useProcessUserFile } from "@/query/mutations/useProcessUserFile";
import { fetchRuntimeCapabilities } from "@/query/runtime-capabilities";
import { WordedError } from "@/lib/errors/apiError";

export type UserFileUploadMeta = Meta & {
  file_id?: string;
  anima_stage?: UserFileUploadStage;
  anima_error?: string;
  anima_process_job_id?: string;
  anima_process_job_status?: string | null;
};

export type UserFileUploadBody = Record<string, never>;
export type UserFileUploadUppy = Uppy<UserFileUploadMeta, UserFileUploadBody>;

type UseUserFileUploadOptions = {
  id: string;
  autoProcess?: boolean;
  clearCompletedFiles?: boolean;
};

function asBrowserFile(file: UppyFile<UserFileUploadMeta, UserFileUploadBody>) {
  if (file.data instanceof File) {
    return file.data;
  }

  if (!(file.data instanceof Blob)) {
    const t = getI18n().getFixedT(null, "app");
    throw new WordedError(t("uploads.fileDataUnavailable"));
  }

  return new File([file.data], file.name ?? "upload", {
    type: file.type || "application/octet-stream",
  });
}

const logger = createLogger("UserFileUpload");

function nowMs() {
  return performance.now();
}

function elapsedMs(startedAt: number) {
  return Math.round(nowMs() - startedAt);
}

function safeFileLogFields(
  instanceId: string,
  file: UppyFile<UserFileUploadMeta, UserFileUploadBody>,
  fileId = file.meta.file_id ?? null,
) {
  return {
    uppyInstanceId: instanceId,
    uppyFileId: file.id,
    size: file.size,
    contentType: file.type || null,
    fileId,
  };
}

function setAnimaFileMeta(
  uppy: UserFileUploadUppy,
  fileId: string,
  meta: Partial<UserFileUploadMeta>,
) {
  uppy.setFileMeta(fileId, meta as UserFileUploadMeta);
}

function processStageFromResponse(
  fileStatus: string | null | undefined,
  jobStatus: string | null | undefined,
): Extract<UserFileUploadStage, "queued" | "processing"> {
  if (jobStatus === "queued") {
    return "queued";
  }
  if (fileStatus === "processing" || jobStatus === "running") {
    return "processing";
  }
  return "processing";
}

/** The generic reason for a refused chat image, in the UI Locale. */
function imageRefusedText(): string {
  return getI18n().getFixedT(null, "library")("uploads.imageRefused");
}

export function useUserFileUpload({
  id,
  autoProcess = true,
  clearCompletedFiles = false,
}: UseUserFileUploadOptions) {
  const apiClient = useProductApiClient();

  const initUpload = useInitUserFileUpload();
  const finalizeUpload = useFinalizeUserFileUpload();
  const processFile = useProcessUserFile();

  const handlersRef = useRef({
    autoProcess,
    clearCompletedFiles,
    finalizeUpload,
    initUpload,
    processFile,
  });

  useEffect(() => {
    handlersRef.current = {
      autoProcess,
      clearCompletedFiles,
      finalizeUpload,
      initUpload,
      processFile,
    };
  }, [
    autoProcess,
    clearCompletedFiles,
    finalizeUpload,
    initUpload,
    processFile,
  ]);

  const uppy = useMemo(() => {
    const instance = new Uppy<UserFileUploadMeta, UserFileUploadBody>({
      id,
      autoProceed: true,
      allowMultipleUploadBatches: true,
      restrictions: USER_FILE_UPLOAD_RESTRICTIONS,
    });
    instance.setOptions({ locale: userFileUploadLocale() });
    const activeUploads = new Map<string, AbortController>();
    instance.addUploader(async (fileIds) => {
      const files = fileIds.map((fileId) => instance.getFile(fileId));
      instance.emit("upload-start", files);
      await Promise.all(
        fileIds.map(async (fileId) => {
          const userFile = instance.getFile(fileId);
          const controller = new AbortController();
          activeUploads.set(fileId, controller);
          const t = getI18n().getFixedT(null, "app");
          try {
            const browserFile = asBrowserFile(userFile);
            const { initUpload: currentInitUpload } = handlersRef.current;
            const startedAt = nowMs();
            setAnimaFileMeta(instance, userFile.id, {
              anima_stage: "initializing",
              anima_error: undefined,
            });
            logger.info("Init", "Upload init request started", {
              ...safeFileLogFields(id, userFile),
            });

            let upload;
            try {
              upload = await currentInitUpload.mutateAsync({
                file: browserFile,
              });
            } catch (error) {
              const message = getUserFileErrorMessage(
                error,
                t("uploads.initFailed"),
              );
              setAnimaFileMeta(instance, userFile.id, {
                anima_stage: "failed",
                anima_error: message,
              });
              logger.warn("Init", "Upload init request failed", {
                ...safeFileLogFields(id, userFile),
                durationMs: elapsedMs(startedAt),
                error: message,
              });
              throw error;
            }

            setAnimaFileMeta(instance, userFile.id, {
              file_id: upload.file_id,
              anima_stage: "uploading",
              anima_error: undefined,
            });
            logger.info("Init", "Upload init request completed", {
              ...safeFileLogFields(id, userFile, upload.file_id),
              durationMs: elapsedMs(startedAt),
            });

            const isApiRelative = !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(
              upload.upload_url,
            );
            const uploadUrl = resolveApiUploadUrl(upload.upload_url);
            const response = await fetch(uploadUrl, {
              method: upload.method ?? "PUT",
              body: browserFile,
              credentials: isApiRelative ? "same-origin" : "omit",
              headers: gatewayUploadHeaders(upload.headers),
              redirect: "error",
              signal: controller.signal,
            });
            if (!response.ok) {
              throw new WordedError(
                t("uploads.httpFailed", { status: response.status }),
              );
            }
            instance.emit("upload-progress", instance.getFile(fileId), {
              uploadStarted: startedAt,
              bytesUploaded: browserFile.size,
              bytesTotal: browserFile.size,
            });
            instance.emit("upload-success", instance.getFile(fileId), {
              status: response.status,
              bytesUploaded: browserFile.size,
              uploadURL: uploadUrl,
            });
          } catch (cause) {
            const error =
              cause instanceof Error
                ? cause
                : new WordedError(t("uploads.failed"));
            instance.emit("upload-error", instance.getFile(fileId), error);
          } finally {
            activeUploads.delete(fileId);
          }
        }),
      );
    });
    instance.on("file-removed", (file) => activeUploads.get(file.id)?.abort());
    instance.on("cancel-all", () => {
      for (const controller of activeUploads.values()) controller.abort();
      activeUploads.clear();
    });

    return instance;
  }, [id]);

  useEffect(() => {
    async function handleUploadSuccess(
      file: UppyFile<UserFileUploadMeta, UserFileUploadBody> | undefined,
    ) {
      if (!file) return;
      const t = getI18n().getFixedT(null, "app");
      const fileId = file.meta.file_id;
      if (!fileId) {
        const missingId = t("uploads.missingFileId");
        setAnimaFileMeta(uppy, file.id, {
          anima_stage: "failed",
          anima_error: missingId,
        });
        toast.error(t("uploads.finalizeFailed"), {
          description: missingId,
        });
        return;
      }

      const {
        autoProcess: shouldProcess,
        clearCompletedFiles: shouldClear,
        finalizeUpload: currentFinalizeUpload,
        processFile: currentProcessFile,
      } = handlersRef.current;

      setAnimaFileMeta(uppy, file.id, {
        anima_stage: "finalizing",
        anima_error: undefined,
      });
      const finalizeStartedAt = nowMs();
      logger.info("Finalize", "Upload finalize request started", {
        ...safeFileLogFields(uppy.opts.id, file, fileId),
      });

      let finalizedFile: PyUserFileResponse | null = null;
      try {
        finalizedFile = await currentFinalizeUpload.mutateAsync({
          fileId,
        });
        logger.info("Finalize", "Upload finalize request completed", {
          ...safeFileLogFields(uppy.opts.id, file, fileId),
          durationMs: elapsedMs(finalizeStartedAt),
          status: finalizedFile.status,
        });
      } catch (error) {
        // An image whose finalize stopped after the upload was saved is
        // completed by the process route, which stores its canonical copy.
        if (isUserImageFileName(file.name)) {
          const recovered = await currentProcessFile
            .mutateAsync({ fileId, force: false })
            .catch(() => null);
          if (
            recovered?.file_status === "ready" ||
            recovered?.file_status === "failed"
          ) {
            const refused = recovered.file_status === "failed";
            logger.info("Finalize", "Image finalize completed by process", {
              ...safeFileLogFields(uppy.opts.id, file, fileId),
              status: recovered.file_status,
            });
            // A refused image's card shows the stored reason from its row.
            setAnimaFileMeta(uppy, file.id, {
              anima_stage: refused ? "failed" : "uploaded",
              anima_error: refused ? imageRefusedText() : undefined,
            });
            if (refused) {
              toast.error(t("uploads.needsAttention"), {
                description: imageRefusedText(),
              });
            }
            return;
          }
        }
        const message = getUserFileErrorMessage(
          error,
          t("uploads.finalizeFailedAfterUpload"),
        );
        setAnimaFileMeta(uppy, file.id, {
          anima_stage: "failed",
          anima_error: message,
        });
        logger.warn("Finalize", "Upload finalize request failed", {
          ...safeFileLogFields(uppy.opts.id, file, fileId),
          durationMs: elapsedMs(finalizeStartedAt),
          error: message,
        });
        toast.error(t("uploads.needsAttention"), {
          description: message,
        });
        return;
      }

      if (finalizedFile && isUserImageFile(finalizedFile)) {
        // An image is ready (or refused) once finalized: it is never processed.
        const refused = finalizedFile.status === "failed";
        const reason = refused
          ? (storedUploadErrorLine(finalizedFile) ?? imageRefusedText())
          : undefined;
        setAnimaFileMeta(uppy, file.id, {
          anima_stage: refused ? "failed" : "uploaded",
          anima_error: reason,
        });
        if (reason) {
          toast.error(t("uploads.needsAttention"), { description: reason });
        }
        return;
      }

      setAnimaFileMeta(uppy, file.id, {
        anima_stage: "uploaded",
        anima_error: undefined,
      });
      // A saved original is a successful upload even when processing is off.
      // An unreadable capability still tries the enqueue, which the server
      // refuses while processing is off, so the card never waits for nothing.
      const capabilities = shouldProcess
        ? await fetchRuntimeCapabilities(apiClient).catch(() => null)
        : null;
      if (
        shouldProcess &&
        capabilities?.user_file_processing.enabled !== false
      ) {
        setAnimaFileMeta(uppy, file.id, {
          anima_stage: "processing",
          anima_error: undefined,
        });
        const processStartedAt = nowMs();
        logger.info("Process", "Upload process request started", {
          ...safeFileLogFields(uppy.opts.id, file, fileId),
        });

        try {
          const processResult = await currentProcessFile.mutateAsync({
            fileId,
            force: false,
          });
          const nextStage = processStageFromResponse(
            processResult.file_status,
            processResult.job_status,
          );
          setAnimaFileMeta(uppy, file.id, {
            anima_stage: nextStage,
            anima_process_job_id: processResult.job_id ?? undefined,
            anima_process_job_status: processResult.job_status,
            anima_error: undefined,
          });
          logger.info("Process", "Upload process request completed", {
            ...safeFileLogFields(uppy.opts.id, file, fileId),
            durationMs: elapsedMs(processStartedAt),
            status: processResult.file_status,
            jobId: processResult.job_id ?? null,
            jobStatus: processResult.job_status ?? null,
          });
          toast.success(t("uploads.queuedForProcessing"));
        } catch (error) {
          const message = getUserFileErrorMessage(
            error,
            t("uploads.processingNotQueuedAfterUpload"),
          );
          // The original stays saved, but nothing will process it: fail the
          // card with the reason so the composer stops waiting for it.
          setAnimaFileMeta(uppy, file.id, {
            anima_stage: "failed",
            anima_error: message,
          });
          logger.warn("Process", "Upload process request failed", {
            ...safeFileLogFields(uppy.opts.id, file, fileId),
            durationMs: elapsedMs(processStartedAt),
            error: message,
          });
          toast.warning(t("uploads.originalSavedNotQueued"), {
            description: message,
          });
          return;
        }
      } else {
        toast.success(
          t("uploads.originalSaved"),
          shouldProcess
            ? { description: t("uploads.processingUnavailable") }
            : undefined,
        );
      }

      if (shouldClear) {
        window.setTimeout(() => {
          if (uppy.getFile(file.id)) {
            uppy.removeFile(file.id);
          }
        }, 1200);
      }
    }

    function handleUploadError(
      file: UppyFile<UserFileUploadMeta, UserFileUploadBody> | undefined,
      error: { message?: string },
    ) {
      const t = getI18n().getFixedT(null, "app");
      if (file) {
        setAnimaFileMeta(uppy, file.id, {
          anima_stage: "failed",
          anima_error: error.message || t("uploads.objectUploadFailed"),
        });
      }
      toast.error(t("uploads.failed"), {
        description:
          error.message || file?.name || t("uploads.objectUploadFailed"),
      });
    }

    function handleRestrictionFailed(
      _file: UppyFile<UserFileUploadMeta, UserFileUploadBody> | undefined,
      error: Error & { isUserFacing?: boolean },
    ) {
      // A refusal the composer already explained (onBeforeFileAdded).
      if (error.isUserFacing === false) return;
      const t = getI18n().getFixedT(null, "app");
      toast.error(t("uploads.rejected"), {
        description: error.message,
      });
    }

    function handleFileAdded(
      file: UppyFile<UserFileUploadMeta, UserFileUploadBody>,
    ) {
      setAnimaFileMeta(uppy, file.id, {
        anima_stage: "preparing",
        anima_error: undefined,
        anima_process_job_id: undefined,
        anima_process_job_status: undefined,
      });
    }

    function handleUploadStart(
      files: UppyFile<UserFileUploadMeta, UserFileUploadBody>[],
    ) {
      for (const file of files) {
        if (!file.meta.file_id) continue;
        setAnimaFileMeta(uppy, file.id, {
          anima_stage: "uploading",
          anima_error: undefined,
        });
      }
    }

    uppy.on("file-added", handleFileAdded);
    uppy.on("upload-start", handleUploadStart);
    uppy.on("upload-success", handleUploadSuccess);
    uppy.on("upload-error", handleUploadError);
    uppy.on("restriction-failed", handleRestrictionFailed);

    return () => {
      uppy.off("file-added", handleFileAdded);
      uppy.off("upload-start", handleUploadStart);
      uppy.off("upload-success", handleUploadSuccess);
      uppy.off("upload-error", handleUploadError);
      uppy.off("restriction-failed", handleRestrictionFailed);
    };
  }, [apiClient, uppy]);

  // Restriction messages follow a UI Locale switch.
  useEffect(() => {
    const i18n = getI18n();
    const relocalize = () =>
      uppy.setOptions({ locale: userFileUploadLocale() });
    i18n.on("languageChanged", relocalize);
    return () => i18n.off("languageChanged", relocalize);
  }, [uppy]);

  useStrictModeSafeDestroy(uppy, (instance) => instance.destroy());

  return uppy;
}
