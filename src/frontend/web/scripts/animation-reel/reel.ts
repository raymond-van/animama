import * as THREE from "three";

import type { Avatar } from "@/lib/avatar";
import { parseAnimaPoseClip } from "@/lib/avatar/poses/animaPoseClip";
import type { SceneCameraPreset } from "@/ui/main/canvas/sceneCameraPresets";

import { ReviewStage } from "../effect-render/reviewStage";
import {
  EffectSession,
  placeCamera,
  seedRandom,
  type PageClipMedia,
  type SessionSound,
} from "../effect-render/session";
import {
  chatCameraFraming,
  createStage,
  type Framing,
} from "../effect-render/stage";

/**
 * Action reel page (driven by `scripts/animation-reel.mjs`): plays one
 * Gesture or Reaction at a time on an Included Avatar and draws each video
 * frame on demand.
 *
 * Each item opens a fresh `Avatar` on the review stage (`../effect-render`):
 * the chat's colour pipeline, lights, camera preset and Scene layers. Its
 * clip always plays through the Avatar's own clip player, so its Avatar,
 * Particle and Scene Effects and its sounds start when chat would start
 * them. A looping clip is stopped (with its fade) after one pass, and a
 * talking-scoped one after the request's talking time, as chat stops it
 * when the reply ends. Frames advance in fixed 60 Hz steps, so a reel is the
 * same on every run whatever the capture speed. Sounds are not played here:
 * each one a clip event plays is reported with its time, and Node mixes them
 * into the video's audio. A label panel in the top-left corner names the
 * item, its effects (lit while active) and their sounds (lit while playing),
 * and shows the Avatar's live expression weights.
 */

/** One effect the item's clip can start, as the label lists it. */
type ReelEffect = {
  alias: string;
  /** Display kind, such as "Avatar Effect". */
  kind: string;
  name: string;
  /** The sound it plays when a clip event applies it, or null. */
  soundCueId: string | null;
};

type ReelLabel = {
  /** Small heading, such as "Gesture · 12 / 107". */
  kicker: string;
  title: string;
  /** Second line, such as a Reaction's emotion and intensity, or null. */
  detail: string | null;
  effects: ReelEffect[];
  /** Sounds the clip plays through its own sound events. */
  sounds: string[];
};

/** A sound cue's display name and length; 0 s for a cue with no file. */
type ReelSoundInfo = { name: string; duration: number };

type ReelItemRequest = {
  avatar: { id: string; url: string };
  size: { width: number; height: number };
  camera: SceneCameraPreset;
  clip: unknown;
  clipMedia: PageClipMedia | null;
  label: ReelLabel;
  /** Every cue the item may play, by cue id. */
  sounds: Record<string, ReelSoundInfo>;
  /** Seconds of rest before the clip starts. */
  lead: number;
  /**
   * Seconds a talking-scoped clip (a Reaction, which chat holds while the
   * Anima speaks) is held before it is stopped, at least until its timed
   * effect events end.
   */
  talk: number;
  /** Seconds kept after the clip, its effects and its sounds have ended. */
  tail: number;
  /** Longest an item runs after its clip starts before it is cut. */
  maxSec: number;
};

type ReelFrame = {
  /** The item ended: everything finished and the tail was shown. */
  done: boolean;
  /** The item ran for `maxSec` without ending and should be cut. */
  timedOut: boolean;
  /** Sounds clip events started since the previous frame. */
  sounds: SessionSound[];
  /** Every controller warning and media problem so far. */
  warnings: string[];
};

