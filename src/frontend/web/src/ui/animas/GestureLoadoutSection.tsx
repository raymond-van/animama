"use client";

import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  EllipsisVertical,
  ListFilter,
  Loader2,
  Play,
  Search,
} from "lucide-react";

import type { PyGestureBinding } from "@animama/runtime-contracts/api-types";
import type { PyGesture } from "@/lib/content/catalogTypes";
import {
  presentUnifiedGestureList,
  type GestureCatalogPresentation,
  type GestureLoadoutPresentation,
  type UnifiedGestureListRow,
  type UnifiedGestureMotionFilter,
  type UnifiedGestureSort,
  type UnifiedGestureStatusFilter,
} from "@/lib/loadout/animaLoadoutPresentation";
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
import { Input } from "@/ui/components/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui/components/tooltip";
import { StarterBadge } from "@/ui/animas/StarterBadge";
import { LoadoutSectionDisclosure } from "@/ui/animas/LoadoutSectionDisclosure";
import {
  ActionLoadoutRow,
  ActionRowIdentity,
} from "@/ui/animas/ActionLoadoutRows";

const INITIAL_GESTURE_ROW_COUNT = 20;

const LIBRARY_GESTURES = {
  section: "actions" as const,
  action: "gestures" as const,
};

/** Compact row identity whose full description is disclosed only when clipped. */
function GestureIdentity({
  name,
  description,
  starter,
}: {
  name: string;
  description: string | null;
  starter: boolean;
}) {
  return (
    <ActionRowIdentity
      name={name}
      description={description}
      badge={starter ? <StarterBadge /> : null}
    />
  );
}

