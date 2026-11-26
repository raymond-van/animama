import { useProductApiClient } from "@animama/product-ui";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  beginChatgptPlanSignInV1ChatgptPlanSignInPost,
  cancelChatgptPlanSignInV1ChatgptPlanSignInDelete,
  refreshChatgptPlanModelsV1ChatgptPlanModelsRefreshPost,
  signOutOfChatgptPlanV1ChatgptPlanSignOutPost,
  updateChatgptPlanPreferencesV1ChatgptPlanPreferencesPut,
} from "@animama/runtime-contracts/sdk";
import type {
  PyChatGptPlanPreferences,
  PyChatGptPlanSignOut,
  PyChatGptPlanStatus,
} from "@animama/runtime-contracts/api-types";
import type { UiLocale } from "@animama/runtime-contracts/locale";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { queryKeys } from "@/query/keys";

function useKeys() {
  const userKey = useRuntimeCacheKey() ?? "__anon__";
  return {
    status: queryKeys.modelConfiguration.chatgptPlan(userKey),
    // Signing in or out changes which plan models the catalog lists.
    catalog: queryKeys.modelConfiguration.all(userKey),
    providers: queryKeys.modelProviders.all(userKey),
  };
}

/**
 * Start a sign-in and return OpenAI's sign-in URL, which the caller opens in
 * the browser. The URL carries the attempt's state, so it is kept only in the
 * caller's memory and never logged.
 */
export function useBeginChatGPTPlanSignIn() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const keys = useKeys();
  return useMutation<
    string,
    unknown,
    { enablePlanUse?: boolean; uiLocale?: UiLocale | null }
  >({
    mutationFn: async ({ enablePlanUse = false, uiLocale = null }) => {
      const { data } = await beginChatgptPlanSignInV1ChatgptPlanSignInPost({
        client: apiClient,
        body: { enable_plan_use: enablePlanUse, ui_locale: uiLocale },
        responseValidator: undefined,
        throwOnError: true,
      });
      return data.authorize_url;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.status }),
    // The result is the sign-in URL: keep no copy in the mutation cache.
    gcTime: 0,
  });
}

/** Stop waiting for the browser; a late return then fails harmlessly. */
export function useCancelChatGPTPlanSignIn() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const keys = useKeys();
  return useMutation<void, unknown, void>({
    mutationFn: async () => {
      await cancelChatgptPlanSignInV1ChatgptPlanSignInDelete({
        client: apiClient,
        throwOnError: true,
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.status }),
  });
}

/** End the session at OpenAI and remove the tokens; the result says whether OpenAI confirmed it. */
export function useSignOutOfChatGPTPlan() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const keys = useKeys();
  return useMutation<PyChatGptPlanSignOut, unknown, void>({
    mutationFn: async () => {
      const { data } = await signOutOfChatgptPlanV1ChatgptPlanSignOutPost({
        client: apiClient,
        responseValidator: undefined,
        throwOnError: true,
      });
      return data;
    },
    // Awaited, so the card shows the signed-out state before the result's notice.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.catalog }),
        queryClient.invalidateQueries({ queryKey: keys.providers }),
      ]),
  });
}

/** List the account's models again; the catalog then shows what OpenAI lists now. */
export function useRefreshChatGPTPlanModels() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const keys = useKeys();
  return useMutation<void, unknown, void>({
    mutationFn: async () => {
      await refreshChatgptPlanModelsV1ChatgptPlanModelsRefreshPost({
        client: apiClient,
        responseValidator: undefined,
        throwOnError: true,
      });
    },
    // A refused refresh may mean OpenAI ended the session, which the status shows.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.status }),
        queryClient.invalidateQueries({ queryKey: keys.catalog }),
        queryClient.invalidateQueries({ queryKey: keys.providers }),
      ]),
  });
}

/** Record the one-time confirmation and whether automatic memory updates may use the plan. */
export function useUpdateChatGPTPlanPreferences() {
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const keys = useKeys();
  return useMutation<PyChatGptPlanStatus, unknown, PyChatGptPlanPreferences>({
    mutationFn: async (preferences) => {
      const { data } =
        await updateChatgptPlanPreferencesV1ChatgptPlanPreferencesPut({
          client: apiClient,
          body: preferences,
          responseValidator: undefined,
          throwOnError: true,
        });
      return data;
    },
    onSuccess: (status) => queryClient.setQueryData(keys.status, status),
  });
}
