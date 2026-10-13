"use client";

import type { ReactNode } from "react";
import {
  Hand,
  Wind,
  HeartHandshake,
  Layers3,
  ScanFace,
  Sparkles,
  UserRound,
  Volume2,
} from "lucide-react";

import type { LibraryRowPresentation } from "@/lib/content/libraryPresentation";
import { ParticleThumbnail } from "./ParticleThumbnail";
import type { PyCatalogViewItem } from "@/lib/content/catalogTypes";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/components/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui/components/tooltip";

export type LibraryLayout = "list" | "grid";

type RowFamily = LibraryRowPresentation["family"];

const icons = {
  gesture: Hand,
  "idle-style": Wind,
  pose: UserRound,
  reaction: HeartHandshake,
  particle: Sparkles,
  "avatar-effect": ScanFace,
  scene: Layers3,
  sound: Volume2,
  avatar: UserRound,
} satisfies Record<RowFamily, typeof Hand>;

/** Shared, responsive product row that leaves actions owned by each domain. */
export function LibraryProductRow({
  row,
  actions,
  className,
  portraitUrl,
  thumbnailUrl,
  particleThumbnail,
  layout = "grid",
}: {
  row: LibraryRowPresentation;
  actions: ReactNode;
  className?: string;
  portraitUrl?: string | null;
  thumbnailUrl?: string | null;
  particleThumbnail?: PyCatalogViewItem["particle_thumbnail"];
  layout?: LibraryLayout;
}) {
  const Icon = icons[row.family];
  return (
    <article
      aria-label={row.name}
      className={cn(
        "bg-card flex min-w-0 flex-col",
        layout === "grid"
          ? "rounded-xl border"
          : "border-b last:border-b-0 sm:flex-row sm:items-stretch",
        className,
      )}
    >
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <div
            tabIndex={0}
            className="focus-visible:ring-ring flex min-h-20 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-3 outline-none focus-visible:ring-2"
          >
            <Avatar className="bg-muted size-10 rounded-lg">
              {!portraitUrl && thumbnailUrl && particleThumbnail ? (
                <ParticleThumbnail
                  src={thumbnailUrl}
                  source={particleThumbnail}
                />
              ) : portraitUrl || thumbnailUrl ? (
                <AvatarImage
                  src={portraitUrl || thumbnailUrl || undefined}
                  alt=""
                  className={
                    portraitUrl ? "object-cover" : "object-contain p-1"
                  }
                />
              ) : null}
              <AvatarFallback className="text-muted-foreground rounded-lg">
                <Icon className="size-5" aria-hidden="true" />
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="line-clamp-2 w-full text-sm leading-snug font-medium break-words">
                  {row.name}
                </span>
                {row.family === "pose" && row.origin === "Mine" ? (
                  <span className="bg-muted text-2xs rounded-full px-2 py-0.5">
                    Local
                  </span>
                ) : null}
                {row.updateAvailable ? (
                  <span className="border-primary/35 bg-primary/10 text-primary text-2xs rounded-full border px-2 py-0.5 font-medium">
                    Update available
                  </span>
                ) : null}
                {row.equippedCount ? (
                  <span className="bg-muted text-2xs rounded-full px-2 py-0.5">
                    Added to {row.equippedCount}
                  </span>
                ) : null}
              </span>
              {row.metadata.length ? (
                <span className="text-muted-foreground mt-1 block text-xs">
                  {row.metadata.join(" · ")}
                </span>
              ) : null}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={6}
          className="max-w-[min(24rem,calc(100vw-2rem))] text-left text-wrap break-words"
        >
          <p className="font-medium">{row.name}</p>
          {row.description ? (
            <p className="mt-1 whitespace-pre-wrap">{row.description}</p>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center gap-2 px-4 py-3",
          layout === "grid"
            ? "justify-start pt-0"
            : "sm:max-w-[48%] sm:justify-end",
        )}
      >
        {actions}
      </div>
    </article>
  );
}