const LABEL_CSS = `
.reel-label {
  position: absolute;
  top: calc(var(--u) * 36);
  left: calc(var(--u) * 36);
  z-index: 30;
  box-sizing: border-box;
  min-width: calc(var(--u) * 360);
  max-width: calc(var(--u) * 680);
  padding: calc(var(--u) * 20) calc(var(--u) * 26);
  border-radius: calc(var(--u) * 16);
  background: rgba(18, 19, 24, 0.76);
  color: #f5f5f7;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  line-height: 1.25;
}
.reel-kicker {
  font-size: calc(var(--u) * 17);
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: 0.7;
}
.reel-title {
  margin-top: calc(var(--u) * 4);
  font-size: calc(var(--u) * 40);
  font-weight: 650;
}
.reel-detail {
  margin-top: calc(var(--u) * 2);
  font-size: calc(var(--u) * 24);
  opacity: 0.85;
}
.reel-rows {
  display: grid;
  gap: calc(var(--u) * 6);
  margin-top: calc(var(--u) * 14);
  font-size: calc(var(--u) * 21);
}
.reel-row {
  display: flex;
  align-items: center;
  gap: calc(var(--u) * 10);
  opacity: 0.5;
}
.reel-row.is-active { opacity: 1; }
.reel-dot {
  flex: none;
  width: calc(var(--u) * 10);
  height: calc(var(--u) * 10);
  border-radius: 50%;
  background: rgba(245, 245, 247, 0.5);
}
.reel-row.is-active .reel-dot { background: #ffd166; }
.reel-kind { font-size: calc(var(--u) * 16); opacity: 0.7; }
.reel-sound {
  margin-left: auto;
  padding-left: calc(var(--u) * 14);
  font-size: calc(var(--u) * 18);
  white-space: nowrap;
}
.reel-sound.is-playing { color: #7ee0ff; }
.reel-row:has(.reel-sound.is-playing) { opacity: 1; }
.reel-none { font-size: calc(var(--u) * 20); opacity: 0.55; }
.reel-expressions {
  /* Takes the panel's width without widening it as the values change. */
  width: 0;
  min-width: 100%;
  margin-top: calc(var(--u) * 14);
}
.reel-expressions-title {
  font-size: calc(var(--u) * 15);
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.6;
}
.reel-chips {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--u) * 6);
  margin-top: calc(var(--u) * 6);
  font-size: calc(var(--u) * 18);
  font-variant-numeric: tabular-nums;
}
.reel-chip {
  padding: calc(var(--u) * 2) calc(var(--u) * 8);
  border-radius: calc(var(--u) * 6);
  white-space: nowrap;
}
`;

/** Weights below this are not listed (they show as 0.00). */
const EXPRESSION_MIN_WEIGHT = 0.005;

/** The corner label: the item, its effects, their sounds and expressions. */
class LabelPanel {
  readonly element = document.createElement("div");
  private effects: { alias: string; row: HTMLElement }[] = [];
  private sounds: { cueId: string; element: HTMLElement }[] = [];
  private chips = document.createElement("div");

  constructor(host: HTMLElement, height: number) {
    const style = document.createElement("style");
    style.textContent = LABEL_CSS;
    document.head.append(style);
    this.element.className = "reel-label";
    // Sizes are authored for 1080 rows and scale with the video height.
    this.element.style.setProperty("--u", `${height / 1080}px`);
    host.append(this.element);
  }

  show(label: ReelLabel, sounds: Record<string, ReelSoundInfo>): void {
    const text = (className: string, value: string) => {
      const element = document.createElement("div");
      element.className = className;
      element.textContent = value;
      return element;
    };
    const soundName = (cueId: string) => sounds[cueId]?.name ?? cueId;
    const soundTag = (cueId: string) => {
      const element = text("reel-sound", `♪ ${soundName(cueId)}`);
      this.sounds.push({ cueId, element });
      return element;
    };
    const row = (name: string, kind: string, cueId: string | null) => {
      const element = document.createElement("div");
      element.className = "reel-row";
      const dot = document.createElement("span");
      dot.className = "reel-dot";
      element.append(dot);
      if (name) element.append(text("reel-name", name));
      element.append(text("reel-kind", kind));
      if (cueId) element.append(soundTag(cueId));
      return element;
    };
    this.effects = [];
    this.sounds = [];
    const rows = document.createElement("div");
    rows.className = "reel-rows";
    for (const effect of label.effects) {
      const element = row(effect.name, effect.kind, effect.soundCueId);
      this.effects.push({ alias: effect.alias, row: element });
      rows.append(element);
    }
    for (const cueId of label.sounds)
      rows.append(row("", "Sound event", cueId));
    if (rows.childElementCount === 0)
      rows.append(text("reel-none", "No effects"));
    const expressions = document.createElement("div");
    expressions.className = "reel-expressions";
    this.chips = document.createElement("div");
    this.chips.className = "reel-chips";
    expressions.append(
      text("reel-expressions-title", "Expressions"),
      this.chips,
    );
    this.element.replaceChildren(
      text("reel-kicker", label.kicker),
      text("reel-title", label.title),
      ...(label.detail ? [text("reel-detail", label.detail)] : []),
      rows,
      expressions,
    );
  }

