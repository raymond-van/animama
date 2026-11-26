import { RefreshCw, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDesktopUpdates } from "@/hooks/useDesktopUpdates";
import { cn } from "@/lib/utils";
import { useUserProfile } from "@/query/hooks/useUserProfile";
import {
  clearAppSettingsRequest,
  requestAppSettings,
  useAppSettingsHost,
} from "@/stores/app-settings-request-store";
import { Avatar, AvatarFallback } from "@/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui/components/tooltip";
import { ApplicationSettingsModal } from "@/ui/sidebar/ApplicationSettingsModal";
import { useCloseMobileSidebar, useSidebar } from "@/ui/sidebar/Sidebar";
import {
  useOptionalAccountAffordances,
  useOptionalRuntimeController,
} from "@/app/runtime/RuntimeAdmissionProvider";
import { AccountUsage } from "./AccountUsage";

/** Update states in which the updater refuses to start a check. */
const UPDATE_BUSY_STATES = new Set(["checking", "downloading", "restarting"]);

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

/**
 * Show admitted personalization and composition-provided account controls.
 * A desktop build that can update also offers **Check for updates…**, the
 * same action as the macOS application menu item; the Windows window has no
 * menu bar, so this is where its owners find the check.
 */
export function SidebarUserMenu() {
  const { t } = useTranslation("sidebar");
  const { open } = useSidebar();
  const closeMobileSidebar = useCloseMobileSidebar();
  const profile = useUserProfile();
  const [menuOpen, setMenuOpen] = useState(false);
  const [applicationSettingsOpen, setApplicationSettingsOpen] = useState(false);
  // Other surfaces (a composer hint, the desktop menu) open App Settings here.
  const settingsRequest = useAppSettingsHost();
  useEffect(() => {
    if (settingsRequest) setApplicationSettingsOpen(true);
  }, [settingsRequest]);
  // "unavailable" covers the web, unpackaged runs, Linux and sealed builds.
  const updates = useDesktopUpdates();
  const canCheckForUpdates = updates.status.state !== "unavailable";
  const [usageOpen, setUsageOpen] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const controller = useOptionalRuntimeController();
  const account = controller?.composition.accountActions;
  const canOpenAccount =
    useOptionalAccountAffordances()?.canOpenAccount ?? false;
  const displayName =
    profile.data?.display_name?.trim() || t("user.fallbackName");
  const triggerButton = (
    <button
      type="button"
      className={cn(
        "group/sidebar text-sidebar-foreground dark:text-sidebar-foreground flex items-center text-left",
        open
          ? "hover:bg-sidebar-accent/60 h-[44px] w-full gap-2 rounded-md px-2"
          : "border-border/60 bg-background/60 text-foreground/80 hover:bg-muted/70 hover:text-foreground short:h-9 short:w-9 h-11 w-11 justify-center rounded-full border p-0 shadow-sm backdrop-blur-md",
      )}
      aria-label={open ? undefined : displayName}
    >
      <Avatar
        className={cn(
          "ring-border shrink-0 ring-1",
          open ? "size-8" : "short:size-8 size-10",
        )}
      >
        <AvatarFallback className="text-xs font-medium">
          {initials(displayName)}
        </AvatarFallback>
      </Avatar>
      {open ? (
        <span className="!m-0 inline-block !p-0 text-sm whitespace-pre transition duration-150 group-hover/sidebar:translate-x-1">
          {displayName}
        </span>
      ) : null}
    </button>
  );

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        {open ? (
          <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {displayName}
            </TooltipContent>
          </Tooltip>
        )}
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={12}
          className="z-[130] w-72 p-3"
        >
          <DropdownMenuItem
            className="gap-2"
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              closeMobileSidebar();
              setApplicationSettingsOpen(true);
            }}
          >
            <Settings className="h-4 w-4" />
            {t("user.appSettings")}
          </DropdownMenuItem>
          {canCheckForUpdates ? (
            <DropdownMenuItem
              className="gap-2"
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                closeMobileSidebar();
                // The update panel shows the check's progress and result; a
                // check, download or restart already running reports there
                // instead, so it is not asked to start another.
                if (!UPDATE_BUSY_STATES.has(updates.status.state))
                  void updates.run("check");
                requestAppSettings("updates");
              }}
            >
              <RefreshCw className="h-4 w-4" />
              {t("user.checkForUpdates")}
            </DropdownMenuItem>
          ) : null}
          {account ? (
            <>
              {canOpenAccount ? (
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    try {
                      account.openAccount();
                    } catch (error) {
                      setAccountError(
                        error instanceof Error
                          ? error.message
                          : t("user.accountUnavailable"),
                      );
                    }
                  }}
                >
                  {t("user.account")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setMenuOpen(false);
                  closeMobileSidebar();
                  setUsageOpen(true);
                }}
              >
                {t("user.usage")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void controller!.signOut().catch(() => {});
                }}
              >
                {t("user.signOut")}
              </DropdownMenuItem>
              {accountError ? (
                <p role="alert" className="text-muted-foreground px-2 text-sm">
                  {accountError}
                </p>
              ) : null}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ApplicationSettingsModal
        open={applicationSettingsOpen}
        onOpenChange={(next) => {
          setApplicationSettingsOpen(next);
          // Closing before the setting could be shown withdraws the request.
          if (!next && settingsRequest)
            clearAppSettingsRequest(settingsRequest);
        }}
        reveal={settingsRequest}
        onRevealed={clearAppSettingsRequest}
      />
      {account ? (
        <AccountUsage
          actions={account}
          open={usageOpen}
          onOpenChange={setUsageOpen}
        />
      ) : null}
    </>
  );
}
