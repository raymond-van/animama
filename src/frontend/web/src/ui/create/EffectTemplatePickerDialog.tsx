"use client";

import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  ImageOff,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  EFFECT_TEMPLATE_KINDS,
  EFFECT_TEMPLATE_KIND_INFO,
  effectTemplateGroups,
  type EffectCreatorRoute,
  type EffectTemplateKind,
} from "@/lib/effects/effectTemplates";
import { loadEffectTemplateThumbnail } from "@/lib/effects/effectTemplateThumbnails";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/ui/components/dialog";
import {
  CREATOR_CARD_CLASS_NAME,
  CreatorIconTile,
  EFFECT_KIND_ICONS,
} from "@/ui/create/CreatorCards";

/**
 * The Effects template picker: step 1 chooses a kind (Particle, Avatar or
 * Scene FX); step 2 chooses that kind's template or Start from scratch, which
 * opens its creator route with a new, unsaved draft. Opened in place by the
 * sidebar Create menu and the Create page, and by the `/effects/new` route.
 */
export function EffectTemplatePickerDialog({
  open,
  initialKind = null,
  onOpenChange,
  onChoose,
  returnFocus,
}: {
  open: boolean;
  /** Open at this kind's step 2 instead of the kind cards. */
  initialKind?: EffectTemplateKind | null;
  onOpenChange: (open: boolean) => void;
  /** A starting point was chosen; its creator navigation is under way. */
  onChoose?: () => void;
  /**
   * The control that receives focus when the picker is dismissed. The dialog
   * has no trigger of its own, and an opener inside a closed menu no longer
   * exists, so callers name a stable control (for example the opening card).
   */
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  // Choosing a starting point navigates away; focus then follows the route.
  const chosenRef = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) chosenRef.current = false;
        onOpenChange(next);
      }}
    >
      <DialogContent
        avoidSidebar
        data-testid="effect-template-picker"
        className="flex h-[min(44rem,calc(100dvh-2rem))] w-[56rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        onOpenAutoFocus={() => {
          chosenRef.current = false;
        }}
        onCloseAutoFocus={(event) => {
          if (chosenRef.current) return;
          const target = returnFocus?.();
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {/* Mounted per opening, so each opening starts at `initialKind`. */}
        <PickerSteps
          initialKind={initialKind}
          onChoose={() => {
            chosenRef.current = true;
            onChoose?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PickerSteps({
  initialKind,
  onChoose,
}: {
  initialKind: EffectTemplateKind | null;
  onChoose?: () => void;
}) {
  const [kind, setKind] = useState<EffectTemplateKind | null>(initialKind);
  const backRef = useRef<HTMLButtonElement>(null);
  const kindRefs = useRef(new Map<EffectTemplateKind, HTMLButtonElement>());
  const previousKind = useRef<EffectTemplateKind | null>(initialKind);

  // Keep focus inside the dialog when a step replaces the focused control.
  useEffect(() => {
    if (kind) backRef.current?.focus();
    else if (previousKind.current)
      kindRefs.current.get(previousKind.current)?.focus();
    previousKind.current = kind ?? previousKind.current;
  }, [kind]);

  const info = kind ? EFFECT_TEMPLATE_KIND_INFO[kind] : null;
  return (
    <>
      <header className="space-y-1.5 border-b px-6 pt-5 pb-4">
        {kind ? (
          <Button
            ref={backRef}
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 px-2"
            onClick={() => setKind(null)}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back
          </Button>
        ) : null}
        <DialogTitle className="text-xl font-semibold tracking-tight">
          {info ? `New ${info.label}` : "Create an effect"}
        </DialogTitle>
        <DialogDescription>
          {info
            ? "Start from a template or from scratch. You get a new, unsaved draft; the template is not changed."
            : "Choose the kind of effect to create."}
        </DialogDescription>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {kind === null ? (
          <div className="flex min-h-full items-center justify-center">
            <div className="grid w-full max-w-3xl gap-4 sm:grid-cols-3">
              {EFFECT_TEMPLATE_KINDS.map((option) => (
                <KindCard
                  key={option}
                  kind={option}
                  buttonRef={(element) => {
                    if (element) kindRefs.current.set(option, element);
                    else kindRefs.current.delete(option);
                  }}
                  onSelect={() => setKind(option)}
                />
              ))}
            </div>
          </div>
        ) : (
          <TemplateStep kind={kind} onChoose={onChoose} />
        )}
      </div>
    </>
  );
}

function KindCard({
  kind,
  buttonRef,
  onSelect,
}: {
  kind: EffectTemplateKind;
  buttonRef: (element: HTMLButtonElement | null) => void;
  onSelect: () => void;
}) {
  const info = EFFECT_TEMPLATE_KIND_INFO[kind];
  const { icon, className } = EFFECT_KIND_ICONS[kind];
  return (
    <button
      ref={buttonRef}
      type="button"
      className={cn(
        CREATOR_CARD_CLASS_NAME,
        "min-h-52 items-center p-5 text-center",
      )}
      onClick={onSelect}
    >
      <CreatorIconTile icon={icon} className={className} />
      <span className="mt-5 text-lg font-semibold">{info.label}</span>
      <span className="text-muted-foreground mt-1.5 flex-1 text-sm leading-6">
        {info.description}
      </span>
      <span className="text-foreground mt-4 flex items-center gap-1 text-sm font-semibold">
        Choose
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
      </span>
    </button>
  );
}

const TEMPLATE_GRID_CLASS_NAME =
  "grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5";

/**
 * Step 2: Start from scratch, then the kind's templates under their group
 * headings, each with its rendered Annie thumbnail.
 */
function TemplateStep({
  kind,
  onChoose,
}: {
  kind: EffectTemplateKind;
  onChoose?: () => void;
}) {
  const { route } = EFFECT_TEMPLATE_KIND_INFO[kind];
  return (
    <div className="space-y-6">
      <div className={TEMPLATE_GRID_CLASS_NAME}>
        <StartFromScratchCard kind={kind} onChoose={onChoose} />
      </div>
      {effectTemplateGroups(kind).map((group) => {
        if (group.templates.length === 0) return null;
        const headingId = `effect-template-group-${kind}-${group.id}`;
        return (
          <section
            key={group.id}
            aria-labelledby={headingId}
            className="space-y-3"
          >
            <h3
              id={headingId}
              className="text-muted-foreground text-sm font-semibold"
            >
              {group.label}
            </h3>
            <div className={TEMPLATE_GRID_CLASS_NAME}>
              {group.templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  label={template.name}
                  to={route}
                  search={{ template: template.id }}
                  onChoose={onChoose}
                  preview={
                    <TemplateThumbnail kind={kind} templateId={template.id} />
                  }
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * A square-preview card linking to a creator route. The preview box has a
 * fixed aspect ratio, so thumbnails that load late or fail do not shift the
 * grid.
 */
function TemplateCard({
  label,
  preview,
  to,
  search,
  onChoose,
}: {
  label: string;
  preview: ReactNode;
  to: EffectCreatorRoute;
  /** `?template=` for a template; omitted for Start from scratch. */
  search?: { template: string };
  onChoose?: () => void;
}) {
  return (
    <Link
      to={to}
      search={search}
      className={cn(CREATOR_CARD_CLASS_NAME, "p-2.5")}
      onClick={onChoose}
    >
      {preview}
      <span
        className="mt-2.5 line-clamp-2 px-0.5 text-sm font-semibold break-words"
        title={label}
      >
        {label}
      </span>
    </Link>
  );
}

function StartFromScratchCard({
  kind,
  onChoose,
}: {
  kind: EffectTemplateKind;
  onChoose?: () => void;
}) {
  return (
    <TemplateCard
      label="Start from scratch"
      to={EFFECT_TEMPLATE_KIND_INFO[kind].route}
      onChoose={onChoose}
      preview={
        <PreviewFrame className="border-border/80 bg-muted/30 border border-dashed">
          <Plus className="text-muted-foreground size-8" aria-hidden="true" />
        </PreviewFrame>
      }
    />
  );
}

function PreviewFrame({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "bg-muted/60 relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl",
        className,
      )}
    >
      {children}
    </span>
  );
}

type ThumbnailState =
  | { status: "loading"; url: string | null }
  | { status: "ready"; url: string }
  | { status: "error" }
  | { status: "empty" };

/**
 * A template's Annie thumbnail, with loading, missing (empty) and failed
 * states.
 */
function TemplateThumbnail({
  kind,
  templateId,
}: {
  kind: EffectTemplateKind;
  templateId: string;
}) {
  const [state, setState] = useState<ThumbnailState>({
    status: "loading",
    url: null,
  });
  useEffect(() => {
    const pending = loadEffectTemplateThumbnail(kind, templateId);
    if (!pending) {
      setState({ status: "empty" });
      return;
    }
    let cancelled = false;
    pending.then(
      (url) => {
        if (!cancelled) setState({ status: "loading", url });
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind, templateId]);

  const url = "url" in state ? state.url : null;
  return (
    <PreviewFrame>
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className={cn(
            "size-full object-cover transition-opacity duration-200",
            state.status === "ready" ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setState({ status: "ready", url })}
          onError={() => setState({ status: "error" })}
        />
      ) : null}
      {state.status === "loading" ? (
        <span
          className="bg-muted absolute inset-0 animate-pulse motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
      {state.status === "error" || state.status === "empty" ? (
        <PreviewMessage
          icon={ImageOff}
          text={
            state.status === "error" ? "Preview unavailable" : "No preview yet"
          }
        />
      ) : null}
    </PreviewFrame>
  );
}

function PreviewMessage({
  icon: Icon,
  text,
}: {
  icon: LucideIcon;
  text: string;
}) {
  return (
    <span className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-2 text-center text-xs">
      <Icon className="size-5" aria-hidden="true" />
      {text}
    </span>
  );
}
