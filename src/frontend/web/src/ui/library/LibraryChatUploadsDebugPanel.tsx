import DashboardModal from "@uppy/react/dashboard-modal";
import { useUppyState } from "@uppy/react";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { useFormatters } from "@animama/product-ui/i18n";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { DEBUG_ENABLED } from "@/platform/env";
import { toast } from "sonner";

import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import {
  useUserFileUpload,
  type UserFileUploadUppy,
} from "@/hooks/useUserFileUpload";
import {
  resolveUserFileUploadCardStatus,
  type UserFileUploadCardStatus,
} from "@/lib/user-files/upload-card-status";
import { getUserFileErrorMessage } from "@/lib/user-files/uploads";
import { cn } from "@/lib/utils";
import { useUserFiles } from "@/query/hooks/useUserFiles";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import { useDeleteUserFile } from "@/query/mutations/useDeleteUserFile";
import { canProcessLibraryUpload } from "@/lib/uploads/libraryUploads";
import { useProcessUserFile } from "@/query/mutations/useProcessUserFile";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";

const EMPTY_USER_FILES: PyUserFileResponse[] = [];
type UppyFilesState = ReturnType<UserFileUploadUppy["getState"]>["files"];

/** Debug-only timestamp text; this panel stays English. */
function formatUserFileTimestamp(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** Debug-only status text from a backend status ID. */
function userFileStatusLabel(status: string | null | undefined) {
  if (!status) return "Unknown";
  return status.replaceAll("_", " ");
}

function isForceProcessStatus(status: string) {
  return status === "ready" || status === "ready_keyword_only";
}

function statusClassName(status: string | null | undefined) {
  switch (status) {
    case "ready":
      return "border-success/30 bg-success/10 text-success";
    case "ready_keyword_only":
      return "border-info/30 bg-info/10 text-info";
    case "processing":
    case "uploaded":
      return "border-warning/30 bg-warning/10 text-warning";
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

function StatusPill({ status }: { status: string | null | undefined }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium capitalize",
        statusClassName(status),
      )}
    >
      {userFileStatusLabel(status)}
    </span>
  );
}

const uploadStatusIconClassName: Record<
  UserFileUploadCardStatus["tone"],
  string
> = {
  active: "bg-primary/10 text-primary",
  destructive: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
};

function UploadStatusGlyph({ status }: { status: UserFileUploadCardStatus }) {
  if (status.active) {
    return <Loader2 className="size-4 animate-spin" aria-hidden="true" />;
  }
  if (status.id === "failed") {
    return <AlertTriangle className="size-4" aria-hidden="true" />;
  }
  if (
    status.id === "ready" ||
    status.id === "ready_keyword_only" ||
    status.id === "uploaded"
  ) {
    return <CheckCircle2 className="size-4" aria-hidden="true" />;
  }
  return <FileText className="size-4" aria-hidden="true" />;
}

