import * as THREE from "three";

import type { MotionCheckAvatar } from "@/lib/avatar/motion-authoring/checks";
import {
  runDraftChecks,
  type DraftCheckReport,
} from "@/lib/avatar/motion-authoring/draftChecks";
import { createDraftChecksClient } from "@/lib/avatar/motion-authoring/draftChecksClient";
import {
  loadHeadlessVrm,
  type IncludedAvatarId,
} from "@/lib/avatar/motion-authoring/headlessVrm";
import {
  renderIncludedAvatarReviewSheets,
  type ReviewSheetEncoding,
} from "@/lib/avatar/motion-authoring/reviewSheet";
import {
  getAnimaPoseClipTimelineDuration,
  parseAnimaPoseClip,
} from "@/lib/avatar/poses/animaPoseClip";

import { renderGestureSheet } from "../animation-render/render";

/**
 * The page side of the parity check between the app and the
 * `animama-animation` skill (driven by `scripts/generation-trial.mjs`). In a
 * real page it runs the app's own code:
 *
 * - the draft checks on the main thread and through the app's worker client,
 *   so the driver can compare both with what `pnpm animation validate` and
 *   `check` report in Node, and time how long a check blocks each thread;
 * - the app's review sheets, drawn through a render target on a renderer the
 *   page already has, beside the sheets `pnpm animation:render` draws with a
 *   renderer of its own.
 *
 * It measures and reports; the code it measures lives in app source.
 */

type TrialAvatar = { id: IncludedAvatarId; url: string };

export type TrialRequest = {
  avatars: TrialAvatar[];
  clips: { id: string; clip: unknown }[];
  /** Draw review sheets for the first clip both ways. */
  frames: boolean;
  rows: number;
  tile: { width: number; height: number };
};

type ClipCheckTrial = {
  clip: string;
  /** Null for a clip the app cannot load. */
  durationSeconds: number | null;
  mainMs: number;
  workerRoundTripMs: number;
  /** Longest gap between main-thread timer ticks while the worker checked. */
  mainThreadMaxGapMs: number;
  /** The report from the main thread. */
  report: DraftCheckReport;
  workerMatchesMain: boolean;
};

type SheetTrial = {
  avatar: string;
  width: number;
  height: number;
  pngBytes: number;
  jpegBytes: number;
  /** The sheet as a PNG. */
  dataUrl: string;
};

type FramesTrial = {
  clip: string;
  times: number[];
  /** Milliseconds include loading the Avatars with their materials. */
  ownRenderer: { firstMs: number; secondMs: number; sheets: SheetTrial[] };
  renderTarget: { firstMs: number; secondMs: number; sheets: SheetTrial[] };
  /** Mean absolute channel difference (0–255) between the two kinds of sheet. */
  renderTargetSrgbDifference: number;
  /** The Avatar files the app's sheets asked for, over both rounds. */
  requestedAvatars: string[];
  /**
   * Whether the existing renderer kept its render target, size, clear colour
   * and clear flags: before, after, and at each of its own frames in between.
   */
  rendererUndisturbed: boolean;
  /** How many of the existing renderer's own frames ran in between. */
  framesBetween: number;
};

export type TrialResult = {
  userAgent: string;
  webglRenderer: string;
  avatars: { id: string; bytes: number; headlessLoadMs: number }[];
  /** Starting the worker and loading both Avatars in it. */
  workerStartMs: number;
  checks: ClipCheckTrial[];
  frames: FramesTrial | null;
};

// --- Draft checks ----------------------------------------------------------

