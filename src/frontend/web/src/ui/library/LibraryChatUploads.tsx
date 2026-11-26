import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Loader2, RefreshCw, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@animama/product-ui/i18n";

import type { ContentLibrarySearch } from "@/lib/content/librarySearch";
import {
  filterLibraryUploads,
  LIBRARY_UPLOAD_PAGE_SIZE,
  libraryUploadViewState,
  presentLibraryUpload,
  type LibraryUploadListRow,
  type LibraryUploadStatusTone,
} from "@/lib/uploads/libraryUploads";
import { cn } from "@/lib/utils";
import { useUserFiles } from "@/query/hooks/useUserFiles";
import { Button } from "@/ui/components/button";
import { Card, CardContent } from "@/ui/components/card";
import { Input } from "@/ui/components/input";
import { LibraryChatUploadsDebugPanel } from "@/ui/library/LibraryChatUploadsDebugPanel";
import { LibraryFilterMenu } from "@/ui/library/LibraryFilterMenu";
import { UserFileThumbnail } from "@/ui/components/user-file-thumbnail";
import { useSearchDraft } from "@/ui/library/useSearchDraft";

const STATUS_STYLES: Record<LibraryUploadStatusTone, string> = {
  active: "border-warning/30 bg-warning/10 text-warning",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted/40 text-muted-foreground",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-info/30 bg-info/10 text-info",
};

function UploadStatus({
  active,
  label,
  tone,
}: {
  active: boolean;
  label: string;
  tone: LibraryUploadStatusTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium",
        STATUS_STYLES[tone],
      )}
    >
      {active ? (
        <Loader2
          className="size-3 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
      {label}
    </span>
  );
}

