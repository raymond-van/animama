import { create } from "zustand";

import type { PyAnimaListItem } from "@/lib/content/catalogTypes";
import { getAnimaDisplayName, sortAnimasByRecent } from "@/lib/anima-profile";

/** The sorts the sidebar's Anima list offers. */
export type SidebarAnimaSort = "recent" | "name-asc" | "name-desc";

/**
 * The Anima list's chosen sort, shared with the delete flow so it can open the
 * next Anima in the order the sidebar shows. It lasts for the window's
 * session, as it did when the sidebar held it.
 */
export const useSidebarAnimaSortStore = create<{ sort: SidebarAnimaSort }>(
  () => ({ sort: "recent" }),
);

/** Choose the sidebar's Anima sort. */
export function setSidebarAnimaSort(sort: SidebarAnimaSort): void {
  useSidebarAnimaSortStore.setState({ sort });
}

/**
 * Sidebar pins (issue #950): pinned items first, each group keeping the list's
 * own order. A stable partition, so the pinned group follows the chosen sort
 * rather than the time each item was pinned.
 */
export function pinnedFirst<T extends { pinned_at?: string | null }>(
  items: readonly T[],
): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const item of items) (item.pinned_at ? pinned : rest).push(item);
  return pinned.concat(rest);
}

/**
 * The sidebar's Anima order: the chosen sort, the recently used Anima first
 * under "recent", then pinned Animas above the rest. The collapsed rail and
 * the delete flow use the same order.
 */
export function orderSidebarAnimas(
  animas: readonly PyAnimaListItem[],
  {
    sort,
    compare,
    recentlyUsedAnimaId = null,
  }: {
    sort: SidebarAnimaSort;
    compare: (left: string, right: string) => number;
    recentlyUsedAnimaId?: string | null;
  },
): PyAnimaListItem[] {
  if (sort === "recent") {
    const recent = sortAnimasByRecent([...animas]).sort((left, right) => {
      if (left.id === recentlyUsedAnimaId) return -1;
      if (right.id === recentlyUsedAnimaId) return 1;
      return 0;
    });
    return pinnedFirst(recent);
  }
  const direction = sort === "name-asc" ? 1 : -1;
  return pinnedFirst(
    [...animas].sort(
      (left, right) =>
        direction *
        compare(getAnimaDisplayName(left), getAnimaDisplayName(right)),
    ),
  );
}

/**
 * The Anima to open after deleting the open one: the next in sidebar order, or
 * the one before it when it was last; null when no other Anima remains.
 */
export function nextAnimaIdAfterDelete(
  orderedAnimaIds: readonly string[],
  deletedAnimaId: string,
): string | null {
  const index = orderedAnimaIds.indexOf(deletedAnimaId);
  const remaining = orderedAnimaIds.filter((id) => id !== deletedAnimaId);
  if (remaining.length === 0) return null;
  if (index < 0) return remaining[0] ?? null;
  return remaining[Math.min(index, remaining.length - 1)] ?? null;
}
