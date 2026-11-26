import { useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import {
  isReplyStillStopping,
  pruneDeletedChat,
  settleDeletedChat,
} from "@/query/chatAndAnimaDeletion";
import { useDeleteChat } from "@/query/mutations/useDeleteChat";
import { ConfirmDeleteDialog } from "@/ui/components/confirm-delete-dialog";
import {
  useConfirmedDelete,
  type DeleteFocusTargets,
} from "@/ui/sidebar/useConfirmedDelete";

/** The chat a delete confirmation names, and where focus returns after. */
export type ChatToDelete = {
  id: string;
  animaId: string;
  title: string;
  focus?: DeleteFocusTargets;
};

/**
 * Confirm and run a chat delete (R5–R8). It names the chat and what is kept;
 * an open chat is replaced by a new chat with the same Anima.
 */
export function ChatDeleteDialog({
  chat,
  onClose,
}: {
  /** The chat to confirm; null closes the dialog. */
  chat: ChatToDelete | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("sidebar");
  const queryClient = useQueryClient();
  const userKey = useRuntimeCacheKey() ?? "__anon__";
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const deleteChat = useDeleteChat();
  const { pending, error, run, reset, returnFocus } = useConfirmedDelete(
    chat?.focus,
  );
  const routeChatId = typeof params?.chatId === "string" ? params.chatId : null;

  const close = () => {
    reset();
    onClose();
  };
  const confirm = (target: ChatToDelete) =>
    void run({
      target: { chatId: target.id },
      request: () => deleteChat.mutateAsync({ chatId: target.id }),
      leave: async () => {
        pruneDeletedChat(queryClient, userKey, target.id);
        // Replace the deleted chat's history entry so Back cannot reopen it.
        if (routeChatId === target.id)
          await navigate({
            to: "/$animaId",
            params: { animaId: target.animaId },
            replace: true,
          });
      },
      settle: () => {
        close();
        void settleDeletedChat(queryClient, userKey, target.id);
        toast.success(t("delete.chat.deleted"));
      },
    });

  return (
    <ConfirmDeleteDialog
      open={chat !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t("delete.chat.title")}
      description={t("delete.chat.description", { title: chat?.title ?? "" })}
      pending={pending}
      returnFocus={returnFocus}
      error={
        error
          ? isReplyStillStopping(error)
            ? t("delete.replyStopping")
            : t("delete.chat.failed")
          : null
      }
      onConfirm={() => {
        if (chat && !pending) confirm(chat);
      }}
    />
  );
}
