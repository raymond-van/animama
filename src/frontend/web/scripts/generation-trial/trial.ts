import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";

import { Avatar } from "@/lib/avatar/Avatar";
import {
  headSized,
  measureAvatarProportions,
  REFERENCE_TOP_OVER_HEAD_BONE,
} from "@/lib/avatar/avatarProportions";
import { configureAvatarGltfLoader } from "@/lib/avatar/configureAvatarGltfLoader";
import {
  installLilToonRenderingWhenLoaded,
  withOnDemandLilToon,
} from "@/lib/avatar/liltoon/lilToon";
import {
  checkMotion,
  formatMotionCheckReport,
  type MotionCheckAvatar,
} from "@/lib/avatar/motion-authoring/checks";
import { loadHeadlessVrm } from "@/lib/avatar/motion-authoring/headlessVrm";
import { applyCanonicalPose } from "@/lib/avatar/motion-authoring/kinematics";
import {
  getAnimaPoseClipTimelineDuration,
  parseAnimaPoseClip,
} from "@/lib/avatar/poses/animaPoseClip";
import { createAnimaPoseClipProgram } from "@/lib/avatar/poses/animaPoseClip/program";
import { getResolvedAvatarPose } from "@/lib/avatar/poses/catalog";
import { prepareLoadedVrm } from "@/lib/avatar/prepareLoadedVrm";
import { UnmetallicMaterialsPlugin } from "@/lib/avatar/unmetallicMaterials";
import { canonicalizeCustomPresetExpressions } from "@/lib/avatar/vrmExpressionPresets";

import { avatarFileSha256 } from "../effect-render/avatarFile";
import type { ChecksWorkerReply, ChecksWorkerRequest } from "./checksWorker";

/**
 * Feasibility trial for generating content in the app (driven by
 * `scripts/generation-trial.mjs`). It answers two questions in a real page:
 *
 * - Do the motion checks the `animama-animation` skill runs in Node also run
 *   in a browser page and in a Web Worker, with the same findings, and how
 *   long do they block the main thread?
 * - Can review sheets be drawn without a second WebGL context, through a
 *   render target on a renderer the page already has, and at what cost?
 *
 * It measures and reports; it is not product code.
 */

type TrialAvatar = { id: string; url: string };

export type TrialRequest = {
  avatars: TrialAvatar[];
  clips: { id: string; clip: unknown }[];
  /** Draw review sheets for the first clip with both strategies. */
  frames: boolean;
  rows: number;
  tile: { width: number; height: number };
};

type ClipCheckTrial = {
  clip: string;
  durationSeconds: number;
  mainMs: number;
  workerMs: number;
  workerRoundTripMs: number;
  /** Longest gap between main-thread timer ticks while the worker checked. */
  mainThreadMaxGapMs: number;
  findings: number;
  fails: number;
  workerMatchesMain: boolean;
  report: string;
};

type SheetTrial = {
  avatar: string;
  width: number;
  height: number;
  pngBytes: number;
  jpegBytes: number;
  dataUrl: string;
};

type FramesTrial = {
  clip: string;
  times: number[];
  texturedLoadMs: { avatar: string; ms: number }[];
  ownRenderer: { firstMs: number; secondMs: number; sheets: SheetTrial[] };
  renderTarget: { firstMs: number; secondMs: number; sheets: SheetTrial[] };
  /** Mean absolute channel difference (0–255) from the own-renderer sheets. */
  renderTargetRawDifference: number;
  renderTargetSrgbDifference: number;
};

export type TrialResult = {
  userAgent: string;
  webglRenderer: string;
  avatars: { id: string; bytes: number; headlessLoadMs: number }[];
  workerLoadMs: number;
  checks: ClipCheckTrial[];
  frames: FramesTrial | null;
};

const LABEL_WIDTH = 64;
const HEADER_HEIGHT = 28;
const BACKGROUND = 0xf4f3ef;

// --- Motion checks -------------------------------------------------------

