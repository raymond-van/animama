import { useProductApiClient } from "@animama/product-ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { avatarPreviewTarget } from "@/lib/content/avatarPreviewTarget";
import { previewCatalogItem } from "@/lib/content/catalogApi";
import type {
  PyAnimaListItem,
  PyContentPreview,
} from "@/lib/content/catalogTypes";
import type {
  AnimaRuntimeCatalogSnapshot,
  RuntimeCatalogEntry,
} from "@/lib/runtime-content/types";
import { adaptRuntimeSnapshot } from "@/lib/runtime-content/runtimeSnapshotAdapter";
import { useAnimaRuntimeCatalog } from "@/query/hooks/useAnimaRuntimeCatalog";
import { useAnimas } from "@/query/hooks/useAnimas";
import { useAvatarCatalog } from "@/query/hooks/useAvatarCatalog";
import { queryKeys } from "@/query/keys";
import { usePreparedContentPreview } from "@/ui/content-preview/usePreparedContentPreview";
import { useSettings } from "@/ui/settings/SettingsProvider";
import {
  contentCreatorCatalogAvatarItemId,
  contentCreatorIncludedAvatarSource,
  contentCreatorModelPreviewTarget,
  contentCreatorOwnAvatarSource,
  contentCreatorModelSourceFromAnima,
  contentCreatorModelSourcesEqual,
  selectContentCreatorPreviewAnima,
  type ContentCreatorModelSource,
  type ContentCreatorPreviewAnimaStatus,
} from "./contentCreatorModelPreview";

export type ContentCreatorModelPreview = {
  previewAnima: PyAnimaListItem | null;
  previewAnimaStatus: ContentCreatorPreviewAnimaStatus;
  runtime: AnimaRuntimeCatalogSnapshot | null;
  modelOptions: ContentCreatorModelSource[];
  selectedModel: ContentCreatorModelSource | null;
  modelEntry: RuntimeCatalogEntry | null;
  modelEntryKey: string | null;
  isAnimaPending: boolean;
  isRuntimePending: boolean;
  isModelCatalogPending: boolean;
  hasMoreModels: boolean;
  isLoadingMoreModels: boolean;
  modelCatalogError: string | null;
  animaError: string | null;
  runtimeError: string | null;
  modelError: string | null;
  selectModel: (source: ContentCreatorModelSource) => void;
  retryAnima: () => Promise<void>;
  retryRuntime: () => Promise<void>;
  retryModels: () => Promise<void>;
  loadMoreModels: () => Promise<void>;
  retrySelectedModel: () => Promise<void>;
};

/**
 * Resolve the last-active Anima's exact model and, with `includedAvatars` and
 * `ownAvatars`, the Included Avatars and the person's own, without mutating
 * user settings or any Anima loadout. The Anima's model is chosen first;
 * without one, the first Included Avatar.
 */
