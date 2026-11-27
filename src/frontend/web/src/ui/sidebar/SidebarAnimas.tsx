import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { getAnimaDisplayName } from "@/lib/anima-profile";
import { useCloseMobileSidebar, useSidebar } from "@/ui/sidebar/Sidebar";
import { SidebarSectionHeader } from "@/ui/sidebar/SidebarSectionHeader";
import { useAnimas } from "@/query/hooks/useAnimas";
import { useSetAnimaPin } from "@/query/mutations/useSidebarPins";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/ui/components/dropdown-menu";
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
  SIDEBAR_ROW_LAST_SPAN_UNDER_MENU_CLASS,
  SIDEBAR_ROW_LINK_CLASS,
  SidebarPinIndicator,
  SidebarRowMenu,
  useSidebarPinToggle,
} from "@/ui/sidebar/SidebarRowMenu";
import {
  setSidebarAnimaSort,
  useSidebarAnimaSortStore,
  type SidebarAnimaSort,
} from "@/ui/sidebar/sidebarOrder";
import { useSidebarAnimaOrder } from "@/ui/sidebar/useSidebarAnimaOrder";

export { AnimaAvatar as SidebarAnimaAvatar } from "@animama/product-ui/components";
import {
  AnimaAvatar as SidebarAnimaAvatar,
  AnimaSelection,
} from "@animama/product-ui/components";

export const SidebarAnimas = () => {
  const { t } = useTranslation("sidebar");
  const { open } = useSidebar();
  const params = useParams({ strict: false });
  const [expanded, setExpanded] = useState(true);
  const sort = useSidebarAnimaSortStore((state) => state.sort);
  const currentAnimaId =
    typeof params?.animaId === "string" ? params.animaId : null;

  const { data: animas = [], isLoading, isError } = useAnimas();
  // The expanded list and the collapsed rail share one order (R2, R4).
  const displayedAnimas = useSidebarAnimaOrder(animas);
  const togglePin = useSidebarPinToggle(useSetAnimaPin());
  const closeMobileSidebar = useCloseMobileSidebar();
  const [animaToDelete, setAnimaToDelete] = useState<AnimaToDelete | null>(
    null,
  );
  // The dialog outlives the drawer: a phone closes the sidebar to show it.
  const deleteDialog = (
    <AnimaDeleteDialog
      anima={animaToDelete}
      onClose={() => setAnimaToDelete(null)}
    />
  );

  // Every branch's root div holds the dialog first, so it keeps its state
  // whether the sidebar is open or not.
  if (!open) {
    if (isLoading || isError || animas.length === 0)
      return <div className="contents">{deleteDialog}</div>;

    return (
      <div className="short:mt-4 mt-14 flex flex-col items-start gap-2">
        {deleteDialog}
        {displayedAnimas.map((anima) => {
          const displayName = getAnimaDisplayName(anima);
          const isActive = anima.id === currentAnimaId;
          const linkNode = (
            <Link
              key={anima.id}
              to="/$animaId"
              params={{ animaId: anima.id }}
              aria-label={displayName}
              className={cn(
                "border-border/60 bg-background/60 text-foreground/80 hover:bg-muted/70 hover:text-foreground short:h-9 short:w-9 flex h-11 w-11 items-center justify-center rounded-full border p-0 shadow-sm backdrop-blur-md transition-colors",
                isActive &&
                  "bg-sidebar-accent/80 text-foreground ring-sidebar-border/80 ring-1",
              )}
            >
              <SidebarAnimaAvatar
                anima={anima}
                displayName={displayName}
                isActive={isActive}
                variant="compact"
              />
            </Link>
          );

          return (
            <Tooltip key={anima.id}>
              <TooltipTrigger asChild>{linkNode}</TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {displayName}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    );
  }

  return (
    <div className="group/sidebar-section mt-4">
      {deleteDialog}
      <SidebarSectionHeader
        label={t("animas.heading")}
        expanded={expanded}
        controlsId="sidebar-animas-list"
        filterActive={sort !== "recent"}
        filterLabel={t("animas.filter")}
        onToggle={() => setExpanded((prev) => !prev)}
      >
        <DropdownMenuLabel>{t("animas.sort.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sort}
          onValueChange={(value) =>
            setSidebarAnimaSort(value as SidebarAnimaSort)
          }
        >
          <DropdownMenuRadioItem
            value="recent"
            className="focus:bg-muted focus:text-foreground"
          >
            {t("animas.sort.recent")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="name-asc"
            className="focus:bg-muted focus:text-foreground"
          >
            {t("animas.sort.nameAscending")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="name-desc"
            className="focus:bg-muted focus:text-foreground"
          >
            {t("animas.sort.nameDescending")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </SidebarSectionHeader>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id="sidebar-animas-list"
            data-sidebar-list=""
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-1">
              {isLoading ? (
                <div className="text-muted-foreground px-2 py-2 text-xs">
                  {t("animas.loading")}
                </div>
              ) : isError ? (
                <div className="text-destructive px-2 py-2 text-xs">
                  {t("animas.loadFailed")}
                </div>
              ) : animas.length === 0 ? (
                <div className="text-muted-foreground px-2 py-2 text-xs">
                  {t("animas.empty")}
                </div>
              ) : (
                <AnimaSelection
                  animas={displayedAnimas}
                  selectedAnimaId={currentAnimaId}
                  renderItem={(anima, props) => {
                    const name = getAnimaDisplayName(anima);
                    const pinned = Boolean(anima.pinned_at);
                    return (
                      <SidebarRowMenu
                        name={name}
                        pinned={pinned}
                        onTogglePin={() =>
                          togglePin({ id: anima.id, pinned, name })
                        }
                        onDelete={(focus) => {
                          closeMobileSidebar();
                          setAnimaToDelete({ id: anima.id, name, focus });
                        }}
                      >
                        <Link
                          to="/$animaId"
                          params={{ animaId: anima.id }}
                          {...props}
                          aria-label={
                            pinned
                              ? t("rowMenu.pinnedName", { name })
                              : props["aria-label"]
                          }
                          className={cn(
                            props.className,
                            "overflow-hidden",
                            SIDEBAR_ROW_LINK_CLASS,
                            // The shared item's name (its last span) truncates
                            // to one line and fades under the More button.
                            "[&>span:last-of-type]:min-w-0 [&>span:last-of-type]:truncate",
                            SIDEBAR_ROW_LAST_SPAN_UNDER_MENU_CLASS,
                          )}
                        >
                          {props.children}
                          {pinned ? <SidebarPinIndicator /> : null}
                        </Link>
                      </SidebarRowMenu>
                    );
                  }}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
