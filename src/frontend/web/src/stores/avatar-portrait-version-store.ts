import { create } from "zustand";

type AvatarPortraitVersionState = {
  /** How many times each Avatar item's portrait was saved this page session. */
  versions: Record<string, number>;
};

/**
 * Portraits saved in this page session, by Avatar item. A retaken Local
 * portrait keeps its file URL (Local files are revalidated, not digest-named),
 * so an image already showing the old portrait never reloads. Surfaces that
 * show a portrait add this version to its URL so the new bytes load.
 */
export const useAvatarPortraitVersionStore = create<AvatarPortraitVersionState>(
  () => ({ versions: {} }),
);

/** Record a saved portrait for `itemId` (`useSaveAvatarPortrait`). */
export function bumpAvatarPortraitVersion(itemId: string): void {
  useAvatarPortraitVersionStore.setState(({ versions }) => ({
    versions: { ...versions, [itemId]: (versions[itemId] ?? 0) + 1 },
  }));
}

/** `url` unchanged until the portrait is saved again, then a fresh URL. */
export function versionedPortraitUrl(
  url: string | null | undefined,
  version: number | undefined,
): string | null {
  if (!url) return null;
  if (!version) return url;
  return `${url}${url.includes("?") ? "&" : "?"}portrait=${version}`;
}

/** The portrait URL for one Avatar item, refreshed after a save this session. */
export function useAvatarPortraitUrl(
  itemId: string | null | undefined,
  url: string | null | undefined,
): string | null {
  const version = useAvatarPortraitVersionStore((state) =>
    itemId ? state.versions[itemId] : undefined,
  );
  return versionedPortraitUrl(url, version);
}
