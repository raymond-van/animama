import { Link, useLocation } from "@tanstack/react-router";
import {
  BotMessageSquare,
  ChevronRight,
  Hand,
  HeartPulse,
  Sparkles,
  UsersRound,
  WandSparkles,
} from "lucide-react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/ui/components/popover";
import {
  useRuntimeFeatureEnabled,
  useRuntimeFeatureUnavailableReason,
} from "@/ui/app/RuntimeFeatureGate";
import { UnavailableAction } from "@/ui/components/unavailable-action";
import { EffectTemplatePickerDialog } from "@/ui/create/EffectTemplatePickerDialog";
import {
  SidebarLink,
  useCloseMobileSidebar,
  type SidebarLinkItem,
} from "@/ui/sidebar/Sidebar";

const CLOSE_DELAY_MS = 140;

const MENU_VARIANTS: Variants = {
  closed: {
    transition: { staggerChildren: 0.025, staggerDirection: -1 },
  },
  open: {
    transition: { delayChildren: 0.02, staggerChildren: 0.045 },
  },
};

const CARD_VARIANTS: Variants = {
  closed: { opacity: 0, scale: 0.94, x: -12 },
  open: {
    opacity: 1,
    scale: 1,
    x: 0,
    transition: { type: "spring", stiffness: 520, damping: 32, mass: 0.7 },
  },
};

const PRIMARY_CREATE_LINKS = [
  {
    to: "/animas/new" as const,
    icon: UsersRound,
    iconClassName: "bg-primary text-primary-foreground",
  },
  {
    to: "/gestures/new" as const,
    icon: Hand,
    iconClassName: "bg-secondary text-secondary-foreground",
  },
  {
    to: "/reactions/new" as const,
    icon: HeartPulse,
    iconClassName: "bg-secondary text-secondary-foreground",
  },
  {
    to: "/generate" as const,
    icon: BotMessageSquare,
    iconClassName: "bg-secondary text-secondary-foreground",
  },
] as const;

/** The card look shared by every Create menu item, including a disabled one. */
const MENU_ITEM_SHAPE_CLASS_NAME =
  "border-border/60 bg-popover/95 focus-visible:ring-ring flex items-center gap-2.5 rounded-lg border px-2 py-1.5 text-sm font-medium shadow-md backdrop-blur-md outline-none focus-visible:ring-2";

const MENU_ITEM_CLASS_NAME = `group/create-item ${MENU_ITEM_SHAPE_CLASS_NAME} hover:bg-muted focus-visible:bg-muted transition-[background-color,box-shadow,transform] hover:translate-x-0.5 hover:shadow-lg`;

/**
 * Hover, click, and keyboard-accessible creation destinations. **Effects**
 * opens the Effects template picker in place; closing it leaves the user on
 * the current page.
 */
