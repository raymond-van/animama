import { UserRound } from "lucide-react";
import { useState } from "react";

import { useAvatarPortraitUrl } from "@/stores/avatar-portrait-version-store";

/**
 * An Avatar card's picture in Create Anima and the Anima Avatar picker: its
 * portrait (shipped, or captured when a stage first showed a Local Avatar) or
 * a placeholder. A portrait that fails to load falls back to the placeholder.
 */
export function AvatarThumbnail({
  itemId,
  portraitUrl,
}: {
  itemId: string;
  portraitUrl: string | null | undefined;
}) {
  // A portrait retaken this session keeps its URL; this one names the save.
  const url = useAvatarPortraitUrl(itemId, portraitUrl);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className="bg-muted/30 flex h-28 items-center justify-center overflow-hidden rounded-lg">
      {url && failed !== url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-contain"
          onError={() => setFailed(url)}
        />
      ) : (
        <UserRound
          className="text-muted-foreground/60 size-11"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
