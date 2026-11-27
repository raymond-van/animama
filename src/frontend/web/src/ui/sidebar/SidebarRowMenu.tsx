import { useRef, type ComponentType, type ReactNode } from "react";
import { Ellipsis, Pin, PinOff, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import type { SetSidebarPinArgs } from "@/query/mutations/useSidebarPins";
import type { DeleteFocusTargets } from "@/ui/sidebar/useConfirmedDelete";
import { Button } from "@/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/ui/components/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";
import { MENU_CLOSES_AT_ONCE_CLASS } from "@/ui/components/menu-classes";

/** The menu item component of the More menu or the right-click menu. */
type RowMenuItem = ComponentType<{
  className?: string;
  onSelect?: (event: Event) => void;
  children?: ReactNode;
}>;

export type SidebarRowActionsProps = {
  pinned: boolean;
  onTogglePin: () => void;
  onDelete: () => void;
};

/**
 * The chat and Anima row actions (issue #950): Pin or Unpin, then Delete.
 * The sidebar's More and right-click menus and the Anima page share them.
 */
export function SidebarRowActionItems({
  Item,
  pinned,
  onTogglePin,
  onDelete,
}: SidebarRowActionsProps & { Item: RowMenuItem }) {
  const { t } = useTranslation("sidebar");
  return (
    <>
      <Item onSelect={onTogglePin}>
        {pinned ? (
          <PinOff className="mr-2 size-4" aria-hidden="true" />
        ) : (
          <Pin className="mr-2 size-4" aria-hidden="true" />
        )}
        {pinned ? t("rowMenu.unpin") : t("rowMenu.pin")}
      </Item>
      <Item
        className="text-destructive focus:text-destructive"
        onSelect={onDelete}
      >
        <Trash2 className="mr-2 size-4" aria-hidden="true" />
        {t("rowMenu.delete")}
      </Item>
    </>
  );
}

/** Marks a pinned row; place it last inside the row's link. */
export function SidebarPinIndicator() {
  // Sits in the row's top-left corner: the row wrapper is the positioned
  // ancestor, so the link's overflow clipping and layout are unaffected.
  return (
    <Pin
      aria-hidden="true"
      className="text-muted-foreground pointer-events-none absolute top-0.5 left-0.5 size-[7px]"
    />
  );
}

/**
 * Focus targets for a row's delete dialog: its More button while the row
 * stays; once it is gone, the next row, the previous row, or the list's
 * heading. They are found now, while the row is still listed.
 */
function rowDeleteFocus(
  row: HTMLElement | null,
  more: HTMLElement | null,
): DeleteFocusTargets {
  const list = row?.closest<HTMLElement>("[data-sidebar-list]") ?? null;
  const links = list
    ? [...list.querySelectorAll<HTMLElement>("[data-sidebar-row] > a")]
    : [];
  const index = links.findIndex((link) => row?.contains(link));
  const heading = list?.id
    ? document.querySelector<HTMLElement>(`[aria-controls="${list.id}"]`)
    : null;
  const survivors = [links[index + 1], links[index - 1], heading];
  return {
    kept: () => more,
    deleted: () => survivors.find((element) => element?.isConnected) ?? null,
  };
}

/**
 * Wraps one sidebar row (its link as `children`) with the row actions: a More
 * button shown on hover and keyboard focus (always on phone widths, which have
 * no hover), and the same items on right-click. The link reserves room for
 * the button with `SIDEBAR_ROW_LINK_CLASS`; the list is marked
 * `data-sidebar-list` (with the ID its heading controls) so focus can move to
 * a surviving row after a delete.
 */
export function SidebarRowMenu({
  name,
  pinned,
  onTogglePin,
  onDelete,
  children,
}: Omit<SidebarRowActionsProps, "onDelete"> & {
  /** The row's name, for the More button's accessible name. */
  name: string;
  /** Open the delete confirmation, returning focus to `focus` afterwards. */
  onDelete: (focus: DeleteFocusTargets) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("sidebar");
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const actions = {
    pinned,
    onTogglePin,
    onDelete: () => onDelete(rowDeleteFocus(rowRef.current, moreRef.current)),
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div ref={rowRef} data-sidebar-row="" className="group/row relative">
          {children}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={moreRef}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("rowMenu.more", { name })}
                className={cn(
                  "text-muted-foreground hover:text-foreground absolute top-1/2 right-1 size-7 -translate-y-1/2 p-0 transition-opacity duration-150 hover:bg-transparent",
                  // Shown whenever focused, including when a closed dialog
                  // returns focus to it.
                  "opacity-100 md:opacity-0 md:group-hover/row:opacity-100 md:group-has-[:focus-visible]/row:opacity-100 md:focus:opacity-100 md:data-[state=open]:opacity-100",
                )}
              >
                <Ellipsis className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            {/* Above the sidebar (z-120), as the section filter menus are. */}
            <DropdownMenuContent
              side="right"
              align="start"
              sideOffset={8}
              className={cn("z-[130] min-w-36", MENU_CLOSES_AT_ONCE_CLASS)}
            >
              <SidebarRowActionItems Item={DropdownMenuItem} {...actions} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className={cn("z-[130]", MENU_CLOSES_AT_ONCE_CLASS)}>
        <SidebarRowActionItems Item={ContextMenuItem} {...actions} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Keeps a row link's text and pin clear of the More button. */
export const SIDEBAR_ROW_LINK_CLASS = "pr-9";

/**
 * Toggle a chat's or Anima's sidebar pin with `setPin` (`useSetChatPin` or
 * `useSetAnimaPin`), saying so when it fails.
 */
export function useSidebarPinToggle(
  setPin: Pick<UseMutationResult<unknown, Error, SetSidebarPinArgs>, "mutate">,
) {
  const { t } = useTranslation("sidebar");
  return (item: { id: string; pinned: boolean; name: string }) =>
    setPin.mutate(
      { id: item.id, pinned: !item.pinned },
      {
        onError: () =>
          toast.error(
            item.pinned
              ? t("rowMenu.unpinFailed", { name: item.name })
              : t("rowMenu.pinFailed", { name: item.name }),
          ),
      },
    );
}
