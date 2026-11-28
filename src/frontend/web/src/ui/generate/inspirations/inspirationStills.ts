import { useProductApiClient } from "@animama/product-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { registerPrivateStateReset } from "@/app/runtime/private-module-state";
import type { IncludedAvatarId } from "@/lib/avatar/motion-authoring/headlessVrm";
import {
  DEFAULT_REVIEW_SHEET_TILE,
  reviewSheetColumns,
} from "@/lib/avatar/motion-authoring/reviewSheet";
import { MAX_ANIMA_POSE_CLIP_BYTES } from "@/lib/avatar/poses/animaPoseClip/clipVocabulary";
import type { PyGesture } from "@/lib/content/catalogTypes";
import { createLogger } from "@/lib/logger";
import {
  VerifiedByteLoader,
  type VerifiedByteMember,
} from "@/lib/runtime-content/VerifiedByteLoader";
import { useGenerationStore } from "@/stores/generation-store";
import {
  createIncludedAvatarFiles,
  includedContentFile,
} from "../includedAvatarFiles";
import {
  PreviewRendererUnavailableError,
  reviewSheetTimes,
  usePreviewSheetRenderer,
  type PreviewSheetRenderer,
} from "../previewSheetRenderer";

const logger = createLogger("GenerateInspirations");

/**
 * The stills of the Inspirations dialog's Included Gestures (R8.6). A card
 * shows its Gesture on an Included Avatar: the review sheet of the Gesture's
 * clip, drawn at run time through the preview canvas's renderer, with the
 * front view of each beat cut from it. Nothing is shipped, uploaded or sent:
 * a still is an image in this page's memory, kept for the session.
 */

/** One tile of a sheet, in the sheet's pixels. */
export type InspirationFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type InspirationStill = {
  /** An object URL of the sheet the frames are cut from. */
  url: string;
  /** The sheet's size in pixels. */
  sheet: { width: number; height: number };
  /** The Avatar from the front at each beat shown, in time order; never empty. */
  frames: readonly InspirationFrame[];
};

/**
 * Where the front view of each row sits on a Gesture's review sheet of
 * `rows` rows. A sheet is a column of time labels and a header row, then one
 * tile per view in each row; the front view is the first. The margins are
 * what the tiles leave over, so they are not repeated here. Empty for a
 * sheet too small to be a Gesture's.
 */
export function inspirationStillFrames(
  sheet: { width: number; height: number },
  rows: number,
): InspirationFrame[] {
  const tile = DEFAULT_REVIEW_SHEET_TILE;
  const views = reviewSheetColumns("right", "body").length;
  const x = sheet.width - views * tile.width;
  const y = sheet.height - rows * tile.height;
  if (rows < 1 || x < 0 || y < 0) return [];
  return Array.from({ length: rows }, (_, row) => ({
    x,
    y: y + row * tile.height,
    width: tile.width,
    height: tile.height,
  }));
}

/**
 * The frame a card rests on: the beat in the middle of the clip, where a
 * Gesture is most itself. Its first and last beats are the pose it starts
 * from and settles into.
 */
export function restingFrame(frames: number): number {
  return Math.floor(frames / 2);
}

/** The session's stills, by the digest of the clip file each was drawn from. */
const useInspirationStillStore = create<{
  stills: Readonly<Record<string, InspirationStill>>;
}>(() => ({ stills: {} }));

/** The clips being drawn now, by digest, so no dialog draws one twice. */
const drawing = new Set<string>();

// The stills are this session's memory; their object URLs are freed with it.
registerPrivateStateReset(() => {
  for (const still of Object.values(useInspirationStillStore.getState().stills))
    URL.revokeObjectURL(still.url);
  useInspirationStillStore.setState({ stills: {} });
});

/**
 * The clip file of an Included Gesture, at the digest-keyed content route
 * that serves Included files only. `null` for a Local Gesture, or one that
 * lists no clip.
 */
function includedClipFile(gesture: PyGesture): VerifiedByteMember | null {
  if (gesture.origin !== "builtin") return null;
  const file = gesture.files?.find(({ role }) => role === "sequence");
  return file ? includedContentFile(file) : null;
}

