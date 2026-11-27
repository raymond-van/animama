import type { WebGLRenderer } from "three";
import { create } from "zustand";

import {
  MAX_REVIEW_SHEET_ROWS,
  renderIncludedAvatarReviewSheets,
  type IncludedAvatarFile,
  type IncludedAvatarReviewSheet,
} from "@/lib/avatar/motion-authoring/reviewSheet";
import { isRecord } from "@/lib/records";

/**
 * Where the page finds a renderer for review sheets. A frame review needs
 * contact sheets of a draft on the Included Avatars. They are drawn through a
 * render target on the preview canvas's own `WebGLRenderer`, so the page
 * keeps one WebGL context. That renderer exists only inside the canvas, so a
 * bridge component mounted there (`GenerationPreviewRendererBridge`)
 * registers it here while the canvas is mounted, and the draft worker asks
 * here when a run requests sheets. With no canvas there is no renderer, and
 * the page says that the frames cannot be drawn.
 */

/**
 * Draws one review sheet per Included Avatar. `avatarFile` answers with each
 * Included Avatar's own VRM file; no other Avatar can be drawn. Rejects when
 * the preview canvas has gone or lost its WebGL context.
 */
export type PreviewSheetRenderer = (request: {
  clip: unknown;
  /** Seconds from the clip's start; one row each, at most six. */
  times: readonly number[];
  avatarFile: IncludedAvatarFile;
}) => Promise<IncludedAvatarReviewSheet[]>;

/** The preview canvas left, or its WebGL context was lost, before the sheets were done. */
export class PreviewRendererUnavailableError extends Error {
  constructor() {
    super("The preview renderer is not available.");
    this.name = "PreviewRendererUnavailableError";
  }
}

const usePreviewSheetRendererStore = create<{
  render: PreviewSheetRenderer | null;
}>(() => ({ render: null }));

/** The registered sheet renderer, or `null` while no preview canvas is mounted. */
export function usePreviewSheetRenderer(): PreviewSheetRenderer | null {
  return usePreviewSheetRendererStore((state) => state.render);
}

/**
 * Offer `renderer` for review sheets until the returned function is called.
 * Nothing is drawn after that: a request in flight stops before its next
 * Avatar, and sheets that finish afterwards are discarded, since a renderer
 * whose canvas has gone may have drawn nothing.
 */
export function registerPreviewSheetRenderer(
  renderer: WebGLRenderer,
): () => void {
  let registered = true;
  const assertUsable = () => {
    if (!registered || renderer.getContext().isContextLost())
      throw new PreviewRendererUnavailableError();
  };
  const render: PreviewSheetRenderer = async (request) => {
    assertUsable();
    const sheets = await renderIncludedAvatarReviewSheets({
      renderer,
      clip: request.clip,
      times: request.times,
      // Checked on both sides of each read: the canvas can leave while an
      // Avatar's file is fetched.
      avatarFile: async (avatar) => {
        assertUsable();
        const file = await request.avatarFile(avatar);
        assertUsable();
        return file;
      },
    });
    assertUsable();
    return sheets;
  };
  usePreviewSheetRendererStore.setState({ render });
  return () => {
    registered = false;
    // A newer canvas may already have registered its own renderer.
    if (usePreviewSheetRendererStore.getState().render === render)
      usePreviewSheetRendererStore.setState({ render: null });
  };
}

/**
 * The times a review sheet shows for a clip: its beats, in time order. A clip
 * with more beats than a sheet has rows keeps the first, the last and evenly
 * spread ones between. A clip without readable beats shows its start.
 */
export function reviewSheetTimes(clip: unknown): number[] {
  const beats = isRecord(clip) && Array.isArray(clip.beats) ? clip.beats : [];
  const times = [
    ...new Set(
      beats.flatMap((beat) =>
        isRecord(beat) &&
        typeof beat.time === "number" &&
        Number.isFinite(beat.time) &&
        beat.time >= 0
          ? [beat.time]
          : [],
      ),
    ),
  ].sort((left, right) => left - right);
  if (times.length === 0) return [0];
  if (times.length <= MAX_REVIEW_SHEET_ROWS) return times;
  const last = times.length - 1;
  return Array.from(
    { length: MAX_REVIEW_SHEET_ROWS },
    (_, row) => times[Math.round((row * last) / (MAX_REVIEW_SHEET_ROWS - 1))]!,
  );
}
