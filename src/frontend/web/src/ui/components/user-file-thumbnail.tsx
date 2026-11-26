import { ImageIcon, ImageOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { useUserFileImageUrl } from "@/query/hooks/useUserFileImageUrl";

/**
 * A small preview of a stored chat image. An image icon stands in while it
 * loads, and a crossed-out one when the file is gone. Decorative: the
 * surrounding row names the file.
 */
export function UserFileThumbnail({
  fileId,
  className,
}: {
  fileId: string;
  /** Size and corner classes, such as `size-7`. */
  className?: string;
}) {
  const { url, isGone } = useUserFileImageUrl(fileId, "thumbnail");
  if (url) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        draggable={false}
        className={cn("shrink-0 rounded-md object-cover", className)}
      />
    );
  }
  const Icon = isGone ? ImageOff : ImageIcon;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-md",
        className,
      )}
    >
      <Icon className="size-3.5" />
    </span>
  );
}
