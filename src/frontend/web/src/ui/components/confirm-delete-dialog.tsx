import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";

export type ConfirmDeleteDialogProps = {
  open: boolean;
  /** Called with false on Cancel, Escape, the close button or an outside click. */
  onOpenChange: (open: boolean) => void;
  /** A question naming what is deleted, such as "Delete chat?". */
  title: string;
  /** What is deleted and what is kept. */
  description: ReactNode;
  /** Optional detail between the description and the buttons. */
  children?: ReactNode;
  /** Shown in the destructive button; defaults to "Delete". */
  confirmLabel?: string;
  onConfirm: () => void;
  /**
   * The delete is running: both buttons are disabled and the dialog cannot be
   * dismissed, so nothing else can happen until it settles.
   */
  pending: boolean;
  /** Why the last attempt failed; the dialog stays open to retry or cancel. */
  error?: string | null;
  /**
   * Where focus goes once the dialog has closed, read at that moment. A
   * controlled dialog has no trigger for Radix to refocus, so callers name one:
   * the menu button that opened it, or a surviving element after a delete.
   */
  returnFocus?: () => HTMLElement | null;
};

/**
 * The plain confirmation every delete uses (issue #950): a title, what is
 * deleted and kept, Cancel and a destructive Delete with a spinner while it
 * runs. The caller owns the request and keeps the dialog open on failure.
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  onConfirm,
  pending,
  error = null,
  returnFocus,
}: ConfirmDeleteDialogProps) {
  const { t } = useTranslation("components");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A running delete cannot be dismissed; its outcome closes the dialog
        // or shows why it failed.
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        // Beside, not under, the expanded desktop sidebar (z-120).
        avoidSidebar
        // The sidebar offset sets an inline max width, so the width is set here.
        className="sm:w-96"
        aria-busy={pending}
        onCloseAutoFocus={(event) => {
          if (!returnFocus) return;
          event.preventDefault();
          const target = returnFocus();
          if (target?.isConnected) target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild={typeof description !== "string"}>
            {typeof description === "string" ? (
              description
            ) : (
              <div>{description}</div>
            )}
          </DialogDescription>
        </DialogHeader>
        {children}
        {error ? (
          <p
            role="alert"
            className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
          >
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {t("confirmDelete.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {confirmLabel ?? t("confirmDelete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
