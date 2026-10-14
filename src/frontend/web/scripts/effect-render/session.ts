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
import { parseAnimaPoseClip } from "@/lib/avatar/poses/animaPoseClip";
import {
  createAnimaPoseClipProgram,
  type AnimaPoseClipProgram,
} from "@/lib/avatar/poses/animaPoseClip/program";
import { getResolvedAvatarPose } from "@/lib/avatar/poses/catalog";
import { applyAvatarVFXEffectById } from "@/lib/avatar/vfx/runtime";
import { updatePoseCreatorAvatarFrame } from "@/ui/pose-creator/poseCreatorAvatarFrame";

import type { ReviewStage } from "./reviewStage";
import { missingSceneMessage } from "./sceneBands";
import { effectEntry, type EffectSource, type Framing } from "./stage";

/*
 * One Avatar with effects applied and a clip playing, advanced in fixed
 * frames: the stage session shared by the review renderer (`render.ts`) and
 * the Action reel recorder (`../animation-reel/reel.ts`).
 */

export type ViewName = "front" | "three-quarter" | "face";

/** Effects a clip's events play, by dependency alias. */
export type PageClipMedia = Omit<PreviewMedia, "notices">;

/** How a session opens: its clip, the clip's effects and held expression. */
export type SessionRequest = {
  /** Gesture or Reaction clip, or null. */
  clip: unknown;
  /** The effects the clip's events play, or null when it plays none. */
  clipMedia: PageClipMedia | null;
  /** VRM expression held at full weight, or null. */
  expression: string | null;
  /** Particle Effects applied directly (their aliases resolve too). */
  particles?: PreviewParticleEffect[];
  /**
   * `auto` (default) samples a clip without effect events as the Gesture
   * creator previews it; `avatar` always plays the clip through the Avatar's
   * own clip player, as chat does.
   */
  clipPlayback?: "auto" | "avatar";
  /** Called for each sound the clip plays, at its session time. */
  onSound?: (sound: SessionSound) => void;
};

/** A sound a clip event played: its cue, volume and session time (s). */
export type SessionSound = { cueId: string; volume: number; time: number };

export type AvatarDiagnostics = {
  id: string;
  applied: boolean;
  activeEffectIds: string[];
  warnings: string[];
  missingPoseRefs: string[];
};

export const FRAME_SEC = 1 / 60;
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
export function seedRandom(seed: number): void {
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
export class EffectSession {
  readonly avatar: Avatar;
  private readonly clip: unknown;
  private readonly playsEvents: boolean;
  private readonly onSound: SessionRequest["onSound"];
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
    request: SessionRequest,
    stage: ReviewStage | null,
  ) {
    this.avatar = avatar;
    this.media = media;
    this.clip = request.clip;
    this.onSound = request.onSound;
    // Without the effects it plays, a Reaction's clip is sampled like a Gesture.
    this.playsEvents =
      request.clipPlayback === "avatar"
        ? Boolean(request.clip)
        : Boolean(
            request.clip && request.clipMedia && clipPlaysEffects(request.clip),
          );
    this.stage = stage;
  }

  static async open(
    url: string,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    request: SessionRequest,
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
      session.problems.push(...media.getProblems());
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
   * Apply every effect at the current session time and start the clip's
   * event playback. `applied` is true only when every requested effect
   * applied.
   */
  async apply(request: {
    effects: EffectSource[];
    particles?: PreviewParticleEffect[];
    scenes?: PreviewSceneEffect[];
  }): Promise<void> {
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
      this.stage.bands.showScene(previewSceneEntry(scene), this.time);
      this.appliedCount += 1;
    }
    if (this.playsEvents && this.clip) {
      const scenes = this.stage?.bands.clipSceneSink(
        (kind, alias) => this.media.resolveSceneVFX(kind, alias),
        () => this.time,
        (alias, kind) => this.problems.push(missingSceneMessage(alias, kind)),
      );
      const onSound = this.onSound;
      this.avatar.setPoseClipExternalEventSink({
        ...scenes,
        ...(onSound
          ? {
              playSfx: (event) =>
                onSound({
                  cueId: event.cueId,
                  volume: event.volume ?? 1,
                  time: this.time,
                }),
            }
          : {}),
      });
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

  /** Advance whole frames until `time` seconds of session time. */
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

  /** Seconds of session time: whole frames advanced since opening. */
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

/** Place `camera` for a view: chat camera framing, or a face close-up. */
export function placeCamera(
  camera: THREE.PerspectiveCamera,
  view: ViewName,
  avatar: Avatar,
  framing: Framing,
): void {
  camera.fov = framing.fov;
  if (view === "face") {
    // Follow the current head so a playing Gesture stays framed.
    const face = (avatar.getHeadPosition() ?? framing.target.clone()).add(
      new THREE.Vector3(0, FACE_AIM_ABOVE_HEAD_BONE, 0),
    );
    camera.position.set(face.x, face.y, face.z + FACE_DISTANCE);
    camera.lookAt(face);
  } else {
    const offset = framing.position
      .clone()
      .sub(framing.target)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), VIEWS[view].angle);
    camera.position.copy(framing.target).add(offset);
    camera.lookAt(framing.target);
  }
  camera.updateProjectionMatrix();
}