/** Draw one clip's still. Rejects when the clip or its sheet cannot be made. */
async function drawStill(input: {
  file: VerifiedByteMember;
  loader: VerifiedByteLoader;
  render: PreviewSheetRenderer;
  avatarFile: (avatar: IncludedAvatarId) => Promise<ArrayBuffer>;
}): Promise<InspirationStill> {
  const { blob } = await input.loader.load(input.file);
  const clip: unknown = JSON.parse(await blob.text());
  const times = reviewSheetTimes(clip);
  // One sheet per Included Avatar comes back; the card shows the first.
  const [sheet] = await input.render({
    clip,
    times,
    avatarFile: input.avatarFile,
    view: "body",
  });
  const frames = sheet ? inspirationStillFrames(sheet, times.length) : [];
  if (!sheet || sheet.blob.size === 0 || frames.length === 0)
    throw new Error("The sheet holds no still.");
  return {
    url: URL.createObjectURL(sheet.blob),
    sheet: { width: sheet.width, height: sheet.height },
    frames,
  };
}

/**
 * The stills of `gestures`, by item id, drawn while the caller is mounted:
 * mount it only while the dialog is open. One clip is drawn at a time, in
 * the order given, and each is kept for the session. A Gesture whose still
 * is yet to be drawn is `pending`, so its card can keep the still's place.
 * One that cannot be drawn is absent, and its card shows its name only: no
 * canvas can draw now, or its clip failed, which is tried again the next time
 * the dialog opens.
 *
 * Nothing is drawn without a preview canvas, on a canvas whose WebGL context
 * was lost, or while the assistant works: a run's frame review draws on the
 * same renderer and must not wait behind a card.
 */
export function useInspirationStills(
  gestures: readonly PyGesture[],
): Readonly<Record<string, InspirationStill | "pending">> {
  const apiClient = useProductApiClient();
  const render = usePreviewSheetRenderer();
  const running = useGenerationStore((state) =>
    Object.values(state.runs).some((run) => run.running),
  );
  const stills = useInspirationStillStore((state) => state.stills);
  // The renderer whose canvas had gone when last asked; another may come.
  const [lost, setLost] = useState<PreviewSheetRenderer | null>(null);
  // The clips this dialog could not draw, by digest: each is tried once.
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const busy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const tools = useMemo(() => {
    const read = createIncludedAvatarFiles(apiClient);
    // Every card is drawn on the same two Avatars: their files are read
    // once and held while the dialog is open.
    const files = new Map<IncludedAvatarId, Promise<ArrayBuffer>>();
    return {
      loader: new VerifiedByteLoader({
        maxMemberBytes: MAX_ANIMA_POSE_CLIP_BYTES,
      }),
      avatarFile: (avatar: IncludedAvatarId) => {
        let file = files.get(avatar);
        if (!file) {
          file = read(avatar);
          files.set(avatar, file);
          // A read that failed is tried again by the next card.
          file.catch(() => files.delete(avatar));
        }
        return file;
      },
    };
  }, [apiClient]);

  const clipFiles = useMemo(
    () =>
      gestures.flatMap((gesture) => {
        const file = includedClipFile(gesture);
        return file ? [{ itemId: gesture.item_id, file }] : [];
      }),
    [gestures],
  );

  useEffect(() => {
    if (busy.current || running || !render || render === lost) return;
    const next = clipFiles.find(
      ({ file }) =>
        !(file.sha256 in stills) &&
        !failed.has(file.sha256) &&
        !drawing.has(file.sha256),
    );
    if (!next) return;
    const key = next.file.sha256;
    busy.current = true;
    drawing.add(key);
    // Whatever the outcome, this dialog is free for its next drawing
    // before the outcome is written: each write below starts that drawing.
    const finish = () => {
      drawing.delete(key);
      busy.current = false;
    };
    void drawStill({ file: next.file, render, ...tools }).then(
      (still) => {
        finish();
        // Kept for the session, also when the dialog closed meanwhile.
        useInspirationStillStore.setState((state) => ({
          stills: { ...state.stills, [key]: still },
        }));
      },
      (error: unknown) => {
        finish();
        const canvasGone = error instanceof PreviewRendererUnavailableError;
        if (!canvasGone)
          logger.warn("Stills", "An inspiration's still was not drawn", {
            reason: error instanceof Error ? error.name : "unknown",
          });
        if (!mounted.current) return;
        // The canvas left or lost its context: the clip itself is not at
        // fault, and is drawn when another canvas offers its renderer.
        if (canvasGone) setLost(() => render);
        else setFailed((current) => new Set(current).add(key));
      },
    );
  }, [clipFiles, failed, lost, render, running, stills, tools]);

  const drawable = render !== null && render !== lost;
  return useMemo(
    () =>
      Object.fromEntries(
        clipFiles.flatMap(({ itemId, file }) => {
          const still =
            stills[file.sha256] ??
            (drawable && !failed.has(file.sha256) ? "pending" : null);
          return still ? [[itemId, still] as const] : [];
        }),
      ),
    [clipFiles, drawable, failed, stills],
  );
}
