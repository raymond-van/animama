import * as THREE from "three";

import {
  previewSceneEntry,
  type PreviewParticleEffect,
  type PreviewSceneEffect,
} from "@/lib/avatar/motion-authoring/preview/previewMedia";
import { captureAvatarPortrait } from "@/lib/avatar/portrait";

import { ReviewStage } from "./reviewStage";
import {
  EffectSession,
  placeCamera,
  seedRandom,
  type AvatarDiagnostics,
  type PageClipMedia,
  type ViewName,
} from "./session";
import {
  chatPortraitFraming,
  createStage,
  effectEntry,
  type EffectSource,
  type Framing,
} from "./stage";

/**
 * Headless effect review page (driven by `scripts/effect-render.mjs` and
 * `effects check`).
 *
 * A stage session mounts one production `Avatar` with the chat's colour
 * pipeline and lights, applies Avatar Effects through
 * `applyAvatarVFXEffectById`, plays Particle Effects through the Avatar's
 * particle controller, and shows Scene Effects in DOM bands behind and in
 * front of the canvas as the chat draws them (`reviewStage.tsx`). Frames
 * advance in fixed 60 Hz steps with the Pose Creator ordering (effects →
 * `vrm.update` → particles) and automatic animation off. Node captures each
 * frame from the page, so Scene layers are part of the tile.
 *
 * A clip without effect events is sampled like the Gesture creator previews
 * it. A clip with effect events (a Reaction) plays through the Avatar's own
 * clip player, so its events start effects when chat would. Effects load
 * asynchronously; each frame waits until the loads its events started have
 * finished, so an effect shows from its event's frame on every run. The
 * session is `session.ts`.
 *
 * `Math.random` is seeded when a stage opens, so Particle Effects emit the
 * same particles on every run.
 */

type StageRequest = {
  avatar: { id: string; url: string };
  tile: { width: number; height: number };
  /** Applied together at time 0, in order. */
  effects: EffectSource[];
  particles: PreviewParticleEffect[];
  scenes: PreviewSceneEffect[];
  /** VRM expression held at full weight while rendering, or null. */
  expression: string | null;
  /** Gesture or Reaction clip, or null. */
  clip: unknown;
  /** The effects the clip's events play, or null when it plays none. */
  clipMedia: PageClipMedia | null;
};

type ThumbnailRequest = {
  effects: EffectSource[];
  expression: string | null;
  clip: unknown;
  avatar: { id: string; url: string };
  time: number;
  size: number;
  /** Camera distance relative to the head framing (default 1). */
  framingScale?: number;
  /** Camera target drop as a share of the view height (default 0). */
  framingDrop?: number;
};

/** The one open stage: its renderer, session and Avatar framing. */
let open: {
  stage: ReviewStage;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  session: EffectSession;
  framing: Framing;
} | null = null;

/** Close the open stage, if any. */
function closeReviewStage(): void {
  if (!open) return;
  const { stage, renderer, scene, session } = open;
  open = null;
  if (session.avatar.scene) scene.remove(session.avatar.scene);
  session.dispose();
  renderer.dispose();
  stage.dispose();
}

/**
 * Open a stage for one Avatar with the request's effects applied. Returns a
 * definition parse error (naming the field) instead of opening, or the
 * Avatar's diagnostics after applying.
 */
async function openReviewStage(
  request: StageRequest,
): Promise<{ parseError: string | null; avatar: AvatarDiagnostics | null }> {
  closeReviewStage();
  try {
    request.effects.forEach((effect) => effectEntry(effect));
    request.scenes.forEach((scene) => previewSceneEntry(scene));
  } catch (error) {
    const field = (error as { field?: unknown }).field;
    const message = error instanceof Error ? error.message : String(error);
    return {
      parseError: typeof field === "string" ? `${field}: ${message}` : message,
      avatar: null,
    };
  }
  seedRandom(0x5eed);
  const { width, height } = request.tile;
  const stage = new ReviewStage(width, height);
  const { renderer, scene, camera } = createStage(width, height);
  let session: EffectSession | null = null;
  try {
    session = await EffectSession.open(
      request.avatar.url,
      camera,
      renderer.domElement,
      request,
      stage,
    );
    stage.attachCanvas(renderer.domElement, session.avatar);
    scene.add(session.avatar.scene!);
    const framing = chatPortraitFraming(session.avatar);
    await session.apply(request);
    open = { stage, renderer, scene, camera, session, framing };
    return {
      parseError: null,
      avatar: session.diagnostics(request.avatar.id),
    };
  } catch (error) {
    session?.dispose();
    renderer.dispose();
    stage.dispose();
    throw error;
  }
}

/** Draw the open stage at `time` seconds after applying, from `view`. */
async function showReviewFrame(
  time: number,
  view: ViewName,
): Promise<AvatarDiagnostics> {
  if (!open) throw new Error("No review stage is open.");
  const { session, renderer, scene, camera, framing } = open;
  await session.advanceTo(time);
  placeCamera(camera, view, session.avatar, framing);
  renderer.render(scene, camera);
  // After the camera moves, so layers aimed at the Avatar follow this view.
  await open.stage.seek(session.time);
  return session.diagnostics("frame");
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Library thumbnail: the portrait capture's head framing, live expression. */
async function renderThumbnail(
  request: ThumbnailRequest,
): Promise<{ dataUrl: string; avatars: AvatarDiagnostics[] }> {
  const { renderer, scene, camera } = createStage(request.size, request.size);
  let session: EffectSession | null = null;
  try {
    session = await EffectSession.open(
      request.avatar.url,
      camera,
      renderer.domElement,
      { ...request, clipMedia: null },
    );
    const { avatar } = session;
    scene.add(avatar.scene!);
    const framing = chatPortraitFraming(avatar);
    await session.apply(request);
    await session.advanceTo(request.time);
    // The capture keeps only the view direction of this front camera.
    placeCamera(camera, "front", avatar, framing);
    const blob = await captureAvatarPortrait({
      avatar,
      renderer,
      camera,
      scene,
      size: request.size,
      expression: "live",
      framingScale: request.framingScale ?? 1,
      framingDrop: request.framingDrop ?? 0,
    });
    return {
      dataUrl: await blobToDataUrl(blob),
      avatars: [session.diagnostics(request.avatar.id)],
    };
  } finally {
    const avatar = session?.avatar;
    if (avatar?.scene) scene.remove(avatar.scene);
    session?.dispose();
    renderer.dispose();
  }
}

declare global {
  interface Window {
    openReviewStage: typeof openReviewStage;
    showReviewFrame: typeof showReviewFrame;
    closeReviewStage: typeof closeReviewStage;
    renderEffectThumbnail: typeof renderThumbnail;
    effectRendererReady: boolean;
  }
}

window.openReviewStage = openReviewStage;
window.showReviewFrame = showReviewFrame;
window.closeReviewStage = closeReviewStage;
window.renderEffectThumbnail = renderThumbnail;
window.effectRendererReady = true;
