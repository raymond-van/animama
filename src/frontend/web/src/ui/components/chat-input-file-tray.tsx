import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import type { UserFileUploadUppy } from "@/hooks/useUserFileUpload";
import {
  resolveUserFileUploadCardStatus,
  type UserFileUploadCardStatus,
} from "@/lib/user-files/upload-card-status";
import { isUserImageFile } from "@/lib/user-files/chat-images";
import { isUserImageFileName } from "@/lib/user-files/uploads";
import { cn } from "@/lib/utils";
import { UserFileThumbnail } from "@/ui/components/user-file-thumbnail";
import { useUserFiles } from "@/query/hooks/useUserFiles";
import { Button } from "@/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui/components/tooltip";
import { useUppyState } from "@uppy/react";
import { useFormatters, type LocaleFormatters } from "@animama/product-ui/i18n";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

type ChatInputFileTrayProps = {
  className?: string;
  /** Shown under the attached files, e.g. when the model cannot search them. */
  note?: string | null;
  /** Shown while an image is attached, e.g. when the model cannot see images. */
  imageNote?: string | null;
  existingFiles?: readonly PyUserFileResponse[];
  onRemoveExistingFile?: (fileId: string) => void;
  uppy: UserFileUploadUppy;
};

const statusTextClassName: Record<UserFileUploadCardStatus["tone"], string> = {
  active: "text-primary",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
};

const statusIconClassName: Record<UserFileUploadCardStatus["tone"], string> = {
  active: "bg-primary/10 text-primary",
  destructive: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
};

function knownFileId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeExtension(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith(".") ? trimmed.toLowerCase() : `.${trimmed}`;
}

function fileKind(
  t: TFunction<"chat">,
  file: ReturnType<UserFileUploadUppy["getFile"]>,
  backendFile: PyUserFileResponse | null,
): string {
  return (
    normalizeExtension(backendFile?.normalized_extension) ??
    normalizeExtension(file.extension) ??
    (file.type || t("composer.files.genericKind"))
  );
}

/** A localized size, or nothing while the size is unknown. */
export function attachmentSize(
  formatters: Pick<LocaleFormatters, "fileSize">,
  bytes: number | null | undefined,
): string | null {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0
    ? formatters.fileSize(bytes)
    : null;
}

function StatusGlyph({ status }: { status: UserFileUploadCardStatus }) {
  if (status.active) {
    return <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />;
  }

  if (status.id === "failed") {
    return <AlertTriangle className="size-3.5" aria-hidden="true" />;
  }

  if (
    status.id === "ready" ||
    status.id === "ready_keyword_only" ||
    status.id === "uploaded"
  ) {
    return <CheckCircle2 className="size-3.5" aria-hidden="true" />;
  }

  return <FileText className="size-3.5" aria-hidden="true" />;
}

