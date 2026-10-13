"use client";

import { ListFilter } from "lucide-react";

import { contentInventoryGroups } from "@/lib/content/libraryContentInventory";
import {
  LIBRARY_UPLOAD_STATUSES,
  type ContentLibrarySearch,
} from "@/lib/content/librarySearch";
import { Button } from "@/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";

type SearchUpdate = (update: Partial<ContentLibrarySearch>) => void;

function labelFromValue(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** One contextual filter/sort menu shared by every Library inventory. */
export function LibraryFilterMenu({
  search,
  onSearchChange,
}: {
  search: ContentLibrarySearch;
  onSearchChange: SearchUpdate;
}) {
  const uploads = search.section === "chat-uploads";
  const groups = contentInventoryGroups(search);
  const gestures = groups.includes("gestures");
  const posesOnly = groups.length === 1 && groups[0] === "poses";
  const gestureFiltersActive =
    gestures &&
    (search.gestureUpdatesOnly ||
      search.gestureStatus !== "all" ||
      search.gestureMotion !== "all" ||
      search.gestureSort !== "custom-first");
  const filtersActive = uploads
    ? search.uploadStatus !== "all"
    : !search.showStarters || search.sort !== "name" || gestureFiltersActive;

  const resetFilters = () => {
    if (uploads) {
      onSearchChange({ uploadStatus: "all" });
      return;
    }
    onSearchChange({
      showStarters: true,
      sort: "name",
      ...(gestures
        ? {
            gestureUpdatesOnly: false,
            gestureStatus: "all" as const,
            gestureMotion: "all" as const,
            gestureSort: "custom-first" as const,
          }
        : {}),
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          className="h-11"
          variant={filtersActive ? "secondary" : "outline"}
          aria-label="Filter and sort Library"
        >
          <ListFilter />
          Filter
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[calc(100dvh-2rem)] min-w-60 overflow-y-auto overscroll-contain"
      >
        {uploads ? (
          <>
            <DropdownMenuLabel>Upload status</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={search.uploadStatus}
              onValueChange={(value) =>
                onSearchChange({
                  uploadStatus: value as ContentLibrarySearch["uploadStatus"],
                })
              }
            >
              {LIBRARY_UPLOAD_STATUSES.map((status) => (
                <DropdownMenuRadioItem
                  key={status}
                  value={status}
                  onSelect={(event) => event.preventDefault()}
                >
                  {status === "all" ? "All statuses" : labelFromValue(status)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : (
          <>
            <DropdownMenuLabel>Show</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={search.showStarters}
              onCheckedChange={(checked) =>
                onSearchChange({ showStarters: checked === true })
              }
              onSelect={(event) => event.preventDefault()}
            >
              Show starters
            </DropdownMenuCheckboxItem>

            <DropdownMenuSeparator />
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={search.sort}
              onValueChange={(value) =>
                onSearchChange({
                  sort: value as ContentLibrarySearch["sort"],
                })
              }
            >
              <DropdownMenuRadioItem
                value="name"
                onSelect={(event) => event.preventDefault()}
              >
                Name
              </DropdownMenuRadioItem>
              {!posesOnly ? (
                <DropdownMenuRadioItem
                  value="updated"
                  onSelect={(event) => event.preventDefault()}
                >
                  Recently updated
                </DropdownMenuRadioItem>
              ) : null}
              <DropdownMenuRadioItem
                value="relevance"
                onSelect={(event) => event.preventDefault()}
              >
                Relevance
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>

            {gestures ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Gestures</DropdownMenuLabel>
                <DropdownMenuCheckboxItem
                  checked={search.gestureUpdatesOnly}
                  onCheckedChange={(checked) =>
                    onSearchChange({
                      gestureUpdatesOnly: checked === true,
                    })
                  }
                  onSelect={(event) => event.preventDefault()}
                >
                  Updates available only
                </DropdownMenuCheckboxItem>

                <DropdownMenuSeparator />
                <DropdownMenuLabel>Gesture status</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={search.gestureStatus}
                  onValueChange={(value) =>
                    onSearchChange({
                      gestureStatus:
                        value as ContentLibrarySearch["gestureStatus"],
                    })
                  }
                >
                  <DropdownMenuRadioItem
                    value="all"
                    onSelect={(event) => event.preventDefault()}
                  >
                    All
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    value="equipped"
                    onSelect={(event) => event.preventDefault()}
                  >
                    Equipped
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    value="unequipped"
                    onSelect={(event) => event.preventDefault()}
                  >
                    Unequipped
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>

                <DropdownMenuSeparator />
                <DropdownMenuLabel>Motion type</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={search.gestureMotion}
                  onValueChange={(value) =>
                    onSearchChange({
                      gestureMotion:
                        value as ContentLibrarySearch["gestureMotion"],
                    })
                  }
                >
                  <DropdownMenuRadioItem
                    value="all"
                    onSelect={(event) => event.preventDefault()}
                  >
                    All
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    value="vrma"
                    onSelect={(event) => event.preventDefault()}
                  >
                    VRMA
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    value="anima_clip"
                    onSelect={(event) => event.preventDefault()}
                  >
                    Clips
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>

                <DropdownMenuSeparator />
                <DropdownMenuLabel>Gesture order</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={search.gestureSort}
                  onValueChange={(value) =>
                    onSearchChange({
                      gestureSort: value as ContentLibrarySearch["gestureSort"],
                    })
                  }
                >
                  <DropdownMenuRadioItem
                    value="custom-first"
                    onSelect={(event) => event.preventDefault()}
                  >
                    Custom first
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    value="name-asc"
                    onSelect={(event) => event.preventDefault()}
                  >
                    Name A–Z
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    value="name-desc"
                    onSelect={(event) => event.preventDefault()}
                  >
                    Name Z–A
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </>
            ) : null}
          </>
        )}

        {filtersActive ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={resetFilters}>
              Reset filters
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
