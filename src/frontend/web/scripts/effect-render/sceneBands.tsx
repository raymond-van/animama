import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import "./sceneLayers.css";
import type { AnimaPoseClipEventSink, Avatar } from "@/lib/avatar";
import {
  buildSceneVFXRuntimeEntry,
  type SceneVFXActiveByKind,
} from "@/lib/scene-vfx/runtime-state";
import type {
  SceneVFXEntry,
  SceneVFXKind,
  SceneVFXRuntimeEntry,
} from "@/lib/scene-vfx/types";
import { CanvasViewportProvider } from "@/ui/main/canvas/CanvasViewportContext";
import { resolveClipOwnedSceneVFXEntry } from "@/ui/main/canvas/clip-owned-scene-vfx";
import { SceneRuntimeProvider } from "@/ui/main/canvas/SceneRuntimeContext";
import {
  SceneVFXOverlayLayers,
  SceneVFXUnderlayLayers,
} from "@/ui/main/scene-vfx/SceneVFXLayers";

/** Why a clip's Scene event shows nothing: no dependency of its kind. */
export function missingSceneMessage(alias: string, kind: SceneVFXKind): string {
  return `Scene Effect “${alias}” has no ${kind === "focus_lines" ? "focus-lines" : "background"} dependency.`;
}

/**
 * A shown Scene: its runtime entry (built once, so a one-shot layer such as
 * the entry flash starts once), its start (session seconds), the id
 * diagnostics report and, for a Scene a clip started, the Scene its clear
 * brings back.
 */
type ShownScene = {
  entry: SceneVFXEntry;
  runtime: SceneVFXRuntimeEntry;
  startedAt: number;
  effectId: string;
  clip: { restores: ShownScene | null } | null;
};

/**
 * The chat's Scene Effect layers for one Avatar view, drawn into `host` by the
 * app's own components: the underlay band (z-0) and the overlay band (z-20).
 * The page places the Avatar canvas at z 10 in the same stacking context, so
 * the bands sit behind and in front of it as chat stacks them. Animations are
 * driven by the page's clock: `seekAnimations` pauses each Scene's animations
 * at the time since that Scene started. Shared by the review stage
 * (`reviewStage.tsx`), the bench and the headed preview.
 */
