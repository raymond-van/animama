import * as THREE from "three";

import { Avatar } from "@/lib/avatar";
import { BUILT_IN_AVATAR_MOTION_CATALOG } from "@/lib/avatar/motion/AvatarMotionCatalog";
import type { ProceduralAnimationLayerId } from "@/lib/avatar/proc-animation/types";
import {
  EMPTY_PREVIEW_MEDIA,
  PreviewMediaProvider,
  clipUsesMedia,
  previewMediaNotices,
  previewSceneEntry,
  type PreviewEffect,
  type PreviewMedia,
} from "@/lib/avatar/motion-authoring/preview/previewMedia";
import type { PreviewState } from "@/lib/avatar/motion-authoring/preview/previewSession";
import {
  REVIEW_REGIONS,
  REVIEW_REGION_LABELS,
} from "@/lib/avatar/motion-authoring/preview/reviewRegions";
import type {
  PreviewChoice,
  PreviewClip,
} from "@/lib/avatar/motion-authoring/preview/sources";
import { parseParticleVFXRuntimeConfig } from "@/lib/avatar/particle-vfx/runtimeConfig";
import { effectSourceEntry } from "@/lib/avatar/vfx/effectSource";
import { applyAvatarVFXEffectById } from "@/lib/avatar/vfx/runtime";

import { SceneBands, missingSceneMessage } from "../effect-render/sceneBands";
import {
  addChatLights,
  applyChatColorPipeline,
  chatPortraitFraming,
  type Framing,
} from "../effect-render/stage";

/**
 * Motion and effect preview page (served by `scripts/animation-preview.mjs`).
 * Each row plays one source on both Included Avatars through the app's own
 * `Avatar` playback, lit and tone-mapped like the chat canvas, so fades,
 * live-layer mutes, expression precedence and clip effects look as they do in
 * chat. Each view draws the chat's Scene layers (`SceneBands`) behind and in
 * front of the shared transparent canvas. A Gesture or Reaction plays its
 * Avatar, Particle and Scene Effects through a media provider built from its
 * dependencies, with Scene events applied as chat applies them. An effect
 * source is applied through the runtime path: an Avatar Effect through
 * `applyAvatarVFXEffectById`, a Particle Effect through the Avatar's particle
 * controller and a Scene Effect in the view's Scene layers. Effect warnings
 * and anything the preview cannot play are listed on the page. The page keeps
 * one playback clock for all rows; Scene animations are paused and seeked to
 * it, so pausing, scrubbing and speed apply to them too. The Review and
 * Compare pickers switch the server to other listed sources.
 */

type ServerState = PreviewState & { avatars: { id: string; url: string }[] };
type CameraPreset = "front" | "threeQuarter" | "side" | "face" | "portrait";

type RowView = {
  key: string;
  label: string;
  /** The source file; a different path means another source was picked. */
  path: string;
  clip: PreviewClip | null;
  effect: PreviewEffect | null;
  /** How long the effect source plays before it ends; null loops it. */
  effectDuration: number | null;
  /** Effects the clip's events play; null when it has none. */
  media: PreviewMedia | null;
  version: string | null;
};

type Cell = {
  rowKey: string;
  avatarId: string;
  avatar: Avatar;
  /** Effects the Avatar's clip events resolve; swapped per source. */
  media: PreviewMediaProvider;
  /** The view's Scene layers, in a host placed over the view. */
  bands: SceneBands;
  /**
   * Seconds on the cell's own timeline: the playhead for an effect source,
   * time since the clip started for a clip (Scene animations seek to it).
   */
  time: number;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Rest head height, which frames every camera preset. */
  headHeight: number;
  /** The chat's Portrait camera preset for the Avatar at rest. */
  portrait: Framing;
  /** Where the camera looks, for the browser test. */
  cameraTarget: THREE.Vector3;
  label: HTMLDivElement;
  playingVersion: string | null;
  /**
   * The source version an effect-playing cell was created for: a changed
   * effect gets fresh Avatars, so their warnings describe only it.
   */
  builtFor: string | null;
  /** Increases with every effect apply or removal; stale applies stop. */
  effectRequest: number;
  /** Why the effect source did not apply, if it did not. */
  effectProblem: string | null;
  /** Completed applies of the effect source, for the browser test. */
  effectApplies: number;
  /** Latest diagnostics, refreshed a few times a second. */
  diagnostics: CellDiagnostics;
  /** Which live layers the Avatar enables by default. */
  layerDefaults: Map<ProceduralAnimationLayerId, boolean>;
};

/** What a cell shows of its effects, for the page and the browser test. */
type CellDiagnostics = {
  row: string;
  avatar: string;
  /** The source version the cell plays. */
  version: string | null;
  /** Completed applies of an effect source (each loop, seek or reload). */
  applies: number;
  /** Labels of the active Avatar Effects. */
  active: string[];
  /** Running Particle Effect instances. */
  particles: number;
  /** Ids of the Scene Effects shown (dependency aliases). */
  scenes: string[];
  warnings: string[];
};

