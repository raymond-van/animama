import { useCallback, useMemo } from "react";
import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";

import { supportedReasoningEfforts } from "@/lib/chat/model-catalog";
import {
  generationModelPatch,
  generationReasoningEffortPatch,
  readGenerationModelId,
  readGenerationReasoningEffort,
} from "@/lib/settings/preferences";
import { useModelProviders } from "@/query/hooks/useModelProviders";
import { useUserSettings } from "@/query/hooks/useUserSettings";
import { useMergeUserPreferences } from "@/query/mutations/useUpdateUserSettings";
import {
  chosenGenerationModel,
  eligibleGenerationModels,
  listedGenerationModels,
  type ListedGenerationModel,
} from "./generateModels";

export type GenerationModelChoice = {
  /** The models the assistant may use, the ChatGPT plan's first. */
  models: PyModelProviderCatalogItem[];
  /**
   * Every model the pickers show: `models`, then the visible chat models
   * that cannot be chosen, each with its reason.
   */
  listed: ListedGenerationModel<PyModelProviderCatalogItem>[];
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
  /** A model choice is being saved; saving an effort level does not count. */
  isChoosing: boolean;
  /** The chosen model's reasoning effort levels, in order; empty when it offers none. */
  efforts: string[];
  /**
   * The level each run names: the one saved for the chosen model while that
   * model still lists it, else `null`, which leaves the model's own default.
   */
  effort: string | null;
  /** Save a level for the chosen model, or `null` to return to its default. */
  chooseEffort: (effort: string | null) => Promise<void>;
};

/**
 * The reasoning effort a run on `model` names: the level saved for that model
 * while the model lists it, else `null` (the model's own default). Unlike a
 * chat turn, the assistant preselects no level.
 */
export function generationReasoningEffort(
  model: PyModelProviderCatalogItem | null,
  preferences: unknown,
): string | null {
  const saved = readGenerationReasoningEffort(preferences, model?.id);
  return saved && supportedReasoningEfforts(model).includes(saved)
    ? saved
    : null;
}

/**
 * The assistant's model choice: the eligible catalog models and the one saved
 * in the owner's preferences (`generation.model_provider_id`), which each run
 * names. It is a choice of the assistant's own, not a model role. Beside it,
 * `generation.reasoning_efforts` keeps the reasoning effort chosen for each
 * model, so every model keeps its own level.
 */
export function useGenerationModel(): GenerationModelChoice {
  const catalog = useModelProviders();
  const settings = useUserSettings();
  const merge = useMergeUserPreferences();
  // Effort saves use their own mutation, as in the chat's picker, so the
  // model control stays open and enabled while one is saving.
  const { mutateAsync: saveEffort } = useMergeUserPreferences();
  const models = useMemo(
    () => eligibleGenerationModels(catalog.data ?? []),
    [catalog.data],
  );
  const listed = useMemo(
    () => listedGenerationModels(catalog.data ?? []),
    [catalog.data],
  );
  const preferences = settings.data?.preferences;
  const savedId = readGenerationModelId(preferences);
  const model = useMemo(
    () => chosenGenerationModel(catalog.data ?? [], savedId),
    [catalog.data, savedId],
  );
  const efforts = useMemo(() => supportedReasoningEfforts(model), [model]);
  const effort = generationReasoningEffort(model, preferences);
  const { mutateAsync } = merge;
  const choose = useCallback(
    async (modelProviderId: string) => {
      await mutateAsync(generationModelPatch(modelProviderId));
    },
    [mutateAsync],
  );
  const modelId = model?.id ?? null;
  const chooseEffort = useCallback(
    async (level: string | null) => {
      if (!modelId) return;
      await saveEffort(generationReasoningEffortPatch(modelId, level));
    },
    [modelId, saveEffort],
  );
  const { isError: catalogFailed, refetch: readCatalog } = catalog;
  const { isError: settingsFailed, refetch: readSettings } = settings;
  const retry = useCallback(() => {
    if (catalogFailed) void readCatalog();
    if (settingsFailed) void readSettings();
  }, [catalogFailed, readCatalog, readSettings, settingsFailed]);
  return {
    models,
    listed,
    model,
    isPending: catalog.isPending || settings.isPending,
    isError: catalogFailed || settingsFailed,
    retry,
    choose,
    isChoosing: merge.isPending,
    efforts,
    effort,
    chooseEffort,
  };
}
