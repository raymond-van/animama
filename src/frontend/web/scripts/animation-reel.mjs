import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EffectSourceError,
  INCLUDED_CONTENT_ROOT,
  REPO_ROOT,
  resolveClipSource,
  resolveDependencies,
  scanLibrary,
} from "./effect-render-sources.mjs";
import {
  avatarFileUrl,
  pageClipMedia,
  sourceRoots,
  withRendererPage,
} from "./effect-render.mjs";

/**
 * Record a video reel of Gestures or Reactions on an Included Avatar.
 *
 *   pnpm -s animation:reel --gestures|--reactions [<source>...] --out <file.mp4>
 *
 * Every Included Gesture (by stem) or Reaction (by emotion, then intensity),
 * or the named sources, plays one at a time through the Avatar's own clip
 * player on the review stage (`effect-render/`): the chat's lighting, camera
 * preset and Scene layers, with its Avatar, Particle and Scene Effects. A
 * corner label names the item and its effects, lighting each while active,
 * and lists the Avatar's live expression weights.
 * Frames advance in fixed steps and are captured from a headless browser, so
 * the reel does not depend on capture speed. The sounds clip events play are
 * mixed into the audio afterwards from local sound files (by default the
 * private comedy sound pack under `build-inputs/`); the video has one chapter
 * per item. Requires `ffmpeg` with libx264 on PATH.
 */
const SOUND_EXTENSIONS = [".ogg", ".mp3", ".wav", ".m4a", ".flac", ".opus"];
/** The licensed comedy sound pack, when this checkout has it. */
const DEFAULT_SOUND_ROOTS = [
  path.join(REPO_ROOT, "build-inputs/wow-comedy-sfx"),
  path.join(INCLUDED_CONTENT_ROOT, "sfx"),
];
const AVATAR_ALIASES = {
  annie: "AvatarSample_A_1_New",
  caitlyn: "AvatarSample_Y_0",
};
const CAMERAS = ["portrait", "portrait-close", "full-body", "full-body-close"];
const EFFECT_KINDS = {
  avatar_effect: "Avatar Effect",
  particle_effect: "Particle Effect",
  scene_effect: "Scene Effect",
};
const AUDIO_RATE = 48_000;
/** Folder levels searched below a sound root. */
const MAX_SOUND_DEPTH = 4;
const GPU_ARGS = [
  "--use-angle=metal",
  "--enable-gpu",
  "--ignore-gpu-blocklist",
];
const SOFTWARE_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

export const DEFAULTS = {
  avatar: "AvatarSample_A_1_New",
  camera: "portrait",
  size: { width: 1920, height: 1080 },
  fps: 30,
  lead: 0.5,
  tail: 0.5,
  talk: 3,
  maxSec: 20,
  crf: 18,
};

const USAGE = [
  "Usage:",
  "  pnpm -s animation:reel --gestures|--reactions [<source>...] --out <file.mp4> [options]",
  "",
  "Records one video of every Included Gesture (--gestures, by stem), every",
  "Included Reaction (--reactions, by emotion then intensity) and any named",
  "sources: a Gesture or Reaction folder, .meta.json, clip .json or",
  "library:[gesture/|reaction/][included/|local/]<stem|content_id|name>.",
  "Each plays once (a loop for one pass) with its effects and sounds, under a",
  "corner label naming it, its effects and its live expression weights. The",
  "video has a chapter per item.",
  "Reactions are talking-scoped: each is held for --talk seconds, then stopped.",
  "",
  "Options:",
  "  --avatar annie|caitlyn|<id>   Included Avatar (default annie)",
  `  --camera ${CAMERAS.join("|")}  chat camera preset (default portrait)`,
  "  --size 1920x1080              video size in pixels",
  "  --fps 30                      frames per second (1-60)",
  "  --lead 0.5 --tail 0.5         seconds of rest before and after each item",
  "  --talk 3                      seconds a talking-scoped Reaction is held, as chat",
  "                                holds it while the Anima speaks (at least until",
  "                                its timed effects end)",
  "  --max 20                      cut an item this many seconds after it starts",
  "  --sounds <dir>                sound root (repeatable); defaults to",
  "                                build-inputs/wow-comedy-sfx and content/included/sfx",
  "  --local-content <dir>         content root for library:local/... (e.g. content/local)",
  "  --software                    render with SwiftShader instead of the macOS GPU",
  "                                (other platforms always use SwiftShader; slower)",
  "  --crf 18                      x264 quality (lower is better; 0-51)",
  "",
  "Sounds come from <key>.meta.json sound_effect sidecars beside their audio",
  "file. A sound with no file plays silently and is reported. The run exits 1",
  "when an item could not be recorded.",
].join("\n");

