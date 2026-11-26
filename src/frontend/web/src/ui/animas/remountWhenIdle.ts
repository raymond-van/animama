import { useAvatarRuntimeStore } from "@/stores/avatar-runtime-store";

type ChatActivity = {
  animaId: string | null;
  activeRunId: string | null;
  activeSpeechRunId: string | null;
};

/** True while the mounted chat is replying or still speaking its reply. */
function chatBusy(state: ChatActivity): boolean {
  return Boolean(state.activeRunId || state.activeSpeechRunId);
}

/** The waiting remount for each Anima; a newer change replaces it. */
const pending = new Map<string, () => void>();

/**
 * Remount the chat showing `animaId` now, or once its current reply and its
 * speech end. A remount disposes the mounted catalog and Pocket voice that an
 * in-flight reply still reads, so an Avatar change made mid-turn waits. A
 * waiting remount is dropped if the chat moves to another Anima first, since
 * `remount` belongs to the Anima it was captured for. Returns a cancel
 * function.
 */
export function remountWhenIdle(
  animaId: string,
  remount: () => unknown,
): () => void {
  pending.get(animaId)?.();
  if (!chatBusy(useAvatarRuntimeStore.getState())) {
    void remount();
    return () => undefined;
  }
  const cancel = () => {
    unsubscribe();
    if (pending.get(animaId) === cancel) pending.delete(animaId);
  };
  const unsubscribe = useAvatarRuntimeStore.subscribe((state) => {
    if (state.animaId !== animaId) {
      cancel();
      return;
    }
    if (chatBusy(state)) return;
    cancel();
    void remount();
  });
  pending.set(animaId, cancel);
  return cancel;
}
