import { useProductApiClient } from "@animama/product-ui";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useRef } from "react";

import { prepareContentPreviews } from "@animama/runtime-contracts/sdk";
import type {
  PyContentPreviewsPrepareResponse,
  PyPreparedPreviewRoot,
  PyTypedBatchDiagnostic,
  PyTypedContentPreview,
} from "@animama/runtime-contracts/api-types";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { typedPreviewTransport } from "@/lib/content/catalogApi";
import type {
  PyContentDependency,
  PyContentPreview,
  PyExactContentSource,
} from "@/lib/content/catalogTypes";
import { queryKeys } from "@/query/keys";

const PREVIEW_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const PREVIEW_REFRESH_MARGIN_MS = 60 * 1000;

const NO_DIAGNOSTICS: readonly PyTypedBatchDiagnostic[] = [];

type ExpiringPreview = { expires_at: string };

/** Refresh a mounted lease near expiry, never merely because focus changed. */
export function actionComponentPreviewRefreshInterval(
  preview: ExpiringPreview | undefined,
  now = Date.now(),
): number {
  const expiresAt = preview ? Date.parse(preview.expires_at) : Number.NaN;
  if (!Number.isFinite(expiresAt)) return PREVIEW_REFRESH_INTERVAL_MS;
  return Math.max(15_000, expiresAt - now - PREVIEW_REFRESH_MARGIN_MS);
}

export function actionComponentPreviewNeedsRenewal(
  preview: ExpiringPreview | undefined,
  now = Date.now(),
): boolean {
  if (!preview) return false;
  const expiresAt = Date.parse(preview.expires_at);
  return (
    Number.isFinite(expiresAt) && expiresAt - now <= PREVIEW_REFRESH_MARGIN_MS
  );
}

function exactSourceKey(
  kind: PyContentDependency["content_type"],
  source: PyExactContentSource,
): string {
  return source.type === "builtin"
    ? `builtin:${kind}:${source.content_id}@${source.version}`
    : `catalog:${source.catalog_item_id}`;
}

/**
 * The key one dependency's source has in a preview batch: its request root,
 * the resolved root's `root_key`, and the `root_key` of a diagnostic about it.
 */
export function actionComponentPreviewRootKey(
  dependency: Pick<PyContentDependency, "content_type" | "source">,
): string {
  return exactSourceKey(dependency.content_type, dependency.source);
}

/** Canonical unique source set used by both the cache and root-preview reuse. */
export function actionComponentPreviewDigest(
  dependencies: readonly PyContentDependency[],
): string {
  return [
    ...new Set(
      dependencies.map((dependency) =>
        exactSourceKey(dependency.content_type, dependency.source),
      ),
    ),
  ]
    .sort()
    .join("|");
}

export function actionComponentPreviewRequestRoots(
  dependencies: readonly PyContentDependency[],
) {
  const unique = new Map<
    string,
    {
      kind: PyContentDependency["content_type"];
      source:
        | { type: "catalog"; catalog_item_id: string }
        | { type: "builtin"; content_id: string; version: number };
    }
  >();
  for (const dependency of dependencies) {
    const source = dependency.source;
    unique.set(exactSourceKey(dependency.content_type, source), {
      kind: dependency.content_type,
      source:
        source.type === "catalog"
          ? { type: "catalog", catalog_item_id: source.catalog_item_id }
          : {
              type: "builtin",
              content_id: source.content_id,
              version: source.version,
            },
    });
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, root]) => root);
}

