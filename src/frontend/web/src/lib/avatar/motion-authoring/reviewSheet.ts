import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";

import { Avatar } from "../Avatar";
import {
  headSized,
  measureAvatarProportions,
  REFERENCE_TOP_OVER_HEAD_BONE,
} from "../avatarProportions";
import { configureAvatarGltfLoader } from "../configureAvatarGltfLoader";
import { withOnDemandLilToon } from "../liltoon/lilToon";
import { parseAnimaPoseClip } from "../poses/animaPoseClip";
import { createAnimaPoseClipProgram } from "../poses/animaPoseClip/program";
import { getResolvedAvatarPose } from "../poses/catalog";
import { prepareLoadedVrm } from "../prepareLoadedVrm";
import { releaseModelScene } from "../releaseModelScene";
import { UnmetallicMaterialsPlugin } from "../unmetallicMaterials";
import { canonicalizeCustomPresetExpressions } from "../vrmExpressionPresets";
import { INCLUDED_AVATAR_FILES, type IncludedAvatarId } from "./headlessVrm";
import { applyCanonicalPose } from "./kinematics";

/**
 * Review sheets for a Gesture clip: a labelled grid of rendered tiles, one row
 * per sampled time and one column per view of each Avatar. A clip plays
 * through the production sampler and VRM 0 conversion on textured Avatars.
 * Live procedural layers are not applied, matching the Gesture creator
 * preview.
 *
 * `drawReviewSheet` lays out and poses the sheet and leaves drawing a tile to
 * its caller. `pnpm animation:render` draws tiles with a renderer of its own
 * (`scripts/animation-render/render.ts`); the app draws them through a render
 * target on a renderer it already has (`renderIncludedAvatarReviewSheets`).
 */

/** The pixel size of one rendered tile. */
export type ReviewSheetTile = { width: number; height: number };

/** An Avatar to draw: its header label and its VRM file, as bytes or a URL. */
export type ReviewSheetAvatar = { label: string; file: ArrayBuffer | string };

/**
 * Draws one tile: renders `scene` from `camera` at the tile's size and paints
 * the picture on the sheet with its top-left corner at (`x`, `y`).
 */
export type ReviewSheetTilePainter = (
  scene: THREE.Scene,
  camera: THREE.Camera,
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
) => void;

export type ReviewSheetRequest = {
  clip: unknown;
  /** Drawn side by side, each with its own four columns. */
  avatars: readonly ReviewSheetAvatar[];
  /** Seconds from the clip's start; one row each. */
  times: readonly number[];
  tile: ReviewSheetTile;
  /** Which of the Avatar's own sides the ¾ and side views look from. */
  side?: "left" | "right";
  /** `body` (whole Avatar and face) or `hands` (close-ups of the `side` hand). */
  view?: "body" | "hands";
  paintTile: ReviewSheetTilePainter;
};

export type ReviewSheet = {
  canvas: HTMLCanvasElement;
  /** Poses the clip names that are not in the app catalog (drawn as the base pose). */
  missingPoseRefs: string[];
};

type View = {
  name: string;
  angle: number;
  face?: boolean;
  /** Hand close-ups: around the Avatar at `angle`, from below the front, or facing the palm. */
  hand?: "world" | "below" | "palm";
};

/** The width of the column of time labels and the height of the header row, px. */
const LABEL_WIDTH = 64;
const HEADER_HEIGHT = 28;
const BACKGROUND = "#f4f3ef";

/**
 * Camera angles around the Avatar (0 = facing it). The Avatar's own left is
 * +X, so the front view shows its right hand on the viewer's left.
 */
const viewsFor = (
  side: "left" | "right",
  view: "body" | "hands" = "body",
): View[] => {
  const sign = side === "left" ? 1 : -1;
  if (view === "hands")
    return [
      { name: `${side} hand front`, angle: 0, hand: "world" },
      { name: `${side} hand 3/4`, angle: (sign * Math.PI) / 4, hand: "world" },
      { name: `${side} hand below`, angle: 0, hand: "below" },
      { name: `${side} palm`, angle: 0, hand: "palm" },
    ];
  return [
    { name: "front", angle: 0, face: false },
    { name: `3/4 ${side}`, angle: (sign * Math.PI) / 4, face: false },
    { name: `${side} side`, angle: (sign * Math.PI) / 2, face: false },
    { name: "face", angle: 0, face: true },
  ];
};

