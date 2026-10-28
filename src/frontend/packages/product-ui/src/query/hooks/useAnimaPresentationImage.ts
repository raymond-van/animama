import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { PyRuntimeImageReference } from "@animama/runtime-contracts/api-types";
import {
  createAnimaPresentationObjectUrl,
  resolveAnimaPresentationImageRequest,
} from "../../lib/animaPresentationImage";
import { useProductRuntime } from "../../runtime/ProductRuntimeProvider";
import { normalizeRuntimeImagePresentation } from "../../lib/imagePresentation";

/** Fetch one bounded private navigation thumbnail and manage its Blob URL. */
export function useAnimaPresentationImage(
  reference: PyRuntimeImageReference | null | undefined,
) {
  const { owner, transport } = useProductRuntime();
  const appBaseUrl = transport.baseUrl;
  const request = reference
    ? resolveAnimaPresentationImageRequest(reference, appBaseUrl)
    : null;
  const requiresPrivateFetch = request?.requiresPrivateFetch ?? false;
  const resolvedUrl = request?.url ?? null;
  const blobQuery = useQuery<Blob>({
    queryKey: [
      "anima-presentation-image",
      owner.id,
      reference?.content_revision ?? "__none__",
      resolvedUrl ?? "__none__",
    ],
    enabled: Boolean(reference && resolvedUrl && requiresPrivateFetch),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async () => {
      if (!resolvedUrl) {
        throw new Error("An Anima presentation image is required");
      }
      const response = await transport.fetch(resolvedUrl, {
        credentials: "same-origin",
        // The reply's policy decides reuse: an Included image's digest URL is
        // kept, a Local image is revalidated (ADR 0033).
        cache: "default",
        redirect: "error",
      });
      if (!response.ok) {
        throw new Error(
          `Anima presentation fetch failed with HTTP ${response.status}`,
        );
      }
      return response.blob();
    },
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blobQuery.data) {
      setObjectUrl(null);
      return;
    }
    const lease = createAnimaPresentationObjectUrl(blobQuery.data);
    setObjectUrl(lease.url);
    return lease.release;
  }, [blobQuery.data]);

  return {
    url: requiresPrivateFetch ? objectUrl : resolvedUrl,
    presentation: normalizeRuntimeImagePresentation(reference?.presentation),
    isPending: Boolean(requiresPrivateFetch && blobQuery.isPending),
    isError: Boolean(requiresPrivateFetch && blobQuery.isError),
  };
}
