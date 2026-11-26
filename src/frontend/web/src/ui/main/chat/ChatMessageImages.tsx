import type { ChatDisplayImage } from "@animama/product-ui/chat";
import { ImageOff } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { useUserFileImageUrl } from "@/query/hooks/useUserFileImageUrl";
import { Dialog, DialogContent, DialogTitle } from "@/ui/components/dialog";

/**
 * Thumbnails share one height; their width follows the image within bounds.
 * The `preview` copy (at most 320 px) stays sharp at twice these sizes for
 * aspect ratios up to about 2:1; a wider image is cropped and slightly soft.
 */
const THUMBNAIL_HEIGHT_PX = 80;
const MIN_THUMBNAIL_WIDTH_PX = 48;
const MAX_THUMBNAIL_WIDTH_PX = 160;

function thumbnailStyle(image: ChatDisplayImage): CSSProperties {
  const ratio =
    image.width && image.height ? image.width / image.height : undefined;
  const width = ratio
    ? Math.min(
        MAX_THUMBNAIL_WIDTH_PX,
        Math.max(MIN_THUMBNAIL_WIDTH_PX, THUMBNAIL_HEIGHT_PX * ratio),
      )
    : THUMBNAIL_HEIGHT_PX;
  return { height: THUMBNAIL_HEIGHT_PX, width: Math.round(width) };
}

/**
 * The images the person sent with a message, shown above its bubble. Each
 * opens larger in a dialog; a deleted image leaves a placeholder.
 */
export function ChatMessageImages({
  images,
}: {
  images: readonly ChatDisplayImage[];
}) {
  const { t } = useTranslation("chat");
  const [opened, setOpened] = useState<{
    image: ChatDisplayImage;
    // A fullscreen chat draws only inside the fullscreen element.
    container: HTMLElement | null;
  } | null>(null);
  // The dialog opens without a Radix trigger, so focus is returned by hand.
  const openerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <ul
        className="flex max-w-full flex-wrap justify-end gap-2"
        aria-label={t("images.listLabel")}
      >
        {images.map((image) => (
          <li key={image.fileId}>
            <ChatMessageImage
              image={image}
              onOpen={(opener) => {
                openerRef.current = opener;
                const fullscreen = document.fullscreenElement;
                setOpened({
                  image,
                  container:
                    fullscreen instanceof HTMLElement ? fullscreen : null,
                });
              }}
            />
          </li>
        ))}
      </ul>
      <Dialog
        open={opened !== null}
        onOpenChange={(open) => {
          if (!open) setOpened(null);
        }}
      >
        {opened ? (
          <ChatImageDialogContent
            image={opened.image}
            container={opened.container}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              openerRef.current?.focus();
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function ChatMessageImage({
  image,
  onOpen,
}: {
  image: ChatDisplayImage;
  onOpen: (opener: HTMLButtonElement) => void;
}) {
  const { t } = useTranslation("chat");
  const { url, isGone, isError } = useUserFileImageUrl(image.fileId, "preview");
  const name = image.name || t("images.unnamed");
  const style = thumbnailStyle(image);
  if (isGone || isError) {
    const reason = isGone ? t("images.unavailable") : t("images.loadFailed");
    return (
      <div
        role="img"
        aria-label={t("images.placeholderLabel", { name, reason })}
        title={name}
        style={style}
        className="border-border/70 bg-muted/60 text-muted-foreground flex flex-col items-center justify-center gap-1 rounded-lg border px-2 text-center"
      >
        <ImageOff className="size-4 shrink-0" aria-hidden="true" />
        <span className="text-2xs line-clamp-2 leading-4">{reason}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={(event) => onOpen(event.currentTarget)}
      aria-label={t("images.open", { name })}
      title={name}
      style={style}
      className="border-border/70 bg-muted focus-visible:ring-ring block overflow-hidden rounded-lg border shadow-xs focus-visible:ring-2 focus-visible:outline-none"
    >
      {url ? (
        <img
          src={url}
          alt=""
          className="size-full object-cover"
          draggable={false}
        />
      ) : (
        <span
          className="bg-muted block size-full animate-pulse motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

function ChatImageDialogContent({
  image,
  container,
  onCloseAutoFocus,
}: {
  image: ChatDisplayImage;
  container: HTMLElement | null;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t } = useTranslation("chat");
  const { url, isGone, isError } = useUserFileImageUrl(
    image.fileId,
    "original",
  );
  const name = image.name || t("images.unnamed");
  return (
    <DialogContent
      aria-describedby={undefined}
      portalContainer={container}
      onCloseAutoFocus={onCloseAutoFocus}
      className="w-auto max-w-[min(64rem,calc(100vw-2rem))] gap-3 p-3 sm:max-w-[min(64rem,calc(100vw-2rem))]"
    >
      <DialogTitle className="truncate pr-8 text-sm font-medium">
        {name}
      </DialogTitle>
      {url ? (
        <img
          src={url}
          alt={name}
          className="max-h-[80vh] max-w-full rounded-md object-contain"
          draggable={false}
        />
      ) : isGone || isError ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <ImageOff className="size-4 shrink-0" aria-hidden="true" />
          {isGone ? t("images.unavailable") : t("images.loadFailed")}
        </p>
      ) : (
        <div
          className="bg-muted size-64 max-w-full animate-pulse rounded-md motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}
    </DialogContent>
  );
}