  /**
   * Light the effects that are active and the sounds that are playing, and
   * list each expression's weight, in the Avatar's expression order. A chip's
   * fill shows its weight.
   */
  update(
    activeAliases: Set<string>,
    playingCues: Set<string>,
    expressions: [name: string, weight: number][],
  ): void {
    for (const { alias, row } of this.effects)
      row.classList.toggle("is-active", activeAliases.has(alias));
    for (const { cueId, element } of this.sounds)
      element.classList.toggle("is-playing", playingCues.has(cueId));
    const chips = expressions.map(([name, weight]) => {
      const chip = document.createElement("span");
      chip.className = "reel-chip";
      chip.textContent = `${name} ${weight.toFixed(2)}`;
      const filled = `${(weight * 100).toFixed(1)}%`;
      chip.style.background = `linear-gradient(to right, rgba(255, 209, 102, 0.38) ${filled}, rgba(245, 245, 247, 0.1) ${filled})`;
      return chip;
    });
    if (chips.length === 0) {
      const none = document.createElement("span");
      none.className = "reel-none";
      none.textContent = "None";
      chips.push(none);
    }
    this.chips.replaceChildren(...chips);
  }

  clear(): void {
    this.element.replaceChildren();
    this.effects = [];
    this.sounds = [];
    this.chips = document.createElement("div");
  }
}

/** The page's stage, kept across items of the same size. */
let stage: {
  review: ReviewStage;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  label: LabelPanel;
  width: number;
  height: number;
} | null = null;

/** The open item. */
let item: {
  request: ReelItemRequest;
  session: EffectSession;
  framing: Framing;
  /** Seconds after starting that the clip is stopped, or null when it ends. */
  stopAfter: number | null;
  /** Session time the clip started, or null during the lead. */
  startedAt: number | null;
  stopped: boolean;
  /** Session time since which everything has been idle, or null. */
  idleSince: number | null;
  sounds: SessionSound[];
  reported: number;
  warnings: Set<string>;
} | null = null;

function ensureStage({ width, height }: ReelItemRequest["size"]) {
  if (stage && stage.width === width && stage.height === height) return stage;
  if (stage) {
    stage.renderer.dispose();
    stage.review.dispose();
  }
  const review = new ReviewStage(width, height);
  const { renderer, scene, camera } = createStage(width, height);
  stage = {
    review,
    renderer,
    scene,
    camera,
    label: new LabelPanel(review.element, height),
    width,
    height,
  };
  return stage;
}

/** Close the open item, keeping the stage for the next one. */
function closeReelItem(): void {
  if (!item || !stage) return;
  const { session } = item;
  item = null;
  if (session.avatar.scene) stage.scene.remove(session.avatar.scene);
  session.dispose();
  stage.review.bands.clearScenes();
  stage.review.bands.setAvatar(null);
  stage.label.clear();
}

/** The Avatar's current non-zero expression weights, in its expression order. */
function expressionWeights(avatar: Avatar): [string, number][] {
  return avatar
    .getAvailableExpressions()
    .map((name): [string, number] => [name, avatar.getExpressionValue(name)])
    .filter(([, weight]) => weight >= EXPRESSION_MIN_WEIGHT);
}

/**
 * When to stop a clip that does not end by itself: a talking-scoped clip
 * after `talk` seconds and its timed events, a loop after one pass; null for
 * a clip that completes on its own.
 */
