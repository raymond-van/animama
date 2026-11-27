import { useCallback, useMemo } from "react";
import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";

import {
  generationModelPatch,
  readGenerationModelId,
} from "@/lib/settings/preferences";
import { useModelProviders } from "@/query/hooks/useModelProviders";
import { useUserSettings } from "@/query/hooks/useUserSettings";
import { useMergeUserPreferences } from "@/query/mutations/useUpdateUserSettings";
import {
  chosenGenerationModel,
  eligibleGenerationModels,
} from "./generateModels";

export type GenerationModelChoice = {
  /** The models the assistant may use, the ChatGPT plan's first. */
  models: PyModelProviderCatalogItem[];
  /**
   * The assistant's model: the owner's saved choice while it can be used.
   * `null` once the catalog and settings are read means setup.
   */
  model: PyModelProviderCatalogItem | null;
  /** The catalog or the saved choice is still being read. */
  isPending: boolean;
  /** The catalog or the settings could not be read. */
  isError: boolean;
  /** Read again whichever of the two could not be read. */
  retry: () => void;
  /** Save `modelProviderId` as the assistant's model. */
  choose: (modelProviderId: string) => Promise<void>;
  isChoosing: boolean;
};

/**
 * The assistant's model choice: the eligible catalog models and the one saved
 * in the owner's preferences (`generation.model_provider_id`), which each run
 * names. It is a choice of the assistant's own, not a model role.
 */
export function useGenerationModel(): GenerationModelChoice {
  const catalog = useModelProviders();
  const settings = useUserSettings();
  const merge = useMergeUserPreferences();
  const models = useMemo(
    () => eligibleGenerationModels(catalog.data ?? []),
    [catalog.data],
  );
  const savedId = readGenerationModelId(settings.data?.preferences);
  const model = useMemo(
    () => chosenGenerationModel(catalog.data ?? [], savedId),
    [catalog.data, savedId],
  );
  const { mutateAsync } = merge;
  const choose = useCallback(
    async (modelProviderId: string) => {
      await mutateAsync(generationModelPatch(modelProviderId));
    },
    [mutateAsync],
  );
  const { isError: catalogFailed, refetch: readCatalog } = catalog;
  const { isError: settingsFailed, refetch: readSettings } = settings;
  const retry = useCallback(() => {
    if (catalogFailed) void readCatalog();
    if (settingsFailed) void readSettings();
  }, [catalogFailed, readCatalog, readSettings, settingsFailed]);
  return {
    models,
    model,
    isPending: catalog.isPending || settings.isPending,
    isError: catalogFailed || settingsFailed,
    retry,
    choose,
    isChoosing: merge.isPending,
  };
}