const FRAME = 1 / 30;
/** Field of view of every camera preset but Portrait, which uses the chat's. */
const PREVIEW_FOV = 30;
/** Applied id of an effect source, distinct from any clip event's. */
const PREVIEW_EFFECT_ID = "animation-preview:effect";
/** An effect source without `--duration` is applied again this often. */
const EFFECT_LOOP_SEC = 4;
/** Shown after a timed effect is removed, before the loop restarts. */
const EFFECT_TAIL_SEC = 0.5;
const DIAGNOSTICS_INTERVAL_MS = 250;

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const ui = {
  status: element<HTMLSpanElement>("status"),
  pickSource: element<HTMLSelectElement>("pick-source"),
  pickCompare: element<HTMLSelectElement>("pick-compare"),
  pickPrevious: element<HTMLButtonElement>("pick-previous"),
  pickNext: element<HTMLButtonElement>("pick-next"),
  pickPosition: element<HTMLSpanElement>("pick-position"),
  errors: element<HTMLDivElement>("errors"),
  views: element<HTMLDivElement>("views"),
  sceneBands: element<HTMLDivElement>("scene-bands"),
  canvas: element<HTMLCanvasElement>("canvas"),
  labels: element<HTMLDivElement>("labels"),
  notices: element<HTMLDivElement>("effect-notices"),
  play: element<HTMLButtonElement>("play"),
  restart: element<HTMLButtonElement>("restart"),
  stepBack: element<HTMLButtonElement>("step-back"),
  stepForward: element<HTMLButtonElement>("step-forward"),
  loop: element<HTMLInputElement>("loop"),
  speed: element<HTMLSelectElement>("speed"),
  time: element<HTMLSpanElement>("time"),
  cameras: element<HTMLDivElement>("cameras"),
  liveLayers: element<HTMLInputElement>("live-layers"),
  previous: element<HTMLInputElement>("previous"),
  scrubber: element<HTMLInputElement>("scrubber"),
  markers: element<HTMLDivElement>("markers"),
  notesFile: element<HTMLParagraphElement>("notes-file"),
  noteForm: element<HTMLFormElement>("note-form"),
  noteText: element<HTMLTextAreaElement>("note-text"),
  notePin: element<HTMLSelectElement>("note-pin"),
  noteRegion: element<HTMLSelectElement>("note-region"),
  noteError: element<HTMLParagraphElement>("note-error"),
  notesList: element<HTMLOListElement>("notes-list"),
};

const renderer = new THREE.WebGLRenderer({
  canvas: ui.canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
});
applyChatColorPipeline(renderer);
// Transparent, so each view's backdrop and Scene underlay show through.
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setScissorTest(true);

const playback = {
  time: 0,
  playing: true,
  speed: 1,
  camera: "front" as CameraPreset,
};
let server: ServerState | null = null;
let rows: RowView[] = [];
let previousRow: RowView | null = null;
let cells: Cell[] = [];
const clock = new THREE.Clock();

// ── Rows and Avatars ─────────────────────────────────────────────────────

/** The longest row's length. */
function totalDuration(): number {
  return Math.max(0.001, ...rows.map(rowEnd));
}

/**
 * How long an effect source plays before it ends on its own: `--duration`,
 * else a Particle Effect's default lifetime or a Scene Effect's own duration.
 * Null loops it every `EFFECT_LOOP_SEC`.
 */
function effectDuration(effect: PreviewEffect): number | null {
  if (effect.duration !== null) return effect.duration;
  if (effect.kind === "particle_effect")
    return parseParticleVFXRuntimeConfig(effect.config).defaultDurationSec;
  if (effect.kind === "scene_effect") {
    const durationMs = previewSceneEntry(effect).durationMs;
    return durationMs == null ? null : durationMs / 1000;
  }
  return null;
}

/**
 * A row's timeline length: a one-shot clip includes its fade-out; an effect
 * source loops every `EFFECT_LOOP_SEC`, or runs its duration and then shows
 * its removal.
 */
function rowEnd(row: RowView | undefined): number {
  if (row?.effect)
    return row.effectDuration === null
      ? EFFECT_LOOP_SEC
      : row.effectDuration + EFFECT_TAIL_SEC;
  if (!row?.clip) return 0;
  return row.clip.duration + (row.clip.loop ? 0 : row.clip.fadeOut);
}

/** Whether a row uses effects, so its Avatars are rebuilt when it changes. */
function usesEffects(row: RowView | undefined): boolean {
  return Boolean(row?.effect || row?.media);
}

