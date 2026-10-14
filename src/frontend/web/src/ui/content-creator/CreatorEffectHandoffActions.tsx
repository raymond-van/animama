"use client";

import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  HeartPulseIcon,
  WandSparklesIcon,
} from "lucide-react";

import type { ActionComponentType } from "@/query/hooks/useEffects";
import { Button } from "@/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";

export function effectCreatorHandoffSearch(
  itemId: string,
  componentType: ActionComponentType,
) {
  return { component: itemId, componentType } as const;
}

/** Stable-ID-only post-save handoff shared by every component creator. */
export function CreatorEffectHandoffActions({
  itemId,
  componentType,
}: {
  itemId: string | null | undefined;
  componentType: ActionComponentType;
}) {
  if (!itemId) return null;
  const search = effectCreatorHandoffSearch(itemId, componentType);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label="Use in…"
          title="Use in…"
          className="bg-background dark:bg-background dark:hover:bg-accent h-11 rounded-xl shadow-sm"
        >
          <WandSparklesIcon />
          <span className="hidden 2xl:inline">Use in…</span>
          <ChevronDownIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem asChild>
          <Link to="/gestures/new" search={search}>
            <WandSparklesIcon className="mr-2 size-4" />
            Use in a Gesture
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/reactions/new" search={search}>
            <HeartPulseIcon className="mr-2 size-4" />
            Use in a Reaction
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
