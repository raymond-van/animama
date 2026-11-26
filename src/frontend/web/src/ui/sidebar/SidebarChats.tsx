import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@animama/product-ui/i18n";
import { getAnimaDisplayName } from "@/lib/anima-profile";
import { cn } from "@/lib/utils";
import { useAnimas } from "@/query/hooks/useAnimas";
import { useCloseMobileSidebar, useSidebar } from "@/ui/sidebar/Sidebar";
import { SidebarAnimaAvatar } from "@/ui/sidebar/SidebarAnimas";
import { SidebarSectionHeader } from "@/ui/sidebar/SidebarSectionHeader";
import { useChats } from "@/query/hooks/useChats";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/ui/components/dropdown-menu";
import { useSetChatPin } from "@/query/mutations/useSidebarPins";
import {
  ChatDeleteDialog,
  type ChatToDelete,
} from "@/ui/sidebar/ChatDeleteDialog";
import {
  SIDEBAR_ROW_LINK_CLASS,
  SidebarPinIndicator,
  SidebarRowMenu,
  useSidebarPinToggle,
} from "@/ui/sidebar/SidebarRowMenu";
import { pinnedFirst } from "@/ui/sidebar/sidebarOrder";

const ALL_ANIMAS_FILTER = "all";

export const SidebarChats = () => {
  const { t } = useTranslation("sidebar");
  const { compare } = useFormatters();
  const params = useParams({ strict: false });
  const { open } = useSidebar();
  const [expanded, setExpanded] = useState(true);
  const [animaFilter, setAnimaFilter] = useState(ALL_ANIMAS_FILTER);
  const routeChatId = typeof params?.chatId === "string" ? params.chatId : null;
  const { data: animas = [] } = useAnimas({ enabled: open });
  const animasById = useMemo(
    () => new Map(animas.map((anima) => [anima.id, anima] as const)),
    [animas],
  );
  const { data: chats = [], isLoading, isError } = useChats({ enabled: open });
  const chatAnimas = useMemo(() => {
    const chatAnimaIds = new Set(chats.map((chat) => chat.anima_id));
    return animas
      .filter((anima) => chatAnimaIds.has(anima.id))
      .sort((left, right) =>
        compare(getAnimaDisplayName(left), getAnimaDisplayName(right)),
      );
  }, [animas, chats, compare]);
  // Pinned chats first within the Anima filter, each group by recency.
  const displayedChats = useMemo(
    () =>
      pinnedFirst(
        animaFilter === ALL_ANIMAS_FILTER
          ? chats
          : chats.filter((chat) => chat.anima_id === animaFilter),
      ),
    [animaFilter, chats],
  );
  const togglePin = useSidebarPinToggle(useSetChatPin());
  const closeMobileSidebar = useCloseMobileSidebar();
  const [chatToDelete, setChatToDelete] = useState<ChatToDelete | null>(null);

  useEffect(() => {
    if (
      animaFilter !== ALL_ANIMAS_FILTER &&
      !chatAnimas.some((anima) => anima.id === animaFilter)
    ) {
      setAnimaFilter(ALL_ANIMAS_FILTER);
    }
  }, [animaFilter, chatAnimas]);

  // The dialog outlives the drawer: a phone closes the sidebar to show it.
  const deleteDialog = (
    <ChatDeleteDialog
      chat={chatToDelete}
      onClose={() => setChatToDelete(null)}
    />
  );

  // Every branch's root div holds the dialog first, so it keeps its state
  // whether the sidebar is open or not.
  if (!open) return <div className="contents">{deleteDialog}</div>;

  return (
    <div className="group/sidebar-section mt-4">
      {deleteDialog}
      <SidebarSectionHeader
        label={t("chats.heading")}
        expanded={expanded}
        controlsId="sidebar-chats-list"
        filterActive={animaFilter !== ALL_ANIMAS_FILTER}
        filterLabel={t("chats.filter")}
        onToggle={() => setExpanded((prev) => !prev)}
      >
        <DropdownMenuLabel>{t("chats.filterByAnima")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={animaFilter}
          onValueChange={setAnimaFilter}
        >
          <DropdownMenuRadioItem
            value={ALL_ANIMAS_FILTER}
            className="focus:bg-muted focus:text-foreground"
          >
            {t("chats.allAnimas")}
          </DropdownMenuRadioItem>
          {chatAnimas.map((anima) => (
            <DropdownMenuRadioItem
              key={anima.id}
              value={anima.id}
              className="focus:bg-muted focus:text-foreground"
            >
              {getAnimaDisplayName(anima)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </SidebarSectionHeader>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id="sidebar-chats-list"
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
                  {t("chats.loading")}
                </div>
              ) : isError ? (
                <div className="text-destructive px-2 py-2 text-xs">
                  {t("chats.loadFailed")}
                </div>
              ) : chats.length === 0 ? (
                <div className="text-muted-foreground px-2 py-2 text-xs">
                  {t("chats.empty")}
                </div>
              ) : displayedChats.length === 0 ? (
                <div className="text-muted-foreground px-2 py-2 text-xs">
                  {t("chats.emptyForAnima")}
                </div>
              ) : (
                displayedChats.map((chat) => {
                  const title = chat.title?.trim() || t("chats.untitled");
                  const isActive = chat.id === routeChatId;
                  const targetAnimaId = chat.anima_id;

                  if (!targetAnimaId) return null;
                  const anima = animasById.get(targetAnimaId);
                  const animaName = anima ? getAnimaDisplayName(anima) : null;
                  const pinned = Boolean(chat.pinned_at);

                  return (
                    <SidebarRowMenu
                      key={chat.id}
                      name={title}
                      pinned={pinned}
                      onTogglePin={() =>
                        togglePin({ id: chat.id, pinned, name: title })
                      }
                      onDelete={(focus) => {
                        closeMobileSidebar();
                        setChatToDelete({
                          id: chat.id,
                          animaId: targetAnimaId,
                          title,
                          focus,
                        });
                      }}
                    >
                      <Link
                        to="/$animaId/c/$chatId"
                        params={{
                          animaId: targetAnimaId,
                          chatId: chat.id,
                        }}
                        title={title}
                        className={cn(
                          "group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm",
                          "text-foreground/90 hover:bg-sidebar-accent/60 transition-colors",
                          "overflow-hidden",
                          SIDEBAR_ROW_LINK_CLASS,
                          isActive && "bg-sidebar-accent text-foreground",
                        )}
                      >
                        {anima && animaName ? (
                          <SidebarAnimaAvatar
                            anima={anima}
                            displayName={animaName}
                            isActive={isActive}
                            variant="chat"
                          />
                        ) : null}
                        <span className="block min-w-0 flex-1 truncate transition duration-150 group-hover:translate-x-0.5">
                          {title}
                        </span>
                        {pinned ? (
                          <>
                            <SidebarPinIndicator />
                            <span className="sr-only">
                              {t("rowMenu.pinned")}
                            </span>
                          </>
                        ) : null}
                      </Link>
                    </SidebarRowMenu>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
