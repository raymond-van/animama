import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Plus,
  X,
} from "lucide-react";

import { StarterBadge } from "@/ui/animas/StarterBadge";
import { Button } from "@/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/ui/components/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/components/popover";

/**
 * Shared pool layout for the Loadout's Idle and Reaction sections: a cell row
 * of member chips with an Add picker, inside collapsible emotion rows. Each
 * section supplies its own wording and rules (eligibility, limits, menus).
 */

/** One member of a pool cell, as both Idle and Reaction cells list it. */
export type LoadoutPoolMember = {
  binding_id: string;
  name: string;
  available: boolean;
};

/** A Library item the Add picker offers. */
export type LoadoutPoolChoice = {
  item_id: string;
  name: string;
  description?: string | null;
  origin: "owned" | "builtin";
};

/** Picker wording from the section's own catalog keys. */
export type LoadoutPoolPickerCopy = {
  add: string;
  search: string;
  local: string;
  included: string;
  loading: string;
  noResults: string;
  catalogUnavailable: string;
  retryCatalog: string;
};

/** A line under a choice: why it cannot be added, or what is happening to it. */
export type LoadoutPoolChoiceStatus = {
  text: string;
  tone: "error" | "muted";
  /** Whether the choice cannot be selected. */
  disabled: boolean;
};

/**
 * Searchable Add picker with Local and Included groups and a Preview per
 * choice. `onSelect` resolves whether the picker closes, so a section can
 * keep it open after a failed check. A page that cannot preview (one that
 * holds the app's preview canvas itself) leaves `onPreview` out, and the
 * choices show no Preview.
 */
export function LoadoutPoolPicker<Item extends LoadoutPoolChoice>({
  addLabel,
  copy,
  local,
  included,
  loading,
  error,
  disabled,
  describedBy,
  busy,
  selecting = false,
  status,
  detail,
  onSelect,
  onPreview,
  onRetry,
}: {
  /** Accessible name of the Add button, naming the cell. */
  addLabel: string;
  copy: LoadoutPoolPickerCopy;
  local: Item[];
  included: Item[];
  loading: boolean;
  error: boolean;
  disabled: boolean;
  /** The visible reason Add is disabled, when there is one. */
  describedBy?: string;
  /** A change is applying: choices wait, but the trigger keeps keyboard focus. */
  busy: boolean;
  /** A choice is being checked, so the others wait for it. */
  selecting?: boolean;
  status?: (item: Item) => LoadoutPoolChoiceStatus | null;
  /** A secondary line, such as a Reaction's suggested cell. */
  detail?: (item: Item) => string | null;
  onSelect: (item: Item) => boolean | Promise<boolean>;
  /** Absent where the page cannot preview a choice. */
  onPreview?: (item: Item) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation("animas");
  const [open, setOpen] = useState(false);

  const choose = async (item: Item) => {
    if (await onSelect(item)) setOpen(false);
  };

  const choice = (item: Item) => {
    const itemStatus = status?.(item) ?? null;
    const itemDetail = detail?.(item) ?? null;
    return (
      <CommandItem
        key={`${item.origin}:${item.item_id}`}
        value={`${item.name} ${item.description ?? ""}${itemDetail ? ` ${itemDetail}` : ""} ${item.origin}`}
        disabled={
          disabled || busy || selecting || Boolean(itemStatus?.disabled)
        }
        onSelect={() => void choose(item)}
        className="min-h-10"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{item.name}</span>
          {itemDetail ? (
            <span className="text-muted-foreground text-2xs truncate capitalize">
              {itemDetail}
            </span>
          ) : null}
          {itemStatus ? (
            <span
              className={
                itemStatus.tone === "error"
                  ? "text-destructive text-2xs whitespace-normal"
                  : "text-muted-foreground text-2xs"
              }
            >
              {itemStatus.text}
            </span>
          ) : null}
        </span>
        {item.origin === "builtin" ? <StarterBadge /> : null}
        {onPreview ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("actions.previewNamed", { name: item.name })}
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onPreview(item);
            }}
          >
            <Play />
          </Button>
        ) : null}
      </CommandItem>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-label={addLabel}
          aria-describedby={describedBy}
          className="shrink-0"
        >
          <Plus />
          {copy.add}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-80 p-0">
        <Command>
          <CommandInput placeholder={copy.search} autoFocus />
          <CommandList>
            <CommandEmpty>
              {error
                ? copy.catalogUnavailable
                : loading
                  ? copy.loading
                  : copy.noResults}
            </CommandEmpty>
            {local.length ? (
              <CommandGroup heading={copy.local}>
                {local.map(choice)}
              </CommandGroup>
            ) : null}
            {included.length ? (
              <CommandGroup heading={copy.included}>
                {included.map(choice)}
              </CommandGroup>
            ) : null}
          </CommandList>
          {loading || error ? (
            <div className="border-t p-2">
              {error ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={onRetry}
                >
                  {copy.retryCatalog}
                </Button>
              ) : (
                <p className="text-muted-foreground flex items-center justify-center gap-2 py-1 text-xs">
                  <Loader2 className="size-3.5 animate-spin" />
                  {copy.loading}
                </p>
              )}
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One member of a cell: its name, an optional badge, Preview (where the page
 * can preview), and Remove when the cell owns it. An unavailable member stays
 * visible so it can be removed.
 */
export function LoadoutPoolMemberChip({
  member,
  unavailableText,
  removeLabel,
  badge,
  inheritedFrom,
  disabled,
  onPreview,
  onRemove,
}: {
  member: LoadoutPoolMember;
  unavailableText: string;
  removeLabel: string;
  badge?: ReactNode;
  /** Where an inherited member comes from; it shows dashed, without Remove. */
  inheritedFrom?: string;
  disabled?: boolean;
  /** Absent where the page cannot preview a member. */
  onPreview?: () => void;
  /** Absent for a member the cell does not own. */
  onRemove?: () => void;
}) {
  const { t } = useTranslation("animas");
  return (
    <li
      className={`flex max-w-full min-w-0 items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2 text-sm ${
        inheritedFrom ? "text-muted-foreground border-dashed" : "bg-muted/40"
      }`}
    >
      <span
        className={`truncate ${member.available ? "" : "text-muted-foreground line-through"}`}
      >
        {member.name}
      </span>
      {badge}
      {member.available ? null : (
        <span className="text-destructive text-2xs shrink-0">
          {unavailableText}
        </span>
      )}
      {inheritedFrom ? (
        <span className="text-2xs shrink-0">{inheritedFrom}</span>
      ) : null}
      {onPreview ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-6"
          disabled={!member.available}
          aria-label={t("actions.previewNamed", { name: member.name })}
          onClick={onPreview}
        >
          <Play />
        </Button>
      ) : null}
      {onRemove ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-6"
          disabled={disabled}
          aria-label={removeLabel}
          onClick={onRemove}
        >
          <X />
        </Button>
      ) : null}
    </li>
  );
}

