import type { PyPose } from "@animama/runtime-contracts/api-types";
import type {
  PyCatalogViewItem,
  PyGesture,
  PyReaction,
} from "@/lib/content/catalogTypes";
import type { ContentLibrarySearch } from "@/lib/content/librarySearch";
import { isNonPortable, nonPortableReason } from "@/lib/content/portability";
import { reactionCellLabel } from "@/lib/loadout/reactionLabels";
import { compareDisplayText } from "@animama/product-ui/i18n";

export type LibraryProductCard = {
  key: string;
  itemId: string;
  family:
    | "gesture"
    | "reaction"
    | "pose"
    | "particle"
    | "avatar-effect"
    | "scene"
    | "sound";
  name: string;
  description: string;
  thumbnailUrl?: string | null;
  particleThumbnail?: PyCatalogViewItem["particle_thumbnail"];
  origin: "Built-in" | "Mine";
  sourceLabel: string;
  updateAvailable: boolean;
  equippedCount: number;
  includedCount: number;
  source: PyGesture["source"];
  emotion?: string;
  intensity?: number;
  /** Usable here but never customized, copied or exported. */
  nonPortable?: boolean;
  /** The revision this view shows, which a delete is fenced on. */
  revision?: string | null;
};

export type LibraryProductActionPolicy = {
  preview: boolean;
  manage: boolean;
  edit: boolean;
  /** Text explaining why Edit is unavailable, when it is. */
  editUnavailableReason?: string;
  useInGesture: boolean;
  useInReaction: boolean;
  /** A Local item with a known revision can be deleted (issue #950, R13). */
  delete: boolean;
};

type LibraryGestureFilters = Pick<
  ContentLibrarySearch,
  "gestureUpdatesOnly" | "gestureStatus" | "gestureSort"
>;

/** Apply the Gesture-only Library filters shared with the Anima Loadout UI. */
export function filterAndSortLibraryGestures(
  cards: LibraryProductCard[],
  filters: LibraryGestureFilters,
): LibraryProductCard[] {
  const rows = cards
    .filter((card) => !filters.gestureUpdatesOnly || card.updateAvailable)
    .filter(
      (card) =>
        filters.gestureStatus === "all" ||
        (filters.gestureStatus === "equipped"
          ? card.equippedCount > 0
          : card.equippedCount === 0),
    );

  if (filters.gestureSort === "custom-first") {
    return [
      ...rows.filter((card) => card.origin === "Mine"),
      ...rows.filter((card) => card.origin === "Built-in"),
    ];
  }
  const direction = filters.gestureSort === "name-asc" ? 1 : -1;
  return rows.sort(
    (left, right) =>
      direction * compareDisplayText(left.name, right.name) ||
      direction * left.key.localeCompare(right.key),
  );
}

/** Keep product-specific Library actions explicit while sharing one row shell. */
export function libraryProductActionPolicy(
  card: LibraryProductCard,
): LibraryProductActionPolicy {
  const action = card.family === "gesture" || card.family === "reaction";
  const reusableEffect = !action && card.family !== "pose";
  // Editing an Included Action makes a Local copy of its motion.
  const editBlocked = Boolean(card.nonPortable);
  return {
    preview: Boolean(card.source),
    manage: action && Boolean(card.source),
    edit: Boolean(card.source) && !editBlocked,
    ...(editBlocked ? { editUnavailableReason: nonPortableReason() } : {}),
    useInGesture: reusableEffect && Boolean(card.source),
    useInReaction: reusableEffect && Boolean(card.source),
    // Included content is read-only; an item none of whose files could be
    // read has no revision and cannot be deleted from the app.
    delete: card.origin === "Mine" && Boolean(card.revision),
  };
}

/**
 * Keep only item-specific metadata; status badges are rendered separately. A
 * Reaction shows its suggested cell, such as "Joy · Moderate".
 */
export function libraryProductMetadata(card: LibraryProductCard): string[] {
  if (!card.emotion) return [];
  return [reactionCellLabel(card.emotion, card.intensity ?? 1)];
}

/** Omit stock catalog placeholders without changing the underlying content. */
export function contentRowDescription(
  value: string | null | undefined,
  name?: string,
): string {
  const description = value?.trim() ?? "";
  const placeholder =
    /^(?:VRM Avatar|Reusable avatar (?:pose|reaction) clip|Scene (?:background|focus-lines) effect preset|No description)\.?$/i;
  return placeholder.test(description) ||
    description.toLowerCase() === name?.trim().toLowerCase()
    ? ""
    : description;
}