async function createCell(row: RowView, avatarId: string, url: string) {
  // The view's backdrop is its Scene host's (see preview.css).
  const scene = new THREE.Scene();
  addChatLights(scene);
  const camera = new THREE.PerspectiveCamera(PREVIEW_FOV, 1, 0.05, 20);
  const media = new PreviewMediaProvider(row.media ?? EMPTY_PREVIEW_MEDIA);
  const avatar = new Avatar(camera, ui.canvas, {
    motionCatalog: BUILT_IN_AVATAR_MOTION_CATALOG,
    mediaCatalog: media,
  });
  await avatar.load({ filePath: url });
  if (!avatar.scene || !avatar.vrm) throw new Error(`Cannot load ${avatarId}.`);
  scene.add(avatar.scene);
  avatar.update(0);
  const head = avatar.vrm.humanoid
    .getRawBoneNode("head")!
    .getWorldPosition(new THREE.Vector3());
  const label = document.createElement("div");
  label.className = "view-label";
  ui.labels.append(label);
  const host = document.createElement("div");
  host.className = "scene-cell";
  ui.sceneBands.append(host);
  const bands = new SceneBands(host);
  bands.setAvatar(avatar);
  const cell: Cell = {
    rowKey: row.key,
    avatarId,
    avatar,
    media,
    bands,
    time: 0,
    scene,
    camera,
    headHeight: head.y,
    portrait: chatPortraitFraming(avatar),
    cameraTarget: new THREE.Vector3(),
    label,
    playingVersion: null,
    builtFor: usesEffects(row) ? row.version : null,
    effectRequest: 0,
    effectProblem: null,
    effectApplies: 0,
    diagnostics: {
      row: row.label,
      avatar: avatarId,
      version: null,
      applies: 0,
      active: [],
      particles: 0,
      scenes: [],
      warnings: [],
    },
    layerDefaults: new Map(
      avatar
        .getProceduralAnimationSnapshot()
        ?.layers.map(({ id, enabled }) => [id, enabled]) ?? [],
    ),
  };
  applyLiveLayers(cell);
  avatar.setPoseClipExternalEventSink(
    bands.clipSceneSink(
      (kind, alias) => cell.media.resolveSceneVFX(kind, alias),
      () => cell.time,
      // As chat does: the clip event fails, and the page lists its error.
      (alias, kind) => {
        throw new Error(missingSceneMessage(alias, kind));
      },
    ),
  );
  return cell;
}

/** Create or dispose cells so there is one per visible row and Avatar. */
async function syncCells() {
  if (!server) return;
  const visible = visibleRows();
  const keep = (cell: Cell) => {
    const row = visible.find(({ key }) => key === cell.rowKey);
    // A changed effect source or effect-playing clip gets fresh Avatars.
    return Boolean(
      row &&
      (usesEffects(row) ? cell.builtFor === row.version : !cell.builtFor),
    );
  };
  for (const cell of cells.filter((cell) => !keep(cell))) {
    cell.avatar.setPoseClipExternalEventSink(null);
    cell.avatar.dispose();
    cell.bands.dispose();
    cell.bands.host.remove();
    cell.label.remove();
  }
  cells = cells.filter(keep);
  for (const row of visible)
    for (const { id, url } of server.avatars)
      if (
        !cells.some((cell) => cell.rowKey === row.key && cell.avatarId === id)
      )
        cells.push(await createCell(row, id, url));
  // Keep row order, then Avatar order, as the grid draws them.
  const order = visible.map(({ key }) => key);
  const avatarOrder = server.avatars.map(({ id }) => id);
  cells.sort(
    (a, b) =>
      order.indexOf(a.rowKey) - order.indexOf(b.rowKey) ||
      avatarOrder.indexOf(a.avatarId) - avatarOrder.indexOf(b.avatarId),
  );
}

function visibleRows(): RowView[] {
  return previousRow && ui.previous.checked ? [...rows, previousRow] : rows;
}

function rowFor(cell: Cell) {
  return visibleRows().find(({ key }) => key === cell.rowKey);
}

/** (Re)start a cell's source from the beginning, then move it to `time`. */
function startCell(cell: Cell, time: number) {
  const row = rowFor(cell);
  cell.avatar.stopClip({ transition: { mode: "fadeOut", durationSec: 0 } });
  clearEffect(cell);
  cell.time = 0;
  cell.playingVersion = null;
  cell.media.setMedia(
    row?.effect ? sourceMedia(row.effect) : (row?.media ?? EMPTY_PREVIEW_MEDIA),
  );
  if (row?.effect) {
    cell.playingVersion = row.version;
    void applyEffect(cell, time);
    return;
  }
  if (!row?.clip) return;
  cell.avatar.playAnimaPoseClip(row.clip.clip, {
    preserveProceduralOffsets: true,
  });
  cell.playingVersion = row.version;
  if (time > 0) seekCell(cell, time);
}

/** The media a Particle or Scene Effect source plays from, by its alias. */
function sourceMedia(effect: PreviewEffect): PreviewMedia {
  if (effect.kind === "particle_effect")
    return { ...EMPTY_PREVIEW_MEDIA, particleEffects: [effect] };
  if (effect.kind === "scene_effect")
    return { ...EMPTY_PREVIEW_MEDIA, sceneEffects: [effect] };
  return EMPTY_PREVIEW_MEDIA;
}

function seekCell(cell: Cell, time: number) {
  const row = rowFor(cell);
  if (row?.effect) {
    void applyEffect(cell, time);
    return;
  }
  // A loop wraps on its own clock; a one-shot holds its end once finished.
  const target = row?.clip?.loop
    ? time
    : Math.min(time, Math.max(0, rowEnd(row) - 1e-4));
  if (row?.clip && clipUsesMedia(row.clip.clip)) {
    replayCell(cell, target);
    return;
  }
  if (!cell.avatar.isClipActive()) startCell(cell, 0);
  cell.avatar.seekPoseClip(target);
  cell.time = target;
}

