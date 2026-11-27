import { useProductApiClient } from "@animama/product-ui";

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  List,
  Loader2,
  Lock,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
} from "lucide-react";

import type {
  ContentKind,
  PyAvatarCatalogItem,
  PyCatalogViewItem,
} from "@/lib/content/catalogTypes";
import {
  previewCatalogItem,
  previewTypedCatalogItem,
} from "@/lib/content/catalogApi";
import { typedActionPreview } from "@/lib/content/typedPreviewAdapters";
import { avatarPreviewTarget } from "@/lib/content/avatarPreviewTarget";
import { componentPreviewTarget } from "@/lib/content/componentPreviewTarget";
import {
  contentInventoryGroups,
  type LibraryInventoryGroup,
} from "@/lib/content/libraryContentInventory";
import {
  effectLibraryCard,
  avatarLibraryDescription,
  filterAndSortLibraryGestures,
  libraryProductActionPolicy,
  libraryRowPresentation,
  actionLibraryCard,
  poseLibraryCard,
  type LibraryProductCard,
} from "@/lib/content/libraryPresentation";
import type { ContentLibrarySearch } from "@/lib/content/librarySearch";
import { actionPreviewTarget } from "@/lib/content-preview/actionPreviewTarget";
import { posePreviewTarget } from "@/lib/content-preview/posePreviewTarget";
import { usePoses } from "@/query/hooks/usePoses";
import { useAvatarCatalog } from "@/query/hooks/useAvatarCatalog";
import { useEffects } from "@/query/hooks/useEffects";
import { useGestures, useReactions } from "@/query/hooks/useActions";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import { RuntimeFeatureGate } from "@/ui/app/RuntimeFeatureGate";
import { useContentPreviewDock } from "@/ui/content-preview/ContentPreviewDockProvider";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui/components/tooltip";
import { UnavailableAction } from "@/ui/components/unavailable-action";
import type { DeleteFocusTargets } from "@/ui/components/useDeleteReturnFocus";
import {
  ContentDeleteDialog,
  type ContentToDelete,
} from "@/ui/content-delete/ContentDeleteDialog";
import { SoundPickerPreview } from "@/ui/sound-preview/SoundPickerPreview";
import {
  ActionManageDialog,
  type ManageActionTarget,
} from "@/ui/action-manage/ActionManageDialog";
import {
  LibraryAvatarSettingsDialog,
  type LibraryAvatarTarget,
} from "./LibraryAvatarSettingsDialog";
import { LibrarySoundDialog } from "./LibrarySoundDialog";
import { LibraryFilterMenu } from "./LibraryFilterMenu";
import { LibraryItemMenu } from "./LibraryItemMenu";
import { LibraryProductRow, type LibraryLayout } from "./LibraryProductRow";
import { useLibraryLayout } from "./useLibraryLayout";
import { useSearchDraft } from "./useSearchDraft";

type SearchUpdate = (update: Partial<ContentLibrarySearch>) => void;

/** The content kind each Library product family deletes as. */
const CARD_CONTENT_KINDS = {
  gesture: "gesture",
  reaction: "reaction",
  pose: "pose",
  particle: "particle_effect",
  "avatar-effect": "avatar_effect",
  scene: "scene_effect",
  sound: "sound_effect",
} as const satisfies Record<LibraryProductCard["family"], ContentKind>;

function ProductGroup({
  id,
  title,
  children,
  footer,
  layout,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  layout: LibraryLayout;
}) {
  const [expanded, setExpanded] = useState(true);
  const contentId = `library-${id}-content`;
  const headingId = `library-${id}-heading`;
  return (
    <section className="space-y-3" aria-labelledby={headingId}>
      <h2
        id={headingId}
        className="bg-background/95 sticky top-28 z-20 backdrop-blur-sm"
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((current) => !current)}
          className="hover:bg-muted/30 focus-visible:ring-ring flex w-full items-center justify-start gap-2 rounded-lg px-3 py-2 text-left outline-none focus-visible:ring-2"
        >
          <span className="truncate text-lg font-semibold">{title}</span>
          {expanded ? (
            <ChevronDown className="size-4 shrink-0" />
          ) : (
            <ChevronRight className="size-4 shrink-0" />
          )}
        </button>
      </h2>
      {expanded ? (
        // Item menus find a surviving item here after a delete.
        <div id={contentId} data-library-group-items="" className="space-y-3">
          <div
            className={
              layout === "grid"
                ? "grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] sm:gap-3"
                : "overflow-hidden rounded-xl border"
            }
          >
            {children}
          </div>
          {footer}
        </div>
      ) : null}
    </section>
  );
}