function GestureListRow({
  row,
  disabled,
  onPreview,
  onPreviewAvailable,
  onEquip,
  onRemove,
  onDisableStarter,
  onRestoreStarter,
}: {
  row: UnifiedGestureListRow;
  disabled: boolean;
  onPreview: (row: PyGestureBinding) => void;
  onPreviewAvailable: (gesture: PyGesture) => void;
  onEquip: (gesture: PyGesture) => void;
  onRemove: (row: PyGestureBinding) => void;
  onDisableStarter: (row: PyGestureBinding) => void;
  onRestoreStarter: (starterId: string) => void;
}) {
  const previewable = Boolean(row.binding ?? row.gesture);
  const hasOverflow = row.kind === "custom";
  const preview = () => {
    if (row.binding) onPreview(row.binding);
    else if (row.gesture) onPreviewAvailable(row.gesture);
  };
  const equip = () => {
    if (row.starterId) onRestoreStarter(row.starterId);
    else if (row.gesture) onEquip(row.gesture);
  };
  const unequip = () => {
    if (!row.binding) return;
    if (row.kind === "custom") onRemove(row.binding);
    else onDisableStarter(row.binding);
  };

  return (
    <ActionLoadoutRow role="listitem" selected={row.equipped}>
      <GestureIdentity
        name={row.name}
        description={row.description}
        starter={row.kind === "starter"}
      />

      {row.updateAvailable ? (
        <span className="text-primary shrink-0 text-xs">Update available</span>
      ) : null}

      {row.equipped ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-primary/40 bg-primary/8 text-primary h-8 shrink-0 rounded-lg text-xs"
          disabled={disabled}
          aria-pressed="true"
          onClick={unequip}
        >
          Equipped
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 rounded-lg text-xs"
          disabled={disabled}
          onClick={equip}
        >
          Equip
        </Button>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={`Preview ${row.name}`}
            disabled={!previewable}
            onClick={preview}
          >
            <Play />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {previewable ? "Preview" : "Preview unavailable"}
        </TooltipContent>
      </Tooltip>

      {hasOverflow ? (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`More actions for ${row.name}`}
                >
                  <EllipsisVertical />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              More actions
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            {row.kind === "custom" ? (
              <DropdownMenuItem asChild>
                <Link to="/library" search={LIBRARY_GESTURES}>
                  {row.updateAvailable
                    ? "Update in Library"
                    : "View in Library"}
                </Link>
              </DropdownMenuItem>
            ) : null}
            {row.kind === "custom" && row.binding ? (
              <DropdownMenuItem
                disabled={disabled}
                className="text-destructive"
                onSelect={() => onRemove(row.binding!)}
              >
                Remove
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span
          className="text-muted-foreground inline-flex size-8 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <EllipsisVertical className="size-4" />
        </span>
      )}
    </ActionLoadoutRow>
  );
}

/** Full Gesture catalog with independent Included and Local visibility. */
export function GestureLoadoutSection({
  presentation,
  catalog,
  catalogLoading,
  catalogError,
  mutationsDisabled,
  onPreview,
  onPreviewAvailable,
  onEquip,
  onRemove,
  onDisableStarter,
  onRestoreStarter,
  onRetryCatalog,
}: {
  presentation: GestureLoadoutPresentation;
  catalog: GestureCatalogPresentation;
  catalogLoading: boolean;
  catalogError: boolean;
  mutationsDisabled: boolean;
  onPreview: (row: PyGestureBinding) => void;
  onPreviewAvailable: (gesture: PyGesture) => void;
  onEquip: (gesture: PyGesture) => void;
  onRemove: (row: PyGestureBinding) => void;
  onDisableStarter: (row: PyGestureBinding) => void;
  onRestoreStarter: (starterId: string) => void;
  onRetryCatalog: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [showIncluded, setShowIncluded] = useState(true);
  const [showLocal, setShowLocal] = useState(true);
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [statusFilter, setStatusFilter] =
    useState<UnifiedGestureStatusFilter>("all");
  const [motionType, setMotionType] =
    useState<UnifiedGestureMotionFilter>("all");
  const [sort, setSort] = useState<UnifiedGestureSort>("custom-first");
  const [showAllRows, setShowAllRows] = useState(false);
  const list = useMemo(
    () =>
      presentUnifiedGestureList({
        presentation,
        catalog,
        showIncluded,
        showLocal,
        updatesOnly,
        status: statusFilter,
        motionType,
        sort,
        query,
      }),
    [
      catalog,
      motionType,
      presentation,
      query,
      showIncluded,
      showLocal,
      sort,
      statusFilter,
      updatesOnly,
    ],
  );
  useEffect(() => {
    if (updatesOnly && list.updateAvailableCount === 0) {
      setUpdatesOnly(false);
    }
  }, [list.updateAvailableCount, updatesOnly]);
  useEffect(() => {
    setShowAllRows(false);
  }, [
    motionType,
    query,
    showIncluded,
    showLocal,
    sort,
    statusFilter,
    updatesOnly,
  ]);
  const visibleRows = showAllRows
    ? list.rows
    : list.rows.slice(0, INITIAL_GESTURE_ROW_COUNT);
  const hasMoreRows = visibleRows.length < list.rows.length;
  const hasNonDefaultView =
    !showIncluded ||
    !showLocal ||
    updatesOnly ||
    statusFilter !== "all" ||
    motionType !== "all" ||
    sort !== "custom-first";

  return (
    <LoadoutSectionDisclosure
      title="Gestures"
      headingId="gesture-loadout-heading"
      contentId="gesture-loadout-content"
      expanded={expanded}
      onToggle={() => setExpanded((current) => !current)}
      sticky
      actions={
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {list.equippedCount} equipped / {list.totalCount} total
          </span>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant={hasNonDefaultView ? "secondary" : "outline"}
                    aria-label="Filter and sort Gestures"
                  >
                    <ListFilter />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                Filter and sort Gestures
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-60">
              <DropdownMenuLabel>Show</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={showIncluded}
                onCheckedChange={(checked) => setShowIncluded(checked === true)}
                onSelect={(event) => event.preventDefault()}
              >
                Show included
                <span className="text-muted-foreground ml-auto text-xs">
                  {list.includedCount}
                </span>
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showLocal}
                onCheckedChange={(checked) => setShowLocal(checked === true)}
                onSelect={(event) => event.preventDefault()}
              >
                Show local
                <span className="text-muted-foreground ml-auto text-xs">
                  {list.localCount}
                </span>
              </DropdownMenuCheckboxItem>
              {list.updateAvailableCount ? (
                <DropdownMenuCheckboxItem
                  checked={updatesOnly}
                  onCheckedChange={(checked) =>
                    setUpdatesOnly(checked === true)
                  }
                  onSelect={(event) => event.preventDefault()}
                >
                  Updates available only
                  <span className="text-muted-foreground ml-auto text-xs">
                    {list.updateAvailableCount}
                  </span>
                </DropdownMenuCheckboxItem>
              ) : null}

              <DropdownMenuSeparator />
              <DropdownMenuLabel>Status</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={statusFilter}
                onValueChange={(value) =>
                  setStatusFilter(value as UnifiedGestureStatusFilter)
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
                value={motionType}
                onValueChange={(value) =>
                  setMotionType(value as UnifiedGestureMotionFilter)
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
                  <span className="text-muted-foreground ml-auto text-xs">
                    {list.motionTypeCounts.vrma}
                  </span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                  value="anima_clip"
                  onSelect={(event) => event.preventDefault()}
                >
                  Clips
                  <span className="text-muted-foreground ml-auto text-xs">
                    {list.motionTypeCounts.anima_clip}
                  </span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>

              <DropdownMenuSeparator />
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sort}
                onValueChange={(value) => setSort(value as UnifiedGestureSort)}
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
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            type="search"
            aria-label="Search gestures"
            placeholder="Search gestures"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-9"
          />
        </div>

        <div className="overflow-hidden rounded-xl border">
          <div role="list" aria-label="Available Gestures" className="divide-y">
            {visibleRows.map((row) => (
              <GestureListRow
                key={row.id}
                row={row}
                disabled={mutationsDisabled}
                onPreview={onPreview}
                onPreviewAvailable={onPreviewAvailable}
                onEquip={onEquip}
                onRemove={onRemove}
                onDisableStarter={onDisableStarter}
                onRestoreStarter={onRestoreStarter}
              />
            ))}
            {hasMoreRows ? (
              <div role="listitem">
                <button
                  type="button"
                  className="text-primary hover:bg-muted/30 focus-visible:ring-ring flex w-full items-center justify-center px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset"
                  onClick={() => setShowAllRows(true)}
                >
                  Show more
                </button>
              </div>
            ) : null}
            {catalogLoading ? (
              <p className="text-muted-foreground flex items-center justify-center gap-2 px-4 py-5 text-sm">
                <Loader2 className="size-4 animate-spin" /> Loading Gestures…
              </p>
            ) : null}
            {catalogError ? (
              <div className="flex items-center justify-between gap-3 px-4 py-4 text-sm">
                <p className="text-destructive">
                  Gestures could not be loaded.
                </p>
                <Button size="sm" variant="outline" onClick={onRetryCatalog}>
                  Retry
                </Button>
              </div>
            ) : null}
            {!catalogLoading && !catalogError && !list.rows.length ? (
              <p className="text-muted-foreground px-4 py-8 text-center text-sm">
                {query.trim()
                  ? "No Gestures match your search."
                  : statusFilter !== "all" ||
                      motionType !== "all" ||
                      updatesOnly ||
                      !showIncluded ||
                      !showLocal
                    ? "No Gestures match the selected filters."
                    : "No Gestures available."}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </LoadoutSectionDisclosure>
  );
}