function UploadProgressPanel({
  files,
  backendFiles,
}: {
  files: UppyFilesState;
  backendFiles: PyUserFileResponse[];
}) {
  const uploadFiles = useMemo(() => Object.values(files), [files]);
  const backendById = useMemo(() => {
    const map = new Map<string, PyUserFileResponse>();
    for (const file of backendFiles) {
      map.set(file.file_id, file);
    }
    return map;
  }, [backendFiles]);

  if (uploadFiles.length === 0) {
    return null;
  }

  return (
    <div className="bg-card/95 border-border/70 fixed right-4 bottom-4 z-40 w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-lg border shadow-2xl shadow-black/25">
      <div className="border-border/70 flex items-center justify-between border-b px-4 py-3">
        <div className="text-foreground text-sm font-semibold">
          Uploading {uploadFiles.length} file
          {uploadFiles.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto p-3">
        {uploadFiles.map((file) => {
          const backendFile =
            typeof file.meta.file_id === "string"
              ? (backendById.get(file.meta.file_id) ?? null)
              : null;
          const status = resolveUserFileUploadCardStatus({
            backendFile,
            uppyFile: file,
          });
          const progressWidth =
            status.id === "uploading" && status.progress !== null
              ? `${status.progress}%`
              : null;

          return (
            <div
              key={file.id}
              className="flex min-w-0 items-center gap-3 rounded-md px-1 py-2"
            >
              <div
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-md",
                  uploadStatusIconClassName[status.tone],
                )}
              >
                <UploadStatusGlyph status={status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-foreground truncate text-sm font-medium">
                  {file.name}
                </div>
                <div className="text-muted-foreground mt-0.5 text-xs">
                  {status.label}
                </div>
                {progressWidth ? (
                  <div className="bg-muted mt-2 h-1 overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full rounded-full transition-[width]"
                      style={{ width: progressWidth }}
                    />
                  </div>
                ) : null}
                {status.error ? (
                  <div className="text-destructive mt-1 truncate text-xs">
                    {status.error}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const DebugSearchTools =
  __ANIMAMA_DEV_BUILD__ && DEBUG_ENABLED
    ? lazy(() => import("@/ui/debug/UploadSearchDebugTools"))
    : null;

export function LibraryChatUploadsDebugPanel() {
  const { fileSize } = useFormatters();
  const capabilities = useRuntimeCapabilities();
  const processingEnabled =
    capabilities.data?.user_file_processing.enabled === true;
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(
    () => new Set(),
  );
  const filesQuery = useUserFiles({ pollActive: true });
  const files = filesQuery.data ?? EMPTY_USER_FILES;
  const uploadUppy = useUserFileUpload({ id: "memory-user-files" });
  const uppyFiles = useUppyState(
    uploadUppy,
    (state): UppyFilesState => state.files,
  );
  const processFile = useProcessUserFile();
  const deleteFile = useDeleteUserFile();

  const selectedIds = useMemo(
    () =>
      files
        .filter((file) => selectedFileIds.has(file.file_id))
        .map((file) => file.file_id),
    [files, selectedFileIds],
  );
  const allVisibleSelected =
    files.length > 0 && selectedIds.length === files.length;

  useEffect(() => {
    setSelectedFileIds((current) => {
      const visibleIds = new Set(files.map((file) => file.file_id));
      const next = new Set(
        [...current].filter((fileId) => visibleIds.has(fileId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [files]);

  const toggleFileSelection = (fileId: string, checked: boolean) => {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(fileId);
      } else {
        next.delete(fileId);
      }
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    setSelectedFileIds(() =>
      checked ? new Set(files.map((file) => file.file_id)) : new Set(),
    );
  };

  const handleProcess = async (file: PyUserFileResponse) => {
    try {
      await processFile.mutateAsync({
        fileId: file.file_id,
        force: isForceProcessStatus(file.status),
      });
      toast.success("File queued for processing.");
    } catch (error) {
      toast.error("Failed to queue processing.", {
        description: getUserFileErrorMessage(error),
      });
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.length === 0) return;
    try {
      await Promise.all(
        selectedIds.map((fileId) => deleteFile.mutateAsync({ fileId })),
      );
      setSelectedFileIds(new Set());
      toast.success("Selected files deleted.");
    } catch (error) {
      toast.error("Failed to delete selected files.", {
        description: getUserFileErrorMessage(error),
      });
    }
  };

  return (
    <div id="chat-upload-debug-tools" className="mt-6 scroll-mt-32 space-y-6">
      {!processingEnabled ? (
        <p className="text-muted-foreground text-sm">
          Upload processing is unavailable. Originals are saved, and files
          indexed earlier remain searchable.
        </p>
      ) : null}
      <DashboardModal
        uppy={uploadUppy}
        open={uploadOpen}
        onRequestClose={() => setUploadOpen(false)}
        closeAfterFinish={false}
        doneButtonHandler={() => setUploadOpen(false)}
        proudlyDisplayPoweredByUppy={false}
        hideProgressDetails={false}
        note="Supported: TXT, Markdown, JSON, CSV, TSV, HTML, XML, PDF, DOCX, PPTX, XLSX. Maximum size 25 MB."
      />
      <UploadProgressPanel files={uppyFiles} backendFiles={files} />

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-foreground text-xl font-semibold">
            Upload management
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage installation-owned files and processing.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void filesQuery.refetch();
            }}
            disabled={filesQuery.isFetching}
          >
            {filesQuery.isFetching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Refresh
          </Button>
          <Button type="button" onClick={() => setUploadOpen(true)}>
            <Upload className="size-4" />
            Upload
          </Button>
        </div>
      </div>

      <section className="border-border/70 bg-card/80 overflow-hidden rounded-lg border">
        <div className="border-border/70 flex flex-col gap-3 border-b px-4 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-foreground text-base font-semibold">
              Uploaded files
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">
              {files.length} file{files.length === 1 ? "" : "s"}
              {selectedIds.length > 0
                ? ` / ${selectedIds.length} selected`
                : ""}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={selectedIds.length === 0 || deleteFile.isPending}
            onClick={() => {
              void handleDeleteSelected();
            }}
          >
            {deleteFile.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            Delete selected
          </Button>
        </div>
        <div className="px-4">
          {filesQuery.isLoading ? (
            <div className="text-muted-foreground py-8 text-sm">
              Loading uploads...
            </div>
          ) : filesQuery.isError ? (
            <div className="text-destructive py-8 text-sm">
              Failed to load uploads.
            </div>
          ) : files.length === 0 ? (
            <div className="border-border/70 bg-muted/20 my-4 rounded-lg border border-dashed p-8">
              <p className="text-foreground text-sm font-medium">
                No uploads yet
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                Upload files from the chat composer or this page.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[760px]">
                <div className="text-muted-foreground border-border/70 grid grid-cols-[2.5rem_minmax(0,1.6fr)_8rem_8rem_7rem_11rem_9rem] items-center border-b py-2 text-xs font-medium">
                  <div className="flex items-center justify-center">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={(checked) =>
                        toggleAllVisible(checked === true)
                      }
                    />
                  </div>
                  <div>File</div>
                  <div>Status</div>
                  <div>Job</div>
                  <div>Chunks</div>
                  <div>Updated</div>
                  <div className="text-right">Action</div>
                </div>
                {files.map((file) => {
                  const canProcess = canProcessLibraryUpload(file, {
                    processingEnabled,
                  });
                  const processLabel = isForceProcessStatus(file.status)
                    ? "Reprocess"
                    : "Process";

                  return (
                    <div
                      key={file.file_id}
                      className="border-border/70 grid grid-cols-[2.5rem_minmax(0,1.6fr)_8rem_8rem_7rem_11rem_9rem] items-center gap-2 border-b py-3 last:border-b-0"
                    >
                      <div className="flex items-center justify-center">
                        <Checkbox
                          checked={selectedFileIds.has(file.file_id)}
                          onCheckedChange={(checked) =>
                            toggleFileSelection(file.file_id, checked === true)
                          }
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="text-foreground truncate text-sm font-medium">
                          {file.original_filename}
                        </div>
                        <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs">
                          <span>{file.normalized_extension}</span>
                          <span>
                            {fileSize(
                              file.stored_size_bytes ??
                                file.declared_size_bytes ??
                                0,
                            )}
                          </span>
                          {file.last_error ? (
                            <span className="text-destructive truncate">
                              {file.last_error}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div>
                        <StatusPill status={file.status} />
                      </div>
                      <div className="text-muted-foreground text-xs capitalize">
                        {file.latest_processing_job?.status
                          ? userFileStatusLabel(
                              file.latest_processing_job.status,
                            )
                          : "None"}
                      </div>
                      <div className="text-muted-foreground text-sm">
                        {file.chunk_count ?? 0}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {formatUserFileTimestamp(
                          file.processed_at ?? file.updated_at,
                        )}
                      </div>
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!canProcess || processFile.isPending}
                          onClick={() => {
                            void handleProcess(file);
                          }}
                        >
                          {processFile.isPending ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : isForceProcessStatus(file.status) ? (
                            <RotateCcw className="size-4" />
                          ) : (
                            <RefreshCw className="size-4" />
                          )}
                          {processLabel}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      {DebugSearchTools ? (
        <Suspense fallback={null}>
          <DebugSearchTools selectedIds={selectedIds} />
        </Suspense>
      ) : null}
    </div>
  );
}
