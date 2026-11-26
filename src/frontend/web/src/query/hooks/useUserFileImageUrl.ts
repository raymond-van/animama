import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { fetchProtectedContentResponse } from "@/lib/runtime-content/runtimeContentDelivery";
import { queryKeys } from "@/query/keys";

/**
 * Which copy to load: `thumbnail` (at most 128 px) for small tiles, `preview`
 * (at most 320 px) for the chat transcript, `original` for the larger view.
 */
export type UserFileImageVariant = "thumbnail" | "preview" | "original";

/** The owner-only byte route for a stored chat image. */
export function userFileContentPath(
  fileId: string,
  variant: UserFileImageVariant,
): string {
  const path = `/v1/files/${encodeURIComponent(fileId)}/content`;
  return variant === "original" ? path : `${path}?variant=${variant}`;
}

/** A failed image request; `gone` when the file was deleted or replaced. */
export class UserFileImageError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Chat image request failed with HTTP ${status}`);
    this.name = "UserFileImageError";
    this.status = status;
  }

  /** 404: deleted or never this owner's image; 409: its bytes changed. */
  get gone(): boolean {
    return this.status === 404 || this.status === 409;
  }

  /** A failure a retry cannot fix; 422 is an image the server cannot shrink. */
  get permanent(): boolean {
    return this.gone || this.status === 422;
  }
}

/**
 * A browser URL for a chat image, read through the same-origin owner boundary
 * and held as a Blob URL while the component is mounted. A deleted image
 * reports `isGone`, so the caller can show a placeholder instead.
 */
export function useUserFileImageUrl(
  fileId: string,
  variant: UserFileImageVariant,
) {
  const cacheKey = useRuntimeCacheKey();
  const query = useQuery<Blob, Error>({
    queryKey: queryKeys.userFileImages.variant(
      cacheKey ?? "__anon__",
      fileId,
      variant,
    ),
    // Owner-scoped bytes wait for the admitted runtime.
    enabled: Boolean(cacheKey),
    staleTime: Number.POSITIVE_INFINITY,
    retry: (failureCount, error) =>
      !(error instanceof UserFileImageError && error.permanent) &&
      failureCount < 2,
    queryFn: async ({ signal }) => {
      const response = await fetchProtectedContentResponse(
        userFileContentPath(fileId, variant),
        { signal },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new UserFileImageError(response.status);
      }
      return response.blob();
    },
  });
  const isGone = query.error instanceof UserFileImageError && query.error.gone;
  const blob = isGone ? undefined : query.data;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  return {
    url,
    isPending: query.isPending,
    isGone,
    isError: query.isError && !isGone,
  };
}