/**
 * Replay a clip with effect events from its start in frames: seeking alone
 * would skip the events before `time`, so their effects would not show. An
 * effect that loads during the replay starts its own motion once loaded.
 */
function replayCell(cell: Cell, time: number) {
  startCell(cell, 0);
  for (let elapsed = 0; elapsed < time - 1e-6; ) {
    const step = Math.min(FRAME, time - elapsed);
    cell.time += step;
    cell.avatar.update(step);
    elapsed += step;
  }
}

/** Remove the cell's effect source and stop any apply still loading. */
function clearEffect(cell: Cell) {
  cell.effectRequest += 1;
  cell.effectProblem = null;
  cell.avatar.vfxController?.removeEffect(PREVIEW_EFFECT_ID);
  cell.avatar.particleVFXController?.clearEffect(PREVIEW_EFFECT_ID);
  cell.bands.clearScenes();
}

/** Which repeat of an effect row's own cycle (`rowEnd`) the playhead is in. */
function effectCycle(row: RowView, time: number): number {
  return time <= 0 ? 0 : Math.ceil(time / rowEnd(row)) - 1;
}

/** Seconds into the effect row's current cycle; a cycle's end belongs to it. */
function effectPhase(row: RowView, time: number): number {
  return time - effectCycle(row, time) * rowEnd(row);
}

/**
 * Show the row's effect source as it is at playhead `time`: remove it, apply
 * it again through the runtime path, then step its frames to the time within
 * its own cycle. A timed effect is absent after its duration.
 */