function InventoryState({
  pending,
  error,
  empty,
  onRetry,
}: {
  pending: boolean;
  error: unknown;
  empty: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation("library");
  if (pending)
    return (
      <p className="text-muted-foreground col-span-full rounded-xl border p-4 text-sm">
        {t("inventory.loading")}
      </p>
    );
  if (error)
    return (
      <div
        role="alert"
        className="col-span-full flex items-center justify-between gap-3 p-4"
      >
        <p className="text-destructive text-sm">{t("inventory.loadFailed")}</p>
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t("inventory.retry")}
          </Button>
        ) : null}
      </div>
    );
  if (empty)
    return (
      <p className="text-muted-foreground col-span-full rounded-xl border border-dashed p-4 text-sm">
        {t("inventory.noMatches")}
      </p>
    );
  return null;
}

/** Grid actions retain their accessible name and reveal labels after a short hover. */
function ActionTooltip({
  label,
  layout,
  children,
}: {
  label: string;
  layout: LibraryLayout;
  children: ReactElement;
}) {
  if (layout === "list") return children;
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ProductRow({
  card,
  onPreview,
  onManage,
  onDelete,
  previewing = false,
  layout,
}: {
  card: LibraryProductCard;
  onPreview: () => void;
  onManage?: () => void;
  /** Open the delete confirmation; offered only for deletable Local items. */
  onDelete: (focus: DeleteFocusTargets) => void;
  previewing?: boolean;
  layout: LibraryLayout;
}) {
  const { t } = useTranslation("library");
  const itemId = card.itemId;
  const componentType =
    card.family === "particle"
      ? "particle_effect"
      : card.family === "avatar-effect"
        ? "avatar_effect"
        : card.family === "scene"
          ? "scene_effect"
          : "sound_effect";
  const editPaths = {
    pose: "/poses",
    gesture: "/gestures",
    reaction: "/reactions",
    particle: "/particle-effects",
    "avatar-effect": "/avatar-effects",
    scene: "/scene-effects",
    sound: "/library",
  } as const;
  const editPath = `${editPaths[card.family]}/${encodeURIComponent(itemId)}/edit`;
  const policy = libraryProductActionPolicy(card);
  const previewLabel =
    card.family === "sound"
      ? previewing
        ? t("inventory.actions.stop")
        : t("inventory.actions.play")
      : t("inventory.actions.preview");
  const manageSoundLabel = t("inventory.actions.manageSound");
  const notEditableLabel = t("inventory.actions.notEditable");
  const editLabel = t("inventory.actions.edit");
  const manageLabel = t("inventory.actions.manage");
  const useInGestureLabel = t("inventory.actions.useInGesture");
  const useInReactionLabel = t("inventory.actions.useInReaction");
  return (
    <LibraryProductRow
      layout={layout}
      row={libraryRowPresentation(card)}
      thumbnailUrl={card.thumbnailUrl}
      particleThumbnail={card.particleThumbnail}
      actions={
        <>
          {policy.preview ? (
            <ActionTooltip label={previewLabel} layout={layout}>
              <Button
                size={layout === "grid" ? "icon-sm" : "sm"}
                variant="outline"
                onClick={onPreview}
                aria-label={previewLabel}
              >
                {previewing ? <Pause /> : <Play />}
                {layout === "list" ? ` ${previewLabel}` : null}
              </Button>
            </ActionTooltip>
          ) : null}
          {card.family === "sound" && onManage ? (
            <ActionTooltip label={manageSoundLabel} layout={layout}>
              <Button
                size={layout === "grid" ? "icon-sm" : "sm"}
                variant="outline"
                onClick={onManage}
                aria-label={manageSoundLabel}
              >
                <Pencil />
                {layout === "list"
                  ? ` ${t("inventory.actions.manageShort")}`
                  : null}
              </Button>
            </ActionTooltip>
          ) : policy.editUnavailableReason ? (
            // Opens the preview-only page, which explains the restriction to
            // every user; the tooltip (on hover or focus, in both layouts)
            // and the description repeat the reason here.
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  size={layout === "grid" ? "icon-sm" : "sm"}
                  variant="outline"
                  asChild
                >
                  <Link
                    to={editPath}
                    aria-label={notEditableLabel}
                    aria-describedby={`not-editable-${card.key}`}
                  >
                    <Lock />
                    {layout === "list" ? ` ${notEditableLabel}` : null}
                    <span id={`not-editable-${card.key}`} className="sr-only">
                      {policy.editUnavailableReason}
                    </span>
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{policy.editUnavailableReason}</TooltipContent>
            </Tooltip>
          ) : policy.edit ? (
            <ActionTooltip label={editLabel} layout={layout}>
              <Button
                size={layout === "grid" ? "icon-sm" : "sm"}
                variant="outline"
                asChild
              >
                <Link to={editPath} aria-label={editLabel}>
                  <Pencil />
                  {layout === "list" ? ` ${editLabel}` : null}
                </Link>
              </Button>
            </ActionTooltip>
          ) : null}
          {policy.manage && onManage ? (
            <ActionTooltip label={manageLabel} layout={layout}>
              <Button
                size={layout === "grid" ? "icon-sm" : "sm"}
                onClick={onManage}
                aria-label={manageLabel}
              >
                <Plus />
                {layout === "list" ? manageLabel : null}
              </Button>
            </ActionTooltip>
          ) : null}
          {policy.useInGesture ? (
            <ActionTooltip label={useInGestureLabel} layout={layout}>
              <Button size={layout === "grid" ? "icon-sm" : "sm"} asChild>
                <Link
                  to="/gestures/new"
                  search={{ component: card.itemId, componentType }}
                  aria-label={useInGestureLabel}
                >
                  <WandSparkles />
                  {layout === "list" ? ` ${useInGestureLabel}` : null}
                </Link>
              </Button>
            </ActionTooltip>
          ) : null}
          {policy.useInReaction ? (
            <ActionTooltip label={useInReactionLabel} layout={layout}>
              <Button size={layout === "grid" ? "icon-sm" : "sm"} asChild>
                <Link
                  to="/reactions/new"
                  search={{ component: card.itemId, componentType }}
                  aria-label={useInReactionLabel}
                >
                  <WandSparkles />
                  {layout === "list" ? ` ${useInReactionLabel}` : null}
                </Link>
              </Button>
            </ActionTooltip>
          ) : null}
          {policy.delete ? (
            <LibraryItemMenu name={card.name} onDelete={onDelete} />
          ) : null}
        </>
      }
    />
  );
}

function LoadMore({
  query,
}: {
  query: {
    hasNextPage?: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => Promise<unknown>;
  };
}) {
  const { t } = useTranslation("library");
  return query.hasNextPage ? (
    <Button
      variant="outline"
      size="sm"
      disabled={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}
    >
      {query.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
      {t("inventory.loadMore")}
    </Button>
  ) : null;
}

/** Typed product inventory; every group retains its own cursor and request. */
export function LibraryContentInventory({
  search,
  onSearchChange,
}: {
  search: ContentLibrarySearch;
  onSearchChange: SearchUpdate;
}) {
  const apiClient = useProductApiClient();
  const { t } = useTranslation("library");

  const [layout, setLayout] = useLibraryLayout();
  const [queryDraft, setQueryDraft] = useSearchDraft(
    search.query,
    useCallback(
      (query: string | undefined) => onSearchChange({ query }),
      [onSearchChange],
    ),
  );
  const groups = contentInventoryGroups(search);
  const includes = (group: LibraryInventoryGroup) => groups.includes(group);
  const origin = search.showStarters ? "all" : "owned";
  // Previews are on unless the runtime says it offers none; a runtime that
  // predates the capability omits it and keeps them.
  const previews = useRuntimeCapabilities().data?.library_previews !== false;
  const gestures = useGestures({
    query: search.query,
    origin,
    sort: search.sort,
    implementationKind:
      search.gestureMotion === "all" ? undefined : search.gestureMotion,
    enabled: includes("gestures"),
  });
  const poses = usePoses({
    query: search.query,
    origin,
    enabled: includes("poses"),
  });
  const reactions = useReactions({
    query: search.query,
    origin,
    sort: search.sort,
    enabled: includes("reactions"),
  });
  const {
    particles,
    sounds,
    avatars: avatarEffects,
    scenes,
  } = useEffects({
    query: search.query,
    origin,
    sort: search.sort,
    enabledFamilies: {
      particles: includes("particle"),
      sounds: includes("sound"),
      avatars: includes("avatar-effects"),
      scenes: includes("scene"),
    },
  });
  const avatars = useAvatarCatalog({
    query: search.query,
    origin,
    sort: search.sort,
    enabled: includes("avatars"),
  });
  const [avatarSettings, setAvatarSettings] =
    useState<LibraryAvatarTarget | null>(null);
  const [managedSound, setManagedSound] = useState<PyCatalogViewItem | null>(
    null,
  );
  const [manage, setManage] = useState<ManageActionTarget | null>(null);
  const [deleting, setDeleting] = useState<ContentToDelete | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const soundPreview = useMemo(
    () =>
      new SoundPickerPreview((id, error) => {
        setPreviewingId(id);
        setPreviewError(error ?? null);
      }),
    [],
  );
  useEffect(
    () => () => soundPreview.stop(),
    [soundPreview, search.section, search.type, search.fx],
  );
  const { openPreview } = useContentPreviewDock();
  const gestureRows = useMemo(() => {
    const cards = (
      gestures.data?.pages.flatMap((page) => page.items) ?? []
    ).map((item) => actionLibraryCard("gesture", item));
    return filterAndSortLibraryGestures(cards, {
      gestureUpdatesOnly: search.gestureUpdatesOnly,
      gestureStatus: search.gestureStatus,
      gestureSort: search.gestureSort,
    });
  }, [
    gestures.data,
    search.gestureSort,
    search.gestureStatus,
    search.gestureUpdatesOnly,
  ]);
  const reactionRows = useMemo(
    () =>
      (reactions.data?.pages.flatMap((page) => page.items) ?? []).map((item) =>
        actionLibraryCard("reaction", item),
      ),
    [reactions.data],
  );
  const effectRows = (
    family: "particle" | "avatar-effect" | "scene" | "sound",
    values: PyCatalogViewItem[],
  ) => values.map((item) => effectLibraryCard(family, item, previews));

  const previewPose = (card: LibraryProductCard) => {
    const item = poses.data?.items.find(
      (candidate) => candidate.item_id === card.itemId,
    );
    if (!item) return;
    soundPreview.stop();
    openPreview(posePreviewTarget(item));
  };
  const previewAction = async (card: LibraryProductCard) => {
    if (!card.source) return;
    soundPreview.stop();
    if (card.source.type !== "catalog") return;
    const preview = typedActionPreview(
      await previewTypedCatalogItem(
        apiClient,
        card.family as "gesture" | "reaction",
        card.source.catalog_item_id,
      ),
    );
    openPreview(actionPreviewTarget(preview, card.name));
  };
  const previewEffect = async (card: LibraryProductCard) => {
    if (card.family === "sound") {
      if (previewingId === card.itemId) soundPreview.stop();
      else void soundPreview.play(apiClient, card.itemId);
      return;
    }
    if (!card.source) return;
    soundPreview.stop();
    if (card.source.type !== "catalog") return;
    const kind = (
      {
        particle: "particle_effect",
        sound: "sound_effect",
        "avatar-effect": "avatar_effect",
        scene: "scene_effect",
      } as const
    )[card.family as "particle" | "sound" | "avatar-effect" | "scene"];
    const preview = await previewCatalogItem(
      apiClient,
      card.source.catalog_item_id,
      undefined,
      kind,
    );
    if (card.family === "particle") {
      openPreview(
        componentPreviewTarget(preview, "particle_effect", card.name),
      );
    } else if (card.family === "avatar-effect" || card.family === "scene") {
      openPreview(
        componentPreviewTarget(
          preview,
          card.family === "avatar-effect" ? "avatar_effect" : "scene_effect",
          card.name,
        ),
      );
    }
  };
  const previewAvatar = async (avatar: PyAvatarCatalogItem) => {
    if (!avatar.catalog_item_id) return;
    soundPreview.stop();
    const preview = await previewCatalogItem(
      apiClient,
      avatar.catalog_item_id,
      undefined,
      "avatar",
    );
    openPreview(avatarPreviewTarget(preview, avatar.name));
  };
  const manageCard = (card: LibraryProductCard) =>
    card.source &&
    setManage({
      kind: card.family as "gesture" | "reaction",
      itemId: card.itemId,
      name: card.name,
      description: card.description,
      source: card.source,
      emotion: card.emotion,
      intensity: card.intensity,
      includedCount: card.includedCount,
    });
  const renderCards = (cards: LibraryProductCard[]) =>
    cards.map((card) => (
      <ProductRow
        key={card.key}
        card={card}
        layout={layout}
        previewing={card.family === "sound" && previewingId === card.itemId}
        onPreview={() =>
          void (card.family === "pose"
            ? previewPose(card)
            : card.family === "gesture" || card.family === "reaction"
              ? previewAction(card)
              : previewEffect(card))
        }
        onManage={
          card.family === "gesture" || card.family === "reaction"
            ? () => manageCard(card)
            : card.family === "sound"
              ? () => {
                  soundPreview.stop();
                  const item = sounds.data?.pages
                    .flatMap((page) => page.items)
                    .find((candidate) => candidate.item_id === card.itemId);
                  if (item) setManagedSound(item);
                }
              : undefined
        }
        onDelete={(focus) => {
          soundPreview.stop();
          setDeleting({
            itemId: card.itemId,
            kind: CARD_CONTENT_KINDS[card.family],
            name: card.name,
            revision: card.revision ?? null,
            focus,
          });
        }}
      />
    ));

  const typedGroups: Array<{
    id: LibraryInventoryGroup;
    title: string;
    cards: LibraryProductCard[];
    query?: typeof gestures | typeof poses;
  }> = [
    {
      id: "gestures",
      title: t("inventory.groups.gestures"),
      cards: gestureRows,
      query: gestures,
    },
    {
      id: "reactions",
      title: t("inventory.groups.reactions"),
      cards: reactionRows,
      query: reactions as typeof gestures,
    },
    {
      id: "poses",
      title: t("inventory.groups.poses"),
      cards: (poses.data?.items ?? []).map(poseLibraryCard),
      query: poses,
    },
    {
      id: "particle",
      title: t("inventory.groups.particleEffects"),
      cards: effectRows(
        "particle",
        particles.data?.pages.flatMap((page) => page.items) ?? [],
      ),
      query: particles as typeof gestures,
    },
    {
      id: "avatar-effects",
      title: t("inventory.groups.avatarEffects"),
      cards: effectRows(
        "avatar-effect",
        avatarEffects.data?.pages.flatMap((page) => page.items) ?? [],
      ),
      query: avatarEffects as typeof gestures,
    },
    {
      id: "scene",
      title: t("inventory.groups.sceneEffects"),
      cards: effectRows(
        "scene",
        scenes.data?.pages.flatMap((page) => page.items) ?? [],
      ),
      query: scenes as typeof gestures,
    },
    {
      id: "sound",
      title: t("inventory.groups.soundEffects"),
      cards: effectRows(
        "sound",
        sounds.data?.pages.flatMap((page) => page.items) ?? [],
      ),
      query: sounds as typeof gestures,
    },
  ];
  return (
    <div className="space-y-3">
      <div className="bg-background/95 sticky top-11 z-30 flex items-center gap-2 py-3 backdrop-blur-sm sm:gap-3">
        <label className="relative min-w-0 flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            className="h-11 pl-9"
            value={queryDraft}
            maxLength={80}
            placeholder={t("inventory.search")}
            onChange={(event) => setQueryDraft(event.target.value)}
          />
        </label>
        <div
          role="group"
          aria-label={t("inventory.layout.label")}
          className="flex items-center gap-1 rounded-lg border p-1"
        >
          {(
            [
              ["grid", t("inventory.layout.grid"), LayoutGrid],
              ["list", t("inventory.layout.list"), List],
            ] as const
          ).map(([value, label, Icon]) => (
            <Tooltip key={value} delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant={layout === value ? "secondary" : "ghost"}
                  aria-label={label}
                  aria-pressed={layout === value}
                  onClick={() => setLayout(value)}
                >
                  <Icon aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <LibraryFilterMenu search={search} onSearchChange={onSearchChange} />
      </div>
      {groups.includes("avatars") ? (
        <div>
          <ProductGroup
            layout={layout}
            id="avatars"
            title={t("inventory.groups.avatars")}
            footer={<LoadMore query={avatars} />}
          >
            <InventoryState
              pending={avatars.isPending}
              error={avatars.error}
              empty={
                avatars.data !== undefined &&
                !avatars.data.pages.some((page) => page.items.length)
              }
              onRetry={() => void avatars.refetch()}
            />
            {(avatars.data?.pages.flatMap((page) => page.items) ?? []).map(
              (avatar) => (
                <LibraryProductRow
                  key={avatar.avatar_id}
                  layout={layout}
                  portraitUrl={avatar.preview_url}
                  row={{
                    family: "avatar",
                    name: avatar.name,
                    description: avatarLibraryDescription(avatar.description),
                    metadata: [],
                    origin: avatar.origin === "local" ? "Mine" : "Built-in",
                  }}
                  actions={
                    <>
                      <ActionTooltip
                        label={t("inventory.actions.preview")}
                        layout={layout}
                      >
                        <Button
                          size={layout === "grid" ? "icon-sm" : "sm"}
                          variant="outline"
                          disabled={!avatar.catalog_item_id}
                          onClick={() => void previewAvatar(avatar)}
                          aria-label={t("inventory.actions.preview")}
                        >
                          <Play />
                          {layout === "list"
                            ? ` ${t("inventory.actions.preview")}`
                            : null}
                        </Button>
                      </ActionTooltip>
                      {avatar.catalog_item_id ? (
                        <ActionTooltip
                          label={t("inventory.actions.avatarSettings")}
                          layout={layout}
                        >
                          <Button
                            size={layout === "grid" ? "icon-sm" : "sm"}
                            variant="outline"
                            onClick={() => {
                              soundPreview.stop();
                              setAvatarSettings({
                                itemId: avatar.catalog_item_id!,
                                source: avatar.origin,
                                name: avatar.name,
                              });
                            }}
                            aria-label={t("inventory.actions.avatarSettings")}
                          >
                            <SlidersHorizontal />
                            {layout === "list"
                              ? ` ${t("inventory.actions.avatarSettingsShort")}`
                              : null}
                          </Button>
                        </ActionTooltip>
                      ) : null}
                      {avatar.catalog_item_id ? (
                        <RuntimeFeatureGate
                          capability="anima_creation"
                          unavailable={(reason) => (
                            // The reason shows in both layouts, unlike the label tooltip.
                            <UnavailableAction reason={reason}>
                              <Button
                                type="button"
                                size={layout === "grid" ? "icon-sm" : "sm"}
                                aria-label={t("inventory.actions.createAnima")}
                              >
                                <Plus />
                                {layout === "list"
                                  ? ` ${t("inventory.actions.createAnima")}`
                                  : null}
                              </Button>
                            </UnavailableAction>
                          )}
                        >
                          <ActionTooltip
                            label={t("inventory.actions.createAnima")}
                            layout={layout}
                          >
                            <Button
                              size={layout === "grid" ? "icon-sm" : "sm"}
                              asChild
                            >
                              <Link
                                to="/animas/new"
                                search={{ avatar: avatar.catalog_item_id }}
                                aria-label={t("inventory.actions.createAnima")}
                              >
                                <Plus />
                                {layout === "list"
                                  ? ` ${t("inventory.actions.createAnima")}`
                                  : null}
                              </Link>
                            </Button>
                          </ActionTooltip>
                        </RuntimeFeatureGate>
                      ) : (
                        <ActionTooltip
                          label={t("inventory.actions.draft")}
                          layout={layout}
                        >
                          <Button
                            size={layout === "grid" ? "icon-sm" : "sm"}
                            disabled
                            aria-label={t("inventory.actions.draft")}
                          >
                            <Plus />
                            {layout === "list"
                              ? ` ${t("inventory.actions.draft")}`
                              : null}
                          </Button>
                        </ActionTooltip>
                      )}
                      {avatar.origin === "local" && avatar.catalog_item_id ? (
                        <LibraryItemMenu
                          name={avatar.name}
                          onDelete={(focus) => {
                            soundPreview.stop();
                            // Avatar rows carry no revision; the dialog reads it.
                            setDeleting({
                              itemId: avatar.catalog_item_id!,
                              kind: "avatar",
                              name: avatar.name,
                              revision: null,
                              focus,
                            });
                          }}
                        />
                      ) : null}
                    </>
                  }
                />
              ),
            )}
          </ProductGroup>
        </div>
      ) : null}
      {typedGroups
        .filter((group) => groups.includes(group.id))
        .map((group) => (
          <div key={group.id}>
            <ProductGroup
              layout={layout}
              id={group.id}
              title={group.title}
              footer={
                group.query && "fetchNextPage" in group.query ? (
                  <LoadMore query={group.query} />
                ) : undefined
              }
            >
              <InventoryState
                pending={Boolean(group.query?.isPending)}
                error={group.query?.error}
                empty={Boolean(group.query?.data) && group.cards.length === 0}
                onRetry={() => void group.query?.refetch()}
              />
              {renderCards(group.cards)}
            </ProductGroup>
          </div>
        ))}
      {previewError ? (
        <p role="alert" className="text-destructive text-sm">
          {previewError}
        </p>
      ) : null}
      {!groups.length ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Sparkles className="mx-auto size-5" />
          <p className="mt-2 font-medium">{t("inventory.uploadsSeparate")}</p>
        </div>
      ) : null}
      {avatarSettings ? (
        <LibraryAvatarSettingsDialog
          key={avatarSettings.itemId}
          avatar={avatarSettings}
          onClose={() => setAvatarSettings(null)}
        />
      ) : null}
      {managedSound ? (
        <LibrarySoundDialog
          key={managedSound.item_id}
          item={managedSound}
          onClose={() => setManagedSound(null)}
        />
      ) : null}
      <ContentDeleteDialog item={deleting} onClose={() => setDeleting(null)} />
      <ActionManageDialog
        open={Boolean(manage)}
        onOpenChange={(open) => {
          if (!open) setManage(null);
        }}
        target={manage}
        onPreview={() => {
          if (manage)
            void previewAction({
              key: "manage",
              itemId: manage.itemId,
              family: manage.kind,
              name: manage.name,
              description: manage.description,
              origin: "Mine",
              sourceLabel: "Local",
              updateAvailable: false,
              equippedCount: 0,
              includedCount: manage.includedCount ?? 0,
              source: manage.source ?? null,
              emotion: manage.emotion,
              intensity: manage.intensity,
            });
        }}
      />
    </div>
  );
}
