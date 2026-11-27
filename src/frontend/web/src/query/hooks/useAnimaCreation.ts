import type { Client } from "@animama/runtime-contracts/sdk";
import { useProductApiClient } from "@animama/product-ui";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { getI18n } from "react-i18next";

import {
  createAnimaV1AnimasPost,
  getAnimaCreationOptionsV1AnimasCreationOptionsGet,
  listAvatarContents,
  listGestures,
  listReactions,
  resolveContentEvidence,
  saveAvatarContent,
  validateAnimaV1AnimasValidatePost,
  type AnimaCreationDiagnostic,
  type AnimaCreationResult,
  type CreateAnimaRequest,
  type AnimaValidationResult,
  type ItemRevisionRef,
  type PyTypedContentPreview,
} from "@animama/runtime-contracts/sdk";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { zAnimaCreationResult } from "@animama/runtime-contracts/validators";
import { previewTypedCatalogItem } from "@/lib/content/catalogApi";
import { toContentSaveApiError } from "@/lib/content/contentSaveErrors";
import { creationFailureText } from "@/lib/errors/creationErrors";
import { queryKeys } from "@/query/keys";
import {
  buildAnimaSpec,
  canonicalJson,
  creationRoots,
  mergeSourceMaps,
  sameRef,
  sourceMapSchema,
  type CreateAnimaDraft,
  type CreationEvidence,
  type CreationSourceKind,
  type FrozenCreationRequest,
} from "@/ui/create-anima/createAnimaDraft";
import { CreatorError } from "@/ui/create-anima/createAnimaErrors";
import {
  classifyCreationFailure,
  type CreationFailure,
} from "@/ui/create-anima/createAnimaSubmission";

/**
 * A creation failure worded from its code (`creationFailureText`): `message`
 * is interface text and `detail` any backend English shown beneath it.
 */
export class AnimaCreationApiError extends CreatorError {
  readonly failure: CreationFailure;
  constructor(failure: CreationFailure) {
    const text = creationFailureText(failure.detail);
    super(text.message, text.detail);
    this.failure = failure;
  }
}

/** Bound stalled reads while preserving the query cache's own cancellation. */
function creationReadSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
}

function sourceFailure(
  issues: AnimaCreationDiagnostic[],
): AnimaCreationApiError {
  return new AnimaCreationApiError({
    state: "rejected",
    detail: {
      code: "anima_creation_sources_stale",
      message: getI18n().t("errors:creation.anima_creation_sources_stale"),
      retryable: false,
      issues,
    },
  });
}

export function creationEvidence(
  preview: PyTypedContentPreview,
): CreationEvidence {
  const revisions = sourceMapSchema.parse(preview.expected_source_revisions);
  const rootRevision = revisions[preview.item.item_id];
  if (
    !rootRevision ||
    rootRevision.kind !== preview.item.kind ||
    rootRevision.revision_sha256 !== preview.item.revision_sha256
  )
    throw new Error("The source returned incomplete revision evidence.");
  return {
    source: {
      item_id: preview.item.item_id,
      revision_sha256: preview.item.revision_sha256,
    },
    revisions,
  };
}