/** Load an Avatar with its materials and face measurements, as the app does. */
async function loadSheetVrm(file: ArrayBuffer | string): Promise<VRM> {
  const bytes = typeof file === "string" ? await fetchAvatarFile(file) : file;
  const loader = configureAvatarGltfLoader(new GLTFLoader());
  // Authored lilToon materials render as in the app, and lit glTF materials
  // without metalness as the app draws them; MToon is untouched.
  loader.register((parser) => withOnDemandLilToon(new VRMLoaderPlugin(parser)));
  loader.register((parser) => new UnmetallicMaterialsPlugin(parser));
  const gltf = await loader.parseAsync(bytes, "");
  try {
    const vrm = (gltf.userData as { vrm?: VRM }).vrm;
    if (!vrm) throw new Error("The file is not a VRM: no VRM extension found.");
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    canonicalizeCustomPresetExpressions(vrm);
    // The app passes the catalog's digest to `Avatar.load`, which selects
    // verified per-Avatar calibrations such as the eyelid closure profile.
    prepareLoadedVrm(vrm, { vrmSha256: await sha256Hex(bytes) });
    await measureFace(vrm, gltf);
    return vrm;
  } catch (error) {
    // A file that parsed but cannot be prepared still holds decoded textures.
    releaseModelScene(gltf.scene);
    throw error;
  }
}