/** Run every clip's checks on the main thread and in a worker, and time both. */
async function checksTrial(
  request: TrialRequest,
): Promise<Pick<TrialResult, "avatars" | "workerLoadMs" | "checks">> {
  const files = await Promise.all(
    request.avatars.map(async ({ id, url }) => ({
      id,
      bytes: await (await fetch(url)).arrayBuffer(),
    })),
  );
  const avatars: MotionCheckAvatar[] = [];
  const loads: TrialResult["avatars"] = [];
  for (const file of files) {
    const started = performance.now();
    const vrm = await loadHeadlessVrm(file.bytes);
    loads.push({
      id: file.id,
      bytes: file.bytes.byteLength,
      headlessLoadMs: performance.now() - started,
    });
    avatars.push({ id: file.id, vrm });
  }

  const worker = new Worker(new URL("./checksWorker.ts", import.meta.url), {
    type: "module",
  });
  const ask = (message: ChecksWorkerRequest, transfer: Transferable[] = []) =>
    new Promise<ChecksWorkerReply>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<ChecksWorkerReply>) =>
        resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage(message, transfer);
    });
  try {
    // The page keeps no use for the bytes after this, so they move.
    const loaded = await ask(
      { kind: "load", avatars: files },
      files.map((file) => file.bytes),
    );
    if (loaded.kind !== "loaded")
      throw new Error(
        `The worker could not load the Avatars: ${describe(loaded)}`,
      );

    const checks: ClipCheckTrial[] = [];
    for (const { id, clip } of request.clips) {
      const mainStarted = performance.now();
      const mainReport = checkMotion(clip, avatars);
      const mainMs = performance.now() - mainStarted;

      let lastTick = performance.now();
      let mainThreadMaxGapMs = 0;
      const ticker = setInterval(() => {
        const now = performance.now();
        mainThreadMaxGapMs = Math.max(mainThreadMaxGapMs, now - lastTick);
        lastTick = now;
      }, 4);
      const workerStarted = performance.now();
      const checked = await ask({ kind: "check", clip });
      const workerRoundTripMs = performance.now() - workerStarted;
      clearInterval(ticker);
      if (checked.kind !== "checked")
        throw new Error(
          `The worker could not check ${id}: ${describe(checked)}`,
        );

      checks.push({
        clip: id,
        durationSeconds: getAnimaPoseClipTimelineDuration(
          parseAnimaPoseClip(clip),
        ),
        mainMs,
        workerMs: checked.checkMs,
        workerRoundTripMs,
        mainThreadMaxGapMs,
        findings: mainReport.findings.length,
        fails: mainReport.findings.filter(
          (finding) => finding.severity === "fail",
        ).length,
        workerMatchesMain:
          JSON.stringify(checked.report) === JSON.stringify(mainReport),
        report: formatMotionCheckReport(mainReport),
      });
    }
    return { avatars: loads, workerLoadMs: loaded.loadMs, checks };
  } finally {
    worker.terminate();
  }
}

const describe = (reply: ChecksWorkerReply) =>
  reply.kind === "failed" ? reply.message : reply.kind;

// --- Review sheets -------------------------------------------------------

type View = { name: string; angle: number; face: boolean };

/** The skill's body views from the Avatar's right (`animation-render`). */
const VIEWS: View[] = [
  { name: "front", angle: 0, face: false },
  { name: "3/4 right", angle: -Math.PI / 4, face: false },
  { name: "right side", angle: -Math.PI / 2, face: false },
  { name: "face", angle: 0, face: true },
];

/** The Included Avatars' rest height of the head bone (m), as in `animation-render`. */
const REFERENCE_HEAD_BONE_HEIGHT = 1.35;

