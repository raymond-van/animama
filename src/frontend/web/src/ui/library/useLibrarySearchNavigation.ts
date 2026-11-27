import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import {
  compactContentLibrarySearch,
  normalizeContentLibrarySearch,
  shouldReplaceContentLibrarySearch,
  type ContentLibrarySearch,
} from "@/lib/content/librarySearch";

const LIBRARY_PATH = "/library";

/** Routes match case-insensitively, so `/Library/` is the Library too. */
function isLibraryPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "").toLowerCase() === LIBRARY_PATH;
}

/**
 * Write a Library search update to the URL while the router is still on the
 * Library.
 *
 * The Library stays on screen while a link it opened, such as a row's Edit
 * link, loads the next page, and a search box commits its typed query only
 * after typing pauses. Every update navigates to `/library`, so one that
 * arrives after the owner has left would replace their navigation and bring
 * them back to the Library. Such an update is dropped instead.
 */
export function useLibrarySearchNavigation() {
  const router = useRouter();
  const navigate = useNavigate({ from: LIBRARY_PATH });
  return useCallback(
    (update: Partial<ContentLibrarySearch>) => {
      // The router moves `latestLocation` as soon as a navigation starts,
      // before the next page has loaded.
      if (!isLibraryPath(router.latestLocation.pathname)) return;
      void navigate({
        replace: shouldReplaceContentLibrarySearch(update),
        search: (current) =>
          compactContentLibrarySearch({
            ...normalizeContentLibrarySearch(current),
            ...update,
          }),
      });
    },
    [navigate, router],
  );
}
