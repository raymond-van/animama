import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { ContentKind } from "@/lib/content/catalogTypes";
import {
  ContentDeleteError,
  inUseRefusalUses,
  isContentChangedRefusal,
  type PyContentUsage,
} from "@/lib/content/contentDeletion";
import { createLogger } from "@/lib/logger";
import { useContentDeletePreflight } from "@/query/hooks/useContentDeletePreflight";
import { useDeleteContentItem } from "@/query/mutations/useDeleteContentItem";
import { ConfirmDeleteDialog } from "@/ui/components/confirm-delete-dialog";
import {
  useDeleteReturnFocus,
  type DeleteFocusTargets,
} from "@/ui/components/useDeleteReturnFocus";
import { sharingKindLabel } from "@/ui/library/sharingPresentation";

const logger = createLogger("ContentDelete");

/** The Local item a delete confirmation names, and where focus returns after. */
export type ContentToDelete = {
  itemId: string;
  kind: ContentKind;
  name: string;
  /**
   * The revision the item was shown at, which the delete is fenced on. Null
   * when the view has none (Library Avatar rows): the dialog reads it.
   */
  revision: string | null;
  focus?: DeleteFocusTargets;
};

/**
 * How each use can be freed in the app, in the order the hints are shown.
 * Unknown uses get no hint.
 */
const FREE_HINTS = [
  "avatar",
  "appearance",
  "voice",
  "behavior",
  "music",
  "content",
] as const;
type FreeHint = (typeof FREE_HINTS)[number];

const USE_HINTS: Partial<Record<PyContentUsage["kind"], FreeHint>> = {
  anima_avatar: "avatar",
  anima_appearance: "appearance",
  anima_voice: "voice",
  anima_gesture: "behavior",
  anima_idle: "behavior",
  anima_reaction: "behavior",
  anima_music: "music",
  content: "content",
};

/** Where to free one kind of use, or why the app cannot. */
function freeHint(t: TFunction<"library">, hint: FreeHint): string {
  switch (hint) {
    case "avatar":
      // Change Avatar in the Anima's Settings tab frees it.
      return t("delete.inUse.freeAvatar");
    case "appearance":
      return t("delete.inUse.freeAppearance");
    case "voice":
      return t("delete.inUse.freeVoice");
    case "behavior":
      return t("delete.inUse.freeBehavior");
    case "music":
      // No screen sets an Anima's music.
      return t("delete.inUse.freeMusic");
    case "content":
      return t("delete.inUse.freeContent");
  }
}

/** One line naming what uses the item (R15). */
function usageLine(t: TFunction<"library">, use: PyContentUsage): string {
  const name = use.name;
  switch (use.kind) {
    case "anima_avatar":
      return t("delete.inUse.animaAvatar", { name });
    case "anima_appearance":
      return t("delete.inUse.animaAppearance", { name });
    case "anima_voice":
      return t("delete.inUse.animaVoice", { name });
    case "anima_gesture":
      return t("delete.inUse.animaGesture", { name });
    case "anima_idle":
      return t("delete.inUse.animaIdle", { name });
    case "anima_reaction":
      return t("delete.inUse.animaReaction", { name });
    case "anima_music":
      return t("delete.inUse.animaMusic", { name });
    case "content":
      return t("delete.inUse.content", { name });
    default:
      // A use this client does not know yet still names its owner.
      return t("delete.inUse.other", { name });
  }
}

/** What uses the item, by name, and how to free it. */
function UsageList({ uses }: { uses: PyContentUsage[] }) {
  const { t } = useTranslation("library");
  const hints = FREE_HINTS.filter((hint) =>
    uses.some((use) => USE_HINTS[use.kind] === hint),
  );
  return (
    <div className="border-warning/30 bg-warning/10 space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">{t("delete.inUse.heading")}</p>
      <ul className="list-disc space-y-1 pl-5">
        {uses.map((use) => (
          <li key={`${use.kind}:${use.id}`}>{usageLine(t, use)}</li>
        ))}
      </ul>
      {/* The server lists at most ten uses. */}
      {uses.length >= 10 ? (
        <p className="text-muted-foreground">{t("delete.inUse.more")}</p>
      ) : null}
      {hints.map((hint) => (
        <p key={hint}>{freeHint(t, hint)}</p>
      ))}
    </div>
  );
}