async function applyEffect(cell: Cell, time: number) {
  clearEffect(cell);
  cell.time = time;
  const request = cell.effectRequest;
  const row = rowFor(cell);
  const effect = row?.effect;
  if (!row || !effect) return;
  const phase = effectPhase(row, time);
  if (row.effectDuration !== null && phase >= row.effectDuration) return;
  let problem: string | null = null;
  try {
    problem = await startEffect(cell, effect, time - phase);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  if (request !== cell.effectRequest) return;
  cell.effectProblem = problem;
  cell.effectApplies += 1;
  for (let elapsed = 0; elapsed < phase - 1e-6; ) {
    const step = Math.min(FRAME, phase - elapsed);
    cell.avatar.vfxController?.update(step);
    cell.avatar.particleVFXController?.update(step);
    elapsed += step;
  }
  refreshDiagnostics();
}

/**
 * Start an effect source from playhead time `startedAt` through the runtime
 * path its kind uses. Returns why it did not start, or null.
 */
async function startEffect(
  cell: Cell,
  effect: PreviewEffect,
  startedAt: number,
): Promise<string | null> {
  if (effect.kind === "scene_effect") {
    const entry = cell.media.resolveSceneVFX(
      effect.definition.kind === "focus_lines"
        ? "focus_lines"
        : "background_layers",
      effect.alias,
    );
    if (!entry) return "The Scene Effect could not be drawn.";
    cell.bands.showScene(
      effect.duration === null
        ? entry
        : { ...entry, durationMs: effect.duration * 1000 },
      startedAt,
      effect.alias,
    );
    return null;
  }
  if (effect.kind === "particle_effect") {
    const played = await cell.avatar.particleVFXController?.playEffect({
      effectId: effect.alias,
      appliedId: PREVIEW_EFFECT_ID,
      ...(effect.duration === null
        ? {}
        : {
            lifetime: { kind: "duration", durationSec: effect.duration },
          }),
    });
    return played ? null : "The Particle Effect could not be played.";
  }
  const entry = effectSourceEntry(effect);
  const applied = await applyAvatarVFXEffectById({
    avatar: cell.avatar,
    effectId: entry.id,
    appliedEffectId: PREVIEW_EFFECT_ID,
    effectEntry: entry,
  });
  if (applied) return null;
  const part = cell.avatar.vfxController?.findUnavailableFacePart(entry);
  return part
    ? `This Avatar has no ${part}, so the effect is skipped (as in chat).`
    : "The effect could not be applied.";
}

function seekAll(time: number) {
  playback.time = Math.min(Math.max(0, time), totalDuration());
  for (const cell of cells) seekCell(cell, playback.time);
  showTime();
}

function restartAll() {
  playback.time = 0;
  for (const cell of cells) startCell(cell, 0);
  showTime();
}

function applyLiveLayers(cell: Cell) {
  for (const [id, enabled] of cell.layerDefaults)
    cell.avatar.setProceduralAnimationLayerEnabled(
      id,
      ui.liveLayers.checked && enabled,
    );
}

// ── Frame loop ──────────────────────────────────────────────────────────

function advance(delta: number) {
  const total = totalDuration();
  const step = delta * playback.speed;
  const before = playback.time;
  playback.time += step;
  if (playback.time >= total) {
    if (!ui.loop.checked) {
      playback.playing = false;
      seekAll(total);
      updatePlayButton();
      return;
    }
    // Looping clips continue seamlessly; one-shots restart from the top.
    if (!rows.every(({ clip }) => clip?.loop)) return restartAll();
    // Re-align shorter loops with the wrapped playhead.
    return seekAll(playback.time - total);
  }
  // Effect sources repeat on their own cycle, even beside a longer row, and
  // a timed Avatar Effect is removed once its duration has passed (Particle
  // and Scene Effects end on their own lifetimes).
  for (const cell of cells) {
    const row = rowFor(cell);
    if (!row?.effect) continue;
    const duration =
      row.effect.kind === "avatar_effect" ? row.effect.duration : null;
    if (effectCycle(row, playback.time) !== effectCycle(row, before))
      void applyEffect(cell, playback.time);
    else if (
      duration != null &&
      effectPhase(row, before) < duration &&
      effectPhase(row, playback.time) >= duration
    )
      clearEffect(cell);
  }
  for (const cell of cells) {
    // An effect source's timeline is the playhead; a clip's runs on its own.
    cell.time = rowFor(cell)?.effect ? playback.time : cell.time + step;
    cell.avatar.update(step);
  }
  showTime();
}

function render() {
  const width = ui.views.clientWidth;
  const height = ui.views.clientHeight;
  renderer.setSize(width, height, false);
  const visible = visibleRows();
  const columns = server?.avatars.length ?? 2;
  const cellWidth = width / columns;
  const cellHeight = height / Math.max(1, visible.length);
  cells.forEach((cell) => {
    const row = visible.findIndex(({ key }) => key === cell.rowKey);
    const column =
      server?.avatars.findIndex(({ id }) => id === cell.avatarId) ?? 0;
    const x = column * cellWidth;
    const y = height - (row + 1) * cellHeight;
    renderer.setViewport(x, y, cellWidth, cellHeight);
    renderer.setScissor(x, y, cellWidth, cellHeight);
    cell.camera.aspect = cellWidth / cellHeight;
    placeCamera(cell);
    renderer.render(cell.scene, cell.camera);
    Object.assign(cell.bands.host.style, {
      left: `${x}px`,
      top: `${row * cellHeight}px`,
      width: `${cellWidth}px`,
      height: `${cellHeight}px`,
    });
    cell.bands.setSize(cellWidth, cellHeight);
    cell.bands.expire(cell.time);
    cell.bands.seekAnimations(cell.time);
    cell.label.style.left = `${x + 6}px`;
    cell.label.style.top = `${row * cellHeight + 6}px`;
    const { active, particles } = cell.diagnostics;
    const effects = [
      ...active,
      ...(particles ? [`${particles} particle effect(s)`] : []),
      ...cell.bands.sceneLabels(),
    ];
    cell.label.textContent = [
      cell.avatarId.replace("AvatarSample_", ""),
      visible[row]?.label ?? "",
      ...(effects.length ? [effects.join(", ")] : []),
    ].join(" · ");
  });
}

function placeCamera(cell: Cell) {
  const { camera, headHeight, cameraTarget } = cell;
  camera.fov = playback.camera === "portrait" ? cell.portrait.fov : PREVIEW_FOV;
  if (playback.camera === "portrait") {
    // Fixed at the rest head, as chat frames it, so a Gesture moves in frame.
    cameraTarget.copy(cell.portrait.target);
    camera.position.copy(cell.portrait.position);
    camera.lookAt(cameraTarget);
  } else if (playback.camera === "face") {
    const face = cell.avatar
      .vrm!.humanoid.getRawBoneNode("head")!
      .getWorldPosition(cameraTarget)
      .add(new THREE.Vector3(0, headHeight * 0.04, 0));
    camera.position.set(face.x, face.y, face.z + headHeight * 0.55);
    camera.lookAt(face);
  } else {
    // The Avatar faces +Z; ¾ and side views look from its own right.
    const angle = { front: 0, threeQuarter: -Math.PI / 4, side: -Math.PI / 2 }[
      playback.camera
    ];
    const distance = headHeight * 2.9;
    const target = cameraTarget.set(0, headHeight * 0.55, 0);
    camera.position.set(
      Math.sin(angle) * distance,
      target.y + headHeight * 0.1,
      Math.cos(angle) * distance,
    );
    camera.lookAt(target);
  }
  camera.updateProjectionMatrix();
}

let diagnosticsAt = 0;
function frame(now: number) {
  const delta = Math.min(clock.getDelta(), 0.1);
  if (playback.playing && cells.length > 0) advance(delta);
  if (now - diagnosticsAt > DIAGNOSTICS_INTERVAL_MS) refreshDiagnostics();
  render();
  requestAnimationFrame(frame);
}

// ── Effect diagnostics ──────────────────────────────────────────────────

function cellDiagnostics(cell: Cell): CellDiagnostics {
  const vfx = cell.avatar.vfxController?.getSnapshot();
  const particles = cell.avatar.particleVFXController?.getSnapshot();
  const clip = cell.avatar.getClipSnapshot();
  return {
    row: rowFor(cell)?.label ?? "",
    avatar: cell.avatarId,
    version: cell.playingVersion,
    applies: cell.effectApplies,
    active: [
      ...(vfx?.activeEffects ?? []),
      ...(vfx?.attachmentEffects ?? []),
    ].map(({ effectLabel }) => effectLabel),
    particles: particles?.activeCount ?? 0,
    scenes: cell.bands.sceneIds(),
    warnings: [
      ...new Set(
        [
          ...(vfx?.warnings ?? []),
          ...(particles?.warnings ?? []),
          ...(particles?.lastError ? [particles.lastError] : []),
          ...cell.media.getProblems(),
          ...(cell.effectProblem ? [cell.effectProblem] : []),
          ...(clip.lastEventError ? [clip.lastEventError] : []),
        ].filter(Boolean),
      ),
    ],
  };
}

/**
 * Show every controller warning, failed clip event and effect the preview
 * cannot play, so nothing fails silently.
 */
function refreshDiagnostics() {
  diagnosticsAt = performance.now();
  for (const cell of cells) cell.diagnostics = cellDiagnostics(cell);
  const notices = visibleRows().flatMap((row) =>
    row.clip ? previewMediaNotices(row.clip.clip, row.media) : [],
  );
  const lines = [
    ...new Set([
      ...notices,
      ...cells.flatMap(({ avatarId, diagnostics }) =>
        diagnostics.warnings.map(
          (warning) =>
            `${avatarId.replace("AvatarSample_", "")} · ${diagnostics.row}: ${warning}`,
        ),
      ),
    ]),
  ];
  const text = lines.join("\n");
  if (ui.notices.textContent !== text) ui.notices.textContent = text;
  ui.notices.hidden = lines.length === 0;
  window.animationPreview.effects = cells.map(({ diagnostics }) => ({
    ...diagnostics,
  }));
  window.animationPreview.notices = lines;
  window.animationPreview.cameras = cells.map((cell) => ({
    avatar: cell.avatarId,
    fov: cell.camera.fov,
    position: cell.camera.position.toArray(),
    target: cell.cameraTarget.toArray(),
  }));
}

// ── Transport and markers ───────────────────────────────────────────────

function showTime() {
  const total = totalDuration();
  ui.time.textContent = `${playback.time.toFixed(2)} / ${total.toFixed(2)} s`;
  ui.scrubber.max = String(total);
  ui.scrubber.value = String(playback.time);
  window.animationPreview.time = playback.time;
}

function updatePlayButton() {
  ui.play.textContent = playback.playing ? "Pause" : "Play";
  ui.play.setAttribute("aria-label", playback.playing ? "Pause" : "Play");
}

function renderMarkers() {
  ui.markers.replaceChildren();
  const total = totalDuration();
  for (const marker of rows[0]?.clip?.markers ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "marker";
    button.style.left = `${(marker.time / total) * 100}%`;
    button.textContent = marker.label;
    button.title = `${marker.label} · ${marker.time.toFixed(2)} s`;
    button.addEventListener("click", () => {
      playback.playing = false;
      updatePlayButton();
      seekAll(marker.time);
    });
    ui.markers.append(button);
  }
}

ui.play.addEventListener("click", () => {
  playback.playing = !playback.playing;
  if (playback.playing && playback.time >= totalDuration() - 1e-3) restartAll();
  clock.getDelta();
  updatePlayButton();
});
ui.restart.addEventListener("click", () => {
  restartAll();
  playback.playing = true;
  updatePlayButton();
});
const step = (direction: number) => {
  playback.playing = false;
  updatePlayButton();
  seekAll(playback.time + direction * FRAME);
};
ui.stepBack.addEventListener("click", () => step(-1));
ui.stepForward.addEventListener("click", () => step(1));
ui.speed.addEventListener("change", () => {
  playback.speed = Number(ui.speed.value);
});
ui.scrubber.addEventListener("input", () => {
  playback.playing = false;
  updatePlayButton();
  seekAll(Number(ui.scrubber.value));
});
ui.cameras.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  if (!button?.dataset.camera) return;
  playback.camera = button.dataset.camera as CameraPreset;
  for (const other of ui.cameras.querySelectorAll("button"))
    other.setAttribute("aria-pressed", String(other === button));
});
ui.liveLayers.addEventListener("change", () => cells.forEach(applyLiveLayers));
ui.previous.addEventListener("change", () => {
  // Through the state queue, so cells are never synced twice at once. A
  // failure is shown and must not stop later state updates.
  applying = applying
    .then(async () => {
      await syncCells();
      seekAll(playback.time);
    })
    .catch(showError);
});

