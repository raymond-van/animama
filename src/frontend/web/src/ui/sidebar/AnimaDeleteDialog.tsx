import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { cn } from "@/lib/utils";
import {
  cachedChatIds,
  isReplyStillStopping,
  pruneDeletedAnima,
  settleDeletedAnima,
} from "@/query/chatAndAnimaDeletion";
import { useAnimas } from "@/query/hooks/useAnimas";
import { useChats } from "@/query/hooks/useChats";
import { useDeleteAnima } from "@/query/mutations/useDeleteAnima";
import { ConfirmDeleteDialog } from "@/ui/components/confirm-delete-dialog";
import { nextAnimaIdAfterDelete } from "@/ui/sidebar/sidebarOrder";
import {
  useConfirmedDelete,
  type DeleteFocusTargets,
} from "@/ui/sidebar/useConfirmedDelete";
import { useSidebarAnimaOrder } from "@/ui/sidebar/useSidebarAnimaOrder";

/** The Anima a delete confirmation names, and where focus returns after. */
export type AnimaToDelete = {
  id: string;
  name: string;
  focus?: DeleteFocusTargets;
};

/**
 * Confirm and run an Anima delete from its sidebar row or its page (R9–R12).
 * It names the Anima, counts its chats and says what is kept. When the Anima
 * is open, the next Anima in sidebar order opens (on its page when an Anima
 * page was open); with none left, the roster's empty state.
 */
export function AnimaDeleteDialog({
  anima,
  onClose,
}: {
  /** The Anima to confirm; null closes the dialog. */
  anima: AnimaToDelete | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("sidebar");
  const queryClient = useQueryClient();
  const userKey = useRuntimeCacheKey() ?? "__anon__";
  const params = useParams({ strict: false });
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const { data: animas = [] } = useAnimas();
  const orderedAnimas = useSidebarAnimaOrder(animas);
  const chats = useChats({
    animaId: anima?.id ?? null,
    enabled: anima !== null,
  });
  const deleteAnima = useDeleteAnima();
  const { pending, error, run, reset, returnFocus } = useConfirmedDelete(
    anima?.focus,
  );
  const routeAnimaId =
    typeof params?.animaId === "string" ? params.animaId : null;
  const onAnimaPage = pathname.startsWith("/animas/");
  // Counted only once the chat list has loaded, so the count is never a guess.
  const chatCount = chats.isSuccess ? chats.data.length : null;

  const close = () => {
    reset();
    onClose();
  };
  const leaveDeletedAnima = async (animaId: string) => {
    // Read the order before the deleted Anima leaves the cached roster.
    const nextAnimaId = nextAnimaIdAfterDelete(
      orderedAnimas.map((candidate) => candidate.id),
      animaId,
    );
    pruneDeletedAnima(queryClient, userKey, animaId);
    if (routeAnimaId !== animaId) return;
    // The roster routes show the empty state (or creation, where the runtime
    // offers it) from the pruned roster when no Anima remains. Each replaces
    // the deleted Anima's history entry so Back cannot reopen it.
    if (onAnimaPage)
      await navigate(
        nextAnimaId
          ? {
              to: "/animas/$animaId",
              params: { animaId: nextAnimaId },
              search: { tab: "overview" },
              replace: true,
            }
          : { to: "/animas", replace: true },
      );
    else
      await navigate(
        nextAnimaId
          ? {
              to: "/$animaId",
              params: { animaId: nextAnimaId },
              replace: true,
            }
          : { to: "/", replace: true },
      );
  };
  const confirm = (target: AnimaToDelete) => {
    const chatIds = cachedChatIds(
      queryClient,
      userKey,
      (chat) => chat.anima_id === target.id,
    );
    void run({
      target: { animaId: target.id },
      request: () => deleteAnima.mutateAsync({ animaId: target.id }),
      leave: () => leaveDeletedAnima(target.id),
      settle: () => {
        close();
        void settleDeletedAnima(queryClient, userKey, target.id, chatIds);
        toast.success(t("delete.anima.deleted", { name: target.name }));
      },
    });
  };

  const name = anima?.name ?? "";
  return (
    <ConfirmDeleteDialog
      open={anima !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t("delete.anima.title", { name })}
      description={
        <>
          {chatCount !== null ? (
            <span className="block">
              {t("delete.anima.chatCount", { name, count: chatCount })}
            </span>
          ) : null}
          <span className={cn("block", chatCount !== null && "mt-2")}>
            {t("delete.anima.description")}
          </span>
        </>
      }
      pending={pending}
      returnFocus={returnFocus}
      error={
        error
          ? isReplyStillStopping(error)
            ? t("delete.replyStopping")
            : t("delete.anima.failed", { name })
          : null
      }
      onConfirm={() => {
        if (anima && !pending) confirm(anima);
      }}
    />
  );
}