/**
 * A cell row: its label, its member chips (or empty text), anything else the
 * section shows in the cell, and the cell's controls on the right.
 */
export function LoadoutPoolCellRow({
  id,
  label,
  listLabel,
  members,
  emptyText,
  extra,
  controls,
}: {
  /** Focus target for links to this cell, such as a creation issue. */
  id?: string;
  label: ReactNode;
  /** Accessible name of the member list: the cell's name. */
  listLabel: string;
  members: ReactNode[];
  emptyText: string;
  /** More cell content, such as inherited members or a limit note. */
  extra?: ReactNode;
  controls: ReactNode;
}) {
  return (
    // On a narrow panel the controls wrap below the members, keeping names readable.
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2 border-b px-4 py-3 last:border-b-0"
    >
      {label}
      <div className="min-w-36 flex-1 space-y-1.5 pt-1.5">
        {members.length ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={listLabel}>
            {members}
          </ul>
        ) : null}
        {extra}
        {members.length || extra ? null : (
          <p className="text-muted-foreground text-sm">{emptyText}</p>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-start gap-1">{controls}</div>
    </div>
  );
}

/** One collapsible emotion row whose region holds that emotion's cell rows. */
export function LoadoutPoolEmotionRow({
  label,
  summary,
  panelId,
  regionLabel,
  open,
  onToggle,
  children,
}: {
  label: string;
  /** Collapsed summary, such as how many members the emotion holds. */
  summary?: string;
  panelId: string;
  regionLabel: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`border-b last:border-b-0 ${
        open ? "border-l-primary border-l-2" : "border-l-2 border-l-transparent"
      }`}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className={`focus-visible:ring-ring flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset ${
          open ? "bg-primary/5 hover:bg-primary/8" : "hover:bg-muted/30"
        }`}
      >
        <span className="truncate text-sm font-semibold capitalize">
          {label}
        </span>
        <span className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs">
          {summary}
          {open ? (
            <ChevronDown className="text-foreground size-4" />
          ) : (
            <ChevronRight className="text-foreground size-4" />
          )}
        </span>
      </button>
      {open ? (
        <div
          id={panelId}
          role="region"
          aria-label={regionLabel}
          className="border-t"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Track which emotion rows are expanded. */
export function useExpandedEmotions(initial: readonly string[] = []) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initial));
  const toggle = (emotion: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(emotion)) next.delete(emotion);
      else next.add(emotion);
      return next;
    });
  return { expanded, toggle };
}
