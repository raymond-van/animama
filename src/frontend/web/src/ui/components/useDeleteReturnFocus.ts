import { useCallback, useEffect, useRef } from "react";

/** Where focus goes when a delete dialog closes. */
export type DeleteFocusTargets = {
  /** Nothing was deleted (Cancel, Escape, or closed after a failure). */
  kept: () => HTMLElement | null;
  /** The item is gone: a surviving element near where it was. */
  deleted: () => HTMLElement | null;
};

/**
 * Remember where a delete dialog returns focus (issue #950). The dialog's
 * target is cleared as it closes, and the dialog may unmount with its page
 * after a delete, so the targets are kept here when a delete is requested and
 * chosen by whether `markDeleted` ran.
 */
export function useDeleteReturnFocus(focus: DeleteFocusTargets | undefined) {
  const focusRef = useRef<DeleteFocusTargets | undefined>(undefined);
  const deletedRef = useRef(false);
  useEffect(() => {
    if (!focus) return;
    focusRef.current = focus;
    deletedRef.current = false;
  }, [focus]);

  /** The delete succeeded: focus goes to the surviving element. */
  const markDeleted = useCallback(() => {
    deletedRef.current = true;
  }, []);
  /** For `ConfirmDeleteDialog.returnFocus`. */
  const returnFocus = useCallback(() => {
    const targets = focusRef.current;
    return (deletedRef.current ? targets?.deleted() : targets?.kept()) ?? null;
  }, []);

  return { markDeleted, returnFocus };
}