async function fetchAvatarFile(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Cannot read the Avatar file: HTTP ${response.status}.`);
  return response.arrayBuffer();
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Find and measure the face as the app does (face parts, landmarks and
 * texture anchors), which registers it for size-aware contacts and framing
 * (`avatarProportions.ts`), before any clip is prepared.
 */
async function measureFace(vrm: VRM, gltf: GLTF): Promise<void> {
  const avatar = new Avatar(new THREE.PerspectiveCamera());
  avatar.vrm = vrm;
  avatar.sourceGltf = gltf;
  await avatar.setFacePartCorrections(null);
}

/**
 * The Included Avatars' rest height of the head bone (m): big-headed Avatars'
 * faces are framed as a reference Avatar of their head's size would be, and
 * their bodies by the top of the head (`REFERENCE_TOP_OVER_HEAD_BONE`).
 */
const REFERENCE_HEAD_BONE_HEIGHT = 1.35;

/**
 * The lengths the views are framed by: the head bone's height `headY` for
 * adult proportions. A big head (`avatarProportions.ts`) frames the body
 * views by the top of the head, so its head stays in view, and the face view
 * by the face's size, so it shows the face rather than the chin.
 */
function framingLengths(
  vrm: VRM,
  headY: number,
): { bodyLength: number; faceLength: number } {
  const proportions = measureAvatarProportions(vrm);
  const top = headY + (proportions.headBox?.max.y ?? 0);
  return {
    bodyLength: headSized(
      proportions,
      headY,
      Math.max(headY, top / REFERENCE_TOP_OVER_HEAD_BONE),
    ),
    faceLength: headSized(
      proportions,
      headY,
      REFERENCE_HEAD_BONE_HEIGHT * proportions.headScale,
    ),
  };
}

function applyExpressions(vrm: VRM, expressions: Record<string, number>) {
  const manager = vrm.expressionManager;
  if (!manager) return;
  for (const expression of manager.expressions)
    manager.setValue(expression.expressionName, 0);
  for (const [name, weight] of Object.entries(expressions))
    if (manager.getExpression(name)) manager.setValue(name, weight);
  manager.update();
}

/**
 * Draw a review sheet for `clip`: a header row, a column of time labels, then
 * four tiles per Avatar in each row. Each Avatar is loaded just before its
 * columns are drawn and disposed after them, so only one is held at a time,
 * and nothing is awaited while one Avatar's tiles are drawn.
 *
 * It draws whichever Avatar files it is given, as the review tools need. The
 * app's sheets go through `renderIncludedAvatarReviewSheets`, which draws the
 * Included Avatars only.
 */
export async function drawReviewSheet(
  request: ReviewSheetRequest,
): Promise<ReviewSheet> {
  // Parsed before any Avatar is loaded, so a clip that cannot play costs none.
  const clip = parseAnimaPoseClip(request.clip);
  const missingPoseRefs = new Set<string>();
  const side = request.side ?? "right";
  const { width, height } = request.tile;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(1, 2, 2);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 20);

  // Resolve references from the app catalog, as playback does.
  const resolvePose = (id: string) => {
    try {
      return getResolvedAvatarPose(id);
    } catch {
      return null;
    }
  };
  const VIEWS = viewsFor(side, request.view);
  const columns = request.avatars.length * VIEWS.length;
  const sheet = document.createElement("canvas");
  sheet.width = LABEL_WIDTH + columns * width;
  sheet.height = HEADER_HEIGHT + request.times.length * height;
  const context = sheet.getContext("2d")!;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, sheet.width, sheet.height);
  context.fillStyle = "#222";
  context.font = "13px sans-serif";

  let column = 0;
  for (const avatar of request.avatars) {
    const vrm = await loadSheetVrm(avatar.file);
    try {
      scene.add(vrm.scene);
      // 2.0 clips are prepared per Avatar (hand presets, planted legs).
      const program = createAnimaPoseClipProgram(clip, { vrm, resolvePose });
      applyCanonicalPose(vrm, {});
      const head = vrm.humanoid
        .getRawBoneNode("head")!
        .getWorldPosition(new THREE.Vector3());
      const { bodyLength, faceLength } = framingLengths(vrm, head.y);
      const target = new THREE.Vector3(0, bodyLength * 0.55, 0);
      const distance = bodyLength * 2.9;
      VIEWS.forEach((view, viewIndex) => {
        context.fillText(
          `${avatar.label} · ${view.name}`,
          LABEL_WIDTH + (column + viewIndex) * width + 6,
          18,
        );
      });
      request.times.forEach((time, row) => {
        const result = program.sample(time);
        result.diagnostics.missingPoseRefs.forEach((id) =>
          missingPoseRefs.add(id),
        );
        const sample = result.sample;
        applyCanonicalPose(vrm, sample.humanoid ?? {});
        applyExpressions(vrm, sample.expressions ?? {});
        vrm.springBoneManager?.reset();
        VIEWS.forEach((view, viewIndex) => {
          if (view.hand) {
            // Close-up centred on the palm, wide enough to show what it touches.
            const bone = (name: string) =>
              vrm.humanoid
                .getNormalizedBoneNode(name as never)
                ?.getWorldPosition(new THREE.Vector3());
            const wrist = bone(`${side}Hand`)!;
            const middle = bone(`${side}MiddleProximal`) ?? wrist;
            const index = bone(`${side}IndexProximal`) ?? middle;
            const little = bone(`${side}LittleProximal`) ?? middle;
            const palm = wrist.clone().lerp(middle, 0.7);
            const forward = middle.clone().sub(wrist).normalize();
            const across = index.clone().sub(little).normalize();
            // Toward the palm side (fingers curl this way) for either hand.
            const palmward =
              side === "right"
                ? across.clone().cross(forward)
                : forward.clone().cross(across);
            const direction =
              view.hand === "palm"
                ? palmward.normalize().add(forward.clone().multiplyScalar(0.25))
                : view.hand === "below"
                  ? new THREE.Vector3(0, -0.7, 1)
                  : new THREE.Vector3(
                      Math.sin(view.angle),
                      0.15,
                      Math.cos(view.angle),
                    );
            const reach = head.y * 0.32;
            camera.position
              .copy(palm)
              .addScaledVector(direction.normalize(), reach);
            camera.up.set(0, 1, 0);
            camera.lookAt(palm);
          } else if (view.face) {
            // Close-up on the current head position so expressions are readable.
            const face = vrm.humanoid
              .getRawBoneNode("head")!
              .getWorldPosition(new THREE.Vector3())
              .add(new THREE.Vector3(0, faceLength * 0.05, 0));
            camera.position.set(face.x, face.y, face.z + faceLength * 0.6);
            camera.lookAt(face);
          } else {
            camera.position.set(
              Math.sin(view.angle) * distance,
              target.y + bodyLength * 0.1,
              Math.cos(view.angle) * distance,
            );
            camera.lookAt(target);
          }
          request.paintTile(
            scene,
            camera,
            context,
            LABEL_WIDTH + (column + viewIndex) * width,
            HEADER_HEIGHT + row * height,
          );
        });
        if (column === 0)
          context.fillText(
            `${time.toFixed(2)}s`,
            8,
            HEADER_HEIGHT + row * height + 18,
          );
      });
    } finally {
      // Detaches the model and closes its decoded textures, which
      // `VRMUtils.deepDispose` alone leaves to garbage collection.
      releaseModelScene(vrm.scene);
    }
    column += VIEWS.length;
  }
  return { canvas: sheet, missingPoseRefs: [...missingPoseRefs] };
}

// --- The app's sheets ------------------------------------------------------

/** The most rows a sheet for a frame review has. */
export const MAX_REVIEW_SHEET_ROWS = 6;

/** The tile size of a frame review's sheets, as `animation:render` defaults. */
export const DEFAULT_REVIEW_SHEET_TILE: ReviewSheetTile = {
  width: 220,
  height: 330,
};

/** Returns an Included Avatar's VRM file, as bytes or a URL to fetch. */
export type IncludedAvatarFile = (
  id: IncludedAvatarId,
) => ArrayBuffer | string | Promise<ArrayBuffer | string>;

/** How a sheet is encoded: JPEG at quality 0.85 unless stated. */
export type ReviewSheetEncoding = {
  type: "image/jpeg" | "image/png";
  /** JPEG quality from 0 to 1. */
  quality?: number;
};

export type IncludedAvatarReviewSheet = {
  avatar: IncludedAvatarId;
  blob: Blob;
  /** The sheet's size in pixels. */
  width: number;
  height: number;
};

export type IncludedAvatarReviewSheetsRequest = {
  /**
   * A renderer the caller already has, such as the preview canvas's: tiles
   * are drawn through a render target on it, so no WebGL context is created.
   */
  renderer: THREE.WebGLRenderer;
  clip: unknown;
  /** Seconds from the clip's start; one row each, at most six. */
  times: readonly number[];
  avatarFile: IncludedAvatarFile;
  tile?: ReviewSheetTile;
  encoding?: ReviewSheetEncoding;
};

/**
 * Render one review sheet per Included Avatar: a row per time with the front,
 * ¾, side and face views from the Avatar's right. There is no parameter for
 * another Avatar: the function draws each Included Avatar in turn and asks the
 * caller only for that Avatar's file. It draws the file it is given, so the
 * caller must answer with the Included Avatar's own bytes.
 *
 * The renderer is used only while one Avatar's tiles are drawn, with nothing
 * awaited in between, and its render target, clear colour and clear flags are
 * put back after every tile; its size and pixel ratio are never changed. The
 * caller's own frames may therefore run between Avatars. The loaded Avatars
 * and the render target are disposed before the function returns.
 */
export async function renderIncludedAvatarReviewSheets(
  request: IncludedAvatarReviewSheetsRequest,
): Promise<IncludedAvatarReviewSheet[]> {
  const { times } = request;
  if (times.length === 0 || times.length > MAX_REVIEW_SHEET_ROWS)
    throw new RangeError(
      `A review sheet has 1 to ${MAX_REVIEW_SHEET_ROWS} rows, not ${times.length}.`,
    );
  if (times.some((time) => !Number.isFinite(time) || time < 0))
    throw new RangeError("A review sheet's times are seconds from 0.");
  // A clip that cannot play is refused before any Avatar file is read.
  const clip = parseAnimaPoseClip(request.clip);
  const tile = request.tile ?? DEFAULT_REVIEW_SHEET_TILE;
  const encoding = request.encoding ?? { type: "image/jpeg", quality: 0.85 };
  const painter = createRenderTargetPainter(request.renderer, tile);
  try {
    const sheets: IncludedAvatarReviewSheet[] = [];
    for (const avatar of Object.keys(
      INCLUDED_AVATAR_FILES,
    ) as IncludedAvatarId[]) {
      const { canvas } = await drawReviewSheet({
        clip,
        avatars: [{ label: avatar, file: await request.avatarFile(avatar) }],
        times,
        tile,
        paintTile: painter.paintTile,
      });
      sheets.push({
        avatar,
        blob: await encodeCanvas(canvas, encoding),
        width: canvas.width,
        height: canvas.height,
      });
    }
    return sheets;
  } finally {
    painter.dispose();
  }
}

/**
 * A render target stores linear colour, and reading it back returns those
 * values as they are; a canvas holds sRGB. Read back unencoded, a sheet comes
 * out darker than the same scene drawn on a canvas.
 */
const SRGB_FROM_LINEAR = Uint8ClampedArray.from({ length: 256 }, (_, value) => {
  const linear = value / 255;
  return Math.round(
    255 *
      (linear <= 0.0031308
        ? 12.92 * linear
        : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055),
  );
});

/**
 * A tile painter that renders through a multisampled render target on
 * `renderer`, reads the pixels back, encodes them to sRGB and puts them on the
 * sheet. It leaves the renderer's render target, clear colour and clear flags
 * as it found them after each tile. Included Avatars carry no lilToon
 * materials, so lilToon's passes are not installed.
 */
function createRenderTargetPainter(
  renderer: THREE.WebGLRenderer,
  tile: ReviewSheetTile,
): { paintTile: ReviewSheetTilePainter; dispose: () => void } {
  const { width, height } = tile;
  const target = new THREE.WebGLRenderTarget(width, height, { samples: 4 });
  const pixels = new Uint8Array(width * height * 4);
  const rowLength = width * 4;
  const clearColor = new THREE.Color();
  return {
    paintTile(scene, camera, context, x, y) {
      const previous = {
        target: renderer.getRenderTarget(),
        cubeFace: renderer.getActiveCubeFace(),
        mipmapLevel: renderer.getActiveMipmapLevel(),
        clearColor: renderer.getClearColor(clearColor),
        clearAlpha: renderer.getClearAlpha(),
        autoClear: renderer.autoClear,
        autoClearColor: renderer.autoClearColor,
        autoClearDepth: renderer.autoClearDepth,
        autoClearStencil: renderer.autoClearStencil,
      };
      try {
        // Every tile starts from a cleared target, whatever the caller's
        // own frames need.
        renderer.autoClear = true;
        renderer.autoClearColor = true;
        renderer.autoClearDepth = true;
        renderer.autoClearStencil = true;
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      } finally {
        renderer.setRenderTarget(
          previous.target,
          previous.cubeFace,
          previous.mipmapLevel,
        );
        // The sheet's background became the context's clear colour; a caller
        // that clears by hand would otherwise clear to it.
        renderer.setClearColor(previous.clearColor, previous.clearAlpha);
        renderer.autoClear = previous.autoClear;
        renderer.autoClearColor = previous.autoClearColor;
        renderer.autoClearDepth = previous.autoClearDepth;
        renderer.autoClearStencil = previous.autoClearStencil;
      }
      const image = context.createImageData(width, height);
      // WebGL rows run bottom to top.
      for (let line = 0; line < height; line += 1) {
        const from = (height - 1 - line) * rowLength;
        const to = line * rowLength;
        for (let offset = 0; offset < rowLength; offset += 4) {
          image.data[to + offset] = SRGB_FROM_LINEAR[pixels[from + offset]!]!;
          image.data[to + offset + 1] =
            SRGB_FROM_LINEAR[pixels[from + offset + 1]!]!;
          image.data[to + offset + 2] =
            SRGB_FROM_LINEAR[pixels[from + offset + 2]!]!;
          // A canvas tile is opaque, as a renderer's own canvas is.
          image.data[to + offset + 3] = 255;
        }
      }
      context.putImageData(image, x, y);
    },
    dispose() {
      target.dispose();
    },
  };
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  encoding: ReviewSheetEncoding,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("The review sheet could not be encoded.")),
      encoding.type,
      encoding.quality,
    );
  });
}