/** Check every clip on the main thread and through the worker, and time both. */
async function checksTrial(
  request: TrialRequest,
): Promise<Pick<TrialResult, "avatars" | "workerStartMs" | "checks">> {
  const files = new Map<IncludedAvatarId, ArrayBuffer>();
  for (const { id, url } of request.avatars)
    files.set(id, await (await fetch(url)).arrayBuffer());
  const avatars: MotionCheckAvatar[] = [];
  const loads: TrialResult["avatars"] = [];
  for (const [id, bytes] of files) {
    const started = performance.now();
    const vrm = await loadHeadlessVrm(bytes);
    loads.push({
      id,
      bytes: bytes.byteLength,
      headlessLoadMs: performance.now() - started,
    });
    avatars.push({ id, vrm });
  }

  const client = createDraftChecksClient(async (id) => {
    const bytes = files.get(id);
    if (!bytes) throw new Error(`The trial was not given ${id}.`);
    return bytes;
  });
  try {
    // The first check starts the worker and has it load the Avatars; a value
    // that is not a clip adds no motion check to that.
    const workerStarted = performance.now();
    await client.check(null);
    const workerStartMs = performance.now() - workerStarted;

    const checks: ClipCheckTrial[] = [];
    for (const { id, clip } of request.clips) {
      const mainStarted = performance.now();
      const report = runDraftChecks(clip, avatars);
      const mainMs = performance.now() - mainStarted;

      let lastTick = performance.now();
      let mainThreadMaxGapMs = 0;
      const ticker = setInterval(() => {
        const now = performance.now();
        mainThreadMaxGapMs = Math.max(mainThreadMaxGapMs, now - lastTick);
        lastTick = now;
      }, 4);
      const roundTripStarted = performance.now();
      const workerReport = await client
        .check(clip)
        .finally(() => clearInterval(ticker));
      const workerRoundTripMs = performance.now() - roundTripStarted;

      checks.push({
        clip: id,
        durationSeconds: report.loadable
          ? getAnimaPoseClipTimelineDuration(parseAnimaPoseClip(clip))
          : null,
        mainMs,
        workerRoundTripMs,
        mainThreadMaxGapMs,
        report,
        workerMatchesMain:
          JSON.stringify(workerReport) === JSON.stringify(report),
      });
    }
    return { avatars: loads, workerStartMs, checks };
  } finally {
    client.dispose();
  }
}

// --- Review sheets ---------------------------------------------------------

const JPEG_QUALITY = 0.85;

const dataUrlBytes = (dataUrl: string) =>
  Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);

const blobDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** Decode an encoded sheet back to a canvas, to read its pixels. */
async function decodeSheet(dataUrl: string): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")!.drawImage(image, 0, 0);
  return canvas;
}

