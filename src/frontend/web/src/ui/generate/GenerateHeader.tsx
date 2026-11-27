import {
  BotMessageSquare,
  HistoryIcon,
  MessageSquarePlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { messageTimestampMs } from "@animama/product-ui/chat";
import { useFormatters } from "@animama/product-ui/i18n";

import { apiErrorLine } from "@/lib/errors/apiError";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";
import { SidebarMenuButton } from "@/ui/sidebar/SidebarMenuButton";
import { describeGenerationActionFailure } from "./generationFailure";
import type { GenerationConversationChoice } from "./useGenerationConversationChoice";

/** The creators' header button shape, for the page's own header actions. */
const HEADER_BUTTON_CLASS_NAME =
  "dark:bg-background dark:hover:bg-accent size-11 rounded-xl p-0 shadow-sm lg:size-12";

/**
 * Start a new conversation, reopen an earlier one, or discard the one on
 * screen with its messages and unsaved drafts (R6.4). All three wait for a
 * run in flight: leaving a conversation stops its run.
 */
export function GenerateConversationMenu({
  choice,
  running,
  currentIsEmpty,
}: {
  choice: GenerationConversationChoice;
  /** A run is in flight on the conversation on screen. */
  running: boolean;
  /** The conversation on screen has no message and no draft yet. */
  currentIsEmpty: boolean;
}) {
  const { t } = useTranslation("generate");
  const formatters = useFormatters();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const { conversations, conversationId } = choice;
  const waitTitle = running ? t("header.waitForRun") : undefined;
  const busy = running || choice.isStarting || choice.isDiscarding;

  const startNew = async () => {
    try {
      await choice.startNew();
    } catch (error) {
      toast.error(apiErrorLine(describeGenerationActionFailure(error)));
    }
  };
  const discard = async () => {
    setConfirmingDiscard(false);
    // The server refuses while a run works on the conversation.
    if (!conversationId || running) return;
    try {
      await choice.discard(conversationId);
    } catch (error) {
      toast.error(apiErrorLine(describeGenerationActionFailure(error)));
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className={`${HEADER_BUTTON_CLASS_NAME} 2xl:w-auto 2xl:px-3`}
        aria-label={t("header.newConversation")}
        title={waitTitle ?? t("header.newConversation")}
        data-testid="generate-new-conversation"
        // An empty conversation is already the new one.
        disabled={busy || currentIsEmpty || !conversationId}
        onClick={() => void startNew()}
      >
        <MessageSquarePlusIcon className="size-4" aria-hidden="true" />
        <span className="hidden 2xl:inline">{t("header.newConversation")}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={HEADER_BUTTON_CLASS_NAME}
            aria-label={t("header.conversations")}
            title={waitTitle ?? t("header.conversations")}
            data-testid="generate-conversations-menu"
            disabled={busy}
          >
            <HistoryIcon className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={8}
          className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 overflow-y-auto rounded-xl p-1.5"
        >
          <DropdownMenuLabel>{t("header.conversations")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={conversationId ?? ""}
            onValueChange={choice.open}
          >
            {conversations.map((conversation) => {
              const updated = messageTimestampMs(conversation.updated_at);
              return (
                <DropdownMenuRadioItem
                  key={conversation.id}
                  value={conversation.id}
                  data-testid="generate-conversation-item"
                  data-conversation-id={conversation.id}
                  className="min-h-11 rounded-lg"
                >
                  <span className="min-w-0">
                    <span className="block truncate">
                      {conversation.title.trim() || t("header.untitled")}
                    </span>
                    {updated > 0 ? (
                      <span className="text-muted-foreground block text-xs">
                        {formatters.dateTime(updated)}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive min-h-11 gap-3 rounded-lg"
            data-testid="generate-conversation-discard"
            disabled={!conversationId || running}
            onSelect={() => setConfirmingDiscard(true)}
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
            {t("header.discardConversation")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <DialogContent data-testid="generate-conversation-discard-dialog">
          <DialogHeader>
            <DialogTitle>{t("header.discard.title")}</DialogTitle>
            <DialogDescription>
              {t("header.discard.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmingDiscard(false)}
            >
              {t("header.discard.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="generate-conversation-discard-confirm"
              // A run started behind the open confirmation.
              disabled={running}
              title={waitTitle}
              onClick={() => void discard()}
            >
              {t("header.discard.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The Generate page's header in the creators' header shape: the page's name,
 * the conversation actions, and the assistant's model at the end.
 */
export function GenerateHeader({
  conversationMenu,
  modelControl,
}: {
  conversationMenu: ReactNode;
  modelControl: ReactNode;
}) {
  const { t } = useTranslation("generate");
  return (
    <header className="[&_button:disabled]:text-muted-foreground bg-background relative z-40 w-full shrink-0 px-2 py-2 sm:pr-3 sm:pl-[calc(var(--app-shell-sidebar-inset)+1rem)] lg:bg-transparent lg:py-3 lg:pr-4 lg:pl-[calc(var(--app-shell-sidebar-inset)+1rem)] lg:transition-[padding-left] lg:duration-150 lg:ease-in-out xl:pr-8 xl:pl-[calc(var(--app-shell-sidebar-inset)+2rem)] [&_button:disabled]:opacity-100">
      <div className="flex min-w-0 items-center gap-2 lg:gap-1.5 2xl:gap-3">
        <div className="flex min-w-0 items-center gap-1">
          <SidebarMenuButton />
          <div className="border-border/70 bg-background flex h-11 min-w-0 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium shadow-sm lg:h-12 [&_svg]:size-4 [&_svg]:shrink-0">
            <BotMessageSquare aria-hidden="true" />
            <h1 className="truncate">{t("page.title")}</h1>
          </div>
        </div>
        {conversationMenu}
        <div className="ml-auto flex min-w-0 items-center">{modelControl}</div>
      </div>
    </header>
  );
}