// ── Review notes ────────────────────────────────────────────────────────

ui.noteRegion.append(new Option("Whole body", ""));
for (const region of REVIEW_REGIONS)
  ui.noteRegion.append(new Option(REVIEW_REGION_LABELS[region], region));

/** Pin choices: the playhead, or a beat (keyframe) of the reviewed clip. */
function renderPinOptions() {
  const selected = ui.notePin.value;
  ui.notePin.replaceChildren(
    new Option(`Playhead (${playback.time.toFixed(2)} s)`, "playhead"),
  );
  for (const marker of rows[0]?.clip?.markers ?? [])
    ui.notePin.append(
      new Option(`${marker.label} (${marker.time.toFixed(2)} s)`, marker.id),
    );
  if ([...ui.notePin.options].some(({ value }) => value === selected))
    ui.notePin.value = selected;
}
ui.notePin.addEventListener("focus", renderPinOptions);

ui.noteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const marker = rows[0]?.clip?.markers.find(
    ({ id }) => id === ui.notePin.value,
  );
  const body = {
    time: marker ? marker.time : Number(playback.time.toFixed(3)),
    ...(marker
      ? {
          beat:
            rows[0]?.clip?.format === "animaPoseClip/2.0"
              ? marker.id
              : marker.label,
        }
      : {}),
    ...(ui.noteRegion.value ? { region: ui.noteRegion.value } : {}),
    text: ui.noteText.value,
  };
  const response = await fetch("/__preview/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  ui.noteError.hidden = response.ok;
  if (!response.ok) {
    ui.noteError.textContent = result.error;
    return;
  }
  ui.noteText.value = "";
  await applyState(result);
});

