import { createFileRoute } from "@tanstack/react-router";

import {
  compactContentLibrarySearch,
  normalizeContentLibrarySearch,
  type ContentLibrarySearch,
  type ContentLibraryUrlSearch,
} from "@/lib/content/librarySearch";
import { LibraryPage } from "@/ui/library/LibraryPage";
import { useLibrarySearchNavigation } from "@/ui/library/useLibrarySearchNavigation";

export const Route = createFileRoute("/_app/library")({
  validateSearch: (search): ContentLibraryUrlSearch =>
    compactContentLibrarySearch(search),
  component: LibraryRoute,
});

function LibraryRoute() {
  const urlSearch = Route.useSearch();
  const search: ContentLibrarySearch = normalizeContentLibrarySearch(urlSearch);
  const onSearchChange = useLibrarySearchNavigation();
  return <LibraryPage search={search} onSearchChange={onSearchChange} />;
}
