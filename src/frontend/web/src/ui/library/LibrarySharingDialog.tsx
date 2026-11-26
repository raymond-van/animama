import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Download, FileArchive, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@animama/product-ui/i18n";
import type { LibrarySharingFlow } from "@/lib/content-sharing/types";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/ui/components/dialog";
import { ContentExportSelection } from "./ContentExportSelection";
import { ContentExportReview } from "./ContentExportReview";
import { ContentImportReview } from "./ContentImportReview";
import { SharingItemRow } from "./SharingPackageDetails";
import { sharingDropSelection } from "./sharingPresentation";

/** Controlled sharing surface; the hook retains operations even when this closes. */
export function LibrarySharingDialog({ flow }: { flow: LibrarySharingFlow }) {
  const { t } = useTranslation("library");
  const formatters = useFormatters();
  const importTrigger = useRef<HTMLButtonElement>(null);
  const exportTrigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (flow.open) heading.current?.focus();
  }, [flow.open, flow.screen]);
  const fileId = useId();
  const chooseFile = () => fileInput.current?.click();
  const title = (() => {
    switch (flow.screen) {
      case "import-selection":
        return t("sharing.titles.import");
      case "export-selection":
        return t("sharing.titles.export");
      case "export-review":
        return t("sharing.titles.exportReview");
      case "import-upload":
        return t("sharing.titles.importUpload");
      case "import-review":
        return t("sharing.titles.importReview");
      case "import-recovery":
        return t("sharing.titles.importRecovery");
      case "complete":
        return t("sharing.titles.complete");
    }
  })();
  const isImportSelection = flow.screen === "import-selection";
  const canChooseFile = !flow.busy && !flow.commitPending;
  return (
    <Dialog open={flow.open} onOpenChange={flow.setOpen}>
      <div className="flex flex-wrap gap-2">
        <DialogTrigger asChild>
          <Button
            ref={importTrigger}
            variant="outline"
            onClick={() => {
              returnFocus.current = importTrigger.current;
              setDropError(null);
              flow.chooseImport();
            }}
          >
            <Download aria-hidden="true" />
            {t("sharing.import.button")}
          </Button>
        </DialogTrigger>
        <DialogTrigger asChild>
          <Button
            ref={exportTrigger}
            variant="outline"
            onClick={() => {
              returnFocus.current = exportTrigger.current;
              setDropError(null);
              flow.chooseExport();
            }}
          >
            <Upload aria-hidden="true" />
            {t("sharing.export.button")}
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent
        avoidSidebar
        onCloseAutoFocus={(event) => {
          // Both triggers share one dialog; restore the button that opened it.
          event.preventDefault();
          // Opened from the desktop menu, no trigger was pressed: use Import.
          (returnFocus.current ?? importTrigger.current)?.focus();
        }}
        className={`flex max-h-[calc(100dvh-2rem)] flex-col gap-5 overflow-hidden p-5 sm:p-8 ${isImportSelection ? "sm:w-[36rem]" : flow.screen === "import-review" || flow.screen === "import-upload" || flow.screen === "import-recovery" ? "sm:w-[48rem]" : "sm:w-[64rem]"}`}
      >
        <input
          ref={fileInput}
          id={fileId}
          type="file"
          accept=".zip"
          className="sr-only"
          tabIndex={-1}
          aria-label={t("sharing.import.chooseZip")}
          disabled={!canChooseFile}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file && canChooseFile) {
              setDropError(null);
              flow.chooseFile(file);
            }
            event.target.value = "";
          }}
        />
        <header className="shrink-0 pr-6">
          <div className="flex items-center gap-3">
            {!isImportSelection &&
            flow.screen !== "export-selection" &&
            flow.screen !== "complete" &&
            !flow.commitPending ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("sharing.back")}
                disabled={flow.busy}
                onClick={flow.back}
              >
                <ArrowLeft aria-hidden="true" />
              </Button>
            ) : null}
            <DialogTitle
              ref={heading}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight outline-none"
            >
              {title}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {t("sharing.description")}
          </DialogDescription>
        </header>
        <div key={flow.screen} className="min-h-0 overflow-y-auto">
          <div className="grid gap-5">
            {flow.error ? (
              <p
                role="alert"
                className="text-destructive rounded-lg border p-3 text-sm break-words"
              >
                {flow.error}
              </p>
            ) : null}
            {flow.notice ? (
              <p
                role="status"
                className="bg-muted rounded-lg p-3 text-sm break-words"
              >
                {flow.notice}
              </p>
            ) : null}
            {isImportSelection ? (
              <div
                className="mt-auto space-y-3 rounded-xl border border-dashed p-5 text-center"
                onDragOver={(event) => {
                  event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!canChooseFile) return;
                  const selection = sharingDropSelection(
                    event.dataTransfer.files,
                  );
                  setDropError(selection.error);
                  if (selection.file) flow.chooseFile(selection.file);
                }}
              >
                <p className="text-muted-foreground text-sm">
                  {t("sharing.import.dropZip")}
                </p>
                {dropError ? (
                  <p role="alert" className="text-destructive text-sm">
                    {dropError}
                  </p>
                ) : null}
                <Button
                  className="w-full"
                  disabled={!canChooseFile}
                  onClick={chooseFile}
                >
                  {t("sharing.import.chooseFile")}
                </Button>
              </div>
            ) : null}
            {flow.screen === "export-selection" ? (
              <ContentExportSelection flow={flow} />
            ) : null}
            {flow.screen === "export-review" ? (
              <ContentExportReview flow={flow} />
            ) : null}
            {flow.screen === "import-review" ? (
              <ContentImportReview flow={flow} />
            ) : null}
            {flow.screen === "import-upload" ? (
              <div className="space-y-5">
                <div className="rounded-xl border p-5">
                  <FileArchive
                    aria-hidden="true"
                    className="text-muted-foreground mb-3 size-8"
                  />
                  <p className="font-medium break-words">
                    {flow.stage?.filename ?? t("sharing.import.preparingFile")}
                  </p>
                  {flow.progress ? (
                    <div className="mt-4 space-y-2">
                      <progress
                        className="w-full"
                        aria-label={t("sharing.import.fileUpload")}
                        max={flow.progress.total || 1}
                        value={flow.progress.received}
                      />
                      <p
                        role="status"
                        className="text-muted-foreground text-sm"
                      >
                        {t("sharing.import.uploadProgress", {
                          received: formatters.fileSize(flow.progress.received),
                          total: formatters.fileSize(flow.progress.total),
                        })}
                      </p>
                    </div>
                  ) : (
                    <p role="status" className="text-muted-foreground mt-2">
                      {t("sharing.import.preparingPackage")}
                    </p>
                  )}
                </div>
                {!flow.busy && !flow.commitPending ? (
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={flow.retryUpload}>
                      {t("sharing.import.retryUpload")}
                    </Button>
                    {flow.stage ? (
                      <Button variant="outline" onClick={chooseFile}>
                        {t("sharing.import.chooseToResume")}
                      </Button>
                    ) : (
                      <Button variant="outline" onClick={chooseFile}>
                        {t("sharing.import.chooseFile")}
                      </Button>
                    )}
                    <Button variant="ghost" onClick={flow.discardImport}>
                      {t("sharing.import.discard")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {flow.screen === "import-recovery" ? (
              <div className="space-y-4">
                <p>
                  {flow.commitPending
                    ? t("sharing.import.mayStillRun")
                    : t("sharing.import.checkSaved")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={flow.recover} disabled={flow.busy}>
                    {t("sharing.import.checkStatus")}
                  </Button>
                  {!flow.commitPending ? (
                    <Button
                      variant="outline"
                      onClick={flow.discardImport}
                      disabled={flow.busy}
                    >
                      {t("sharing.import.discard")}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {flow.screen === "complete" && flow.result ? (
              <div className="space-y-5">
                <p>
                  {flow.result.anima_id
                    ? t("sharing.import.completeAnima")
                    : t("sharing.import.completeContent")}
                </p>
                <div className="divide-y rounded-xl border">
                  {flow.result.items
                    .filter(
                      (item) => item.selected || Boolean(flow.result?.anima_id),
                    )
                    .map((item) => (
                      <SharingItemRow
                        key={item.item_id}
                        item={{ id: item.item_id, ...item }}
                      />
                    ))}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" asChild>
                    <Link to="/library" onClick={() => flow.setOpen(false)}>
                      {t("sharing.import.viewInLibrary")}
                    </Link>
                  </Button>
                  {flow.result.anima_id ? (
                    <Button onClick={flow.openAnima} disabled={flow.busy}>
                      {t("sharing.import.openAnima")}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