function ExistingFileCard({
  file,
  onRemove,
}: {
  file: PyUserFileResponse;
  onRemove?: (fileId: string) => void;
}) {
  const { t } = useTranslation("chat");
  const formatters = useFormatters();
  const statusLabel =
    file.status === "ready"
      ? t("composer.files.ready")
      : t("composer.files.readyKeywordOnly");
  return (
    <div
      className="border-border/70 bg-background/80 flex min-h-14 min-w-0 basis-[13rem] items-center gap-2 rounded-lg border px-2 py-1.5 shadow-xs"
      aria-label={t("composer.files.cardLabel", {
        name: file.original_filename,
        status: statusLabel,
      })}
    >
      {isUserImageFile(file) ? (
        <UserFileThumbnail fileId={file.file_id} className="size-7" />
      ) : (
        <div className="bg-success/10 text-success flex size-7 shrink-0 items-center justify-center rounded-md">
          <CheckCircle2 className="size-3.5" aria-hidden="true" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-xs font-medium">
          {file.original_filename}
        </div>
        <div className="text-muted-foreground text-2xs mt-0.5 flex min-w-0 items-center gap-1.5 leading-4">
          <span className="shrink-0">
            {normalizeExtension(file.normalized_extension) ??
              t("composer.files.genericKind")}
          </span>
          <span className="shrink-0">
            {attachmentSize(
              formatters,
              file.stored_size_bytes ?? file.declared_size_bytes,
            )}
          </span>
          <span className="text-success min-w-0 truncate font-medium">
            {statusLabel}
          </span>
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground size-6 shrink-0 rounded-full"
            onClick={() => onRemove?.(file.file_id)}
          >
            <X className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{t("composer.files.remove")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent avoidCollisions={false} side="bottom">
          {t("composer.files.remove")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** A small preview of an image the person is attaching, read from the local file. */
function LocalImagePreview({ data }: { data: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(data);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [data]);
  // The box keeps its size while the preview is being read.
  return url ? (
    <img
      src={url}
      alt=""
      className="size-7 shrink-0 rounded-md object-cover"
      draggable={false}
    />
  ) : (
    <span className="bg-muted size-7 shrink-0 rounded-md" aria-hidden="true" />
  );
}

export function ChatInputFileTray({
  className,
  note,
  imageNote,
  existingFiles = [],
  onRemoveExistingFile,
  uppy,
}: ChatInputFileTrayProps) {
  const { t } = useTranslation("chat");
  const formatters = useFormatters();
  const filesById = useUppyState(uppy, (state) => state.files);
  const files = useMemo(() => Object.values(filesById), [filesById]);
  const knownFileIds = useMemo(
    () =>
      Array.from(
        new Set(
          files
            .map((file) => file.meta.file_id)
            .filter((fileId): fileId is string => knownFileId(fileId)),
        ),
      ),
    [files],
  );
  const knownFileIdSet = useMemo(() => new Set(knownFileIds), [knownFileIds]);
  const filesQuery = useUserFiles({
    enabled: knownFileIds.length > 0,
    pollActive: true,
  });
  const backendFilesById = useMemo(() => {
    const map = new Map<string, PyUserFileResponse>();
    for (const file of filesQuery.data ?? []) {
      if (knownFileIdSet.has(file.file_id)) {
        map.set(file.file_id, file);
      }
    }
    return map;
  }, [filesQuery.data, knownFileIdSet]);

  if (files.length === 0 && existingFiles.length === 0) {
    return null;
  }
  const hasImage =
    files.some((file) => isUserImageFileName(file.name)) ||
    existingFiles.some((file) => isUserImageFile(file));

  return (
    <div className={cn("w-full space-y-2", className)}>
      <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto pr-1">
        {files.map((file) => {
          const fileId = knownFileId(file.meta.file_id)
            ? file.meta.file_id
            : null;
          const backendFile = fileId
            ? (backendFilesById.get(fileId) ?? null)
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
              className="border-border/70 bg-background/80 flex min-h-14 min-w-0 basis-[13rem] items-center gap-2 rounded-lg border px-2 py-1.5 shadow-xs"
              aria-label={t("composer.files.cardLabel", {
                name: file.name,
                status: status.label,
              })}
            >
              {/* A ready image shows itself; other states keep the status glyph. */}
              {isUserImageFileName(file.name) &&
              file.data instanceof Blob &&
              !status.active &&
              status.id !== "failed" ? (
                <LocalImagePreview data={file.data} />
              ) : (
                <div
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-md",
                    statusIconClassName[status.tone],
                  )}
                >
                  <StatusGlyph status={status} />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-foreground truncate text-xs font-medium">
                  {file.name}
                </div>
                <div className="text-muted-foreground text-2xs mt-0.5 flex min-w-0 items-center gap-1.5 leading-4">
                  <span className="shrink-0">
                    {fileKind(t, file, backendFile)}
                  </span>
                  <span className="shrink-0">
                    {attachmentSize(
                      formatters,
                      backendFile?.stored_size_bytes ??
                        backendFile?.declared_size_bytes ??
                        file.size,
                    )}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 truncate font-medium",
                      statusTextClassName[status.tone],
                    )}
                  >
                    {status.label}
                  </span>
                </div>
                {progressWidth ? (
                  <div className="bg-muted mt-1 h-1 overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full rounded-full transition-[width]"
                      style={{ width: progressWidth }}
                    />
                  </div>
                ) : null}
                {status.error ? (
                  <div className="text-destructive text-2xs mt-0.5 truncate leading-4">
                    {status.error}
                  </div>
                ) : null}
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground size-6 shrink-0 rounded-full"
                    onClick={() => {
                      uppy.removeFile(file.id);
                    }}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">
                      {t("composer.files.remove")}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent avoidCollisions={false} side="bottom">
                  {t("composer.files.remove")}
                </TooltipContent>
              </Tooltip>
            </div>
          );
        })}
        {existingFiles.map((file) => (
          <ExistingFileCard
            key={`existing-${file.file_id}`}
            file={file}
            onRemove={onRemoveExistingFile}
          />
        ))}
      </div>
      {note ? (
        <p className="text-muted-foreground text-xs" role="status">
          {note}
        </p>
      ) : null}
      {imageNote && hasImage ? (
        <p className="text-muted-foreground text-xs" role="status">
          {imageNote}
        </p>
      ) : null}
    </div>
  );
}
