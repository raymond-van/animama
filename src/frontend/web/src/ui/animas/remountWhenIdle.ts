import { useAvatarRuntimeStore } from "@/stores/avatar-runtime-store";

type ChatActivity = {
  activeRunId: string | null;
  activeSpeechRunId: string | null;
  activeVoiceTurn: unknown;
};

/** True while the mounted chat is replying, speaking or taking a voice turn. */
function chatBusy(state: ChatActivity): boolean {
  return Boolean(
    state.activeRunId || state.activeSpeechRunId || state.activeVoiceTurn,
  );
}

/**
 * Remount the mounted chat's runtime now, or once its current turn ends.
 * A remount disposes the mounted catalog and Pocket voice that an in-flight
 * reply still reads, so an Avatar change made mid-turn waits for the reply,
 * its speech and any voice turn to finish. Returns a cancel function.
 */
export function remountWhenIdle(remount: () => unknown): () => void {
  if (!chatBusy(useAvatarRuntimeStore.getState())) {
    void remount();
    return () => undefined;
  }
  const unsubscribe = useAvatarRuntimeStore.subscribe((state) => {
    if (chatBusy(state)) return;
    unsubscribe();
    void remount();
  });
  return unsubscribe;
}