const VALUE_OPTIONS = new Set([
  "--out",
  "--avatar",
  "--camera",
  "--size",
  "--fps",
  "--lead",
  "--tail",
  "--talk",
  "--max",
  "--sounds",
  "--local-content",
  "--crf",
]);
const FLAG_OPTIONS = new Set([
  "--gestures",
  "--reactions",
  "--software",
  "--help",
]);

function number(value, flag, { min, max, integer = false }) {
  const parsed = Number(value);
  if (
    value === "" ||
    !Number.isFinite(parsed) ||
    parsed < min ||
    parsed > max ||
    (integer && !Number.isInteger(parsed))
  )
    throw new EffectSourceError(
      `${flag} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}.`,
    );
  return parsed;
}

/** Parse argv into reel options; throws `EffectSourceError` on bad input. */
export function parseReelArgs(argv) {
  const sources = [];
  const values = {};
  const soundRoots = [];
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (FLAG_OPTIONS.has(arg)) flags.add(arg);
    else if (VALUE_OPTIONS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new EffectSourceError(`${arg} needs a value.`);
      if (arg === "--sounds") soundRoots.push(value);
      else values[arg] = value;
      index += 1;
    } else if (arg.startsWith("--"))
      throw new EffectSourceError(`Unknown option ${arg}.`);
    else sources.push(arg);
  }
  if (flags.has("--help")) return { help: true };
  const options = {
    help: false,
    gestures: flags.has("--gestures"),
    reactions: flags.has("--reactions"),
    sources,
    out: values["--out"] ?? null,
    avatar: DEFAULTS.avatar,
    camera: values["--camera"] ?? DEFAULTS.camera,
    size: DEFAULTS.size,
    fps: DEFAULTS.fps,
    lead: DEFAULTS.lead,
    tail: DEFAULTS.tail,
    talk: DEFAULTS.talk,
    maxSec: DEFAULTS.maxSec,
    crf: DEFAULTS.crf,
    soundRoots,
    localContent: values["--local-content"] ?? null,
    software: flags.has("--software"),
  };
  if (!options.gestures && !options.reactions && sources.length === 0)
    throw new EffectSourceError(
      "Choose --gestures, --reactions or name sources.",
    );
  if (!options.out) throw new EffectSourceError("--out is required.");
  if (!options.out.toLowerCase().endsWith(".mp4"))
    throw new EffectSourceError("--out must name an .mp4 file.");
  if (values["--avatar"] !== undefined) {
    const avatar = values["--avatar"];
    options.avatar = AVATAR_ALIASES[avatar.toLowerCase()] ?? avatar;
    if (!/^[A-Za-z0-9_-]+$/.test(options.avatar))
      throw new EffectSourceError(`Invalid --avatar ${avatar}.`);
  }
  if (!CAMERAS.includes(options.camera))
    throw new EffectSourceError(
      `Invalid --camera ${options.camera}; use ${CAMERAS.join(", ")}.`,
    );
  if (values["--size"] !== undefined) {
    const match = /^(\d{3,4})x(\d{3,4})$/.exec(values["--size"]);
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    // x264 with yuv420p needs even dimensions.
    if (!match || width % 2 || height % 2 || width > 3840 || height > 2160)
      throw new EffectSourceError(
        `Invalid --size ${values["--size"]}; use even WIDTHxHEIGHT up to 3840x2160.`,
      );
    options.size = { width, height };
  }
  if (values["--fps"] !== undefined)
    options.fps = number(values["--fps"], "--fps", {
      min: 1,
      max: 60,
      integer: true,
    });
  for (const [flag, key, max] of [
    ["--lead", "lead", 10],
    ["--tail", "tail", 10],
    ["--talk", "talk", 60],
    ["--max", "maxSec", 120],
  ])
    if (values[flag] !== undefined)
      options[key] = number(values[flag], flag, { min: 0, max });
  if (values["--crf"] !== undefined)
    options.crf = number(values["--crf"], "--crf", {
      min: 0,
      max: 51,
      integer: true,
    });
  return options;
}

