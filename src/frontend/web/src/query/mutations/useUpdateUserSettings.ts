"use client";

import { useProductApiClient } from "@animama/product-ui";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  getUserSettingsV1UsersMeSettingsGet,
  patchUserSettingsV1UsersMeSettingsPatch,
} from "@animama/runtime-contracts/sdk";
import type {
  PyUserSettings,
  PyUserSettingsUpdate,
} from "@/lib/content/catalogTypes";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import {
  mergePreferences,
  type SettingsPreferences,
} from "@/lib/settings/preferences";
import { queryKeys } from "@/query/keys";
import { useOptionalRuntimeController } from "@/app/runtime/RuntimeAdmissionProvider";
import { isUiLocale } from "@animama/runtime-contracts/locale";
import type { SessionRequestScope } from "@/app/runtime/session-requests";

export type UpdateUserSettingsArgs = {
  body: PyUserSettingsUpdate;
};

export function useUpdateUserSettings() {
  const apiClient = useProductApiClient();

  const queryClient = useQueryClient();
  const userId = useRuntimeCacheKey();
  const userKey = userId ?? "__anon__";
  const controller = useOptionalRuntimeController();
  const currentSession = (scope?: SessionRequestScope | null) =>
    !controller ||
    (controller.getSnapshot().scope === scope && scope?.key === userId);

  return useMutation<
    PyUserSettings,
    Error,
    UpdateUserSettingsArgs,
    { scope: SessionRequestScope | null | undefined }
  >({
    onMutate: () => ({ scope: controller?.getSnapshot().scope }),
    mutationFn: async (args) => {
      const write = async () => {
        const result = await patchUserSettingsV1UsersMeSettingsPatch({
          client: apiClient,
          body: args.body,
          responseValidator: undefined,
          throwOnError: false,
        });
        if (result.error)
          throw { ...result.error, status: result.response.status };
        if (!result.data) throw new Error("Settings response was empty");
        return result.data;
      };
      // Omitted locale is unrelated settings work. Never infer intent from the
      // server's full materialized settings response.
      return controller &&
        userId &&
        "locale" in args.body &&
        (args.body.locale === null || isUiLocale(args.body.locale))
        ? controller.saveLocale(userId, args.body.locale, write)
        : write();
    },
    onSuccess: (settings, _args, context) => {
      if (!userId || !currentSession(context?.scope)) return;
      queryClient.setQueryData(queryKeys.settings.user(userKey), settings);
    },
    onSettled: (_data, _error, _args, context) => {
      if (!userId || !currentSession(context?.scope)) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.all(userKey),
      });
    },
  });
}

/**
 * Merge a preferences patch into the owner's saved preferences and save them.
 * `PATCH /v1/users/me/settings` replaces the whole preferences object, so this
 * reads the current settings fresh first. Both `SettingsProvider` and setup
 * use it to preserve preferences outside the patch; a failed read makes no write.
 */
export function useMergeUserPreferences() {
  const apiClient = useProductApiClient();

  const queryClient = useQueryClient();
  const userKey = useRuntimeCacheKey() ?? "__anon__";
  const update = useUpdateUserSettings();
  return useMutation<PyUserSettings, Error, SettingsPreferences>({
    mutationFn: async (patch) => {
      const current = await queryClient.fetchQuery({
        queryKey: queryKeys.settings.user(userKey),
        staleTime: 0,
        queryFn: async () =>
          (
            await getUserSettingsV1UsersMeSettingsGet({
              client: apiClient,
              responseValidator: undefined,
              throwOnError: true,
            })
          ).data,
      });
      const base = (current.preferences ?? {}) as SettingsPreferences;
      return update.mutateAsync({
        body: { preferences: mergePreferences(base, patch) },
      });
    },
  });
}
