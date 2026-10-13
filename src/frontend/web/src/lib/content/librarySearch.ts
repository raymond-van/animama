export const LIBRARY_SECTIONS = [
  "all",
  "avatars",
  "actions",
  "fx",
  "chat-uploads",
] as const;
export type ContentLibrarySection = (typeof LIBRARY_SECTIONS)[number];

/** Individual product families offered under the combined All section. */
export const LIBRARY_CONTENT_TYPES = [
  "all",
  "avatars",
  "gestures",
  "reactions",
  "poses",
  "idle-styles",
  "particle",
  "avatar-effects",
  "scene",
  "sound",
] as const;
export type LibraryContentType = (typeof LIBRARY_CONTENT_TYPES)[number];

export const LIBRARY_ACTION_FILTERS = [
  "all",
  "gestures",
  "reactions",
  "poses",
  "idle-styles",
] as const;
export type LibraryActionFilter = (typeof LIBRARY_ACTION_FILTERS)[number];

export const LIBRARY_GESTURE_MOTION_FILTERS = [
  "all",
  "anima_clip",
  "vrma",
] as const;
export type LibraryGestureMotionFilter =
  (typeof LIBRARY_GESTURE_MOTION_FILTERS)[number];

export const LIBRARY_GESTURE_STATUS_FILTERS = [
  "all",
  "equipped",
  "unequipped",
] as const;
export type LibraryGestureStatusFilter =
  (typeof LIBRARY_GESTURE_STATUS_FILTERS)[number];

export const LIBRARY_GESTURE_SORTS = [
  "custom-first",
  "name-asc",
  "name-desc",
] as const;
export type LibraryGestureSort = (typeof LIBRARY_GESTURE_SORTS)[number];

export const LIBRARY_FX_FILTERS = [
  "all",
  "particle",
  "avatar",
  "scene",
  "sound",
] as const;
export type LibraryFxFilter = (typeof LIBRARY_FX_FILTERS)[number];

export const LIBRARY_SORTS = ["relevance", "updated", "name"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export const LIBRARY_UPLOAD_STATUSES = [
  "all",
  "pending_upload",
  "uploaded",
  "processing",
  "ready",
  "ready_keyword_only",
  "failed",
] as const;
export type LibraryUploadStatus = (typeof LIBRARY_UPLOAD_STATUSES)[number];

export type ContentLibrarySearch = {
  section: ContentLibrarySection;
  type: LibraryContentType;
  action: LibraryActionFilter;
  gestureMotion: LibraryGestureMotionFilter;
  showStarters: boolean;
  gestureUpdatesOnly: boolean;
  gestureStatus: LibraryGestureStatusFilter;
  gestureSort: LibraryGestureSort;
  fx: LibraryFxFilter;
  sort: LibrarySort;
  query?: string;
  uploadQuery?: string;
  uploadStatus: LibraryUploadStatus;
};

/** Sparse, canonical search state written to the browser URL. */
export type ContentLibraryUrlSearch = Partial<ContentLibrarySearch>;

export type RawContentLibrarySearch = Record<string, unknown>;

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function cleanQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim().slice(0, 80);
  return result || undefined;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

/** Normalize the stable product-domain Library URL contract. */
export function normalizeContentLibrarySearch(
  search: RawContentLibrarySearch,
): ContentLibrarySearch {
  const section = oneOf(LIBRARY_SECTIONS, search.section)
    ? search.section
    : "all";
  const query = cleanQuery(search.query);
  const uploadQuery = cleanQuery(search.uploadQuery);
  const type = oneOf(LIBRARY_CONTENT_TYPES, search.type) ? search.type : "all";
  return {
    section,
    type,
    action: oneOf(LIBRARY_ACTION_FILTERS, search.action)
      ? search.action
      : "all",
    gestureMotion: oneOf(LIBRARY_GESTURE_MOTION_FILTERS, search.gestureMotion)
      ? search.gestureMotion
      : "all",
    showStarters: booleanOr(search.showStarters, true),
    gestureUpdatesOnly: booleanOr(search.gestureUpdatesOnly, false),
    gestureStatus: oneOf(LIBRARY_GESTURE_STATUS_FILTERS, search.gestureStatus)
      ? search.gestureStatus
      : "all",
    gestureSort: oneOf(LIBRARY_GESTURE_SORTS, search.gestureSort)
      ? search.gestureSort
      : "custom-first",
    fx: oneOf(LIBRARY_FX_FILTERS, search.fx) ? search.fx : "all",
    sort:
      ((section === "actions" && search.action === "poses") ||
        (section === "all" && type === "poses")) &&
      search.sort === "updated"
        ? "name"
        : oneOf(LIBRARY_SORTS, search.sort)
          ? search.sort
          : query
            ? "relevance"
            : "name",
    ...(query ? { query } : {}),
    ...(uploadQuery ? { uploadQuery } : {}),
    uploadStatus: oneOf(LIBRARY_UPLOAD_STATUSES, search.uploadStatus)
      ? search.uploadStatus
      : "all",
  };
}

/**
 * Keep only non-default values owned by the active Library section.
 *
 * The UI consumes the normalized form above; this sparse form is exclusively
 * for readable, shareable browser URLs.
 */
export function compactContentLibrarySearch(
  search: RawContentLibrarySearch,
): ContentLibraryUrlSearch {
  const normalized = normalizeContentLibrarySearch(search);
  const compact: ContentLibraryUrlSearch = {};

  if (normalized.section !== "all") compact.section = normalized.section;

  if (normalized.section === "chat-uploads") {
    if (normalized.uploadQuery) compact.uploadQuery = normalized.uploadQuery;
    if (normalized.uploadStatus !== "all") {
      compact.uploadStatus = normalized.uploadStatus;
    }
    return compact;
  }

  if (normalized.query) compact.query = normalized.query;
  if (!normalized.showStarters) compact.showStarters = false;

  const defaultSort = normalized.query ? "relevance" : "name";
  if (normalized.sort !== defaultSort) compact.sort = normalized.sort;

  if (normalized.section === "all" && normalized.type !== "all") {
    compact.type = normalized.type;
  } else if (normalized.section === "actions") {
    if (normalized.action !== "all") compact.action = normalized.action;
  } else if (normalized.section === "fx" && normalized.fx !== "all") {
    compact.fx = normalized.fx;
  }

  const gestures =
    (normalized.section === "all" &&
      (normalized.type === "all" || normalized.type === "gestures")) ||
    (normalized.section === "actions" &&
      (normalized.action === "all" || normalized.action === "gestures"));
  if (gestures) {
    if (normalized.gestureMotion !== "all") {
      compact.gestureMotion = normalized.gestureMotion;
    }
    if (normalized.gestureUpdatesOnly) compact.gestureUpdatesOnly = true;
    if (normalized.gestureStatus !== "all") {
      compact.gestureStatus = normalized.gestureStatus;
    }
    if (normalized.gestureSort !== "custom-first") {
      compact.gestureSort = normalized.gestureSort;
    }
  }

  return compact;
}

export function contentLibrarySearchFromUrl(url: URL): ContentLibraryUrlSearch {
  return compactContentLibrarySearch(Object.fromEntries(url.searchParams));
}

/** Text edits replace history; discrete discovery choices remain navigable. */
export function shouldReplaceContentLibrarySearch(
  update: Partial<ContentLibrarySearch>,
): boolean {
  const keys = Object.keys(update);
  return (
    keys.length === 1 && (keys[0] === "query" || keys[0] === "uploadQuery")
  );
}