/** Typed reads never replace the reference the user selected. */
export function loadCreationPreview(
  apiClient: Client,
  queryClient: QueryClient,
  owner: string,
  kind: CreationSourceKind,
  source: ItemRevisionRef,
  options: {
    fresh?: boolean;
    acceptCurrent?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<PyTypedContentPreview> {
  return queryClient.fetchQuery({
    queryKey: queryKeys.animaCreation.preview(
      owner,
      kind,
      source.item_id,
      options.acceptCurrent ? "current" : source.revision_sha256,
    ),
    staleTime: options.fresh ? 0 : 60_000,
    gcTime: 120_000,
    retry: false,
    queryFn: async ({ signal }) => {
      // Metadata belongs to the shared cache, not a particular preview mount.
      // A StrictMode cleanup must not poison another consumer with its aborted
      // signal. Each consumer still cancels its own byte loader/playback.
      const preview = await previewTypedCatalogItem(
        apiClient,
        kind,
        source.item_id,
        creationReadSignal(signal),
      );
      const evidence = creationEvidence(preview);
      if (!options.acceptCurrent && !sameRef(source, evidence.source))
        throw sourceFailure([
          {
            code: "source_revision_changed",
            message: getI18n().t("errors:creation.source_revision_changed"),
            path: "/expected_source_revisions",
            item_id: source.item_id,
            expected_revision_sha256: source.revision_sha256,
            current_revision_sha256: evidence.source.revision_sha256,
          },
        ]);
      return preview;
    },
  });
}

/** Bounded, read-only closure refresh; stale support evidence remains a visible error. */
export async function resolveCreationEvidence(
  apiClient: Client,
  _queryClient: QueryClient,
  _owner: string,
  draft: CreateAnimaDraft,
): Promise<CreateAnimaDraft> {
  const roots = creationRoots(draft);
  const unique = [
    ...new Map(
      roots.map((root) => [
        `${root.kind}:${root.source.item_id}@${root.source.revision_sha256}`,
        root,
      ]),
    ).values(),
  ];
  const result = (
    await resolveContentEvidence({
      client: apiClient,
      body: {
        schema_version: 1,
        roots: unique.map((root) => ({
          kind: root.kind,
          source: root.source,
        })),
      },
      signal: AbortSignal.timeout(30_000),
      throwOnError: true,
      responseValidator: undefined,
    })
  ).data;
  const returned = new Map(
    result.roots.map((root) => [root.source.item_id, root]),
  );
  const evidence: Record<string, CreationEvidence> = {};
  const issues: AnimaCreationDiagnostic[] = [];
  for (const root of unique) {
    const resolved = returned.get(root.source.item_id);
    const diagnostic = result.diagnostics.find(
      (item) =>
        item.item_id === root.source.item_id ||
        item.root_key === `catalog:${root.source.item_id}`,
    );
    // The diagnostic keeps its own code so the issue is worded from it.
    let problem: { code: string; message: string } | null = diagnostic
      ? { code: diagnostic.code, message: diagnostic.message }
      : null;
    if (!resolved)
      problem ??= {
        code: "source_unavailable",
        message: getI18n().t("errors:creation.source_unavailable"),
      };
    if (resolved) {
      const next: CreationEvidence = {
        source: resolved.source,
        revisions: sourceMapSchema.parse(resolved.expected_source_revisions),
      };
      const prior = draft.evidence[root.source.item_id]?.revisions;
      const baseline =
        prior && Object.keys(prior).length > 0
          ? prior
          : draft.seed_revisions[root.source.item_id]
            ? Object.fromEntries(
                Object.keys(next.revisions).map((id) => [
                  id,
                  draft.seed_revisions[id],
                ]),
              )
            : null;
      if (baseline && canonicalJson(baseline) !== canonicalJson(next.revisions))
        problem = {
          code: "source_dependency_changed",
          message: getI18n().t("errors:creation.source_dependency_changed"),
        };
      if (!problem) evidence[root.source.item_id] = next;
    }
    if (problem)
      for (const use of roots.filter(
        (candidate) =>
          candidate.kind === root.kind &&
          sameRef(candidate.source, root.source),
      ))
        issues.push({
          ...problem,
          path: use.path,
          item_id: root.source.item_id,
          declaring_action_item_id: ["gesture", "reaction"].includes(root.kind)
            ? root.source.item_id
            : null,
        });
  }
  if (!result.complete || issues.length) {
    if (!issues.length)
      issues.push({
        code: "source_needs_attention",
        message: getI18n().t("errors:creation.source_needs_attention"),
        path: "/expected_source_revisions",
      });
    throw sourceFailure(issues);
  }
  mergeSourceMaps(Object.values(evidence).map((item) => item.revisions));
  return { ...draft, evidence };
}

/**
 * Every Avatar item the owner can use, with each portrait's capture revision.
 * Create Anima, the Anima settings Avatar picker and the Anima page stage
 * share this one query, so a save or portrait refresh updates all of them.
 */
export function useAvatarContents(enabled = true) {
  const apiClient = useProductApiClient();
  const userId = useRuntimeCacheKey();
  return useQuery({
    enabled: Boolean(userId && enabled),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryKey: queryKeys.animaCreation.list(userId ?? "__anon__", "avatar"),
    queryFn: async ({ signal }) =>
      (
        await listAvatarContents({
          client: apiClient,
          signal: creationReadSignal(signal),
          throwOnError: true,
          responseValidator: undefined,
        })
      ).data.items,
  });
}

/** Options and each family keep independent loading, failure, and retry states. */
export function useAnimaCreationSources(enabled: boolean) {
  const apiClient = useProductApiClient();

  const userId = useRuntimeCacheKey();
  const owner = userId ?? "__anon__";
  const common = {
    enabled: Boolean(userId && enabled),
    retry: false as const,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  };
  const options = useQuery({
    ...common,
    queryKey: queryKeys.animaCreation.options(owner),
    queryFn: async ({ signal }) =>
      (
        await getAnimaCreationOptionsV1AnimasCreationOptionsGet({
          client: apiClient,
          signal: creationReadSignal(signal),
          throwOnError: true,
          responseValidator: undefined,
        })
      ).data,
  });
  const avatars = useAvatarContents(enabled);
  const gestures = useQuery({
    ...common,
    queryKey: queryKeys.animaCreation.list(owner, "gesture"),
    queryFn: async ({ signal }) =>
      (
        await listGestures({
          client: apiClient,
          signal: creationReadSignal(signal),
          throwOnError: true,
          responseValidator: undefined,
        })
      ).data.items,
  });
  const reactions = useQuery({
    ...common,
    queryKey: queryKeys.animaCreation.list(owner, "reaction"),
    queryFn: async ({ signal }) =>
      (
        await listReactions({
          client: apiClient,
          signal: creationReadSignal(signal),
          throwOnError: true,
          responseValidator: undefined,
        })
      ).data.items,
  });
  return { options, avatars, gestures, reactions };
}
export type AnimaCreationSources = ReturnType<typeof useAnimaCreationSources>;

export function useAnimaCreationOperations() {
  const apiClient = useProductApiClient();

  const owner = useRuntimeCacheKey() ?? "__anon__";
  const queryClient = useQueryClient();
  const validate = useMutation({
    mutationFn: async (
      draft: CreateAnimaDraft,
    ): Promise<{ draft: CreateAnimaDraft; result: AnimaValidationResult }> => {
      const resolved = await resolveCreationEvidence(
        apiClient,
        queryClient,
        owner,
        draft,
      );
      const response = await validateAnimaV1AnimasValidatePost({
        client: apiClient,
        body: buildAnimaSpec(resolved),
        signal: AbortSignal.timeout(60_000),
        requestValidator: undefined,
        responseValidator: undefined,
        throwOnError: false,
      });
      if (!response.data)
        throw new AnimaCreationApiError(
          classifyCreationFailure(response.error, response.response?.status),
        );
      return { draft: resolved, result: response.data };
    },
    retry: false,
  });
  const create = useMutation({
    mutationFn: async (
      body: FrozenCreationRequest,
    ): Promise<AnimaCreationResult> => {
      try {
        const response = await createAnimaV1AnimasPost({
          client: apiClient,
          // Saved commands can contain retired source kinds. The private backend
          // compatibility decoder permits exact receipt replay only; a miss rejects.
          // New commands have already passed creationRequestSchema.
          body: body as CreateAnimaRequest,
          signal: AbortSignal.timeout(60_000),
          requestValidator: undefined,
          responseValidator: undefined,
          throwOnError: false,
        });
        const result = zAnimaCreationResult.safeParse(response.data);
        if (
          ![200, 201].includes(response.response?.status) ||
          !result.success ||
          !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(result.data.anima_id)
        )
          throw new AnimaCreationApiError(
            classifyCreationFailure(response.error, response.response?.status),
          );
        void queryClient.invalidateQueries({
          queryKey: queryKeys.animas.all(owner),
        });
        // A new Anima adds an identity folder to the Memory workspace.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.memoryEntries.animaIdentities(owner),
        });
        return result.data;
      } catch (error) {
        if (error instanceof AnimaCreationApiError) throw error;
        throw new AnimaCreationApiError(classifyCreationFailure(error));
      }
    },
    retry: false,
  });
  const saveAvatar = useMutation({
    mutationFn: async (input: {
      file: File;
      name: string;
      replace?: ItemRevisionRef;
    }) => {
      const response = await saveAvatarContent({
        client: apiClient,
        path: { entry_name: input.name },
        signal: AbortSignal.timeout(120_000),
        body: {
          operation_id: crypto.randomUUID(),
          files: [input.file],
          creation_context: true,
          catalog_item_id: input.replace?.item_id,
          expected_revision: input.replace?.revision_sha256,
        },
        requestValidator: undefined,
        responseValidator: undefined,
        throwOnError: false,
      });
      if (!response.data)
        throw toContentSaveApiError(
          response.error,
          response.response?.status ?? null,
        );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.animaCreation.list(owner, "avatar"),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.content.all(owner),
      });
      return response.data;
    },
    retry: false,
  });
  const resolve = useCallback(
    (
      kind: CreationSourceKind,
      source: ItemRevisionRef,
      options?: Parameters<typeof loadCreationPreview>[5],
    ) =>
      loadCreationPreview(apiClient, queryClient, owner, kind, source, options),
    [apiClient, queryClient, owner],
  );
  return { validate, create, saveAvatar, resolve };
}
export type AnimaCreationOperations = ReturnType<
  typeof useAnimaCreationOperations
>;
