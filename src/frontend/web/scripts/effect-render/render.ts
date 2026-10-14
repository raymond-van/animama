import * as THREE from "three";

import { Avatar } from "@/lib/avatar";
import { applyCanonicalPose } from "@/lib/avatar/motion-authoring/kinematics";
import {
  PreviewMediaProvider,
  previewSceneEntry,
  type PreviewMedia,
  type PreviewParticleEffect,
  type PreviewSceneEffect,
} from "@/lib/avatar/motion-authoring/preview/previewMedia";
import { BUILT_IN_AVATAR_MOTION_CATALOG } from "@/lib/avatar/motion/AvatarMotionCatalog";
import { captureAvatarPortrait } from "@/lib/avatar/portrait";
import { parseAnimaPoseClip } from "@/lib/avatar/poses/animaPoseClip";
import {
  createAnimaPoseClipProgram,
  type AnimaPoseClipProgram,
} from "@/lib/avatar/poses/animaPoseClip/program";
import { getResolvedAvatarPose } from "@/lib/avatar/poses/catalog";
import { applyAvatarVFXEffectById } from "@/lib/avatar/vfx/runtime";
import { updatePoseCreatorAvatarFrame } from "@/ui/pose-creator/poseCreatorAvatarFrame";

import { ReviewStage } from "./reviewStage";
import { missingSceneMessage } from "./sceneBands";
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
 * finished (`PendingLoads`), so an effect shows from its event's frame on
 * every run.
 *
 * `Math.random` is seeded when a stage opens, so Particle Effects emit the
 * same particles on every run.
 */

type ViewName = "front" | "three-quarter" | "face";

/** Effects a clip's events play, by dependency alias. */
type PageClipMedia = Omit<PreviewMedia, "notices">;

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
  /**
   * The effects the clip's events play, or null to sample the clip as a pose
   * with `effects` applied at 0.
   */
  clipMedia: PageClipMedia | null;
  avatar: { id: string; url: string };
  time: number;
  size: number;
  /** Camera distance relative to the head framing (default 1). */
  framingScale?: number;
  /** Camera target drop as a share of the view height (default 0). */
  framingDrop?: number;
};

type AvatarDiagnostics = {
  id: string;
  applied: boolean;
  activeEffectIds: string[];
  warnings: string[];
  missingPoseRefs: string[];
};

const FRAME_SEC = 1 / 60;
/** Longest wait for the effect loads one frame's events started. */
const EVENT_LOAD_TIMEOUT_MS = 10_000;
/** Frames run before applying so spring bones settle from the load pose. */
const SETTLE_SEC = 1;
/**
 * Face view distance in metres: tighter than the chat's Portrait (close)
 * preset (0.8 m) so eye and mouth artwork is legible. Emote hovers far above
 * the head may be cropped here; the front and 3/4 views show them whole.
 */
const FACE_DISTANCE = 0.55;
/** The head bone sits at the skull base; aim this far above it, at the face. */
const FACE_AIM_ABOVE_HEAD_BONE = 0.07;

const VIEWS: Record<ViewName, { angle: number }> = {
  front: { angle: 0 },
  // The Avatar's own left is +X, so a negative angle looks from its right.
  "three-quarter": { angle: -Math.PI / 4 },
  face: { angle: 0 },
};