function renderNotes() {
  const review = server?.review;
  ui.notesFile.textContent = review
    ? `Saved to ${review.path}${review.error ? ` — ${review.error}` : ""}`
    : "";
  const notes = [...(review?.sidecar?.notes ?? [])].sort(
    (a, b) => a.time - b.time,
  );
  ui.notesList.replaceChildren(
    ...notes.map((note) => {
      const item = document.createElement("li");
      item.className = "note";
      const head = document.createElement("div");
      head.className = "note-head";
      head.textContent = [
        `${note.time.toFixed(2)} s`,
        // A 2.0 note names its beat by id; show the beat's label.
        rows[0]?.clip?.markers.find(({ id }) => id === note.beat)?.label ??
          note.beat,
        note.region ? REVIEW_REGION_LABELS[note.region] : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const status = document.createElement("span");
      status.className = `note-status ${note.status}`;
      status.textContent = note.status === "open" ? "Open" : "Resolved";
      head.append(status);
      if (note.status === "open") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Delete";
        remove.className = "small";
        remove.addEventListener("click", async (event) => {
          event.stopPropagation();
          const response = await fetch(
            `/__preview/notes/${encodeURIComponent(note.id)}`,
            { method: "DELETE" },
          );
          if (response.ok) await applyState(await response.json());
        });
        head.append(remove);
      }
      const text = document.createElement("p");
      text.textContent = note.text;
      item.append(head, text);
      if (note.resolution) {
        const resolution = document.createElement("p");
        resolution.className = "resolution";
        resolution.textContent = note.resolution;
        item.append(resolution);
      }
      item.addEventListener("click", () => {
        playback.playing = false;
        updatePlayButton();
        seekAll(note.time);
      });
      return item;
    }),
  );
}

// ── Source pickers ──────────────────────────────────────────────────────

let choices: PreviewChoice[] = [];

/** Fill a picker with the choices, grouped as the server lists them. */
function fillPicker(select: HTMLSelectElement, none: string | null) {
  select.replaceChildren();
  if (none) select.append(new Option(none, ""));
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const choice of choices) {
    let group = groups.get(choice.group);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = choice.group;
      groups.set(choice.group, group);
      select.append(group);
    }
    group.append(new Option(choice.label, choice.spec));
  }
}

/** Show the playing sources in the pickers. */
function showSelection() {
  const specFor = (row: RowView | undefined) =>
    choices.find(({ path }) => path === row?.path)?.spec ?? "";
  ui.pickSource.value = specFor(rows[0]);
  ui.pickCompare.value = specFor(rows[1]);
  showPosition();
}

/**
 * The Review item's picker group, which Previous and Next cycle through, so
 * stepping through a folder of drafts never wanders into Library items.
 */
function reviewGroup(): { items: PreviewChoice[]; index: number } {
  const current = choices.find(({ spec }) => spec === ui.pickSource.value);
  if (!current) return { items: [], index: -1 };
  const items = choices.filter(({ group }) => group === current.group);
  return { items, index: items.indexOf(current) };
}

/** Show where the Review item sits in its group, such as "3 / 22". */
function showPosition() {
  const { items, index } = reviewGroup();
  const cycling = items.length > 1;
  ui.pickPosition.textContent = cycling ? `${index + 1} / ${items.length}` : "";
  ui.pickPrevious.disabled = !cycling;
  ui.pickNext.disabled = !cycling;
}

/** Review the previous (-1) or next (+1) item in the group, wrapping around. */
function stepReview(direction: -1 | 1) {
  const { items, index } = reviewGroup();
  if (items.length < 2) return;
  const next = items[(index + direction + items.length) % items.length];
  ui.pickSource.value = next.spec;
  void pick();
}

async function loadChoices() {
  const response = await fetch("/__preview/choices");
  if (!response.ok) return;
  choices = await response.json();
  fillPicker(ui.pickSource, null);
  fillPicker(ui.pickCompare, "None");
  showSelection();
}

/** Ask the server to play the picked sources. */
async function pick() {
  ui.status.textContent = "Loading…";
  const response = await fetch("/__preview/select", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: ui.pickSource.value,
      compare: ui.pickCompare.value || null,
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    showSelection();
    showError(new Error(result.error));
    return;
  }
  await applyState(result);
}
ui.pickSource.addEventListener("change", () => void pick());
ui.pickCompare.addEventListener("change", () => void pick());
ui.pickPrevious.addEventListener("click", () => stepReview(-1));
ui.pickNext.addEventListener("click", () => stepReview(1));
// `[` and `]` step through the Review group, except while typing a note.
window.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const { target } = event;
  if (
    target instanceof Element &&
    target.closest("input, textarea, [contenteditable]")
  )
    return;
  if (event.key === "[") stepReview(-1);
  else if (event.key === "]") stepReview(1);
  else return;
  event.preventDefault();
});
// New clips or Library items appear when the page regains focus.
window.addEventListener("focus", () => void loadChoices());

