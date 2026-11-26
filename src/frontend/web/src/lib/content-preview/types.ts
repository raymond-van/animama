import type {
  ItemRevisionRef,
  PyPose,
} from "@animama/runtime-contracts/api-types";
import type {
  RuntimeResourceKind,
  AnimaRuntimeCatalogSnapshot,
  RuntimeCatalogEntry,
  RuntimeContentSlot,
} from "@/lib/runtime-content/types";

export const CONTENT_PREVIEW_KINDS = [
  "avatar_model",
  "animation",
  "anima_pose_clip",
  "particle_vfx",
  "avatar_vfx",
  "scene_vfx",
] as const satisfies readonly RuntimeResourceKind[];

export type ContentPreviewKind = (typeof CONTENT_PREVIEW_KINDS)[number];

type ContentPreviewTargetBase = {
  key: string;
  kind: ContentPreviewKind;
  displayName: string;
  versionLabel: string;
  slot: RuntimeContentSlot;
  runtimeId: string;
  configSchemaVersion: number;
  config: Record<string, unknown>;
  supportEntries?: RuntimeCatalogEntry[];
  /** Exact finite Style playback, independent of the ordinary preview Loop toggle. */
  idlePlayback?: {
    timeScale: number;
    repetitions: number;
    loopType: "once" | "repeat" | "pingpong";
    durationSeconds: number;
  };
  /** Optional Anima-owned catalog used instead of Library's neutral context. */
  animaContext?: {
    animaId: string;
    runtime: AnimaRuntimeCatalogSnapshot;
  };
  /**
   * For an Avatar preview: the Local Avatar revision whose stale portrait the
   * Dock captures again once this model is loaded and at rest.
   */
  portraitRetake?: ItemRevisionRef;
};

export type ContentPreviewTarget =
  | (ContentPreviewTargetBase & { sourceType: "pose_content"; item: PyPose })
  | (ContentPreviewTargetBase & {
      sourceType: "resolved_entry";
      entry: RuntimeCatalogEntry;
    })
  | (ContentPreviewTargetBase & {
      sourceType: "resolved_action";
      entry: RuntimeCatalogEntry;
      runtime: AnimaRuntimeCatalogSnapshot;
    });

export type ContentPreviewView = "hidden" | "minimized" | "docked" | "expanded";

export type ContentPreviewLoadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "error";

/** Return whether the persistent preview renderer supports this content kind. */
export function isContentPreviewKind(
  kind: RuntimeResourceKind,
): kind is ContentPreviewKind {
  return (CONTENT_PREVIEW_KINDS as readonly RuntimeResourceKind[]).includes(
    kind,
  );
}

/** Return whether the first Preview vertical slice can render this kind. */
export function isPhaseTwoContentPreviewKind(
  kind: RuntimeResourceKind,
): kind is Extract<
  ContentPreviewKind,
  "avatar_model" | "animation" | "anima_pose_clip"
> {
  return (
    kind === "avatar_model" ||
    kind === "animation" ||
    kind === "anima_pose_clip"
  );
}

/** Pick the deterministic Library runtime slot for a canvas preview. */
export function libraryContentPreviewSlot(
  kind: ContentPreviewKind,
  role?: string | null,
): RuntimeContentSlot {
  switch (kind) {
    case "avatar_model":
      return "primary_model";
    case "animation":
      return role === "idle" || role === "idle_animation"
        ? "idle_animation"
        : "gesture";
    case "anima_pose_clip":
      return role === "reaction" ? "reaction" : "pose";
    case "particle_vfx":
      return "particle_vfx";
    case "avatar_vfx":
      return "avatar_vfx";
    case "scene_vfx":
      return role === "focus" ? "scene_focus_vfx" : "scene_background_vfx";
  }
}

export function contentPreviewSupportsLoop(
  target: ContentPreviewTarget,
): boolean {
  return target.kind === "animation" && !target.idlePlayback;
}

/** Avatar releases provide their own model; every other visual needs an Anima. */
export function contentPreviewRequiresAnimaContext(
  target: ContentPreviewTarget,
): boolean {
  return target.kind !== "avatar_model";
}