/** A reel item from a resolved clip source. */
function reelItem({ clipPath, clip, dependencies, meta }, fallbackStem) {
  const kind = meta?.content_type === "reaction" ? "reaction" : "gesture";
  const stem = fallbackStem ?? path.basename(clipPath, ".json");
  const hint = meta?.placement_hint ?? {};
  return {
    kind,
    stem,
    name:
      typeof meta?.name === "string"
        ? meta.name
        : typeof clip?.name === "string"
          ? clip.name
          : stem,
    emotion: typeof hint.emotion === "string" ? hint.emotion : null,
    intensity: Number.isInteger(hint.intensity) ? hint.intensity : null,
    clip,
    dependencies,
  };
}

/** Reactions in emotion order, then intensity, then stem. */
export function compareReactions(a, b) {
  return (
    (a.emotion ?? "").localeCompare(b.emotion ?? "") ||
    (a.intensity ?? 0) - (b.intensity ?? 0) ||
    a.stem.localeCompare(b.stem)
  );
}

/**
 * The items to record: Included Gestures (by stem), then Included Reactions
 * (by emotion and intensity), then each named source in order.
 */
export async function listReelItems({
  gestures,
  reactions,
  sources,
  cwd,
  localContent,
}) {
  const items = [];
  const included = async (kind) => {
    const found = [];
    for (const { stem, descriptorPath } of await scanLibrary(
      INCLUDED_CONTENT_ROOT,
      kind,
    ))
      found.push(
        reelItem(await resolveClipSource(descriptorPath, { cwd }), stem),
      );
    return found;
  };
  if (gestures) items.push(...(await included("gesture")));
  if (reactions)
    items.push(...(await included("reaction")).sort(compareReactions));
  for (const spec of sources) {
    const source = await resolveClipSource(spec, { cwd, localContent });
    const stem = source.meta
      ? path.basename(path.dirname(source.clipPath))
      : null;
    items.push(reelItem(source, stem));
  }
  return items;
}

async function soundSidecars(folder, depth) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(
    () => [],
  );
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(folder, entry.name);
    if (entry.isFile() && entry.name.endsWith(".meta.json")) found.push(file);
    else if (entry.isDirectory() && depth > 1)
      found.push(...(await soundSidecars(file, depth - 1)));
  }
  return found;
}

/** The audio file a sound sidecar describes: its listed file or a sibling. */
async function soundFile(metaPath, meta) {
  const folder = path.dirname(metaPath);
  const listed = (Array.isArray(meta.files) ? meta.files : [])
    .map((file) => file?.path)
    .filter((file) => typeof file === "string")
    .map((file) => path.resolve(folder, file));
  const stem = path.basename(metaPath, ".meta.json");
  const siblings = SOUND_EXTENSIONS.map((ext) => path.join(folder, stem + ext));
  for (const file of [...listed, ...siblings]) {
    // A listed file must stay inside the sidecar's folder.
    if (path.relative(folder, file).startsWith("..")) continue;
    if ((await stat(file).catch(() => null))?.isFile()) return realpath(file);
  }
  return null;
}

/**
 * Sound effects under `roots`, by content id: each `<key>.meta.json` with
 * `content_type: "sound_effect"` beside (or listing) its audio file. An
 * earlier root wins when two define the same content id.
 */
export async function loadSoundCatalog(roots) {
  const catalog = new Map();
  for (const root of roots) {
    for (const metaPath of await soundSidecars(root, MAX_SOUND_DEPTH)) {
      let meta;
      try {
        meta = JSON.parse(await readFile(metaPath, "utf8"));
      } catch {
        continue;
      }
      const id = meta?.content_id ?? meta?.id;
      if (meta?.content_type !== "sound_effect" || typeof id !== "string")
        continue;
      if (catalog.has(id)) continue;
      const file = await soundFile(metaPath, meta);
      if (!file) continue;
      catalog.set(id, {
        file,
        name: typeof meta.name === "string" ? meta.name : id,
        duration: Number.isFinite(meta.duration_seconds)
          ? meta.duration_seconds
          : null,
      });
    }
  }
  return catalog;
}

/** Sound effect dependencies by alias: the cue a clip's sound event names. */
function soundAliases(dependencies) {
  return new Map(
    dependencies
      .filter(
        (dependency) =>
          dependency?.content_type === "sound_effect" &&
          typeof dependency.alias === "string" &&
          typeof dependency.ref === "string",
      )
      .map((dependency) => [dependency.alias, dependency.ref]),
  );
}

/** A content id's readable fallback name: `builtin:sound-effect:a_b` → `a_b`. */
const refKey = (ref) => ref.split(":").pop();

/**
 * The corner label for an item, and every sound cue it may play by cue id
 * (the content id an effect names, or a sound event's alias) with the
 * content id that plays it.
 */