function UploadRow({ row }: { row: LibraryUploadListRow }) {
  const { t } = useTranslation("library");
  const formatters = useFormatters();
  const createdAt = row.createdAt ? new Date(row.createdAt) : null;
  const facts = [
    row.extension ?? t("uploads.genericKind"),
    row.sizeBytes && row.sizeBytes > 0
      ? formatters.fileSize(row.sizeBytes)
      : null,
    row.contentType,
    createdAt && !Number.isNaN(createdAt.getTime())
      ? formatters.dateTime(createdAt, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : null,
  ];
  return (
    <div className="border-border/70 flex min-w-0 flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0 sm:flex-nowrap">
      {row.imageFileId ? (
        <UserFileThumbnail
          fileId={row.imageFileId}
          className="size-9 rounded-lg"
        />
      ) : (
        <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
          <FileText className="size-4" aria-hidden="true" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.name}</p>
        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {facts
            .filter((fact): fact is string => Boolean(fact))
            .map((fact, index) => (
              <span key={index} className="flex min-w-0 items-center gap-x-2">
                {index > 0 ? <span aria-hidden="true">·</span> : null}
                <span className="max-w-52 truncate">{fact}</span>
              </span>
            ))}
        </div>
        {row.error ? (
          <p className="text-destructive mt-1 text-xs break-words">
            {row.error}
          </p>
        ) : null}
      </div>
      <div className="ml-12 flex w-full items-center justify-end gap-2 sm:ml-0 sm:w-auto">
        <UploadStatus
          active={row.active}
          label={row.statusLabel}
          tone={row.statusTone}
        />
        <Button asChild size="sm" variant="ghost" className="min-h-10 shrink-0">
          <a
            href="#chat-upload-debug-tools"
            aria-label={t("uploads.manageFile", { name: row.name })}
          >
            {t("uploads.manage")}
          </a>
        </Button>
      </div>
    </div>
  );
}

function UploadEmptyState({
  filtered,
  onClearFilters,
}: {
  filtered: boolean;
  onClearFilters: () => void;
}) {
  const { t } = useTranslation("library");
  return (
    <div className="border-border/70 m-4 rounded-lg border border-dashed p-8 text-center">
      <p className="font-medium">
        {filtered ? t("uploads.empty.noMatches") : t("uploads.empty.none")}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">
        {filtered
          ? t("uploads.empty.noMatchesHint")
          : t("uploads.empty.noneHint")}
      </p>
      {filtered ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-4 min-h-10"
          onClick={onClearFilters}
        >
          {t("uploads.empty.clearFilters")}
        </Button>
      ) : (
        <Button asChild size="sm" variant="outline" className="mt-4 min-h-10">
          <a href="#chat-upload-debug-tools">{t("uploads.openManager")}</a>
        </Button>
      )}
    </div>
  );
}

/** Focused native Chat Upload inventory with active-work polling. */
export function LibraryChatUploads({
  search,
  onSearchChange,
}: {
  search: ContentLibrarySearch;
  onSearchChange: (update: Partial<ContentLibrarySearch>) => void;
}) {
  const { t } = useTranslation("library");
  const formatters = useFormatters();
  const files = useUserFiles({ pollActive: true });
  const [queryDraft, setQueryDraft] = useSearchDraft(
    search.uploadQuery,
    useCallback(
      (uploadQuery: string | undefined) => onSearchChange({ uploadQuery }),
      [onSearchChange],
    ),
  );
  const [visibleCount, setVisibleCount] = useState(LIBRARY_UPLOAD_PAGE_SIZE);
  const filtered = useMemo(
    () =>
      filterLibraryUploads(files.data ?? [], {
        query: search.uploadQuery,
        status: search.uploadStatus,
      }),
    [files.data, search.uploadQuery, search.uploadStatus],
  );
  const rows = useMemo(
    () => filtered.slice(0, visibleCount).map(presentLibraryUpload),
    [filtered, visibleCount],
  );
  const state = libraryUploadViewState({
    isPending: files.isPending,
    isError: files.isError,
    totalCount: files.data?.length ?? 0,
    filteredCount: filtered.length,
  });

  useEffect(() => {
    setVisibleCount(LIBRARY_UPLOAD_PAGE_SIZE);
  }, [search.uploadQuery, search.uploadStatus]);

  return (
    <section aria-labelledby="library-uploads-heading">
      <Card className="border-border/70 overflow-hidden shadow-sm">
        <CardContent className="p-0">
          <div className="border-border/70 flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-end">
            <div className="min-w-0 flex-1">
              <div className="mb-3 flex items-baseline gap-3">
                <h2
                  id="library-uploads-heading"
                  className="text-base font-semibold"
                >
                  {t("uploads.heading")}
                </h2>
                {!files.isPending && !files.isError ? (
                  <span className="text-muted-foreground text-xs">
                    {filtered.length === (files.data?.length ?? 0)
                      ? t("uploads.count", {
                          count: filtered.length,
                          formattedCount: formatters.number(filtered.length),
                        })
                      : t("uploads.filteredCount", {
                          shown: formatters.number(filtered.length),
                          total: formatters.number(files.data?.length ?? 0),
                        })}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <label className="relative block min-w-0 flex-1">
                  <span className="sr-only">{t("uploads.search")}</span>
                  <Search
                    className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                    aria-hidden="true"
                  />
                  <Input
                    value={queryDraft}
                    maxLength={80}
                    className="h-11 pl-9"
                    placeholder={t("uploads.search")}
                    onChange={(event) => setQueryDraft(event.target.value)}
                  />
                </label>
                <LibraryFilterMenu
                  search={search}
                  onSearchChange={onSearchChange}
                />
              </div>
            </div>
            <Button asChild size="sm" variant="outline" className="h-11">
              <a href="#chat-upload-debug-tools">{t("uploads.manageAll")}</a>
            </Button>
          </div>

          <p
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {state === "loading"
              ? t("uploads.live.loading")
              : state === "error"
                ? t("uploads.live.error")
                : state === "empty"
                  ? t("uploads.live.empty")
                  : state === "no_results"
                    ? t("uploads.live.noResults")
                    : t("uploads.live.showing", {
                        count: filtered.length,
                        shown: formatters.number(rows.length),
                        total: formatters.number(filtered.length),
                      })}
          </p>

          {state === "loading" ? (
            <p className="text-muted-foreground p-6 text-sm" role="status">
              {t("uploads.loading")}
            </p>
          ) : state === "error" ? (
            <div
              className="flex flex-wrap items-center justify-between gap-4 p-6"
              role="alert"
            >
              <p className="text-destructive text-sm">
                {t("uploads.loadFailed")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-10"
                onClick={() => void files.refetch()}
              >
                <RefreshCw className="size-4" /> {t("uploads.retry")}
              </Button>
            </div>
          ) : state === "empty" || state === "no_results" ? (
            <UploadEmptyState
              filtered={state === "no_results"}
              onClearFilters={() =>
                onSearchChange({
                  uploadQuery: undefined,
                  uploadStatus: "all",
                })
              }
            />
          ) : (
            <>
              <div>
                {rows.map((row) => (
                  <UploadRow key={row.key} row={row} />
                ))}
              </div>
              {visibleCount < filtered.length ? (
                <div className="border-border/70 flex justify-center border-t p-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="min-h-10"
                    onClick={() =>
                      setVisibleCount((current) =>
                        Math.min(
                          current + LIBRARY_UPLOAD_PAGE_SIZE,
                          filtered.length,
                        ),
                      )
                    }
                  >
                    {t("uploads.showMore")}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
      <LibraryChatUploadsDebugPanel />
    </section>
  );
}