function previewFromBundle(
  bundle: PyContentPreviewsPrepareResponse,
  root: PyPreparedPreviewRoot,
): PyContentPreview | null {
  if (!bundle.lease) return null;
  const byId = new Map(bundle.items.map((item) => [item.item_id, item]));
  const item = byId.get(root.item_id);
  if (!item) return null;
  const closureIds = new Set(root.closure_item_ids);
  const supports = root.closure_item_ids.flatMap((itemId) => {
    const support = byId.get(itemId);
    return support && support.item_id !== item.item_id ? [support] : [];
  });
  const closureFileRefs = new Set(
    bundle.items.flatMap((candidate) =>
      closureIds.has(candidate.item_id)
        ? (candidate.files ?? []).map((file) => file.file_ref)
        : [],
    ),
  );
  const typed = {
    preview_id: bundle.lease.preview_id,
    revision_sha256: bundle.lease.revision_sha256,
    expires_at: bundle.lease.expires_at,
    item,
    supports,
    files: bundle.lease.files.filter((file) =>
      closureFileRefs.has(file.file_ref),
    ),
    expected_source_revisions: {},
  } as PyTypedContentPreview;
  return typedPreviewTransport(typed);
}

/**
 * Resolve every current component root through one shared preview capability.
 *
 * `refetchOnMount: "always"` asks again each time its caller mounts, even
 * while an earlier answer is still fresh: for a caller that must notice a
 * component deleted from the Library while it was away.
 */
export function useActionComponentPreviews(
  dependencies: readonly PyContentDependency[],
  options: { enabled?: boolean; refetchOnMount?: "always" } = {},
) {
  const apiClient = useProductApiClient();

  const userId = useRuntimeCacheKey();
  const digest = actionComponentPreviewDigest(dependencies);
  const roots = useMemo(
    () => actionComponentPreviewRequestRoots(dependencies),
    [dependencies],
  );
  const enabled = Boolean(
    userId && dependencies.length > 0 && options.enabled !== false,
  );
  const prepared = useRef<
    Array<{ dependency: PyContentDependency; preview: PyContentPreview }>
  >([]);
  const query = useQuery<PyContentPreviewsPrepareResponse>({
    queryKey: queryKeys.actionComponentPreviews.bundle(
      userId ?? "__anon__",
      digest,
    ),
    enabled,
    staleTime: 60_000,
    gcTime: 120_000,
    placeholderData: keepPreviousData,
    refetchOnMount: options.refetchOnMount ?? true,
    refetchInterval: ({ state }) =>
      actionComponentPreviewRefreshInterval(state.data?.lease ?? undefined),
    refetchOnWindowFocus: ({ state }) =>
      actionComponentPreviewNeedsRenewal(state.data?.lease ?? undefined),
    refetchOnReconnect: ({ state }) =>
      actionComponentPreviewNeedsRenewal(state.data?.lease ?? undefined),
    queryFn: async ({ signal }) =>
      (
        await prepareContentPreviews({
          client: apiClient,
          body: { schema_version: 1, roots },
          signal,
          throwOnError: true,
          responseValidator: undefined,
        })
      ).data,
  });
  // Keep the list's identity while its inputs are unchanged: the creator
  // rebuilds its runtime catalog, and so reloads the Avatar, when it changes.
  const data = query.data;
  const currentPreviews = useMemo(() => {
    const rootByKey = new Map(
      (data?.roots ?? []).map((root) => [root.root_key, root]),
    );
    return dependencies.flatMap((dependency) => {
      const root = rootByKey.get(
        exactSourceKey(dependency.content_type, dependency.source),
      );
      const preview = root && data ? previewFromBundle(data, root) : null;
      return preview ? [{ dependency, preview }] : [];
    });
  }, [data, dependencies]);
  if (!enabled) prepared.current = [];
  else if (query.data && !query.isPlaceholderData)
    prepared.current = currentPreviews;
  const previews =
    enabled && query.isPlaceholderData && prepared.current.length > 0
      ? prepared.current
      : currentPreviews;
  return {
    previews,
    pending: enabled && (query.isPending || query.isPlaceholderData),
    /**
     * What the last answer at hand said about roots it could not resolve,
     * each by its `root_key` and a code (`source_unavailable` for a source
     * the owner's Library does not hold). Empty until an answer arrives, so
     * a root without a diagnostic is not thereby known to resolve.
     */
    diagnostics: (enabled && query.data?.diagnostics) || NO_DIAGNOSTICS,
    errors: [
      ...(query.data?.diagnostics ?? []).map((item) => item.message),
      ...(query.error instanceof Error ? [query.error.message] : []),
    ],
  };
}
