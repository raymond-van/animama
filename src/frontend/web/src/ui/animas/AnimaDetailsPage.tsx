import { buildEmotionPresentation } from "@/lib/emotion/presentation";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui/components/tooltip";

import {
  ChevronLeft,
  ChevronRight,
  Eye,
  ImageUp,
  MousePointer2,
  Square,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type {
  PyAnimaResponse,
  PyRuntimeImageReference,
} from "@/lib/content/catalogTypes";
import type { RuntimeCatalogEntry } from "@/lib/runtime-content/types";
import { getAnimaDisplayName, sortAnimasByRecent } from "@/lib/anima-profile";
import {
  ANIMA_MANAGEMENT_TABS,
  adjacentAnimaId,
  type AnimaManagementTab,
} from "@/lib/animas/anima-management-search";
import { resolveAnimaIdentityContent } from "@/lib/animas/anima-management-presentation";
import {
  INITIAL_ANIMA_STAGE_PREVIEW_STATE,
  isAnimaStagePreviewTarget,
  reduceAnimaStagePreview,
} from "@/lib/content-preview/managementPreview";
import { logContentPreviewLifecycle } from "@/lib/content-preview/lifecycle";
import { shouldAutoplayContentPreview } from "@/lib/content-preview/playback";
import type {
  ContentPreviewLoadStatus,
  ContentPreviewTarget,
} from "@/lib/content-preview/types";
import { runtimeImagePresentation } from "@/lib/runtime-content/animaRuntimeSnapshot";
import { runtimeContentDeliveryUrl } from "@/lib/runtime-content/runtimeContentDelivery";
import { adaptRuntimeSnapshot } from "@/lib/runtime-content/runtimeSnapshotAdapter";
import { cn } from "@/lib/utils";
import { useAnima } from "@/query/hooks/useAnima";
import { useAnimas } from "@/query/hooks/useAnimas";
import { useAnimaPresentationImage } from "@/query/hooks/useAnimaPresentationImage";
import { useAnimaRuntimeCatalog } from "@/query/hooks/useAnimaRuntimeCatalog";
import { useMemoryEntryByPath } from "@/query/hooks/useMemoryEntries";
import { useRuntimeContentMediaUrl } from "@/query/hooks/useRuntimeContentMediaUrl";
import {
  AnimaAppearanceDialog,
  type AnimaAppearanceSection,
} from "@/ui/animas/AnimaAppearanceDialog";
import { AnimaLoadout } from "@/ui/animas/AnimaLoadout";
import { AnimaAvatarStage } from "@/ui/animas/AnimaAvatarStage";
import { AnimaPageActions } from "@/ui/animas/AnimaPageActions";
import { AnimaCarousel } from "@/ui/animas/AnimaCarousel";
import {
  ANIMA_SHOWCASE_CAMERAS,
  ANIMA_SHOWCASE_ORBIT_TARGET,
  ANIMA_SHOWCASE_SHORT_CAMERA,
} from "@/ui/animas/AnimaManagementStagePresentation";
import {
  useAnimaRosterLayout,
  useShortAnimaViewport,
} from "@/ui/animas/useAnimaRosterLayout";
import { AppShellPage } from "@/ui/app/AppShellPage";
import { StageBackgroundLayer } from "@/ui/main/canvas/StageBackgroundLayer";
import { usePreparedContentPreview } from "@/ui/content-preview/usePreparedContentPreview";
import { Button } from "@/ui/components/button";
import { Card, CardContent } from "@/ui/components/card";
import { Dialog, DialogContent, DialogTitle } from "@/ui/components/dialog";
import { EmotionalState } from "@/ui/components/emotional-state";
import { EmotionMascot } from "@/ui/components/emotion-mascot";
import { RuntimeImageFrame } from "@/ui/components/runtime-image-frame";
import { Tabs, TabsList, TabsTrigger } from "@/ui/components/tabs";
import { AnimaMemoriesSection } from "@/ui/animas/AnimaMemoriesSection";
import { AnimaIdentitySection } from "@/ui/animas/AnimaIdentitySection";
import { AnimaSettingsModal } from "@/ui/main/header/AnimaSettingsModal";
import { SidebarMenuButton } from "@/ui/sidebar/SidebarMenuButton";

export type AnimaDetailsPageProps = {
  animaId: string;
  activeTab: AnimaManagementTab;
  onTabChange: (tab: AnimaManagementTab) => void;
  onSelectAnima: (animaId: string, tab: AnimaManagementTab) => void;
  /** Omit when the runtime does not offer Anima creation. */
  onCreateAnima?: () => void;
  /** Shown on a disabled New Anima action when the runtime withholds creation. */
  createAnimaUnavailableReason?: string;
};

/** Display label for a management tab; tab IDs stay in the URL. */
function tabLabel(t: TFunction<"animas">, tab: AnimaManagementTab): string {
  switch (tab) {
    case "overview":
      return t("management.tabs.overview");
    case "memories":
      return t("management.tabs.memories");
    case "emotions":
      return t("management.tabs.emotions");
    case "loadout":
      return t("management.tabs.loadout");
    case "settings":
      return t("management.tabs.settings");
  }
}

const STAGE_PREVIEW_TOAST_ID = "anima-stage-preview";

function stagePreviewStatusLabel(
  t: TFunction<"animas">,
  status: ContentPreviewLoadStatus,
): string {
  switch (status) {
    case "loading":
      return t("management.preview.states.loading");
    case "playing":
      return t("management.preview.states.playing");
    case "ready":
      return t("management.preview.states.ready");
    case "error":
      return t("management.preview.states.error");
    default:
      return t("management.preview.states.idle");
  }
}

function LoadingManagementWorkspace() {
  const { t } = useTranslation("animas");
  return (
    <AppShellPage contentClassName="max-w-2xl">
      <Card className="border-border/70 bg-card/90 shadow-xl shadow-black/10">
        <CardContent className="flex min-h-64 items-center justify-center p-8 text-center">
          <div className="space-y-2">
            <p className="text-foreground font-medium">
              {t("management.loading.title")}
            </p>
            <p className="text-muted-foreground text-sm">
              {t("management.loading.description")}
            </p>
          </div>
        </CardContent>
      </Card>
    </AppShellPage>
  );
}

function ManagementError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation("animas");
  return (
    <AppShellPage contentClassName="max-w-2xl">
      <Card className="border-destructive/35 bg-card/90 shadow-xl shadow-black/10">
        <CardContent className="flex min-h-64 flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="space-y-2">
            <h1 className="text-destructive font-semibold">
              {t("management.error.title")}
            </h1>
            <p className="text-muted-foreground text-sm">{message}</p>
          </div>
          <Button type="button" variant="outline" onClick={onRetry}>
            {t("actions.retry")}
          </Button>
        </CardContent>
      </Card>
    </AppShellPage>
  );
}

