import { useEffect, useRef } from "react";

/**
 * Choose a provider's model when it becomes ready during setup: saving a
 * built-in key, or signing in with a ChatGPT plan. The model set up last
 * wins. A provider that was already ready chooses nothing, so only explicit
 * actions in this setup pick the default.
 *
 * Readiness and the model can arrive in either order (the connection list and
 * the model catalog are separate queries, and a plan's models exist only once
 * it is ready), so a provider that became ready chooses its model as soon as
 * one is known.
 */
export function useChooseWhenReady(
  loaded: boolean,
  { ready, modelId }: { ready: boolean; modelId: string | null },
  onChatModelChange: (id: string | null) => void,
) {
  const wasReady = useRef<boolean | null>(null);
  const awaitingModel = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    if (wasReady.current === false && ready) awaitingModel.current = true;
    if (!ready) awaitingModel.current = false;
    if (awaitingModel.current && modelId) {
      awaitingModel.current = false;
      onChatModelChange(modelId);
    }
    wasReady.current = ready;
  }, [loaded, modelId, onChatModelChange, ready]);
}