export type LibraryRowPresentation = {
  family: LibraryProductCard["family"] | "avatar";
  name: string;
  description: string;
  metadata: string[];
  origin: "Built-in" | "Mine";
  includedCount?: number;
  updateAvailable?: boolean;
  equippedCount?: number;
};

/** Adapt a typed product card to the compact row presentation contract. */
export function libraryRowPresentation(
  card: LibraryProductCard,
): LibraryRowPresentation {
  return {
    family: card.family,
    name: card.name,
    description: contentRowDescription(card.description, card.name),
    metadata: libraryProductMetadata(card),
    origin: card.origin,
    includedCount: card.includedCount,
    updateAvailable: card.updateAvailable,
    equippedCount: card.equippedCount,
  };
}

/** Extract one readable scan-line description from Avatar identity markdown. */
export function avatarLibraryDescription(value: string | null | undefined) {
  const line = (value ?? "")
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate && !candidate.startsWith("#"));
  return contentRowDescription(line?.replace(/^[-*+]\s+/, ""));
}

function reactionPlacement(value: PyReaction) {
  // The Reaction list returns the suggestion as fields; catalog views carry
  // it in their metadata.
  if (typeof value.emotion === "string" && typeof value.intensity === "number")
    return { emotion: value.emotion, intensity: value.intensity };
  const hint = value.metadata?.placement_hint;
  if (!hint || typeof hint !== "object") return {};
  const raw = hint as Record<string, unknown>;
  return typeof raw.emotion === "string" && typeof raw.intensity === "number"
    ? { emotion: raw.emotion, intensity: raw.intensity }
    : {};
}

/** Present one stable product identity independent of files or implementation. */
export function actionLibraryCard(
  family: "gesture" | "reaction",
  value: PyGesture | PyReaction,
): LibraryProductCard {
  return {
    key: `${family}:${value.origin}:${value.item_id}`,
    itemId: value.item_id,
    family,
    name: value.name,
    description: value.description?.trim() || "No description",
    origin: value.origin === "builtin" ? "Built-in" : "Mine",
    sourceLabel: value.catalog_source === "included" ? "Included" : "Local",
    updateAvailable: value.update_available ?? false,
    equippedCount: 0,
    includedCount: Object.values(value.included_resource_counts ?? {}).reduce(
      (total, count) => total + count,
      0,
    ),
    source: value.source,
    nonPortable: isNonPortable(value),
    revision: value.revision_sha256 ?? null,
    ...(family === "reaction" ? reactionPlacement(value as PyReaction) : {}),
  };
}

/**
 * Present one Effect or Sound. `previews` is the runtime's `library_previews`
 * capability: without it the card carries no preview source, so its tile
 * shows the family icon and requests no thumbnail, texture or manifest.
 */
export function effectLibraryCard(
  family: "particle" | "avatar-effect" | "scene" | "sound",
  value: PyCatalogViewItem,
  previews = true,
): LibraryProductCard {
  return {
    key: `${family}:${value.origin}:${value.item_id}`,
    itemId: value.item_id,
    family,
    name: value.name,
    description: value.description?.trim() || "No description",
    ...(previews
      ? {
          thumbnailUrl: value.thumbnail_url,
          particleThumbnail: value.particle_thumbnail,
        }
      : {}),
    origin: value.origin === "builtin" ? "Built-in" : "Mine",
    sourceLabel: value.catalog_source === "included" ? "Included" : "Local",
    updateAvailable: false,
    equippedCount: 0,
    includedCount: 0,
    source: value.source,
    revision: value.revision_sha256 ?? null,
  };
}

/** Present standalone Pose metadata without treating it as equipment. */
export function poseLibraryCard(item: PyPose): LibraryProductCard {
  return {
    key: `pose:${item.item_id}`,
    itemId: item.item_id,
    family: "pose",
    name: item.name,
    description: item.description ?? "",
    origin: item.source === "included" ? "Built-in" : "Mine",
    sourceLabel: item.source === "included" ? "Starter" : "Local",
    updateAvailable: false,
    equippedCount: 0,
    includedCount: 0,
    source: {
      type: "catalog",
      catalog_item_id: item.item_id,
      logical_key: item.logical_key ?? item.pose_id,
    },
    revision: item.revision_sha256,
  };
}
