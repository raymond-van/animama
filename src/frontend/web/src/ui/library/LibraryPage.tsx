"use client";

import { useLibrarySharingFlow } from "@/query/hooks/useLibrarySharingFlow";
import { LibrarySharingDialog } from "./LibrarySharingDialog";
import { LibraryBig, Menu } from "lucide-react";

import { hostedExclusionReasons } from "@/app/runtime/route-admission";
import {
  LIBRARY_CONTENT_TYPES,
  type ContentLibrarySearch,
  type LibraryContentType,
} from "@/lib/content/librarySearch";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import { AppShellPage } from "@/ui/app/AppShellPage";
import { useOptionalAppShell } from "@/ui/app/AppShell";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/components/button";
import {
  UNDERLINE_TAB_LIST_CLASS,
  underlineTabClassName,
} from "@/ui/components/tabs";
import { UnavailableAction } from "@/ui/components/unavailable-action";
import { LibraryChatUploads } from "@/ui/library/LibraryChatUploads";
import { LibraryContentInventory } from "@/ui/library/LibraryContentInventory";
import {
  useRuntimeFeatureEnabled,
  useRuntimeFeatureUnavailableReason,
} from "@/ui/app/RuntimeFeatureGate";
import { ContentHealth } from "@/ui/content-health/ContentHealth";

const SECTIONS = [
  ["all", "All"],
  ["avatars", "Avatars"],
  ["actions", "Actions"],
  ["fx", "FX"],
  ["chat-uploads", "Chat Uploads"],
] as const;

const CONTENT_TYPE_LABELS: Record<LibraryContentType, string> = {
  all: "All",
  avatars: "Avatars",
  gestures: "Gestures",
  reactions: "Reactions",
  poses: "Poses",
  "idle-styles": "Idle Styles",
  particle: "Particle FX",
  "avatar-effects": "Avatar FX",
  scene: "Scene FX",
  sound: "Sounds",
};

/** Common product Library. Creation starts from the dedicated Create hub. */
export function LibraryPage({
  search,
  onSearchChange,
}: {
  search: ContentLibrarySearch;
  onSearchChange: (update: Partial<ContentLibrarySearch>) => void;
}) {
  const appShell = useOptionalAppShell();
  const sharing = useLibrarySharingFlow();
  const uploadsEnabled = useRuntimeFeatureEnabled("chat_file_uploads");
  const uploadsUnavailable =
    useRuntimeFeatureUnavailableReason("chat_file_uploads");
  // Chat Uploads also manages document processing. Where uploads are withheld,
  // the section names a withheld processor too; a local runtime without the
  // document worker still offers uploads and never shows this reason.
  const documentsUnavailable =
    useRuntimeCapabilities().data?.user_file_processing?.enabled === false
      ? hostedExclusionReasons.document_processing
      : null;
  return (
    <AppShellPage contentClassName="gap-0">
      <header className="pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open sidebar"
              onClick={appShell?.openSidebar}
            >
              <Menu aria-hidden="true" />
            </Button>
            <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-xl">
              <LibraryBig className="size-5" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <ContentHealth />
            <LibrarySharingDialog flow={sharing} />
          </div>
        </div>
      </header>
      <nav
        aria-label="Library sections"
        className={cn(
          "bg-background/95 sticky top-0 z-40 backdrop-blur-sm",
          UNDERLINE_TAB_LIST_CLASS,
        )}
      >
        {SECTIONS.filter(
          ([value]) =>
            value !== "chat-uploads" ||
            uploadsEnabled ||
            uploadsUnavailable !== null,
        ).map(([value, label]) =>
          value === "chat-uploads" && uploadsUnavailable ? (
            <UnavailableAction key={value} reason={uploadsUnavailable}>
              <button
                type="button"
                className={underlineTabClassName(search.section === value)}
                aria-pressed={search.section === value}
              >
                {label}
              </button>
            </UnavailableAction>
          ) : (
            <button
              key={value}
              type="button"
              className={underlineTabClassName(search.section === value)}
              aria-pressed={search.section === value}
              onClick={() => onSearchChange({ section: value })}
            >
              {label}
            </button>
          ),
        )}
      </nav>
      {search.section === "all" ? (
        <div
          role="group"
          aria-label="Library content types"
          className="flex flex-wrap items-center gap-2 pt-4"
        >
          {LIBRARY_CONTENT_TYPES.map((value) => (
            <Button
              key={value}
              size="sm"
              variant={search.type === value ? "default" : "outline"}
              aria-pressed={search.type === value}
              onClick={() => onSearchChange({ type: value })}
            >
              {CONTENT_TYPE_LABELS[value]}
            </Button>
          ))}
        </div>
      ) : null}
      {search.section === "actions" ? (
        <div className="flex flex-wrap items-center gap-2 pt-4">
          {(
            ["all", "gestures", "reactions", "poses", "idle-styles"] as const
          ).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={search.action === value ? "default" : "outline"}
              onClick={() => onSearchChange({ action: value })}
            >
              {value === "all"
                ? "All"
                : value === "idle-styles"
                  ? "Idle Styles"
                  : value[0].toUpperCase() + value.slice(1)}
            </Button>
          ))}
        </div>
      ) : null}
      {search.section === "fx" ? (
        <div className="flex flex-wrap gap-2 pt-4">
          {(["all", "particle", "avatar", "scene", "sound"] as const).map(
            (value) => (
              <Button
                key={value}
                size="sm"
                variant={search.fx === value ? "default" : "outline"}
                onClick={() => onSearchChange({ fx: value })}
              >
                {value === "all"
                  ? "All"
                  : `${value[0].toUpperCase()}${value.slice(1)}${value === "sound" ? "" : " FX"}`}
              </Button>
            ),
          )}
        </div>
      ) : null}
      <div className="pt-5">
        {search.section === "chat-uploads" ? (
          uploadsEnabled ? (
            <LibraryChatUploads
              search={search}
              onSearchChange={onSearchChange}
            />
          ) : (
            <section
              className="space-y-3"
              aria-labelledby="library-uploads-unavailable"
            >
              <h2
                id="library-uploads-unavailable"
                className="text-lg font-semibold"
              >
                Chat Uploads unavailable
              </h2>
              <p className="text-muted-foreground">
                {[
                  uploadsUnavailable,
                  documentsUnavailable,
                  "You can still import, create and share Library content.",
                ]
                  .filter(Boolean)
                  .join(" ")}
              </p>
              <Button
                variant="outline"
                onClick={() => onSearchChange({ section: "all" })}
              >
                Back to Library
              </Button>
            </section>
          )
        ) : (
          <LibraryContentInventory
            search={search}
            onSearchChange={onSearchChange}
          />
        )}
      </div>
    </AppShellPage>
  );
}