export function SidebarCreateMenu() {
  const { t } = useTranslation("sidebar");
  const [open, setOpen] = useState(false);
  const [effectsPickerOpen, setEffectsPickerOpen] = useState(false);
  const pathname = useLocation({ select: (location) => location.pathname });
  const reduceMotion = useReducedMotion();
  const contentId = useId();
  const closeTimerRef = useRef<number | null>(null);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  /** Focus returned from the picker must not reopen the hover menu. */
  const suppressFocusOpenRef = useRef(false);
  /** A choice or dismissal closed the menu; only Create itself reopens it. */
  const dismissedRef = useRef(false);
  const closeMobileSidebar = useCloseMobileSidebar();
  const animaCreation = useRuntimeFeatureEnabled("anima_creation");
  // A withheld Anima creator keeps its item, disabled with the shared reason.
  const animaCreationUnavailable =
    useRuntimeFeatureUnavailableReason("anima_creation");
  // The content assistant is local-only; its item is hidden unless offered.
  const contentGeneration = useRuntimeFeatureEnabled("content_generation");
  const primaryLinks = PRIMARY_CREATE_LINKS.filter((item) =>
    item.to === "/generate"
      ? contentGeneration
      : animaCreation ||
        animaCreationUnavailable !== null ||
        item.to !== "/animas/new",
  );
  /** Each creation destination's menu label. */
  const createLabel = (to: (typeof PRIMARY_CREATE_LINKS)[number]["to"]) => {
    switch (to) {
      case "/animas/new":
        return t("create.anima");
      case "/gestures/new":
        return t("create.gesture");
      case "/reactions/new":
        return t("create.reaction");
      case "/generate":
        return t("create.generate");
    }
  };
  const trigger: SidebarLinkItem = {
    label: t("create.label"),
    to: "/create",
    icon: (
      <Sparkles className="text-sidebar-foreground dark:text-sidebar-foreground short:size-5 h-6 w-6 flex-shrink-0" />
    ),
  };

  const cancelClose = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const openMenu = () => {
    cancelClose();
    dismissedRef.current = false;
    setOpen(true);
  };

  /**
   * Pointer or focus reaching the menu keeps it open and recovers a hover close
   * that beat the pointer there. The closed menu stays mounted while it
   * animates out, so a dismissed menu must not reopen from those events.
   */
  const keepMenu = () => {
    if (!dismissedRef.current) openMenu();
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, CLOSE_DELAY_MS);
  };

  const closeMenu = () => {
    cancelClose();
    dismissedRef.current = true;
    setOpen(false);
  };

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => (next ? openMenu() : closeMenu())}
      >
        <PopoverAnchor asChild>
          <div onMouseEnter={openMenu} onMouseLeave={scheduleClose}>
            <SidebarLink
              link={trigger}
              className={
                pathname === "/create" || pathname === "/effects/new"
                  ? "bg-accent/70 text-accent-foreground hover:bg-accent/80"
                  : undefined
              }
              showTooltip={false}
              animateLabel={false}
              aria-label={t("create.label")}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? contentId : undefined}
              onClick={closeMenu}
              ref={triggerRef}
              onFocus={() => {
                // Focus returned by the closed Effects picker must not reopen
                // the menu; the guard lasts until focus leaves the trigger.
                if (suppressFocusOpenRef.current) return;
                openMenu();
              }}
              onBlur={() => {
                suppressFocusOpenRef.current = false;
                scheduleClose();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  cancelClose();
                  closeMenu();
                }
              }}
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          id={contentId}
          role="menu"
          aria-label={t("create.label")}
          side="right"
          align="start"
          sideOffset={4}
          collisionPadding={12}
          className="z-[130] w-44 border-0 bg-transparent p-0 shadow-none"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onMouseEnter={keepMenu}
          onMouseLeave={scheduleClose}
          onFocusCapture={keepMenu}
          onBlurCapture={scheduleClose}
          onEscapeKeyDown={() => {
            cancelClose();
            closeMenu();
          }}
        >
          <motion.div
            className="space-y-1"
            initial={reduceMotion ? false : "closed"}
            animate={reduceMotion ? undefined : open ? "open" : "closed"}
            variants={MENU_VARIANTS}
          >
            {primaryLinks.map((item) => {
              const Icon = item.icon;
              const icon = (
                <span
                  className={`${item.iconClassName} flex size-7 shrink-0 items-center justify-center rounded-md shadow-sm ring-1 ring-black/5 transition-transform group-hover/create-item:scale-105`}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                </span>
              );
              return (
                <motion.div key={item.to} variants={CARD_VARIANTS}>
                  {item.to === "/animas/new" && animaCreationUnavailable ? (
                    <UnavailableAction
                      reason={animaCreationUnavailable}
                      side="right"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className={`${MENU_ITEM_SHAPE_CLASS_NAME} w-full`}
                      >
                        {icon}
                        <span className="min-w-0 flex-1 text-left whitespace-nowrap">
                          {createLabel(item.to)}
                        </span>
                      </button>
                    </UnavailableAction>
                  ) : (
                    <Link
                      to={item.to}
                      role="menuitem"
                      activeOptions={{ exact: true }}
                      activeProps={{
                        className: "bg-muted/80 text-foreground",
                      }}
                      className={MENU_ITEM_CLASS_NAME}
                      onClick={closeMenu}
                    >
                      {icon}
                      <span className="min-w-0 flex-1 whitespace-nowrap">
                        {createLabel(item.to)}
                      </span>
                      <ChevronRight
                        className="text-muted-foreground size-4 shrink-0 -translate-x-1 opacity-0 transition-all group-hover/create-item:translate-x-0 group-hover/create-item:opacity-100 group-focus-visible/create-item:translate-x-0 group-focus-visible/create-item:opacity-100 group-data-[status=active]/create-item:translate-x-0 group-data-[status=active]/create-item:opacity-100"
                        aria-hidden="true"
                      />
                    </Link>
                  )}
                </motion.div>
              );
            })}
            <motion.div variants={CARD_VARIANTS}>
              <button
                type="button"
                role="menuitem"
                aria-haspopup="dialog"
                className={`${MENU_ITEM_CLASS_NAME} w-full`}
                onClick={() => {
                  closeMenu();
                  // The picker opens in place, so the mobile drawer must not
                  // stay drawn over it.
                  closeMobileSidebar();
                  setEffectsPickerOpen(true);
                }}
              >
                <span className="bg-accent text-accent-foreground flex size-7 shrink-0 items-center justify-center rounded-md shadow-sm ring-1 ring-black/5 transition-transform group-hover/create-item:scale-105">
                  <WandSparkles className="size-3.5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 text-left whitespace-nowrap">
                  {t("create.effects")}
                </span>
                <ChevronRight
                  className="text-muted-foreground size-4 shrink-0 -translate-x-1 opacity-0 transition-all group-hover/create-item:translate-x-0 group-hover/create-item:opacity-100 group-focus-visible/create-item:translate-x-0 group-focus-visible/create-item:opacity-100"
                  aria-hidden="true"
                />
              </button>
            </motion.div>
          </motion.div>
        </PopoverContent>
      </Popover>
      <EffectTemplatePickerDialog
        open={effectsPickerOpen}
        onOpenChange={setEffectsPickerOpen}
        onChoose={() => setEffectsPickerOpen(false)}
        // The Effects item unmounts with the menu; return to the Create trigger.
        returnFocus={() => {
          const trigger = triggerRef.current;
          if (trigger?.isConnected) suppressFocusOpenRef.current = true;
          return trigger;
        }}
      />
    </>
  );
}