export function describeItem(item, { index, total, media, catalog }) {
  const kindName = item.kind === "reaction" ? "Reaction" : "Gesture";
  const effects = [
    ...(media?.avatarEffects ?? []).map(({ alias, effect }) => ({
      alias,
      kind: EFFECT_KINDS.avatar_effect,
      name: effect.name,
      soundCueId: effect.soundRef ?? null,
    })),
    ...(media?.particleEffects ?? []).map(({ alias, particle }) => ({
      alias,
      kind: EFFECT_KINDS.particle_effect,
      name: particle.name,
      soundCueId: null,
    })),
    ...(media?.sceneEffects ?? []).map(({ alias, scene }) => ({
      alias,
      kind: EFFECT_KINDS.scene_effect,
      name: scene.name,
      soundCueId: null,
    })),
  ];
  const aliases = soundAliases(item.dependencies);
  const eventCues = [
    ...new Set(
      (Array.isArray(item.clip?.events) ? item.clip.events : [])
        .filter(
          (event) => event?.kind === "sfx" && typeof event.cueId === "string",
        )
        .map((event) => event.cueId),
    ),
  ];
  const cues = {};
  for (const cueId of [
    ...effects.map((effect) => effect.soundCueId).filter(Boolean),
    ...eventCues,
  ]) {
    const ref = aliases.get(cueId) ?? cueId;
    const sound = catalog.get(ref);
    cues[cueId] = {
      ref,
      name: sound ? sound.name : `${refKey(ref)} (no file)`,
      duration: sound?.duration ?? 0,
    };
  }
  const detail =
    item.kind === "reaction" && item.emotion
      ? `${item.emotion[0].toUpperCase()}${item.emotion.slice(1)}${
          item.intensity ? ` · intensity ${item.intensity}` : ""
        }`
      : null;
  return {
    label: {
      kicker: `${kindName} · ${index + 1} / ${total}`,
      title: item.name,
      detail,
      effects,
      sounds: eventCues,
    },
    cues,
  };
}

/** `mm:ss.s` for progress lines. */
export function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

