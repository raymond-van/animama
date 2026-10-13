import { flushSync } from "react-dom";

import type { Avatar } from "@/lib/avatar";

import { SceneBands } from "./sceneBands";

/** Mid-grey tile backdrop: light and dark artwork both stay readable. */
export const TILE_BACKDROP = "#8e9097";

/**
 * One review tile as the chat draws it: Scene underlay layers, the Avatar's
 * WebGL canvas, then Scene overlay layers, over the tile backdrop. The review
 * tools capture the element from the page, so DOM Scene layers are included.
 * Each Scene Effect's animations are paused and seeked to the time since that
 * effect started, so a tile is the same on every run; an effect with a
 * duration is removed when it ends, as the chat's lifecycle bridge does.
 */
export class ReviewStage {
  readonly element: HTMLDivElement;
  /** The Scene layers; the review tools show and clear Scenes through it. */
  readonly bands: SceneBands;
  private readonly canvasHost: HTMLDivElement;

  constructor(width: number, height: number) {
    this.element = document.createElement("div");
    this.element.id = "review-stage";
    Object.assign(this.element.style, {
      position: "relative",
      width: `${width}px`,
      height: `${height}px`,
      overflow: "hidden",
      background: TILE_BACKDROP,
    });
    // No z-index on the layers' host, so its z-0 and z-20 bands stack with
    // the canvas host (z 10) as the chat stacks its bands around the canvas.
    const layers = document.createElement("div");
    Object.assign(layers.style, { position: "absolute", inset: "0" });
    this.canvasHost = document.createElement("div");
    Object.assign(this.canvasHost.style, {
      position: "absolute",
      inset: "0",
      zIndex: "10",
    });
    this.element.append(layers, this.canvasHost);
    document.body.append(this.element);
    this.bands = new SceneBands(layers);
    this.bands.setSize(width, height);
  }

  /** Place the Avatar renderer's canvas between the Scene bands. */
  attachCanvas(canvas: HTMLCanvasElement, avatar: Avatar): void {
    this.canvasHost.replaceChildren(canvas);
    this.bands.setAvatar(avatar);
  }

  /**
   * Show the Scene Effects as they are at `time` seconds of session time:
   * drop effects whose duration has ended, re-render (so layers that follow
   * the Avatar, such as focus lines aimed at the face, re-resolve against the
   * current camera), then pause each effect's animations at its own elapsed
   * time. With `freeze`, the paused animations are written into the layers'
   * styles and removed, so nothing is animated when the stage is captured;
   * the layers then stay as they are, so freeze only for a final capture.
   */
  async seek(
    time: number,
    { freeze = false }: { freeze?: boolean } = {},
  ): Promise<void> {
    this.bands.expire(time);
    this.bands.render();
    // Let layer effects that sample the Avatar commit their state.
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => undefined);
    this.bands.seekAnimations(time, { freeze });
  }

  dispose(): void {
    this.bands.dispose();
    this.element.remove();
  }
}