function stopAfter(
  clip: ReturnType<typeof parseAnimaPoseClip>,
  talk: number,
): number | null {
  if (clip.playback) {
    const eventsEnd = Math.max(
      0,
      ...(clip.events ?? []).map(
        (event) =>
          event.time + ("duration" in event ? (event.duration ?? 0) : 0),
      ),
    );
    return Math.max(talk, clip.duration, eventsEnd);
  }
  return clip.loop === true ? clip.duration : null;
}

/** Open one item: a fresh Avatar at rest, its label shown, its clip not started. */
async function openReelItem(request: ReelItemRequest): Promise<void> {
  closeReelItem();
  const parsed = parseAnimaPoseClip(request.clip);
  seedRandom(0x5eed);
  const current = ensureStage(request.size);
  const sounds: SessionSound[] = [];
  const session = await EffectSession.open(
    request.avatar.url,
    current.camera,
    current.renderer.domElement,
    {
      clip: request.clip,
      clipMedia: request.clipMedia,
      expression: null,
      clipPlayback: "avatar",
      onSound: (sound) => sounds.push(sound),
    },
    current.review,
  );
  current.review.attachCanvas(current.renderer.domElement, session.avatar);
  current.scene.add(session.avatar.scene!);
  current.label.show(request.label, request.sounds);
  item = {
    request,
    session,
    framing: chatCameraFraming(session.avatar, request.camera),
    stopAfter: stopAfter(parsed, request.talk),
    startedAt: null,
    stopped: false,
    idleSince: null,
    sounds,
    reported: 0,
    warnings: new Set(),
  };
}

/** Draw the open item at `time` seconds after opening it. */
async function reelFrame(time: number): Promise<ReelFrame> {
  if (!item || !stage) throw new Error("No reel item is open.");
  const current = item;
  const { session, request } = current;
  if (current.startedAt === null) {
    await session.advanceTo(Math.min(time, request.lead));
    if (time >= request.lead) {
      await session.apply({ effects: [] });
      current.startedAt = session.time;
    }
  }
  await session.advanceTo(time);
  const elapsed =
    current.startedAt === null ? 0 : session.time - current.startedAt;
  if (
    current.stopAfter !== null &&
    !current.stopped &&
    elapsed >= current.stopAfter
  ) {
    session.avatar.stopClip();
    current.stopped = true;
  }

  placeCamera(stage.camera, "front", session.avatar, current.framing);
  stage.renderer.render(stage.scene, stage.camera);
  await stage.review.seek(session.time);

  const diagnostics = session.diagnostics(request.avatar.id);
  diagnostics.warnings.forEach((warning) => current.warnings.add(warning));
  const playing = new Set<string>();
  let soundsEnd = 0;
  for (const sound of current.sounds) {
    const end = sound.time + (request.sounds[sound.cueId]?.duration ?? 0);
    soundsEnd = Math.max(soundsEnd, end);
    if (session.time >= sound.time && session.time < end)
      playing.add(sound.cueId);
  }
  stage.label.update(
    new Set(diagnostics.activeEffectIds),
    playing,
    expressionWeights(session.avatar),
  );

  const idle =
    current.startedAt !== null &&
    !session.avatar.isClipActive() &&
    diagnostics.activeEffectIds.length === 0 &&
    session.time >= soundsEnd;
  current.idleSince = idle ? (current.idleSince ?? session.time) : null;
  const sounds = current.sounds.slice(current.reported);
  current.reported = current.sounds.length;
  return {
    done:
      current.idleSince !== null &&
      session.time - current.idleSince >= request.tail,
    timedOut: current.startedAt !== null && elapsed >= request.maxSec,
    sounds,
    warnings: [...current.warnings],
  };
}

declare global {
  interface Window {
    openReelItem: typeof openReelItem;
    reelFrame: typeof reelFrame;
    closeReelItem: typeof closeReelItem;
    effectRendererReady: boolean;
  }
}

window.openReelItem = openReelItem;
window.reelFrame = reelFrame;
window.closeReelItem = closeReelItem;
window.effectRendererReady = true;