/** Load an Avatar with its materials, as the app and `animation-render` do. */
async function loadTexturedVrm(url: string): Promise<VRM> {
  const loader = configureAvatarGltfLoader(new GLTFLoader());
  loader.register((parser) => withOnDemandLilToon(new VRMLoaderPlugin(parser)));
  loader.register((parser) => new UnmetallicMaterialsPlugin(parser));
  const gltf: GLTF = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm as VRM;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  canonicalizeCustomPresetExpressions(vrm);
  prepareLoadedVrm(vrm, { vrmSha256: await avatarFileSha256(url) });
  // Measuring the face registers it for size-aware contacts and framing.
  const avatar = new Avatar(new THREE.PerspectiveCamera());
  avatar.vrm = vrm;
  avatar.sourceGltf = gltf;
  await avatar.setFacePartCorrections(null);
  return vrm;
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

/** How one tile's pixels reach the sheet. */
type TilePainter = {
  /** Render the scene and paint the tile at (x, y) on each given sheet. */
  paint(
    scene: THREE.Scene,
    camera: THREE.Camera,
    contexts: CanvasRenderingContext2D[],
    x: number,
    y: number,
  ): void;
  dispose(): void;
};

/** A renderer of the tile's own size: one more WebGL context. */
function ownRendererPainter(tile: TrialRequest["tile"]): TilePainter {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(tile.width, tile.height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const releaseLilToon = installLilToonRenderingWhenLoaded(renderer);
  return {
    paint(scene, camera, [context], x, y) {
      renderer.render(scene, camera);
      context!.drawImage(renderer.domElement, x, y);
    },
    dispose() {
      releaseLilToon();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

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
 * A render target on a renderer the page already has: no new WebGL context.
 * The first sheet gets the pixels as read back; the second gets them encoded
 * from linear to sRGB, to show which matches a renderer's own canvas.
 */
function renderTargetPainter(
  renderer: THREE.WebGLRenderer,
  tile: TrialRequest["tile"],
): TilePainter {
  const target = new THREE.WebGLRenderTarget(tile.width, tile.height, {
    samples: 4,
  });
  const pixels = new Uint8Array(tile.width * tile.height * 4);
  const releaseLilToon = installLilToonRenderingWhenLoaded(renderer);
  return {
    paint(scene, camera, contexts, x, y) {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(
        target,
        0,
        0,
        tile.width,
        tile.height,
        pixels,
      );
      renderer.setRenderTarget(null);
      contexts.forEach((context, index) => {
        const image = context.createImageData(tile.width, tile.height);
        const row = tile.width * 4;
        // WebGL rows run bottom to top.
        for (let line = 0; line < tile.height; line += 1) {
          const from = (tile.height - 1 - line) * row;
          for (let offset = 0; offset < row; offset += 1) {
            const value = pixels[from + offset]!;
            image.data[line * row + offset] =
              index === 1 && offset % 4 !== 3
                ? SRGB_FROM_LINEAR[value]!
                : value;
          }
        }
        context.putImageData(image, x, y);
      });
    },
    dispose() {
      releaseLilToon();
      target.dispose();
    },
  };
}

function newSheet(tile: TrialRequest["tile"], rows: number) {
  const canvas = document.createElement("canvas");
  canvas.width = LABEL_WIDTH + VIEWS.length * tile.width;
  canvas.height = HEADER_HEIGHT + rows * tile.height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = "#f4f3ef";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#222";
  context.font = "13px sans-serif";
  return { canvas, context };
}

/**
 * Draw one sheet per Avatar: a row per time, a column per view. `sheetsPerAvatar`
 * is how many sheets the painter fills at once (the render target fills two).
 */
function drawSheets(
  painter: TilePainter,
  sheetsPerAvatar: number,
  clip: unknown,
  avatars: { id: string; vrm: VRM }[],
  times: number[],
  tile: TrialRequest["tile"],
): HTMLCanvasElement[][] {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(1, 2, 2);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(
    30,
    tile.width / tile.height,
    0.1,
    20,
  );
  const resolvePose = (id: string) => {
    try {
      return getResolvedAvatarPose(id);
    } catch {
      return null;
    }
  };
  return avatars.map(({ id, vrm }) => {
    const sheets = Array.from({ length: sheetsPerAvatar }, () =>
      newSheet(tile, times.length),
    );
    scene.add(vrm.scene);
    const program = createAnimaPoseClipProgram(parseAnimaPoseClip(clip), {
      vrm,
      resolvePose,
    });
    applyCanonicalPose(vrm, {});
    const head = vrm.humanoid
      .getRawBoneNode("head")!
      .getWorldPosition(new THREE.Vector3());
    const proportions = measureAvatarProportions(vrm);
    const top = head.y + (proportions.headBox?.max.y ?? 0);
    const bodyLength = headSized(
      proportions,
      head.y,
      Math.max(head.y, top / REFERENCE_TOP_OVER_HEAD_BONE),
    );
    const faceLength = headSized(
      proportions,
      head.y,
      REFERENCE_HEAD_BONE_HEIGHT * proportions.headScale,
    );
    const target = new THREE.Vector3(0, bodyLength * 0.55, 0);
    const distance = bodyLength * 2.9;
    for (const { context } of sheets) {
      VIEWS.forEach((view, column) =>
        context.fillText(
          `${id} · ${view.name}`,
          LABEL_WIDTH + column * tile.width + 6,
          18,
        ),
      );
    }
    times.forEach((time, row) => {
      const sample = program.sample(time).sample;
      applyCanonicalPose(vrm, sample.humanoid ?? {});
      applyExpressions(vrm, sample.expressions ?? {});
      vrm.springBoneManager?.reset();
      VIEWS.forEach((view, column) => {
        if (view.face) {
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
        painter.paint(
          scene,
          camera,
          sheets.map((sheet) => sheet.context),
          LABEL_WIDTH + column * tile.width,
          HEADER_HEIGHT + row * tile.height,
        );
      });
      for (const { context } of sheets)
        context.fillText(
          `${time.toFixed(2)}s`,
          8,
          HEADER_HEIGHT + row * tile.height + 18,
        );
    });
    scene.remove(vrm.scene);
    return sheets.map((sheet) => sheet.canvas);
  });
}

const dataUrlBytes = (dataUrl: string) =>
  Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);

function sheetTrial(avatar: string, canvas: HTMLCanvasElement): SheetTrial {
  const dataUrl = canvas.toDataURL("image/png");
  return {
    avatar,
    width: canvas.width,
    height: canvas.height,
    pngBytes: dataUrlBytes(dataUrl),
    jpegBytes: dataUrlBytes(canvas.toDataURL("image/jpeg", 0.85)),
    dataUrl,
  };
}

/** Mean absolute channel difference between two sheets of the same size. */
function meanDifference(a: HTMLCanvasElement, b: HTMLCanvasElement): number {
  const read = (canvas: HTMLCanvasElement) =>
    canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height)
      .data;
  const left = read(a);
  const right = read(b);
  let total = 0;
  for (let index = 0; index < left.length; index += 1)
    total += Math.abs(left[index]! - right[index]!);
  return total / left.length;
}

/** Draw the first clip's sheets with both strategies, twice each, and time them. */
async function framesTrial(
  request: TrialRequest,
  existing: THREE.WebGLRenderer,
): Promise<FramesTrial> {
  const { id, clip } = request.clips[0]!;
  const duration = getAnimaPoseClipTimelineDuration(parseAnimaPoseClip(clip));
  const times = Array.from(
    { length: request.rows },
    (_, index) =>
      Math.round(((duration * index) / (request.rows - 1)) * 1000) / 1000,
  );
  const texturedLoadMs: FramesTrial["texturedLoadMs"] = [];
  const avatars: { id: string; vrm: VRM }[] = [];
  for (const avatar of request.avatars) {
    const started = performance.now();
    avatars.push({ id: avatar.id, vrm: await loadTexturedVrm(avatar.url) });
    texturedLoadMs.push({
      avatar: avatar.id,
      ms: performance.now() - started,
    });
  }

  const timed = (
    painter: TilePainter,
    sheetsPerAvatar: number,
  ): { ms: number; sheets: HTMLCanvasElement[][] } => {
    const started = performance.now();
    const sheets = drawSheets(
      painter,
      sheetsPerAvatar,
      clip,
      avatars,
      times,
      request.tile,
    );
    return { ms: performance.now() - started, sheets };
  };

  const own = ownRendererPainter(request.tile);
  const ownFirst = timed(own, 1);
  const ownSecond = timed(own, 1);
  own.dispose();

  const shared = renderTargetPainter(existing, request.tile);
  const sharedFirst = timed(shared, 2);
  const sharedSecond = timed(shared, 2);
  shared.dispose();

  for (const { vrm } of avatars) VRMUtils.deepDispose(vrm.scene);

  const differences = avatars.map((_, index) => ({
    raw: meanDifference(
      ownSecond.sheets[index]![0]!,
      sharedSecond.sheets[index]![0]!,
    ),
    srgb: meanDifference(
      ownSecond.sheets[index]![0]!,
      sharedSecond.sheets[index]![1]!,
    ),
  }));
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    clip: id,
    times,
    texturedLoadMs,
    ownRenderer: {
      firstMs: ownFirst.ms,
      secondMs: ownSecond.ms,
      sheets: avatars.map((avatar, index) =>
        sheetTrial(avatar.id, ownSecond.sheets[index]![0]!),
      ),
    },
    renderTarget: {
      firstMs: sharedFirst.ms,
      secondMs: sharedSecond.ms,
      sheets: avatars.map((avatar, index) =>
        sheetTrial(avatar.id, sharedSecond.sheets[index]![1]!),
      ),
    },
    renderTargetRawDifference: mean(differences.map((value) => value.raw)),
    renderTargetSrgbDifference: mean(differences.map((value) => value.srgb)),
  };
}

// --- Entry ---------------------------------------------------------------

/** Stands in for the renderer a preview canvas already owns. */
function existingRenderer(): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(640, 480);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.append(renderer.domElement);
  renderer.render(new THREE.Scene(), new THREE.PerspectiveCamera());
  return renderer;
}

async function run(request: TrialRequest): Promise<TrialResult> {
  const renderer = existingRenderer();
  const gl = renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const checks = await checksTrial(request);
  const frames = request.frames ? await framesTrial(request, renderer) : null;
  renderer.dispose();
  return {
    userAgent: navigator.userAgent,
    webglRenderer: debug
      ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : "unknown",
    ...checks,
    frames,
  };
}

declare global {
  interface Window {
    runGenerationTrial: (request: TrialRequest) => Promise<TrialResult>;
    generationTrialReady: boolean;
  }
}

window.runGenerationTrial = run;
window.generationTrialReady = true;