export function useContentCreatorModelPreview({
  ownerKey,
  selectedModel,
  onSelectModel,
  includedAvatars = false,
  ownAvatars = false,
}: {
  ownerKey: string;
  selectedModel: ContentCreatorModelSource | null;
  onSelectModel: (source: ContentCreatorModelSource) => void;
  /** Also offer every Included Avatar. */
  includedAvatars?: boolean;
  /** Also offer the person's own Avatars (the Avatar catalog's first page). */
  ownAvatars?: boolean;
}): ContentCreatorModelPreview {
  const { t } = useTranslation("creator");
  const userId = useRuntimeCacheKey();
  const apiClient = useProductApiClient();
  const { userSettings, isLoading: settingsLoading } = useSettings();
  const animasQuery = useAnimas();
  const animaSelection = useMemo(
    () =>
      selectContentCreatorPreviewAnima(
        animasQuery.data ?? [],
        userSettings?.last_active_anima_id,
      ),
    [animasQuery.data, userSettings?.last_active_anima_id],
  );
  const previewAnimaId = animaSelection.anima?.id ?? null;
  const runtimeQuery = useAnimaRuntimeCatalog(previewAnimaId);
  const runtime = useMemo(
    () => (runtimeQuery.data ? adaptRuntimeSnapshot(runtimeQuery.data) : null),
    [runtimeQuery.data],
  );
  const equippedModel = useMemo(
    () =>
      previewAnimaId && runtime
        ? contentCreatorModelSourceFromAnima(previewAnimaId, runtime)
        : null,
    [previewAnimaId, runtime],
  );
  const includedQuery = useAvatarCatalog({
    origin: "included",
    enabled: includedAvatars,
  });
  const includedSources = useMemo(
    () =>
      includedAvatars
        ? (includedQuery.data?.pages ?? [])
            .flatMap((page) => page.items)
            .flatMap((item) =>
              item.catalog_item_id
                ? [
                    contentCreatorIncludedAvatarSource({
                      catalog_item_id: item.catalog_item_id,
                      name: item.name,
                    }),
                  ]
                : [],
            )
        : [],
    [includedAvatars, includedQuery.data?.pages],
  );
  const ownQuery = useAvatarCatalog({ origin: "local", enabled: ownAvatars });
  const ownSources = useMemo(
    () =>
      ownAvatars
        ? (ownQuery.data?.pages ?? [])
            .flatMap((page) => page.items)
            .flatMap((item) =>
              item.catalog_item_id
                ? [
                    contentCreatorOwnAvatarSource({
                      catalog_item_id: item.catalog_item_id,
                      name: item.name,
                    }),
                  ]
                : [],
            )
        : [],
    [ownAvatars, ownQuery.data?.pages],
  );
  const listsAvatars = includedAvatars || ownAvatars;
  const modelOptions = useMemo(
    () => [
      ...(equippedModel
        ? [
            {
              ...equippedModel,
              // Beside other Avatars, name the Anima the model is from.
              displayName: listsAvatars
                ? animaSelection.anima?.display_name
                  ? t("modelPreview.animaModel", {
                      name: animaSelection.anima.display_name,
                    })
                  : t("modelPreview.unnamedAnimaModel")
                : equippedModel.displayName,
            },
          ]
        : []),
      ...ownSources,
      ...includedSources,
    ],
    [
      animaSelection.anima?.display_name,
      equippedModel,
      includedSources,
      listsAvatars,
      ownSources,
      t,
    ],
  );

  useEffect(() => {
    if (equippedModel) {
      if (
        !selectedModel ||
        (selectedModel.sourceType === "resolved_entry" &&
          !contentCreatorModelSourcesEqual(selectedModel, equippedModel))
      ) {
        onSelectModel(equippedModel);
      }
      return;
    }
    // Without an Anima, preview on the first Included Avatar.
    if (
      !selectedModel &&
      animasQuery.isSuccess &&
      (animaSelection.status === "none" || runtimeQuery.isError) &&
      includedSources[0]
    ) {
      onSelectModel(includedSources[0]);
    }
  }, [
    animaSelection.status,
    animasQuery.isSuccess,
    equippedModel,
    includedSources,
    onSelectModel,
    previewAnimaId,
    runtimeQuery.isError,
    selectedModel,
  ]);

  // An Included or own Avatar is previewed through its catalog item.
  const catalogItemId = contentCreatorCatalogAvatarItemId(selectedModel);
  const catalogPreview = useQuery<PyContentPreview>({
    queryKey: queryKeys.avatars.preview(
      userId ?? "__anon__",
      catalogItemId ?? "__none__",
    ),
    enabled: Boolean(userId && catalogItemId),
    // File grants expire; fetch a fresh one shortly before. The preview target
    // below is keyed by the Avatar's revision, so a new grant does not reload
    // an Avatar that is already loaded.
    staleTime: (query) => previewGrantRefreshMs(query.state.data),
    refetchInterval: (query) =>
      query.state.data ? previewGrantRefreshMs(query.state.data) : false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      previewCatalogItem(apiClient, catalogItemId!, signal, "avatar"),
  });

  const target = useMemo(() => {
    if (selectedModel && selectedModel.sourceType !== "resolved_entry") {
      if (!catalogPreview.data) return null;
      const preview = avatarPreviewTarget(
        catalogPreview.data,
        selectedModel.displayName,
      );
      // Identity is the Avatar item and revision, not the file grant.
      return {
        ...preview,
        key: `${selectedModel.sourceType === "included_avatar" ? "included-avatar" : "own-avatar"}:${selectedModel.itemId}:${catalogPreview.data.revision}`,
      };
    }
    return contentCreatorModelPreviewTarget({
      source: selectedModel,
      animaId: previewAnimaId,
      runtime,
      ownerKey,
    });
  }, [catalogPreview.data, ownerKey, previewAnimaId, runtime, selectedModel]);
  const preparedModel = usePreparedContentPreview(target, {
    enabled: Boolean(target),
    owner: "management",
  });
  const noModelAvailable =
    animaSelection.status === "none" &&
    animasQuery.isSuccess &&
    modelOptions.length === 0 &&
    (!includedAvatars || includedQuery.isSuccess) &&
    (!ownAvatars || ownQuery.isSuccess);
  const modelError =
    preparedModel.error ??
    (catalogPreview.isError
      ? selectedModel?.sourceType === "own_avatar"
        ? t("modelPreview.ownFailed")
        : t("modelPreview.includedFailed")
      : selectedModel &&
          !target &&
          selectedModel.sourceType === "resolved_entry"
        ? t("modelPreview.releaseUnavailable")
        : noModelAvailable
          ? t("modelPreview.noAnima")
          : null);

  return {
    previewAnima: animaSelection.anima,
    previewAnimaStatus: animaSelection.status,
    runtime,
    modelOptions,
    selectedModel,
    modelEntry: preparedModel.prepared?.entry ?? null,
    modelEntryKey: preparedModel.prepared?.entryKey ?? null,
    isAnimaPending: settingsLoading || animasQuery.isPending,
    isRuntimePending:
      (Boolean(previewAnimaId) && runtimeQuery.isPending) ||
      (Boolean(catalogItemId) && catalogPreview.isPending),
    isModelCatalogPending:
      (includedAvatars && includedQuery.isPending) ||
      (ownAvatars && ownQuery.isPending),
    hasMoreModels: false,
    isLoadingMoreModels: false,
    modelCatalogError: includedQuery.isError
      ? t("modelPreview.includedListFailed")
      : ownAvatars && ownQuery.isError
        ? t("modelPreview.ownListFailed")
        : null,
    animaError: animasQuery.isError ? t("modelPreview.animasFailed") : null,
    runtimeError: runtimeQuery.isError ? t("modelPreview.runtimeFailed") : null,
    modelError,
    selectModel: onSelectModel,
    retryAnima: async () => {
      await animasQuery.refetch();
    },
    retryRuntime: async () => {
      await runtimeQuery.refetch();
    },
    retryModels: async () => {
      if (includedAvatars && includedQuery.isError)
        await includedQuery.refetch();
      if (ownAvatars && ownQuery.isError) await ownQuery.refetch();
    },
    loadMoreModels: async () => undefined,
    retrySelectedModel: async () => {
      // A failed catalog load may be an expired grant: fetch a fresh one.
      if (catalogItemId) await catalogPreview.refetch();
      await preparedModel.retry();
    },
  };
}

/** Refresh a preview's file grant 30 s before it expires (at least every 5 s). */
function previewGrantRefreshMs(
  preview: { expires_at: string } | undefined,
): number {
  if (!preview) return 0;
  const expires = Date.parse(preview.expires_at);
  if (!Number.isFinite(expires)) return 60_000;
  return Math.max(5_000, expires - Date.now() - 30_000);
}