/**
 * Confirm and run the delete of one Local item of any kind (issue #950,
 * R13–R17), on the shared delete confirmation. It names the item and its
 * kind, says its Local files are removed for good, and first reads what uses
 * it: an item in use names those uses and cannot be confirmed. A refusal
 * keeps the dialog open; a changed item retries at its current revision.
 */
export function ContentDeleteDialog({
  item,
  onClose,
  onDeleted,
}: {
  /** The item to confirm; null closes the dialog. */
  item: ContentToDelete | null;
  onClose: () => void;
  /** After a successful delete, before the dialog closes. */
  onDeleted?: (item: ContentToDelete) => void;
}) {
  const { t } = useTranslation("library");
  // The last item stays shown while the dialog closes.
  const lastItem = useRef<ContentToDelete | null>(null);
  useEffect(() => {
    if (item) lastItem.current = item;
  }, [item]);
  const shown = item ?? lastItem.current;
  const remove = useDeleteContentItem();
  // Read while open; a closing dialog keeps what it showed.
  const preflight = useContentDeletePreflight(shown, item !== null);
  const [error, setError] = useState<unknown>(null);
  // A changed item is retried at the revision the refusal reported.
  const [retryRevision, setRetryRevision] = useState<string | null>(null);
  const { markDeleted, returnFocus } = useDeleteReturnFocus(item?.focus);
  const itemId = item?.itemId ?? null;
  useEffect(() => {
    setError(null);
    setRetryRevision(null);
  }, [itemId]);

  const checked = preflight.data;
  // Each opening reads afresh, so an earlier result is not shown as current.
  const checking = preflight.isPending || preflight.isFetching;
  // An item that is already gone leaves its view; focus goes to a survivor.
  useEffect(() => {
    if (checked?.available === false) markDeleted();
  }, [checked, markDeleted]);
  const uses = inUseRefusalUses(error).length
    ? inUseRefusalUses(error)
    : checked?.available
      ? checked.usedBy
      : [];
  const revision =
    retryRevision ??
    item?.revision ??
    (checked?.available ? checked.revision : null);
  const pending = remove.isPending;
  // A failed usage check does not block Delete when the revision is known:
  // the server refuses an item in use.
  const confirmDisabled =
    checking || checked?.available === false || uses.length > 0 || !revision;

  const close = () => {
    setError(null);
    setRetryRevision(null);
    remove.reset();
    onClose();
  };
  const confirm = async (target: ContentToDelete, at: string) => {
    setError(null);
    try {
      await remove.mutateAsync({
        itemId: target.itemId,
        kind: target.kind,
        revision: at,
      });
    } catch (failure) {
      logger.warn(
        "Delete",
        failure instanceof ContentDeleteError
          ? `Content delete refused (${failure.status}, ${failure.code ?? "no code"})`
          : "Content delete request failed",
      );
      if (failure instanceof ContentDeleteError && failure.currentRevision)
        setRetryRevision(failure.currentRevision);
      setError(failure);
      return;
    }
    markDeleted();
    onDeleted?.(target);
    toast.success(t("delete.deleted", { name: target.name }));
    close();
  };

  const name = shown?.name ?? "";
  const status = checking
    ? t("delete.checking")
    : checked?.available === false
      ? t("delete.unavailable")
      : checked && !revision
        ? t("delete.noRevision")
        : // Only a view without the revision needs the check to offer Delete.
          preflight.isError && !revision
          ? t("delete.checkFailed")
          : null;

  return (
    <ConfirmDeleteDialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t("delete.title", { name })}
      description={
        <>
          <p>
            {t("delete.description", {
              kind: sharingKindLabel(shown?.kind ?? "content"),
            })}
          </p>
          {shown?.kind === "avatar" ? (
            <p className="mt-2">{t("delete.avatarPortrait")}</p>
          ) : null}
        </>
      }
      pending={pending}
      confirmDisabled={confirmDisabled}
      returnFocus={returnFocus}
      error={
        !error || uses.length
          ? null
          : isContentChangedRefusal(error)
            ? t("delete.changed")
            : t("delete.failed", { name })
      }
      onConfirm={() => {
        if (item && revision && !pending && !confirmDisabled)
          void confirm(item, revision);
      }}
    >
      {/* One live region from opening, so the check's result is announced. */}
      <div aria-live="polite">
        {uses.length && !checking ? (
          <UsageList uses={uses} />
        ) : status ? (
          <p className="text-muted-foreground text-sm">{status}</p>
        ) : null}
      </div>
    </ConfirmDeleteDialog>
  );
}
