import { useRef, useState } from "react";
import { Ellipsis } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useSetAnimaPin } from "@/query/mutations/useSidebarPins";
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
import {
  AnimaDeleteDialog,
  type AnimaToDelete,
} from "@/ui/sidebar/AnimaDeleteDialog";
import {
  SidebarRowActionItems,
  useSidebarPinToggle,
} from "@/ui/sidebar/SidebarRowMenu";
import type { DeleteFocusTargets } from "@/ui/sidebar/useConfirmedDelete";

/**
 * The Anima page's More menu: the sidebar row's Pin or Unpin and Delete, with
 * the same confirmation (R9). Deleting opens the next Anima's page.
 */
export function AnimaPageActions({
  animaId,
  name,
  pinned,
}: {
  animaId: string;
  /** The Anima's display name. */
  name: string;
  pinned: boolean;
}) {
  const { t } = useTranslation("sidebar");
  const togglePin = useSidebarPinToggle(useSetAnimaPin());
  const [animaToDelete, setAnimaToDelete] = useState<AnimaToDelete | null>(
    null,
  );
  const label = t("rowMenu.more", { name });
  const moreRef = useRef<HTMLButtonElement>(null);
  // A delete opens the next Anima's page, which replaces this one, so focus
  // then goes to that page's More button (`data-anima-page-more`).
  const focus: DeleteFocusTargets = {
    kept: () => moreRef.current,
    deleted: () =>
      document.querySelector<HTMLElement>("[data-anima-page-more]"),
  };

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                ref={moreRef}
                type="button"
                variant="outline"
                size="icon"
                className="rounded-full"
                aria-label={label}
                data-anima-page-more=""
              >
                <Ellipsis className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          className={cn("min-w-36", MENU_CLOSES_AT_ONCE_CLASS)}
        >
          <SidebarRowActionItems
            Item={DropdownMenuItem}
            pinned={pinned}
            onTogglePin={() => togglePin({ id: animaId, pinned, name })}
            onDelete={() => setAnimaToDelete({ id: animaId, name, focus })}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <AnimaDeleteDialog
        anima={animaToDelete}
        onClose={() => setAnimaToDelete(null)}
      />
    </>
  );
}