// ── Server state ────────────────────────────────────────────────────────

async function fetchState(): Promise<ServerState> {
  const response = await fetch("/__preview/state");
  if (!response.ok) throw new Error(`State request failed: ${response.status}`);
  return response.json();
}

/**
 * The earlier version to compare with: the one the latest note was made
 * against (what the owner last reviewed), or else the retained version
 * before the current one.
 */
async function loadPreviousRow(state: ServerState): Promise<RowView | null> {
  // An effect's retained descriptor lacks its images, so it is not replayed.
  if (state.rows[0]?.type === "effect") return null;
  const sidecar = state.review.sidecar;
  const versions = sidecar?.versions ?? [];
  const current = state.rows[0]?.version;
  const latestNote = [...(sidecar?.notes ?? [])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  const index = versions.findIndex(({ id }) => id === current);
  const previous =
    versions.find(({ id }) => id === latestNote?.version && id !== current) ??
    (index > 0 ? versions[index - 1] : null);
  if (!previous) return null;
  if (previousRow?.version === previous.id) return previousRow;
  const response = await fetch(`/__preview/versions/${previous.id}`);
  if (!response.ok) return null;
  return {
    key: "previous",
    path: "",
    label: `${previous.id === latestNote?.version ? "Reviewed" : "Previous"} version (${new Date(previous.savedAt).toLocaleTimeString()})`,
    clip: await response.json(),
    effect: null,
    effectDuration: null,
    // Earlier versions play with the current dependencies.
    media: state.rows[0]?.media ?? null,
    version: previous.id,
  };
}

/** Apply server state, one update at a time (Avatars load asynchronously). */
let applying: Promise<void> = Promise.resolve();
function applyState(state: ServerState): Promise<void> {
  const next = applying.then(() => applyStateNow(state));
  applying = next.catch(() => undefined);
  return next;
}

async function applyStateNow(state: ServerState) {
  // An older state can arrive after a newer one; keep the newer.
  if (server && state.generation < server.generation) return;
  server = state;
  const before = rows.map(({ path }) => path).join("\n");
  rows = state.rows.map((row) => ({
    key: row.role,
    label: row.label,
    path: row.path,
    clip: row.clip,
    effect: row.effect,
    effectDuration: row.effect ? effectDuration(row.effect) : null,
    media: row.media,
    version: row.version,
  }));
  // Another source was picked: start it from the top.
  const switched =
    before !== "" && before !== rows.map(({ path }) => path).join("\n");
  if (switched) {
    playback.time = 0;
    ui.previous.checked = false;
  }
  showSelection();
  previousRow = await loadPreviousRow(state);
  ui.previous.disabled = !previousRow;
  if (!previousRow) ui.previous.checked = false;
  const problems = state.rows.filter(({ error }) => error);
  ui.errors.hidden = problems.length === 0;
  ui.errors.textContent = problems
    .map(({ label, error }) =>
      [
        `${label}: ${error!.message}`,
        ...error!.issues.map(({ path, message }) => `  ${path}: ${message}`),
      ].join("\n"),
    )
    .join("\n\n");
  await syncCells();
  // Restart any row whose source changed, keeping the playhead.
  const time = Math.min(playback.time, totalDuration());
  for (const cell of cells)
    if (switched || cell.playingVersion !== rowFor(cell)?.version)
      startCell(cell, time);
  playback.time = time;
  renderMarkers();
  renderPinOptions();
  renderNotes();
  showTime();
  refreshDiagnostics();
  ui.status.textContent = `${rows.length > 1 ? "Comparing" : "Playing"} · live reload on`;
  window.animationPreview.generation = state.generation;
  window.animationPreview.ready = true;
}

declare global {
  interface Window {
    animationPreview: {
      ready: boolean;
      generation: number;
      time: number;
      error: string | null;
      /** Each cell's effects and warnings, refreshed a few times a second. */
      effects: CellDiagnostics[];
      /** The lines of the effect warnings panel. */
      notices: string[];
      /** Each cell's camera, refreshed with the effects. */
      cameras: {
        avatar: string;
        fov: number;
        position: [number, number, number];
        target: [number, number, number];
      }[];
    };
  }
}
window.animationPreview = {
  ready: false,
  generation: -1,
  time: 0,
  error: null,
  effects: [],
  notices: [],
  cameras: [],
};

async function start() {
  try {
    await loadChoices();
    await applyState(await fetchState());
    updatePlayButton();
    requestAnimationFrame(frame);
    const events = new EventSource("/__preview/events");
    events.onmessage = async (message) => {
      if (Number(message.data) !== server?.generation)
        await applyState(await fetchState());
    };
  } catch (error) {
    showError(error);
  }
}

function showError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  window.animationPreview.error = message;
  ui.status.textContent = `Error: ${message}`;
}

void start();