function EmotionsTab({ anima }: { anima: PyAnimaResponse }) {
  const { t } = useTranslation("animas");
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">{t("management.emotionsTitle")}</h2>
      <EmotionalState
        emotionalState={anima.emotional_state}
        variant="inline"
        className="h-[min(32rem,60dvh)]"
      />
    </section>
  );
}

function ManagementPanel({
  anima,
  activeTab,
  displayName,
  identity,
  identityLoading,
  identityError,
  fallbackIdentity,
  profileThumbnail,
  backgroundImage,
  onTabChange,
  onStagePreview,
  onOpenStage,
}: {
  anima: PyAnimaResponse;
  activeTab: AnimaManagementTab;
  displayName: string;
  identity: string;
  identityLoading: boolean;
  identityError: boolean;
  fallbackIdentity: string;
  profileThumbnail: PyRuntimeImageReference | null;
  backgroundImage: RuntimeCatalogEntry | null;
  onTabChange: (tab: AnimaManagementTab) => void;
  onStagePreview: (target: ContentPreviewTarget) => void;
  /** Phone layouts show the stage on demand instead of beside the panel. */
  onOpenStage?: () => void;
}) {
  const { t } = useTranslation("animas");
  const { t: emotionT } = useTranslation("emotion");
  const emotion = buildEmotionPresentation(anima.emotional_state, emotionT);
  const [appearanceSection, setAppearanceSection] =
    useState<AnimaAppearanceSection | null>(null);
  const profileThumbnailMedia = useAnimaPresentationImage(profileThumbnail);
  const backgroundMedia = useRuntimeContentMediaUrl(backgroundImage);
  const tabListRef = useRef<HTMLDivElement>(null);
  // Phone tabs scroll sideways; centre a selected tab that is out of view.
  // Only the strip scrolls, never the page.
  useEffect(() => {
    const list = tabListRef.current;
    const active = list?.querySelector<HTMLElement>('[data-state="active"]');
    if (!list || !active) return;
    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.left >= listRect.left && activeRect.right <= listRect.right)
      return;
    list.scrollLeft +=
      activeRect.left - listRect.left - (listRect.width - activeRect.width) / 2;
  }, [activeTab]);

  return (
    <>
      <aside className="border-border/70 bg-card/80 m-3 flex min-w-0 flex-col rounded-[1.75rem] border shadow-xl shadow-black/10 backdrop-blur-md xl:my-5 xl:mr-5 xl:ml-0 xl:min-h-0 xl:flex-1 xl:overflow-hidden">
        <div className="px-5 pt-4 md:px-7 md:pt-5">
          <div className="flex min-w-0 items-center gap-3 sm:flex-wrap">
            <button
              type="button"
              onClick={() => setAppearanceSection("profile_image")}
              aria-label={t("management.customizeAppearance", {
                name: displayName,
              })}
              className="group focus-visible:ring-ring/50 hover:bg-muted/45 relative -ml-2 flex min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-2xl px-2 py-1 text-left transition-[background-color,box-shadow,transform] outline-none hover:shadow-sm focus-visible:ring-[3px] motion-reduce:transition-none"
            >
              {backgroundMedia.url ? (
                <>
                  <RuntimeImageFrame
                    src={backgroundMedia.url}
                    alt=""
                    presentation={runtimeImagePresentation(backgroundImage)}
                    className="pointer-events-none absolute inset-0 size-full opacity-[0.15] saturate-90 transition-opacity group-hover:opacity-50 group-focus-visible:opacity-50"
                  />
                  <span
                    className="bg-card/10 pointer-events-none absolute inset-0"
                    aria-hidden="true"
                  />
                </>
              ) : null}
              <h1 className="text-foreground relative z-10 min-w-0 truncate text-3xl leading-none font-semibold tracking-tight sm:text-4xl">
                {displayName}
              </h1>
              <span className="relative z-10 flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full sm:size-14">
                {profileThumbnailMedia.url ? (
                  <RuntimeImageFrame
                    src={profileThumbnailMedia.url}
                    alt=""
                    presentation={profileThumbnailMedia.presentation}
                    className="size-full rounded-full"
                  />
                ) : (
                  <span className="text-muted-foreground text-sm font-semibold">
                    {displayName.slice(0, 2).toLocaleUpperCase()}
                  </span>
                )}
              </span>
              <span
                className="bg-card/90 text-foreground/75 pointer-events-none absolute top-1.5 right-1.5 z-20 flex size-6 scale-90 items-center justify-center rounded-full opacity-0 shadow-sm backdrop-blur-sm transition-[opacity,transform] group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100"
                aria-hidden="true"
              >
                <ImageUp className="size-3.5" />
              </span>
            </button>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {onOpenStage ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="rounded-full"
                      aria-label={t("management.stage.open")}
                      onClick={onOpenStage}
                    >
                      <Eye className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("management.stage.open")}</TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onTabChange("emotions")}
                    aria-label={t("management.openEmotions", {
                      feeling: emotion.feeling.label,
                    })}
                    className="focus-visible:ring-ring/50 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full transition-opacity outline-none hover:opacity-80 focus-visible:ring-[3px]"
                  >
                    <EmotionMascot
                      src={emotion.feeling.mascot}
                      className="size-10"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{emotion.feeling.label}</TooltipContent>
              </Tooltip>
              <AnimaPageActions
                animaId={anima.id}
                name={displayName}
                pinned={Boolean(anima.pinned_at)}
              />
            </div>
          </div>

          <Tabs
            value={activeTab}
            onValueChange={(value) => {
              if (ANIMA_MANAGEMENT_TABS.includes(value as AnimaManagementTab)) {
                onTabChange(value as AnimaManagementTab);
              }
            }}
            className="mt-3"
          >
            <TabsList
              ref={tabListRef}
              className="border-border/70 flex h-auto w-full [scrollbar-width:none] justify-start overflow-x-auto rounded-none border-b bg-transparent p-0 sm:grid sm:grid-cols-5"
            >
              {ANIMA_MANAGEMENT_TABS.map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="text-muted-foreground data-[state=active]:text-foreground data-[state=active]:after:bg-primary relative shrink-0 rounded-none bg-transparent px-3 py-3 text-sm shadow-none after:absolute after:inset-x-2 after:bottom-[-1px] after:h-0.5 after:rounded-full after:bg-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none sm:px-1"
                >
                  {tabLabel(t, tab)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div
          className={`min-w-0 flex-1 px-5 md:px-7 xl:min-h-0 xl:overflow-y-auto ${
            activeTab === "loadout" ? "pb-5 md:pb-6" : "py-5 md:py-6"
          }`}
        >
          {activeTab === "overview" ? (
            <AnimaIdentitySection
              key={anima.id}
              animaId={anima.id}
              identity={identity}
              identityLoading={identityLoading}
              identityError={identityError}
              fallbackIdentity={fallbackIdentity}
            />
          ) : activeTab === "memories" ? (
            <AnimaMemoriesSection key={anima.id} animaId={anima.id} />
          ) : activeTab === "emotions" ? (
            <EmotionsTab anima={anima} />
          ) : activeTab === "loadout" ? (
            <AnimaLoadout animaId={anima.id} onStagePreview={onStagePreview} />
          ) : (
            <AnimaSettingsModal animaId={anima.id} />
          )}
        </div>
      </aside>
      <AnimaAppearanceDialog
        animaId={anima.id}
        animaName={displayName}
        profileThumbnail={profileThumbnail}
        section={appearanceSection}
        onSectionChange={setAppearanceSection}
        onOpenChange={(next) => !next && setAppearanceSection(null)}
      />
    </>
  );
}