/** Deterministic `Math.random` (mulberry32), so particles repeat exactly. */
function seedRandom(seed: number): void {
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const resolvePose = (id: string) => {
  try {
    return getResolvedAvatarPose(id);
  } catch {
    return null;
  }
};

/**
 * Counts unfinished effect loads that clip events start. Each stage of a load
 * (resolving the effect, loading its art, applying it) is a tracked method,
 * and consecutive stages are chained by microtasks, so the count reaches zero
 * only when every load has finished or failed.
 */
class PendingLoads {
  private count = 0;

  /** Count each call of `methods` on `target` until its promise settles. */
  track<T extends object>(target: T, methods: (keyof T & string)[]): void {
    for (const name of methods) {
      const method = target[name];
      if (typeof method !== "function") continue;
      Object.assign(target, {
        [name]: async (...args: unknown[]) => {
          this.count += 1;
          try {
            return await method.apply(target, args);
          } finally {
            this.count -= 1;
          }
        },
      });
    }
  }

  /** Wait (in macrotasks, so chained stages run) until no load is pending. */
  async settle(): Promise<void> {
    const deadline = performance.now() + EVENT_LOAD_TIMEOUT_MS;
    while (this.count > 0) {
      if (performance.now() > deadline)
        throw new Error(
          `Effect loads started by clip events did not finish within ${EVENT_LOAD_TIMEOUT_MS / 1000} s.`,
        );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/** Whether a clip has events that start effects. */
function clipPlaysEffects(clip: unknown): boolean {
  const events = (clip as { events?: { kind?: string }[] } | null)?.events;
  return (events ?? []).some((event) =>
    ["avatar_vfx", "particle_vfx", "scene_vfx"].includes(event.kind ?? ""),
  );
}

/**
 * One Avatar with its effects applied, advanced in fixed frames from the
 * moment they were applied.
 */
class EffectSession {
  readonly avatar: Avatar;
  private readonly clip: unknown;
  private readonly playsEvents: boolean;
  private readonly missingPoseRefs = new Set<string>();
  private readonly problems: string[] = [];
  private readonly stage: ReviewStage | null;
  /** The effects clip events resolve, by alias. */
  private readonly media: PreviewMediaProvider;
  private readonly loads = new PendingLoads();
  /** The clip prepared for this Avatar (hand presets, planted legs). */
  private program: AnimaPoseClipProgram | null = null;
  private frame = 0;
  private requested = 0;
  private appliedCount = 0;
  private particleIds: string[] = [];

  private constructor(
    avatar: Avatar,
    media: PreviewMediaProvider,
    request: Pick<StageRequest, "clip" | "clipMedia">,
    stage: ReviewStage | null,
  ) {
    this.avatar = avatar;
    this.media = media;
    this.clip = request.clip;
    // Without the effects it plays, a Reaction's clip is sampled like a Gesture.
    this.playsEvents = Boolean(
      request.clip && request.clipMedia && clipPlaysEffects(request.clip),
    );
    this.stage = stage;
  }

  static async open(
    url: string,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    request: Pick<StageRequest, "clip" | "clipMedia" | "expression"> & {
      particles?: PreviewParticleEffect[];
    },
    stage: ReviewStage | null = null,
  ): Promise<EffectSession> {
    const media = new PreviewMediaProvider({
      avatarEffects: request.clipMedia?.avatarEffects ?? [],
      particleEffects: [
        ...(request.clipMedia?.particleEffects ?? []),
        ...(request.particles ?? []),
      ],
      sceneEffects: request.clipMedia?.sceneEffects ?? [],
      notices: [],
    });
    const avatar = new Avatar(camera, canvas, {
      motionCatalog: BUILT_IN_AVATAR_MOTION_CATALOG,
      mediaCatalog: media,
    });
    try {
      await avatar.load({ filePath: url });
      avatar.setAutomaticAnimationPlaybackEnabled(false);
      avatar.prepareFirstFrame();
      const session = new EffectSession(avatar, media, request, stage);
      if (session.playsEvents) {
        session.loads.track(media, ["loadAvatarVFX", "resolveParticleVFX"]);
        if (avatar.vfxController)
          session.loads.track(avatar.vfxController, [
            "applyAttachmentVFX",
            "applyHoverVFX",
            "applyFaceAnchoredVFX",
            "applyTextureVFX",
          ]);
        if (avatar.particleVFXController)
          session.loads.track(avatar.particleVFXController, ["playEffect"]);
      }
      if (request.expression) {
        if (!avatar.getAvailableExpressions().includes(request.expression)) {
          throw new Error(
            `Expression "${request.expression}" is not available; choose one of ${avatar.getAvailableExpressions().join(", ")}.`,
          );
        }
        avatar.setExpression(request.expression, 1);
      }
      for (let index = 0; index < SETTLE_SEC / FRAME_SEC; index += 1) {
        session.poseAt(0);
        updatePoseCreatorAvatarFrame(avatar, FRAME_SEC);
      }
      return session;
    } catch (error) {
      avatar.dispose();
      throw error;
    }
  }

  /**
   * Apply every effect at time 0 and start the clip's event playback.
   * `applied` is true only when every requested effect applied.
   */
  async apply(
    request: Pick<StageRequest, "effects"> & {
      particles?: PreviewParticleEffect[];
      scenes?: PreviewSceneEffect[];
    },
  ): Promise<void> {
    const particles = request.particles ?? [];
    const scenes = request.scenes ?? [];
    this.requested = request.effects.length + particles.length + scenes.length;
    for (const effect of request.effects) {
      const entry = effectEntry(effect);
      if (
        await applyAvatarVFXEffectById({
          avatar: this.avatar,
          effectId: entry.id,
          effectEntry: entry,
        })
      )
        this.appliedCount += 1;
    }
    for (const particle of particles) {
      const appliedId = `review:${particle.alias}`;
      const played =
        (await this.avatar.particleVFXController?.playEffect({
          effectId: particle.alias,
          appliedId,
        })) ?? false;
      if (played) {
        this.appliedCount += 1;
        this.particleIds.push(appliedId);
      }
    }
    for (const scene of scenes) {
      if (!this.stage) throw new Error("Scene Effects need a review stage.");
      this.stage.bands.showScene(previewSceneEntry(scene), 0);
      this.appliedCount += 1;
    }
    if (this.playsEvents && this.clip) {
      this.avatar.setPoseClipExternalEventSink(
        this.stage?.bands.clipSceneSink(
          (kind, alias) => this.media.resolveSceneVFX(kind, alias),
          () => this.time,
          (alias, kind) => this.problems.push(missingSceneMessage(alias, kind)),
        ) ?? null,
      );
      this.avatar.playAnimaPoseClip(
        this.clip as Parameters<Avatar["playAnimaPoseClip"]>[0],
        { preserveProceduralOffsets: true },
      );
    }
  }

  /** Pose the Avatar from the clip at `time`, as the Gesture creator previews it. */
  private poseAt(time: number): void {
    const vrm = this.avatar.vrm;
    if (!this.clip || !vrm || this.playsEvents) return;
    this.program ??= createAnimaPoseClipProgram(parseAnimaPoseClip(this.clip), {
      vrm,
      resolvePose,
    });
    const { sample, diagnostics } = this.program.sample(time);
    diagnostics.missingPoseRefs.forEach((id) => this.missingPoseRefs.add(id));
    applyCanonicalPose(vrm, sample.humanoid ?? {});
    for (const [name, weight] of Object.entries(sample.expressions ?? {})) {
      // Effect-forced and --expression overrides keep precedence.
      if (!this.avatar.hasExpressionOverride(name))
        vrm.expressionManager?.setValue(name, weight);
    }
  }

  /** Advance whole frames until `time` seconds after applying. */
  async advanceTo(time: number): Promise<void> {
    const target = Math.round(time / FRAME_SEC);
    while (this.frame < target) {
      this.frame += 1;
      if (this.playsEvents) {
        this.avatar.update(FRAME_SEC);
        await this.loads.settle();
      } else {
        this.poseAt(this.frame * FRAME_SEC);
        updatePoseCreatorAvatarFrame(this.avatar, FRAME_SEC);
      }
    }
    this.avatar.vrm?.scene.updateMatrixWorld(true);
  }

  /** Seconds since the effects were applied. */
  get time(): number {
    return this.frame * FRAME_SEC;
  }

  diagnostics(id: string): AvatarDiagnostics {
    const snapshot = this.avatar.vfxController?.getSnapshot();
    const particles = this.avatar.particleVFXController?.getSnapshot();
    const activeParticles = new Map(
      particles?.activeInstances.map((instance) => [
        instance.appliedId,
        instance.effectId,
      ]) ?? [],
    );
    return {
      id,
      applied: this.requested > 0 && this.appliedCount === this.requested,
      activeEffectIds: [
        ...[
          ...(snapshot?.activeEffects ?? []),
          ...(snapshot?.attachmentEffects ?? []),
        ].map((effect) => effect.effectId),
        // Particle Effects applied directly report their review id; those
        // a clip event started report their effect id.
        ...[...activeParticles].map(([appliedId, effectId]) =>
          this.particleIds.includes(appliedId) ? appliedId : effectId,
        ),
        ...(this.stage?.bands.sceneIds() ?? []),
      ],
      warnings: [
        ...(snapshot?.warnings ?? ["The Avatar has no effect controller."]),
        ...(particles?.warnings ?? []),
        // Read now: a clip event's override can fail after the media loaded.
        ...this.media.getProblems(),
        ...this.problems,
      ],
      missingPoseRefs: [...this.missingPoseRefs],
    };
  }

  dispose(): void {
    this.avatar.setPoseClipExternalEventSink(null);
    this.avatar.dispose();
  }
}

/** Place `camera` for a view: chat Portrait framing, or a face close-up. */
function placeCamera(
  camera: THREE.PerspectiveCamera,
  view: ViewName,
  avatar: Avatar,
  portrait: Framing,
): void {
  camera.fov = portrait.fov;
  if (view === "face") {
    // Follow the current head so a playing Gesture stays framed.
    const face = (avatar.getHeadPosition() ?? portrait.target.clone()).add(
      new THREE.Vector3(0, FACE_AIM_ABOVE_HEAD_BONE, 0),
    );
    camera.position.set(face.x, face.y, face.z + FACE_DISTANCE);
    camera.lookAt(face);
  } else {
    const offset = portrait.position
      .clone()
      .sub(portrait.target)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), VIEWS[view].angle);
    camera.position.copy(portrait.target).add(offset);
    camera.lookAt(portrait.target);
  }
  camera.updateProjectionMatrix();
}

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

/**
 * Library thumbnail: the portrait capture's head framing, live expression.
 * With `clipMedia`, the clip plays and its events start their effects, so
 * `time` is the clip's time.
 */
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
      request,
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
