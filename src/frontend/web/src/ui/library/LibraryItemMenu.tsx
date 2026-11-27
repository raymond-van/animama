import { useRef } from "react";
import { Ellipsis, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";
import { MENU_CLOSES_AT_ONCE_CLASS } from "@/ui/components/menu-classes";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui/components/tooltip";
import type { DeleteFocusTargets } from "@/ui/components/useDeleteReturnFocus";

/** Marks one Library group's items, with the ID its heading controls. */
const GROUP_ITEMS_SELECTOR = "[data-library-group-items]";

/** The first keyboard stop inside one Library item. */
function firstStop(item: Element | undefined): HTMLElement | null {
  return (
    item?.querySelector<HTMLElement>('[tabindex="0"], button, a[href]') ?? null
  );
}

/**
 * Focus targets for a Library item's delete dialog: its More button while the
 * item stays; once it is gone, the next item, the previous item, or its
 * group's heading. They are found now, while the item is still listed.
 */
function itemDeleteFocus(more: HTMLElement | null): DeleteFocusTargets {
  const item = more?.closest("article") ?? null;
  const group = item?.closest<HTMLElement>(GROUP_ITEMS_SELECTOR) ?? null;
  const items = group ? [...group.querySelectorAll("article")] : [];
  const index = item ? items.indexOf(item) : -1;
  const heading = group?.id
    ? document.querySelector<HTMLElement>(`[aria-controls="${group.id}"]`)
    : null;
  const survivors = [
    firstStop(items[index + 1]),
    firstStop(items[index - 1]),
    heading,
  ];
  return {
    kept: () => more,
    deleted: () => survivors.find((element) => element?.isConnected) ?? null,
  };
}

/**
 * A Library item's More menu (issue #950, R13): Delete for a Local item, in
 * grid and list layouts. Its group's items element is marked
 * `data-library-group-items` (with the ID its heading controls) so focus can
 * move to a surviving item after a delete.
 */
export function LibraryItemMenu({
  name,
  onDelete,
}: {
  /** The item's name, for the More button's accessible name. */
  name: string;
  /** Open the delete confirmation, returning focus to `focus` afterwards. */
  onDelete: (focus: DeleteFocusTargets) => void;
}) {
  const { t } = useTranslation("library");
  const moreRef = useRef<HTMLButtonElement>(null);
  const label = t("inventory.actions.more", { name });
  return (
    <DropdownMenu>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              ref={moreRef}
              type="button"
              size="icon-sm"
              variant="ghost"
              // The last action, at the item's trailing edge.
              className="ml-auto"
              aria-label={label}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className={cn("min-w-36", MENU_CLOSES_AT_ONCE_CLASS)}
      >
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => onDelete(itemDeleteFocus(moreRef.current))}
        >
          <Trash2 className="mr-2 size-4" aria-hidden="true" />
          {t("inventory.actions.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
