import type { UserFileUploadUppy } from "@/hooks/useUserFileUpload";
import { getUserFileErrorMessage } from "@/lib/user-files/uploads";
import { cn } from "@/lib/utils";
import { FileUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

type ChatFileDropOverlayProps = {
  accepting: boolean;
  className?: string;
  enabled: boolean;
  uppy?: UserFileUploadUppy;
};

function hasFilePayload(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes("Files"));
}

function droppedFiles(event: DragEvent): File[] {
  return Array.from(event.dataTransfer?.files ?? []);
}

function addFileToUppy(
  uppy: UserFileUploadUppy,
  file: File,
  source = "chat-page-drop",
) {
  uppy.addFile({
    data: file,
    isRemote: false,
    name: file.name,
    source,
    type: file.type || "application/octet-stream",
  });
}

/** Errors the uploader already explained to the person, such as an image refusal. */
function alreadyExplained(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { isUserFacing?: unknown }).isUserFacing === false
  );
}

/** Add pasted images to the composer; refusals are shown by its own rules. */
export function addPastedImages(
  uppy: UserFileUploadUppy,
  images: readonly File[],
) {
  for (const image of images) {
    try {
      addFileToUppy(uppy, image, "chat-paste");
    } catch {
      // Uppy reported the restriction, or the composer refused the image.
    }
  }
}

export function ChatFileDropOverlay({
  accepting,
  className,
  enabled,
  uppy,
}: ChatFileDropOverlayProps) {
  const { t } = useTranslation("chat");
  const [draggingFiles, setDraggingFiles] = useState(false);
  const dragDepthRef = useRef(0);

  const resetDragState = useCallback(() => {
    dragDepthRef.current = 0;
    setDraggingFiles(false);
  }, []);

  const addDroppedFiles = useCallback(
    (files: File[]) => {
      if (!uppy || files.length === 0) return;

      let failedCount = 0;
      let firstError: unknown = null;

      for (const file of files) {
        try {
          addFileToUppy(uppy, file);
        } catch (error) {
          if (alreadyExplained(error)) continue;
          failedCount += 1;
          firstError ??= error;
        }
      }

      if (firstError) {
        const title =
          failedCount === files.length
            ? t("composer.drop.allFailed")
            : t("composer.drop.someFailed", { count: failedCount });
        // The uploader's own message is kept as written; it may name a limit.
        toast.error(title, {
          description: getUserFileErrorMessage(
            firstError,
            t("composer.drop.failedHint"),
          ),
        });
      }
    },
    [t, uppy],
  );

  useEffect(() => {
    if (!enabled) {
      resetDragState();
      return;
    }

    const setDropEffect = (event: DragEvent) => {
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = accepting ? "copy" : "none";
      }
    };

    const handleDragEnter = (event: DragEvent) => {
      if (!hasFilePayload(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropEffect(event);
      dragDepthRef.current += 1;
      setDraggingFiles(accepting);
    };

    const handleDragOver = (event: DragEvent) => {
      if (!hasFilePayload(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropEffect(event);
      setDraggingFiles(accepting);
    };

    const handleDragLeave = (event: DragEvent) => {
      if (!hasFilePayload(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setDraggingFiles(false);
      }
    };

    const handleDrop = (event: DragEvent) => {
      if (!hasFilePayload(event)) return;
      event.preventDefault();
      event.stopPropagation();

      const files = droppedFiles(event);
      resetDragState();

      if (files.length === 0) return;
      if (!accepting || !uppy) {
        toast.error(t("composer.drop.unavailable"));
        return;
      }

      addDroppedFiles(files);
    };

    const listenerOptions = { capture: true };

    window.addEventListener("dragenter", handleDragEnter, listenerOptions);
    window.addEventListener("dragover", handleDragOver, listenerOptions);
    window.addEventListener("dragleave", handleDragLeave, listenerOptions);
    window.addEventListener("drop", handleDrop, listenerOptions);
    window.addEventListener("blur", resetDragState);
    window.addEventListener("dragend", resetDragState);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter, listenerOptions);
      window.removeEventListener("dragover", handleDragOver, listenerOptions);
      window.removeEventListener("dragleave", handleDragLeave, listenerOptions);
      window.removeEventListener("drop", handleDrop, listenerOptions);
      window.removeEventListener("blur", resetDragState);
      window.removeEventListener("dragend", resetDragState);
    };
  }, [accepting, addDroppedFiles, enabled, resetDragState, t, uppy]);

  if (!draggingFiles) {
    return null;
  }

  return (
    <div
      className={cn(
        "bg-background/72 pointer-events-none fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="text-foreground flex flex-col items-center gap-3 text-center">
        <FileUp className="text-primary size-14" aria-hidden="true" />
        <p className="text-2xl font-semibold">{t("composer.drop.prompt")}</p>
      </div>
    </div>
  );
}
