import { useProductApiClient } from "@animama/product-ui";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getChatgptPlanV1ChatgptPlanGet } from "@animama/runtime-contracts/sdk";
import type { PyChatGptPlanStatus } from "@animama/runtime-contracts/api-types";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import { queryKeys } from "@/query/keys";

/** How often the status is read while the browser sign-in is pending. */
export const CHATGPT_PLAN_PENDING_POLL_MS = 1_000;

export { CHATGPT_MANAGE_USAGE_URL } from "@animama/product-ui/chat";

/** Whether this runtime offers signing in with a ChatGPT plan (the local composition). */
export function useChatGPTPlanAvailable(): boolean {
  return useRuntimeCapabilities().data?.chatgpt_plan === true;
}

/**
 * The installation's ChatGPT plan session: whether sign-in is offered here,
 * the signed-in account and the person's choices. Never a token. While a
 * sign-in waits for the browser the status is read every second, so the card
 * moves on as soon as OpenAI sends the browser back. The server reports the
 * sign-in as pending until the return has stored the account's models, so
 * when the plan becomes usable the model catalog is read again and finds them.
 */
export function useChatGPTPlan() {
  const apiClient = useProductApiClient();
  const ownerId = useRuntimeCacheKey();
  const available = useChatGPTPlanAvailable();
  const queryClient = useQueryClient();
  const userKey = ownerId ?? "__anon__";
  const status = useQuery<PyChatGptPlanStatus>({
    queryKey: queryKeys.modelConfiguration.chatgptPlan(userKey),
    enabled: available && Boolean(ownerId),
    refetchInterval: (query) =>
      query.state.data?.sign_in_pending ? CHATGPT_PLAN_PENDING_POLL_MS : false,
    queryFn: async () => {
      const { data } = await getChatgptPlanV1ChatgptPlanGet({
        client: apiClient,
        responseValidator: undefined,
        throwOnError: true,
      });
      return data;
    },
  });
  // A finished sign-in has stored its models; until then it still reads as pending.
  const usable = status.data
    ? status.data.state === "signed_in" &&
      status.data.plan_use_granted &&
      !status.data.sign_in_pending
    : undefined;
  const wasUsable = useRef(usable);
  useEffect(() => {
    if (wasUsable.current === false && usable === true) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.modelConfiguration.all(userKey),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.modelProviders.all(userKey),
      });
    }
    if (usable !== undefined) wasUsable.current = usable;
  }, [usable, queryClient, userKey]);
  return status;
}