/**
 * Composes one live character stage with URL-controlled management tabs. Only
 * the selected path Anima resolves detail, identity, and runtime data.
 */
export function AnimaDetailsPage({
  animaId,
  activeTab,
  onTabChange,
  onSelectAnima,
  onCreateAnima,
  createAnimaUnavailableReason,
}: AnimaDetailsPageProps) {
  const { t } = useTranslation("animas");
  const [stagePreview, dispatchStagePreview] = useReducer(
    reduceAnimaStagePreview,
    INITIAL_ANIMA_STAGE_PREVIEW_STATE,
  );
  const stagePreviewInvokerRef = useRef<HTMLElement | null>(null);
  const previousStageTargetKeyRef = useRef<string | null>(null);
  const stagePreparation = usePreparedContentPreview(stagePreview.target, {
    enabled: Boolean(stagePreview.target),
    owner: "management",
  });
  const rosterLayout = useAnimaRosterLayout();
  const isDesktopLayout = rosterLayout === "desktop";
  const isPhoneLayout = rosterLayout === "phone";
  const shortViewport = useShortAnimaViewport();
  // Phones show the management panel as the page and open the stage
  // full-screen on request or for a preview, so no canvas runs behind it.
  const [phoneStageOpen, setPhoneStageOpen] = useState(false);
  const animasQuery = useAnimas();
  const animaQuery = useAnima(animaId, { enabled: Boolean(animaId) });
  const runtimeSnapshotQuery = useAnimaRuntimeCatalog(animaId);
  const runtimeContent = useMemo(
    () =>
      runtimeSnapshotQuery.data
        ? adaptRuntimeSnapshot(runtimeSnapshotQuery.data)
        : undefined,
    [runtimeSnapshotQuery.data],
  );
  const runtimeContentQuery = { ...runtimeSnapshotQuery, data: runtimeContent };
  const identityQuery = useMemoryEntryByPath({
    animaId,
    path: "IDENTITY.md",
    type: "file",
    enabled: Boolean(animaId),
  });
  const sortedAnimas = sortAnimasByRecent(animasQuery.data ?? []);
  const orderedAnimaIds = sortedAnimas.map((anima) => anima.id);
  const selectedIndex = orderedAnimaIds.indexOf(animaId);
  const anima = animaQuery.data ?? null;
  const selectedAnima = sortedAnimas.find(
    (candidate) => candidate.id === animaId,
  );

  const openStagePreview = useCallback(
    (target: ContentPreviewTarget): void => {
      if (!isAnimaStagePreviewTarget(target)) return;
      // Only phones show the stage on demand; wider layouts keep it docked.
      if (isPhoneLayout) setPhoneStageOpen(true);
      toast.dismiss(STAGE_PREVIEW_TOAST_ID);
      if (document.activeElement instanceof HTMLElement) {
        stagePreviewInvokerRef.current = document.activeElement;
      }
      logContentPreviewLifecycle(
        previousStageTargetKeyRef.current &&
          previousStageTargetKeyRef.current !== target.key
          ? "target_replacement"
          : "preview_open",
        "management",
        {
          kind: target.kind,
          slot: target.slot,
          sourceType: target.sourceType,
        },
      );
      previousStageTargetKeyRef.current = target.key;
      dispatchStagePreview({ type: "select", target });
    },
    [isPhoneLayout],
  );
  const stopStagePreview = useCallback(() => {
    toast.dismiss(STAGE_PREVIEW_TOAST_ID);
    dispatchStagePreview({ type: "stop" });
    previousStageTargetKeyRef.current = null;
    const invoker = stagePreviewInvokerRef.current;
    stagePreviewInvokerRef.current = null;
    if (!invoker?.isConnected) return;
    window.requestAnimationFrame(() => invoker.focus());
  }, []);
  const closePhoneStage = useCallback(() => {
    setPhoneStageOpen(false);
    // A stage opened with View Avatar has no preview to stop; the dialog
    // returns focus to its trigger.
    if (stagePreview.target) stopStagePreview();
  }, [stagePreview.target, stopStagePreview]);

  // Leaving the phone layout closes its stage, so it cannot reopen unasked.
  useEffect(() => {
    if (!isPhoneLayout) setPhoneStageOpen(false);
  }, [isPhoneLayout]);

  useEffect(() => {
    if (!stagePreparation.prepared) return;
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    dispatchStagePreview({
      type: "prepared",
      prepared: stagePreparation.prepared,
      autoplay: shouldAutoplayContentPreview(prefersReducedMotion),
    });
  }, [stagePreparation.prepared]);

  useEffect(() => {
    if (!stagePreparation.error) return;
    dispatchStagePreview({
      type: "status",
      status: "error",
      error: stagePreparation.error,
    });
  }, [stagePreparation.error]);
  // The stage shows only a Stop button, so a failed preview is reported here,
  // with Retry while its content could not be prepared.
  const { retry: retryStagePreparation } = stagePreparation;
  useEffect(() => {
    if (!stagePreview.target || !stagePreview.error) return;
    toast.error(
      t("management.preview.status", {
        name: stagePreview.target.displayName,
        status: stagePreview.error,
      }),
      {
        id: STAGE_PREVIEW_TOAST_ID,
        action: stagePreview.prepared
          ? undefined
          : {
              label: t("actions.retry"),
              onClick: () => void retryStagePreparation(),
            },
      },
    );
  }, [
    retryStagePreparation,
    stagePreview.error,
    stagePreview.prepared,
    stagePreview.target,
    t,
  ]);
  const handleStagePreviewStatus = useCallback(
    (status: ContentPreviewLoadStatus, message?: string) => {
      if (status === "playing") {
        logContentPreviewLifecycle("first_playable_frame", "management");
      }
      dispatchStagePreview({ type: "status", status, error: message });
    },
    [],
  );

  useEffect(() => {
    if (
      stagePreview.target &&
      (activeTab !== "loadout" ||
        stagePreview.target.animaContext?.animaId !== animaId)
    ) {
      dispatchStagePreview({ type: "stop" });
      previousStageTargetKeyRef.current = null;
    }
  }, [activeTab, animaId, stagePreview.target]);

  const selectAdjacent = (direction: -1 | 1) => {
    const nextAnimaId = adjacentAnimaId(orderedAnimaIds, animaId, direction);
    if (nextAnimaId && nextAnimaId !== animaId) {
      onSelectAnima(nextAnimaId, activeTab);
    }
  };

  if (animasQuery.isPending || animaQuery.isLoading) {
    return <LoadingManagementWorkspace />;
  }

  if (animasQuery.isError) {
    return (
      <ManagementError
        message={t("management.error.roster")}
        onRetry={() => void animasQuery.refetch()}
      />
    );
  }

  if (animaQuery.isError || !anima) {
    return (
      <ManagementError
        message={t("management.error.anima")}
        onRetry={() => void animaQuery.refetch()}
      />
    );
  }

  const displayName = getAnimaDisplayName(anima);
  const fallbackIdentity = anima.avatar?.identity?.trim() ?? "";
  const identity = resolveAnimaIdentityContent(
    identityQuery.data?.content,
    fallbackIdentity,
  );
  const avatarRuntimeContent = runtimeContentQuery.data?.avatar_model ?? null;
  const avatarUrl = runtimeContentDeliveryUrl(avatarRuntimeContent);
  const canMove = sortedAnimas.length > 1 && selectedIndex >= 0;

  const gestureHint = (
    <>
      <MousePointer2 className="size-3.5" />
      <span className="min-[360px]:hidden">
        {t("management.gestureHint.short")}
      </span>
      <span className="hidden min-[360px]:inline md:hidden">
        {t("management.gestureHint.pinch")}
      </span>
      <span className="hidden md:inline xl:hidden">
        {t("management.gestureHint.touch")}
      </span>
      <span className="hidden xl:inline">
        {t("management.gestureHint.pointer")}
      </span>
    </>
  );

  const renderStage = (presentation: "docked" | "phone") => (
    <AnimaAvatarStage
      animaId={animaId}
      animaName={displayName}
      avatarUrl={avatarUrl}
      avatarRuntimeContentEntry={avatarRuntimeContent}
      runtimeContent={runtimeContentQuery.data}
      contentPreview={stagePreview.prepared}
      contentPreviewTarget={stagePreview.target}
      contentPreviewStatus={stagePreview.status}
      contentPreviewLoop={stagePreview.loop}
      contentPreviewPlayRequest={stagePreview.playRequest}
      onContentPreviewStatusChange={handleStagePreviewStatus}
      camera={
        presentation === "phone" && shortViewport
          ? ANIMA_SHOWCASE_SHORT_CAMERA
          : ANIMA_SHOWCASE_CAMERAS[rosterLayout]
      }
      orbitTarget={ANIMA_SHOWCASE_ORBIT_TARGET}
      showMetadata={false}
      emptyTitle={
        runtimeContentQuery.isLoading
          ? t("management.avatar.preparingTitle")
          : runtimeContentQuery.isError
            ? t("management.avatar.unavailableTitle")
            : undefined
      }
      emptyDescription={
        runtimeContentQuery.isLoading
          ? t("management.avatar.preparingDescription")
          : runtimeContentQuery.isError
            ? t("management.avatar.unavailableDescription")
            : undefined
      }
      className="h-full min-h-0"
      backdrop={
        presentation === "phone" ? (
          <StageBackgroundLayer variant="showcase" />
        ) : (
          <StageBackgroundLayer
            variant="showcase"
            className="[mask-image:linear-gradient(to_right,transparent,black_18%,black_82%,transparent)]"
          />
        )
      }
      transparent
      overlay={
        <>
          {presentation === "docked" ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                disabled={!canMove}
                aria-label={t("carousel.previous")}
                onClick={() => selectAdjacent(-1)}
                className="bg-background/88 pointer-events-auto absolute top-[43%] left-[calc(var(--app-shell-sidebar-inset)+1.25rem)] -translate-y-1/2 rounded-full shadow-lg backdrop-blur-md md:left-[calc(var(--app-shell-sidebar-inset)+2rem)]"
              >
                <ChevronLeft className="size-5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                disabled={!canMove}
                aria-label={t("carousel.next")}
                onClick={() => selectAdjacent(1)}
                className="bg-background/88 pointer-events-auto absolute top-[43%] right-5 -translate-y-1/2 rounded-full shadow-lg backdrop-blur-md md:right-8"
              >
                <ChevronRight className="size-5" />
              </Button>
            </>
          ) : null}

          <div
            className={cn(
              "bg-background/84 text-muted-foreground absolute left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-xl border px-3 py-2 text-xs shadow-md backdrop-blur-md",
              presentation === "phone"
                ? "bottom-[max(1.5rem,env(safe-area-inset-bottom))]"
                : "bottom-[7.75rem] md:bottom-[10rem] xl:bottom-[10.25rem]",
            )}
          >
            {gestureHint}
          </div>

          {stagePreview.target ? (
            <div
              role="region"
              aria-label={t("management.preview.region", {
                name: stagePreview.target.displayName,
              })}
              aria-busy={stagePreview.status === "loading"}
              className={cn(
                "pointer-events-auto absolute",
                presentation === "phone"
                  ? "top-[max(1rem,env(safe-area-inset-top))] right-4"
                  : "top-5 right-5",
              )}
            >
              <p
                className="sr-only"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {t("management.preview.status", {
                  name: stagePreview.target.displayName,
                  status:
                    stagePreview.error ??
                    stagePreviewStatusLabel(t, stagePreview.status),
                })}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="bg-background/85 min-h-10 shadow-sm backdrop-blur-sm"
                aria-label={t("management.preview.stop", {
                  name: stagePreview.target.displayName,
                })}
                onClick={stopStagePreview}
              >
                <Square className="size-3.5" /> {t("actions.stop")}
              </Button>
            </div>
          ) : null}

          {runtimeContentQuery.isError ? (
            <div className="pointer-events-auto absolute inset-x-0 top-[43%] flex -translate-y-1/2 justify-center px-16">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runtimeContentQuery.refetch()}
              >
                {t("management.avatar.retry")}
              </Button>
            </div>
          ) : null}
        </>
      }
    />
  );

  const carousel = (
    <AnimaCarousel
      animas={sortedAnimas}
      selectedAnimaId={animaId}
      onSelect={(nextAnimaId) => onSelectAnima(nextAnimaId, activeTab)}
      onPrevious={() => selectAdjacent(-1)}
      onNext={() => selectAdjacent(1)}
      onCreate={onCreateAnima}
      createUnavailableReason={createAnimaUnavailableReason}
      compact={isPhoneLayout}
      showNavigationButtons={false}
    />
  );

  const managementPanel = (
    <ManagementPanel
      anima={anima}
      activeTab={activeTab}
      displayName={displayName}
      identity={identity}
      identityLoading={identityQuery.isLoading}
      identityError={identityQuery.isError}
      fallbackIdentity={fallbackIdentity}
      profileThumbnail={selectedAnima?.presentation.profile_thumbnail ?? null}
      backgroundImage={runtimeContentQuery.data?.background_image ?? null}
      onTabChange={onTabChange}
      onStagePreview={openStagePreview}
      onOpenStage={isPhoneLayout ? () => setPhoneStageOpen(true) : undefined}
    />
  );

  return (
    <AppShellPage
      className="min-h-app xl:h-app xl:overflow-hidden"
      contentClassName="min-h-full max-w-none gap-0 px-0 py-0 md:px-0 md:py-0 lg:px-0 xl:h-full xl:min-h-0"
      backdrop={
        // A soft, full-window wash of the stage image reaches behind the
        // frosted sidebar and panel; the stage column draws it sharply.
        <StageBackgroundLayer
          variant="showcase"
          className="fixed inset-0 scale-110 opacity-60 blur-2xl"
        />
      }
      sidebarBehavior="adaptive-canvas"
    >
      {isPhoneLayout ? (
        // Landscape phones show the icon rail; keep the panel clear of it.
        <div className="relative z-10 flex min-h-full min-w-0 flex-col pl-[var(--app-shell-sidebar-inset)]">
          <div className="flex items-center gap-1 px-3 pt-3">
            <SidebarMenuButton />
            <div className="min-w-0 flex-1">{carousel}</div>
          </div>
          {managementPanel}
          <Dialog
            open={phoneStageOpen}
            onOpenChange={(open) => {
              if (!open) closePhoneStage();
            }}
          >
            <DialogContent
              showCloseButton={false}
              aria-describedby={undefined}
              // Keep the stage open while the preview error toast is used.
              onInteractOutside={(event) => event.preventDefault()}
              // Above the icon rail (z-120), below sidebar menus (z-130).
              className="bg-background inset-0 top-0 left-0 z-[125] block h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 rounded-none p-0 ring-0 sm:max-w-none"
            >
              <DialogTitle className="sr-only">
                {t("management.stage.title", { name: displayName })}
              </DialogTitle>
              {renderStage("phone")}
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label={t("management.stage.close")}
                onClick={closePhoneStage}
                className="bg-background/88 absolute top-[max(1rem,env(safe-area-inset-top))] left-4 z-40 rounded-full shadow-lg backdrop-blur-md"
              >
                <X className="size-5" />
              </Button>
            </DialogContent>
          </Dialog>
        </div>
      ) : (
        <div
          className={cn(
            "relative min-h-full min-w-0",
            isDesktopLayout
              ? "grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(30rem,34rem)] overflow-hidden 2xl:grid-cols-[minmax(0,1fr)_minmax(34rem,40rem)]"
              : "flex flex-col",
          )}
        >
          <section
            className={cn(
              "relative z-10 min-w-0 overflow-hidden",
              isDesktopLayout
                ? "h-full min-h-0"
                : "h-[min(46rem,72dvh)] min-h-[34rem]",
            )}
          >
            {renderStage("docked")}

            <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 z-40 w-[calc(100%-1.5rem)] max-w-[52rem] -translate-x-1/2 md:bottom-4 md:w-[calc(100%-2rem)] xl:bottom-5 xl:max-w-[43rem]">
              {carousel}
            </div>
          </section>

          <div className="relative z-10 min-w-0 xl:flex xl:min-h-0">
            {managementPanel}
          </div>
        </div>
      )}
    </AppShellPage>
  );
}
