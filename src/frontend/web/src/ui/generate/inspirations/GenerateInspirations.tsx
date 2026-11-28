import { useUppyState } from "@uppy/react";
import { Lightbulb } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PyGesture, PyUserFileResponse } from "@/lib/content/catalogTypes";
import { isUserImageFile } from "@/lib/user-files/chat-images";
import { cn } from "@/lib/utils";
import { useUserFiles } from "@/query/hooks/useUserFiles";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/components/dialog";
import { UserFileThumbnail } from "@/ui/components/user-file-thumbnail";
import { MAX_GENERATION_REFERENCE_EXAMPLES } from "../references/generationReferences";
import type { GenerateReferencesController } from "../references/useGenerateReferences";
import { GenerateStarters } from "./GenerateStarters";
import { includedInspirations } from "./includedInspirations";
import {
  restingFrame,
  useInspirationStills,
  type InspirationStill,
} from "./inspirationStills";

/** How long a card shows each beat's pose while it plays. */
const BEAT_STEP_MS = 500;

/** Whether the person asked the system for less motion. */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The frame of a still a card shows: its resting frame, or, while `playing`,
 * the clip's beat poses one after the other from the first, round and round.
 */
function useStillFrame(frames: number, playing: boolean): number {
  const animate = playing && frames > 1;
  const [tick, setTick] = useState(0);
  // The next time it plays, it starts from the first beat again.
  if (!animate && tick !== 0) setTick(0);
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(
      () => setTick((current) => current + 1),
      BEAT_STEP_MS,
    );
    return () => clearInterval(timer);
  }, [animate]);
  return animate ? tick % frames : restingFrame(frames);
}

/**
 * One Included Gesture of the dialog: its still on an Included Avatar, which
 * steps through the clip's beat poses on hover and on keyboard focus, and its
 * name. A still yet to be drawn keeps its place; where none can be drawn the
 * card shows the name only. Choosing it adds the Gesture as an example of the
 * feel.
 */