/** An FFMETADATA chapter list: one chapter per recorded item, in ms. */
export function chapterMetadata(chapters) {
  const escape = (text) => text.replace(/[=;#\\\n]/g, (char) => `\\${char}`);
  return [
    ";FFMETADATA1",
    ...chapters.flatMap(({ start, end, title }) => [
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${Math.round(start * 1000)}`,
      `END=${Math.round(end * 1000)}`,
      `title=${escape(title)}`,
    ]),
    "",
  ].join("\n");
}

/**
 * The audio inputs and filter graph that mix `sounds` (`{ file, time,
 * volume }`, time in seconds) over `inputOffset` (the silent base track's
 * input index; sound inputs follow it). Each distinct file is one input,
 * split once per use.
 */
export function audioMixGraph(sounds, inputOffset) {
  const files = [...new Set(sounds.map((sound) => sound.file))];
  const filters = [];
  const uses = new Map(files.map((file) => [file, []]));
  sounds.forEach((sound, index) => uses.get(sound.file).push({ sound, index }));
  const mixed = [];
  files.forEach((file, fileIndex) => {
    const input = inputOffset + 1 + fileIndex;
    const list = uses.get(file);
    const labels = list.map(({ index }) => `s${index}`);
    if (list.length > 1)
      filters.push(
        `[${input}:a]asplit=${list.length}${labels.map((label) => `[${label}]`).join("")}`,
      );
    for (const { sound, index } of list) {
      const source = list.length > 1 ? `[s${index}]` : `[${input}:a]`;
      const delay = Math.max(0, Math.round(sound.time * 1000));
      filters.push(
        `${source}aformat=sample_rates=${AUDIO_RATE}:channel_layouts=stereo,adelay=${delay}:all=1,volume=${sound.volume}[e${index}]`,
      );
      mixed.push(`[e${index}]`);
    }
  });
  filters.push(
    `[${inputOffset}:a]${mixed.join("")}amix=inputs=${mixed.length + 1}:duration=first:normalize=0[aout]`,
  );
  return { files, graph: filters.join(";") };
}

/** Run ffmpeg to completion; rejects with its error output. */
async function runFfmpeg(args) {
  const child = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", ...args],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${errors.trim()}`);
}

async function checkFfmpeg() {
  const child = spawn("ffmpeg", ["-hide_banner", "-encoders"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  // A missing binary emits "error" (and no exit code) instead of "close".
  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", resolve);
  });
  if (code !== 0)
    throw new Error(
      "ffmpeg was not found on PATH; install it to record reels.",
    );
  if (!/\blibx264\b/.test(output))
    throw new Error(
      "This ffmpeg has no libx264 encoder; install an ffmpeg built with it.",
    );
}

/**
 * An H.264 encoder fed JPEG frames on stdin. `write` respects back-pressure;
 * `finish` closes the stream and waits for the file.
 */
function startEncoder({ file, fps, crf }) {
  const child = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-framerate",
      String(fps),
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      file,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const closed = once(child, "close").then(([code]) => {
    if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${errors.trim()}`);
  });
  closed.catch(() => undefined);
  return {
    async write(frame) {
      if (child.exitCode !== null) await closed;
      if (!child.stdin.write(frame))
        await Promise.race([once(child.stdin, "drain"), closed]);
    },
    async finish() {
      child.stdin.end();
      await closed;
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
}

/** The page's WebGL renderer name, to say whether frames use the GPU. */
function webglRenderer(page) {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return info
      ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
      : "unknown";
  });
}

/**
 * Record `items` to `out`. Returns per-item results (`{ stem, start, end,
 * warnings, failure }`); a failed item keeps any frames already recorded.
 */
export async function recordReel({
  items,
  out,
  avatar,
  camera,
  size,
  fps,
  lead,
  tail,
  talk,
  maxSec,
  crf,
  catalog,
  localContent,
  software,
  log = console.log,
}) {
  await checkFfmpeg();
  const work = await mkdtemp(path.join(tmpdir(), "animama-reel-"));
  const video = path.join(work, "video.mp4");
  const results = [];
  const sounds = [];
  let frames = 0;
  try {
    const medias = [];
    for (const item of items) {
      const media = item.dependencies.length
        ? await resolveDependencies(item.dependencies, { localContent })
        : null;
      for (const notice of media?.notices ?? [])
        log(`Warning ${item.stem}: ${notice}`);
      medias.push(media);
    }
    const extraRoots = [
      ...new Set(
        (
          await Promise.all(medias.map((media) => sourceRoots([], media)))
        ).flat(),
      ),
    ];
    const encoder = startEncoder({ file: video, fps, crf });
    try {
      await withRendererPage(
        {
          localContent,
          extraRoots,
          pageDir: "animation-reel",
          launch: {
            headless: true,
            // ANGLE's Metal GPU path on macOS; SwiftShader elsewhere.
            args:
              software || process.platform !== "darwin"
                ? SOFTWARE_ARGS
                : GPU_ARGS,
            viewport: size,
            deviceScaleFactor: 1,
          },
        },
        async ({ page, fsUrl, imageUrl }) => {
          log(`WebGL renderer: ${await webglRenderer(page)}`);
          const cdp = await page.context().newCDPSession(page);
          const capture = async () =>
            Buffer.from(
              (
                await cdp.send("Page.captureScreenshot", {
                  format: "jpeg",
                  quality: 95,
                  optimizeForSpeed: true,
                })
              ).data,
              "base64",
            );
          const started = performance.now();
          for (const [index, item] of items.entries()) {
            const media = medias[index];
            const { label, cues } = describeItem(item, {
              index,
              total: items.length,
              media,
              catalog,
            });
            const result = {
              stem: item.stem,
              title: `${label.kicker} · ${label.title}${label.detail ? ` (${label.detail})` : ""}`,
              start: frames / fps,
              end: frames / fps,
              warnings: [],
              failure: null,
            };
            results.push(result);
            const missing = Object.values(cues)
              .filter((cue) => !catalog.has(cue.ref))
              .map((cue) => cue.ref);
            if (missing.length)
              result.warnings.push(`no sound file for ${missing.join(", ")}`);
            try {
              await page.evaluate((request) => window.openReelItem(request), {
                avatar: {
                  id: avatar,
                  url: avatarFileUrl(fsUrl, avatar),
                },
                size,
                camera,
                clip: item.clip,
                clipMedia: await pageClipMedia(media, { fsUrl, imageUrl }),
                label,
                sounds: Object.fromEntries(
                  Object.entries(cues).map(([cueId, cue]) => [
                    cueId,
                    { name: cue.name, duration: cue.duration },
                  ]),
                ),
                lead,
                tail,
                talk,
                maxSec,
              });
              for (let frame = 0; ; frame += 1) {
                const state = await page.evaluate(
                  (time) => window.reelFrame(time),
                  frame / fps,
                );
                await encoder.write(await capture());
                for (const sound of state.sounds) {
                  const ref = cues[sound.cueId]?.ref ?? sound.cueId;
                  const file = catalog.get(ref)?.file;
                  // Sound times are seconds since the item opened.
                  if (file)
                    sounds.push({
                      file,
                      volume: sound.volume,
                      time: result.start + sound.time,
                    });
                }
                frames += 1;
                result.warnings = [
                  ...new Set([...result.warnings, ...state.warnings]),
                ];
                if (state.done) break;
                if (state.timedOut) {
                  result.warnings.push(
                    `still active ${maxSec} s after starting; cut`,
                  );
                  break;
                }
              }
            } catch (error) {
              result.failure =
                error instanceof Error ? error.message : String(error);
            } finally {
              await page.evaluate(() => window.closeReelItem());
            }
            result.end = frames / fps;
            const wall = (performance.now() - started) / 1000;
            log(
              `${result.failure ? "FAILED" : "Recorded"} [${index + 1}/${items.length}] ${item.stem} at ${formatTime(result.start)} (${(result.end - result.start).toFixed(1)} s; ${formatTime(wall)} elapsed)${result.failure ? `: ${result.failure}` : ""}`,
            );
            for (const warning of result.warnings) log(`  Warning: ${warning}`);
          }
        },
      );
      await encoder.finish();
    } catch (error) {
      encoder.kill();
      throw error;
    }
    if (frames === 0) throw new Error("No frames were recorded.");
    const duration = frames / fps;
    const chapters = path.join(work, "chapters.txt");
    await writeFile(
      chapters,
      chapterMetadata(
        results
          .filter((result) => result.end > result.start)
          .map(({ start, end, title }) => ({ start, end, title })),
      ),
    );
    const { files, graph } = audioMixGraph(sounds, 1);
    const metadataInput = 2 + files.length;
    await runFfmpeg([
      "-y",
      "-i",
      video,
      "-f",
      "lavfi",
      "-t",
      duration.toFixed(3),
      "-i",
      `anullsrc=r=${AUDIO_RATE}:cl=stereo`,
      ...files.flatMap((file) => ["-i", file]),
      "-i",
      chapters,
      "-filter_complex",
      graph,
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-map_chapters",
      String(metadataInput),
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      out,
    ]);
    return { results, duration, soundCount: sounds.length };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main(argv) {
  let options;
  try {
    options = parseReelArgs(argv);
  } catch (error) {
    console.log(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help || argv.length === 0) {
    console.log(USAGE);
    return options.help ? 0 : 2;
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  try {
    const localContent = options.localContent
      ? await realpath(path.resolve(cwd, options.localContent))
      : null;
    const avatarFile = path.join(
      INCLUDED_CONTENT_ROOT,
      "avatars",
      `${options.avatar}.vrm`,
    );
    if (!(await stat(avatarFile).catch(() => null)))
      throw new EffectSourceError(`No Included Avatar ${options.avatar}.`);
    const items = await listReelItems({ ...options, cwd, localContent });
    if (items.length === 0) throw new EffectSourceError("No items to record.");
    const soundRoots = options.soundRoots.length
      ? options.soundRoots.map((root) => path.resolve(cwd, root))
      : DEFAULT_SOUND_ROOTS;
    const catalog = await loadSoundCatalog(soundRoots);
    if (catalog.size === 0)
      console.log(
        `Warning: no sound files under ${soundRoots.join(", ")}; the reel is silent. Pass --sounds <dir>, such as the primary checkout's build-inputs/wow-comedy-sfx.`,
      );
    else console.log(`Sounds: ${catalog.size} from ${soundRoots.join(", ")}`);
    const out = path.resolve(cwd, options.out);
    console.log(
      `Recording ${items.length} item(s) on ${options.avatar} at ${options.size.width}x${options.size.height}, ${options.fps} fps.`,
    );
    const { results, duration, soundCount } = await recordReel({
      ...options,
      items,
      out,
      catalog,
      localContent,
    });
    const failed = results.filter((result) => result.failure);
    const warned = results.filter((result) => result.warnings.length);
    console.log(
      `Wrote ${out} (${formatTime(duration)}, ${results.length} item(s), ${soundCount} sound(s)).`,
    );
    if (warned.length) console.log(`${warned.length} item(s) had warnings.`);
    if (failed.length) {
      console.log(`${failed.length} item(s) could not be recorded.`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof EffectSourceError) {
      console.log(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exit(await main(process.argv.slice(2)));
}