/** Mean absolute channel difference between two sheets of the same size. */
function meanDifference(a: HTMLCanvasElement, b: HTMLCanvasElement): number {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(
      `Sheets differ in size: ${a.width}×${a.height} and ${b.width}×${b.height}.`,
    );
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

/**
 * Keep the existing renderer drawing its own frames, as a preview canvas
 * does, and note whether any frame finds its state changed.
 */
function watchRenderer(renderer: THREE.WebGLRenderer) {
  const gl = renderer.getContext();
  const state = () =>
    JSON.stringify({
      onCanvas: renderer.getRenderTarget() === null,
      // The context's own clear colour, which clearing by hand would use.
      clearValue: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
      size: renderer.getSize(new THREE.Vector2()).toArray(),
      pixelRatio: renderer.getPixelRatio(),
      clearColor: renderer.getClearColor(new THREE.Color()).getHex(),
      clearAlpha: renderer.getClearAlpha(),
      autoClear: [
        renderer.autoClear,
        renderer.autoClearColor,
        renderer.autoClearDepth,
        renderer.autoClearStencil,
      ],
    });
  const before = state();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  let undisturbed = true;
  let frames = 0;
  let handle = requestAnimationFrame(function frame() {
    frames += 1;
    undisturbed &&= state() === before;
    renderer.render(scene, camera);
    handle = requestAnimationFrame(frame);
  });
  return {
    stop() {
      cancelAnimationFrame(handle);
      return { undisturbed: undisturbed && state() === before, frames };
    },
  };
}

/** Draw the first clip's sheets both ways, twice each, and compare them. */
async function framesTrial(
  request: TrialRequest,
  existing: THREE.WebGLRenderer,
): Promise<FramesTrial> {
  const { id: clipId, clip } = request.clips[0]!;
  const duration = getAnimaPoseClipTimelineDuration(parseAnimaPoseClip(clip));
  const times = Array.from(
    { length: request.rows },
    (_, index) =>
      Math.round(((duration * index) / (request.rows - 1)) * 1000) / 1000,
  );
  const urls = new Map(request.avatars.map(({ id, url }) => [id, url]));

  // `animation:render`'s page, one Avatar a sheet as the app lays them out.
  const drawOwn = async () => {
    const started = performance.now();
    const sheets: { avatar: string; dataUrl: string }[] = [];
    for (const avatar of request.avatars) {
      const { dataUrl } = await renderGestureSheet({
        clip,
        avatars: [avatar],
        times,
        tile: request.tile,
        side: "right",
      });
      sheets.push({ avatar: avatar.id, dataUrl });
    }
    return { ms: performance.now() - started, sheets };
  };
  const requestedAvatars: string[] = [];
  const drawApp = async (encoding?: ReviewSheetEncoding) => {
    const started = performance.now();
    const sheets = await renderIncludedAvatarReviewSheets({
      renderer: existing,
      clip,
      times,
      tile: request.tile,
      avatarFile: (avatar) => {
        requestedAvatars.push(avatar);
        const url = urls.get(avatar);
        if (!url) throw new Error(`The trial was not given ${avatar}.`);
        return url;
      },
      encoding,
    });
    return { ms: performance.now() - started, sheets };
  };

  const ownFirst = await drawOwn();
  const ownSecond = await drawOwn();
  const watch = watchRenderer(existing);
  // As the app asks for them (JPEG), then losslessly for the comparison.
  const appFirst = await drawApp();
  const appSecond = await drawApp({ type: "image/png" });
  const watched = watch.stop();

  const ownSheets: SheetTrial[] = [];
  const appSheets: SheetTrial[] = [];
  const differences: number[] = [];
  for (const [index, png] of appSecond.sheets.entries()) {
    const own = ownSecond.sheets.find((sheet) => sheet.avatar === png.avatar);
    if (!own) throw new Error(`No own-renderer sheet for ${png.avatar}.`);
    const ownCanvas = await decodeSheet(own.dataUrl);
    const appDataUrl = await blobDataUrl(png.blob);
    differences.push(meanDifference(ownCanvas, await decodeSheet(appDataUrl)));
    ownSheets.push({
      avatar: own.avatar,
      width: ownCanvas.width,
      height: ownCanvas.height,
      pngBytes: dataUrlBytes(own.dataUrl),
      jpegBytes: dataUrlBytes(ownCanvas.toDataURL("image/jpeg", JPEG_QUALITY)),
      dataUrl: own.dataUrl,
    });
    const jpeg = appFirst.sheets[index]!;
    if (jpeg.avatar !== png.avatar || jpeg.blob.type !== "image/jpeg")
      throw new Error(`The app's sheet ${index} is not ${png.avatar}'s JPEG.`);
    appSheets.push({
      avatar: png.avatar,
      width: png.width,
      height: png.height,
      pngBytes: png.blob.size,
      jpegBytes: jpeg.blob.size,
      dataUrl: appDataUrl,
    });
  }
  return {
    clip: clipId,
    times,
    ownRenderer: {
      firstMs: ownFirst.ms,
      secondMs: ownSecond.ms,
      sheets: ownSheets,
    },
    renderTarget: {
      firstMs: appFirst.ms,
      secondMs: appSecond.ms,
      sheets: appSheets,
    },
    renderTargetSrgbDifference:
      differences.reduce((sum, value) => sum + value, 0) / differences.length,
    requestedAvatars,
    rendererUndisturbed: watched.undisturbed,
    framesBetween: watched.frames,
  };
}

// --- Entry -----------------------------------------------------------------

/**
 * Stands in for the renderer a preview canvas already owns, with settings
 * other than the defaults so a change to any of them shows.
 */
function existingRenderer(): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(640, 480);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x336699, 0.5);
  renderer.autoClearStencil = false;
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