function InspirationGestureCard({
  gesture,
  still,
  chosen,
  full,
  limitId,
  onChoose,
}: {
  gesture: PyGesture;
  /** The Gesture's still; `pending` while it is yet to be drawn. */
  still: InspirationStill | "pending" | undefined;
  /** Already an example of the next message. */
  chosen: boolean;
  /** The next message has all the examples it takes. */
  full: boolean;
  /** The id of the note that says so. */
  limitId: string;
  onChoose: () => void;
}) {
  const { t } = useTranslation("generate");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const drawn = still === "pending" ? undefined : still;
  const frames = drawn?.frames.length ?? 0;
  const index = useStillFrame(frames, hovered || focused);
  const frame = drawn?.frames[index];
  const unavailable = chosen || full;
  return (
    <li>
      <button
        type="button"
        data-testid="generate-inspiration-gesture"
        data-key={gesture.logical_key ?? undefined}
        data-still={drawn ? "ready" : (still ?? "none")}
        data-frame={drawn ? index : undefined}
        // Kept focusable, so its poses can still be looked at.
        aria-disabled={unavailable || undefined}
        aria-describedby={full && !chosen ? limitId : undefined}
        className={cn(
          "border-border/70 bg-background focus-visible:ring-ring/50 hover:border-primary/40 flex h-full w-full flex-col gap-1.5 rounded-lg border p-1.5 text-left outline-none focus-visible:ring-[3px]",
          unavailable && "opacity-70",
        )}
        // Nothing moves for a person who asked the system for less motion.
        onMouseEnter={() => setHovered(!prefersReducedMotion())}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(!prefersReducedMotion())}
        onBlur={() => setFocused(false)}
        onClick={() => {
          if (!unavailable) onChoose();
        }}
      >
        {still ? (
          <span
            aria-hidden="true"
            className="bg-muted relative block aspect-[2/3] w-full overflow-hidden rounded-md"
          >
            {drawn && frame ? (
              // The whole sheet, scaled and moved so that one tile fills
              // the box: the tile and the box have the same proportions.
              <img
                src={drawn.url}
                alt=""
                draggable={false}
                className="absolute top-0 left-0 max-w-none"
                style={{
                  width: `${(drawn.sheet.width / frame.width) * 100}%`,
                  transform: `translate(${(-frame.x / drawn.sheet.width) * 100}%, ${(-frame.y / drawn.sheet.height) * 100}%)`,
                }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          data-testid="generate-inspiration-name"
          className="text-xs font-medium break-words"
        >
          {gesture.name}
        </span>
        {chosen ? (
          <span className="text-muted-foreground text-2xs">
            {t("references.picker.chosen")}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** The dialog's section of Included Gestures, with their stills. */
function IncludedInspirations({
  references,
}: {
  references: GenerateReferencesController;
}) {
  const { t } = useTranslation("generate");
  const titleId = useId();
  const limitId = useId();
  const { gestures, examples } = references;
  const offered = useMemo(
    () => includedInspirations(gestures.included),
    [gestures.included],
  );
  const stills = useInspirationStills(offered);
  // The Gesture added last, by name, for the line that says so.
  const [added, setAdded] = useState<string | null>(null);
  const chosen = new Set(examples.map(({ itemId }) => itemId));
  const full = examples.length >= MAX_GENERATION_REFERENCE_EXAMPLES;
  return (
    <section
      aria-labelledby={titleId}
      data-testid="generate-inspirations-included"
      className="space-y-2"
    >
      <div className="space-y-0.5">
        <h3 id={titleId} className="text-sm font-medium">
          {t("inspirations.included.title")}
        </h3>
        <p className="text-muted-foreground text-xs">
          {t("inspirations.included.hint")}
        </p>
      </div>
      {gestures.loading ? (
        <p className="text-muted-foreground text-xs" role="status">
          {t("references.picker.loading")}
        </p>
      ) : gestures.error ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" role="alert">
          <span>{t("references.picker.unavailable")}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={gestures.retry}
          >
            {t("references.picker.retry")}
          </Button>
        </div>
      ) : offered.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("inspirations.included.none")}
        </p>
      ) : (
        <ul
          aria-labelledby={titleId}
          className="grid grid-cols-3 gap-2 sm:grid-cols-4"
        >
          {offered.map((gesture) => (
            <InspirationGestureCard
              key={gesture.item_id}
              gesture={gesture}
              still={stills[gesture.item_id]}
              chosen={chosen.has(gesture.item_id)}
              full={full}
              limitId={limitId}
              onChoose={() => {
                references.addExample({
                  itemId: gesture.item_id,
                  name: gesture.name,
                });
                setAdded(gesture.name);
              }}
            />
          ))}
        </ul>
      )}
      {/* Always present, so that what it comes to say is announced. */}
      <p
        role="status"
        data-testid="generate-inspiration-added"
        className="text-muted-foreground min-h-4 text-xs"
      >
        {added === null
          ? ""
          : t("inspirations.included.added", { name: added })}
      </p>
      {full ? (
        <p id={limitId} className="text-muted-foreground text-xs">
          {t("references.examples.full", {
            max: MAX_GENERATION_REFERENCE_EXAMPLES,
          })}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The dialog's section of the person's own images: the ready images among
 * their stored files, as thumbnails with their names. Choosing one attaches
 * it to the next message by its file id (nothing is uploaded), and choosing
 * it again takes it off.
 */
function OwnImageInspirations({
  images,
}: {
  images: NonNullable<GenerateReferencesController["images"]>;
}) {
  const { t } = useTranslation("generate");
  const titleId = useId();
  const files = useUserFiles();
  const stored = useMemo(
    () =>
      (files.data ?? []).filter(
        (file) => isUserImageFile(file) && file.status === "ready",
      ),
    [files.data],
  );
  const attached = new Set(images.existing.map(({ file_id }) => file_id));
  // An image uploaded for this message is among the stored ones too.
  const uploaded = useUppyState(images.uppy, (state) =>
    Object.values(state.files)
      .flatMap((file) => file.meta.file_id ?? [])
      .join("\n"),
  );
  const uploadedIds = new Set(uploaded ? uploaded.split("\n") : []);
  return (
    <section
      aria-labelledby={titleId}
      data-testid="generate-inspirations-images"
      className="space-y-2"
    >
      <div className="space-y-0.5">
        <h3 id={titleId} className="text-sm font-medium">
          {t("inspirations.images.title")}
        </h3>
        <p className="text-muted-foreground text-xs">
          {t("inspirations.images.hint")}
        </p>
      </div>
      {files.isPending ? (
        <p className="text-muted-foreground text-xs" role="status">
          {t("inspirations.images.loading")}
        </p>
      ) : files.isError && !files.data ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" role="alert">
          <span>{t("inspirations.images.failed")}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void files.refetch()}
          >
            {t("references.picker.retry")}
          </Button>
        </div>
      ) : stored.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("inspirations.images.empty")}
        </p>
      ) : (
        <ul
          aria-labelledby={titleId}
          className="grid grid-cols-4 gap-2 sm:grid-cols-6"
        >
          {stored.map((file: PyUserFileResponse) => {
            const isUploaded = uploadedIds.has(file.file_id);
            const isAttached = isUploaded || attached.has(file.file_id);
            return (
              <li key={file.file_id}>
                <button
                  type="button"
                  data-testid="generate-inspiration-image"
                  data-file-id={file.file_id}
                  aria-pressed={isAttached}
                  // An upload is taken off in the composer's tray.
                  aria-disabled={isUploaded || undefined}
                  className={cn(
                    "border-border/70 bg-background focus-visible:ring-ring/50 hover:border-primary/40 flex h-full w-full flex-col gap-1.5 rounded-lg border p-1.5 text-left outline-none focus-visible:ring-[3px]",
                    isAttached && "border-primary/50 bg-primary/5",
                  )}
                  onClick={() => {
                    if (!isUploaded) images.toggleExisting(file);
                  }}
                >
                  <UserFileThumbnail
                    fileId={file.file_id}
                    className="aspect-square w-full"
                  />
                  <span
                    data-testid="generate-inspiration-name"
                    className="text-xs font-medium break-all"
                  >
                    {file.original_filename}
                  </span>
                  {isAttached ? (
                    <span className="text-primary text-2xs">
                      {t("inspirations.images.attached")}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The Generate page's Inspirations (R8.6): a button in the references row
 * and the dialog it opens, with prompt starters, a few of Animama's Included
 * Gestures to add as examples of the feel, and the person's own images to
 * attach as references. Nothing in it is sent until the person sends their
 * request.
 */
export function GenerateInspirations({
  references,
  disabled,
  onFillRequest,
}: {
  references: GenerateReferencesController;
  /** The assistant is working, or the conversation is not ready. */
  disabled: boolean;
  /** Put a starter's text in the request field, with the cursor. */
  onFillRequest: (text: string) => void;
}) {
  const { t } = useTranslation("generate");
  const startersId = useId();
  const [open, setOpen] = useState(false);
  // The starter chosen, until the closed dialog lets go of the keyboard.
  const starter = useRef<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* The trigger is where the keyboard returns when the dialog closes. */}
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          data-testid="generate-inspirations-open"
          className="shrink-0"
        >
          <Lightbulb />
          {t("inspirations.open")}
        </Button>
      </DialogTrigger>
      <DialogContent
        data-testid="generate-inspirations"
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          if (starter.current === null) return;
          // The cursor goes to the request field with the starter's
          // text, instead of back to the button.
          event.preventDefault();
          onFillRequest(starter.current);
          starter.current = null;
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("inspirations.title")}</DialogTitle>
          <DialogDescription>{t("inspirations.description")}</DialogDescription>
        </DialogHeader>
        <section aria-labelledby={startersId} className="space-y-2">
          <div className="space-y-0.5">
            <h3 id={startersId} className="text-sm font-medium">
              {t("starters.label")}
            </h3>
            <p className="text-muted-foreground text-xs">
              {t("inspirations.starters.hint")}
            </p>
          </div>
          <GenerateStarters
            onChoose={(text) => {
              starter.current = text;
              setOpen(false);
            }}
          />
        </section>
        <IncludedInspirations references={references} />
        {references.images ? (
          <OwnImageInspirations images={references.images} />
        ) : null}
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