export class SceneBands {
  readonly host: HTMLElement;
  private readonly root: Root;
  private readonly scenes = new Map<SceneVFXKind, ShownScene>();
  private avatar: Avatar | null = null;
  private width = 0;
  private height = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    this.root = createRoot(host);
  }

  /** The Avatar that layers aimed at it (focus lines on the face) follow. */
  setAvatar(avatar: Avatar | null): void {
    this.avatar = avatar;
    this.render();
  }

  /** The view's size in CSS pixels; re-renders only when it changes. */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.render();
  }

  /**
   * Show a Scene Effect from session time `startedAt` (seconds), replacing
   * any of its kind. `effectId` is the id diagnostics report (default the
   * entry's).
   */
  showScene(
    entry: SceneVFXEntry,
    startedAt: number,
    effectId: string = entry.id,
  ): void {
    this.scenes.set(entry.kind, {
      entry,
      runtime: buildSceneVFXRuntimeEntry(entry),
      startedAt,
      effectId,
      clip: null,
    });
    this.render();
  }

  /** Remove every Scene. */
  clearScenes(): void {
    if (this.scenes.size === 0) return;
    this.scenes.clear();
    this.render();
  }

  /**
   * The Scene half of a clip event sink, applying a clip's Scene Effects as
   * chat does: each lasts until the clip clears it, and a clear removes only
   * the Scene its own event started and brings back the one shown before the
   * clip. `resolve` finds a Scene by kind and dependency alias (null reports
   * it through `onMissing`, which may throw to fail the clip event as chat
   * does); `now` is the session time in seconds.
   */
  clipSceneSink(
    resolve: (kind: SceneVFXKind, alias: string) => SceneVFXEntry | null,
    now: () => number,
    onMissing: (alias: string, kind: SceneVFXKind) => void,
  ): Pick<AnimaPoseClipEventSink, "applySceneVFX" | "clearSceneVFX"> {
    return {
      applySceneVFX: (event, context) => {
        const scene = resolve(event.sceneKind, event.presetId);
        if (!scene) {
          onMissing(event.presetId, event.sceneKind);
          return;
        }
        const shown = this.scenes.get(event.sceneKind) ?? null;
        const entry = resolveClipOwnedSceneVFXEntry(
          event,
          context,
          () => scene,
        );
        this.scenes.set(event.sceneKind, {
          entry,
          runtime: buildSceneVFXRuntimeEntry(entry),
          startedAt: now(),
          effectId: event.presetId,
          clip: { restores: shown?.clip ? shown.clip.restores : shown },
        });
        this.render();
      },
      clearSceneVFX: (event, context) => {
        const shown = this.scenes.get(event.sceneKind);
        if (!shown?.clip || shown.entry.id !== context.appliedId) return;
        if (shown.clip.restores)
          this.scenes.set(event.sceneKind, shown.clip.restores);
        else this.scenes.delete(event.sceneKind);
        this.render();
      },
    };
  }

  /** Scene Effects currently shown, by effect id. */
  sceneIds(): string[] {
    return [...this.scenes.values()].map(({ effectId }) => effectId);
  }

  /** Display names of the Scene Effects currently shown. */
  sceneLabels(): string[] {
    return [...this.scenes.values()].map(({ entry }) => entry.label);
  }

  /**
   * Remove Scenes whose duration has ended by session time `time`, as the
   * chat's lifecycle bridge does. Returns whether any was removed.
   */
  expire(time: number): boolean {
    let removed = false;
    for (const [kind, { entry, startedAt }] of this.scenes)
      if (
        entry.durationMs != null &&
        time - startedAt > entry.durationMs / 1000
      ) {
        this.scenes.delete(kind);
        removed = true;
      }
    if (removed) this.render();
    return removed;
  }

  /**
   * Pause each Scene's animations at its own elapsed time at `time`. With
   * `freeze`, each paused animation's values are committed to its element's
   * style and the animation is cancelled: a capture of static layers is the
   * same on every run, while Chrome may rasterize an animated item slightly
   * differently from run to run. Frozen layers do not animate again.
   */
  seekAnimations(
    time: number,
    { freeze = false }: { freeze?: boolean } = {},
  ): void {
    for (const { entry, startedAt } of this.scenes.values()) {
      const root = this.host.querySelector(
        `[data-scene-vfx-id="${CSS.escape(entry.id)}"]`,
      );
      const elapsedMs = Math.max(0, (time - startedAt) * 1000);
      for (const animation of root?.getAnimations({ subtree: true }) ?? []) {
        animation.pause();
        animation.currentTime = elapsedMs;
        if (freeze) {
          animation.commitStyles();
          animation.cancel();
        }
      }
    }
  }

  /** Draw the shown Scenes now. */
  render(): void {
    const activeByKind: SceneVFXActiveByKind = {};
    for (const { entry, runtime } of this.scenes.values()) {
      if (entry.kind === "focus_lines")
        activeByKind.focus_lines = runtime as NonNullable<
          SceneVFXActiveByKind["focus_lines"]
        >;
      else
        activeByKind.background_layers = runtime as NonNullable<
          SceneVFXActiveByKind["background_layers"]
        >;
    }
    const viewport = {
      width: this.width,
      height: this.height,
      aspectRatio: this.height > 0 ? this.width / this.height : 1,
      hasSize: this.width > 0 && this.height > 0,
    };
    flushSync(() =>
      this.root.render(
        <CanvasViewportProvider value={viewport}>
          <SceneRuntimeProvider value={{ avatar: this.avatar }}>
            <SceneVFXUnderlayLayers activeByKind={activeByKind} />
            <SceneVFXOverlayLayers
              activeByKind={activeByKind}
              className="z-20"
            />
          </SceneRuntimeProvider>
        </CanvasViewportProvider>,
      ),
    );
  }

  dispose(): void {
    this.scenes.clear();
    this.root.unmount();
  }
}
