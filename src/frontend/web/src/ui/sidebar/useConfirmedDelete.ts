import { useCallback, useState } from "react";

import { createLogger } from "@/lib/logger";
import { DeleteRequestError } from "@/query/chatAndAnimaDeletion";
import {
  holdChatSends,
  stopStreamingReplies,
  type ChatDeleteTarget,
} from "@/stores/chat-delete-coordination-store";
import {
  useDeleteReturnFocus,
  type DeleteFocusTargets,
} from "@/ui/components/useDeleteReturnFocus";

export type { DeleteFocusTargets };

const logger = createLogger("Delete");

/** The steps of one confirmed chat or Anima delete. */
export type ConfirmedDeleteSteps = {
  target: ChatDeleteTarget;
  /** The delete request; rejects when the server refuses it. */
  request: () => Promise<void>;
  /** Drop it from the sidebar and leave its page, if open. */
  leave: () => Promise<void>;
  /** Refresh what the delete changed and say it is done. */
  settle: () => void;
};

/**
 * Run a confirmed delete (issue #950). It stops the target's streaming reply
 * in this window and holds new sends to it until the page has left it, so no
 * turn can race the delete (the server also stops and awaits turns it already
 * admitted). A refusal is kept for the dialog, which stays open to retry.
 */
export function useConfirmedDelete(focus: DeleteFocusTargets | undefined) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { markDeleted, returnFocus } = useDeleteReturnFocus(focus);

  const run = useCallback(
    async ({ target, request, leave, settle }: ConfirmedDeleteSteps) => {
      setPending(true);
      setError(null);
      const release = holdChatSends(target);
      try {
        stopStreamingReplies(target);
        await request();
        markDeleted();
      } catch (failure) {
        logger.warn(
          "Delete",
          failure instanceof DeleteRequestError
            ? `Delete refused (${failure.status}, ${failure.code ?? "no code"})`
            : "Delete request failed",
        );
        release();
        setPending(false);
        setError(failure);
        return false;
      }
      try {
        await leave();
      } catch {
        // The delete succeeded; a failed navigation must not hide that.
        logger.warn("Delete", "Leaving the deleted item's page failed");
      } finally {
        release();
        setPending(false);
        settle();
      }
      return true;
    },
    [markDeleted],
  );
  const reset = useCallback(() => setError(null), []);

  return { pending, error, run, reset, returnFocus };
}
