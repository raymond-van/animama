import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EFFECT_TEMPLATE_KINDS,
  effectTemplates,
} from "../src/lib/effects/effectTemplates.ts";
import {
  EffectRenderFailure,
  renderEffectThumbnails,
} from "./effect-render.mjs";
import {
  EffectSourceError,
  resolveAnyEffectSource,
  resolveClipSource,
  resolveEffectSource,
} from "./effect-render-sources.mjs";

/**
 * Regenerate the effect template thumbnails shown by the Effects template
 * picker:
 *
 *   pnpm -s effects:thumbnails [--kind avatar|particle|scene] [template-id...]
 *
 * Without IDs every template is rendered (only `--kind`'s with `--kind`), and
 * the run then removes thumbnails whose template no longer exists from the
 * folders of the kinds it rendered, never another kind's. A template ID is
 * its Included folder stem; an ID that names templates of several kinds needs
 * `--kind` (today every stem is unique across kinds).
 *
 * Templates come from `src/lib/effects/effectTemplates.ts`. Each is rendered
 * on Annie into `src/assets/effect-templates/` (`<id>.webp` for Avatar FX,
 * `particle/<id>.webp` and `scene/<id>.webp` for the other kinds) at
 * `THUMBNAIL_SIZE` px, at the template's `thumbnail.time` or 1 s after
 * applying:
 *
 * - **Avatar FX** use the `effects:render --thumbnail` renderer (portrait head
 *   framing; `WIDE_FRAMING_SCALE` times wider for a `wide` template;
 *   `BODY_FRAMING_SCALE` times wider and aimed `BODY_FRAMING_DROP` of the view
 *   lower for a `body` template; live expression; posed by the template's
 *   Included Gesture `clip`, sampled at that time, when it names one).
 * - **Particle and Scene FX** use the review stage of `effects:render` sheets:
 *   the front view with the chat's Portrait framing (closer and aimed
 *   higher for a `head` template, `STAGE_FRAMINGS`), randomness seeded, Scene
 *   layers behind and in front of Annie over the mid-grey tile backdrop,
 *   captured at `STAGE_CAPTURE_SIZE` px and downscaled. Each renders in a
 *   freshly loaded page with CPU rasterization and its Scene layers frozen
 *   (`renderEffectThumbnails`), so it does not depend on what rendered before.
 *
 * Renders are deterministic, so unchanged effects reproduce identical files,
 * whether a template is rendered alone or in a full run.
 */
const webRoot = fileURLToPath(new URL("..", import.meta.url));
export const THUMBNAIL_DIR = path.join(webRoot, "src/assets/effect-templates");
/** Each kind's thumbnail folder; Avatar FX files stay at the top level. */
export const THUMBNAIL_DIRS = {
  avatar: THUMBNAIL_DIR,
  particle: path.join(THUMBNAIL_DIR, "particle"),
  scene: path.join(THUMBNAIL_DIR, "scene"),
};
/** Edge in pixels; cards show them at up to about 160 CSS px. */
export const THUMBNAIL_SIZE = 320;
/** Seconds after applying, so motion and fades have settled. */
export const THUMBNAIL_TIME = 1;
/**
 * Review-stage capture edge, downscaled to `THUMBNAIL_SIZE`: Scene layers are
 * sized in screen pixels, so this sets how large stickers and patterns look
 * beside Annie (about as in a desktop chat window).
 */
export const STAGE_CAPTURE_SIZE = 768;
/** Camera distance of a `wide` thumbnail, relative to the head framing. */
export const WIDE_FRAMING_SCALE = 2.2;
/** Camera distance of a `body` thumbnail, relative to the head framing. */
export const BODY_FRAMING_SCALE = 3.2;
/**
 * How far a `body` thumbnail's camera target sits below the head, as a share
 * of the view height: the frame runs from just above Annie's head to her
 * upper thighs with the torso centred, so art at the belly or hips is whole.
 */
export const BODY_FRAMING_DROP = 0.28;
const FRAMINGS = {
  wide: { framingScale: WIDE_FRAMING_SCALE },
  body: { framingScale: BODY_FRAMING_SCALE, framingDrop: BODY_FRAMING_DROP },
};
/**
 * Particle and Scene thumbnail framings other than the chat's Portrait
 * framing (head to waist): `head` stands the camera at 0.8 of its distance and
 * aims a quarter of the view higher, so the head is large with room above it.
 */
export const STAGE_FRAMINGS = {
  head: { framingScale: 0.8, framingDrop: -0.25 },
};

/** Every template of `kinds`, tagged with its kind. */
function templatesOf(kinds) {
  return kinds.flatMap((kind) =>
    effectTemplates(kind).map((template) => ({ kind, template })),
  );
}

/**
 * The templates a run renders, as `{ kind, template }`: all of them (of
 * `kind` when given), or the named IDs. An unknown ID, or one that names
 * templates of several kinds without `kind`, throws `EffectSourceError`.
 */
export function selectTemplates(ids, kind = null) {
  const candidates = templatesOf(kind ? [kind] : EFFECT_TEMPLATE_KINDS);
  if (ids.length === 0) return candidates;
  return ids.map((id) => {
    const matches = candidates.filter(({ template }) => template.id === id);
    if (matches.length === 0)
      throw new EffectSourceError(
        `Unknown ${kind ? `${kind} ` : ""}effect template ${id}.`,
      );
    if (matches.length > 1)
      throw new EffectSourceError(
        `Template ${id} exists for ${matches.map((match) => match.kind).join(" and ")}; name one with --kind.`,
      );
    return matches[0];
  });
}

/** The thumbnail file of a `kind` template. */
export function thumbnailFile(kind, id) {
  return path.join(THUMBNAIL_DIRS[kind], `${id}.webp`);
}

/**
 * Resolve one selected template into a `renderEffectThumbnails` job. An
 * Avatar template resolves its Included effect and, when `thumbnail.clip`
 * names an Included Gesture by folder stem, that Gesture's clip. A Particle
 * or Scene template resolves its Included effect by kind and stem, with its
 * `thumbnail.framing` as camera settings. An unknown effect or Gesture throws
 * `EffectSourceError`.
 */
export async function thumbnailJob({ kind, template }) {
  const sourceOptions = { cwd: webRoot, localContent: null };
  const outFile = thumbnailFile(kind, template.id);
  if (kind !== "avatar") {
    const { framing, time } = template.thumbnail ?? {};
    return {
      effect: await resolveAnyEffectSource(
        `library:${kind}-effect/included/${template.id}`,
        sourceOptions,
      ),
      outFile,
      framingScale: 1,
      framingDrop: 0,
      ...STAGE_FRAMINGS[framing],
      time,
    };
  }
  const { framing, time, clip } = template.thumbnail ?? {};
  return {
    effect: await resolveEffectSource(
      `library:included/${template.contentId}`,
      sourceOptions,
    ),
    clip: clip
      ? (await resolveClipSource(`library:included/${clip}`, sourceOptions))
          .clip
      : null,
    outFile,
    framingScale: 1,
    ...FRAMINGS[framing],
    time,
  };
}

/**
 * Remove `kind`'s thumbnails that no template names, from `dirs[kind]`
 * (default `THUMBNAIL_DIRS`). Only `.webp` files directly in that folder are
 * read, so the Avatar run leaves the `particle/` and `scene/` folders alone.
 * Returns the removed files relative to `dirs.avatar`.
 */
export async function removeStaleThumbnails(kind, dirs = THUMBNAIL_DIRS) {
  const known = new Set(effectTemplates(kind).map(({ id }) => `${id}.webp`));
  const removed = [];
  for (const entry of await readdir(dirs[kind], {
    withFileTypes: true,
  }).catch(() => [])) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".webp") &&
      !known.has(entry.name)
    ) {
      const file = path.join(dirs[kind], entry.name);
      await rm(file);
      removed.push(path.relative(dirs.avatar, file));
    }
  }
  return removed;
}

const USAGE =
  "Usage: pnpm -s effects:thumbnails [--kind avatar|particle|scene] [template-id...]";

/** Split argv into `--kind` and template IDs; anything else is an error. */
export function parseThumbnailArgs(argv) {
  const ids = [];
  let kind = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--kind") {
      kind = argv[index + 1] ?? "";
      index += 1;
      if (!EFFECT_TEMPLATE_KINDS.includes(kind))
        throw new EffectSourceError(
          `--kind must be one of ${EFFECT_TEMPLATE_KINDS.join(", ")}.`,
        );
    } else if (arg.startsWith("--")) {
      throw new EffectSourceError(`Unknown option ${arg}.`);
    } else ids.push(arg);
  }
  return { kind, ids };
}

async function main(argv) {
  if (argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const { kind, ids } = parseThumbnailArgs(argv);
    const selected = selectTemplates(ids, kind);
    const jobs = [];
    for (const entry of selected) jobs.push(await thumbnailJob(entry));
    await renderEffectThumbnails({
      jobs,
      time: THUMBNAIL_TIME,
      size: THUMBNAIL_SIZE,
      captureSize: STAGE_CAPTURE_SIZE,
      onResult: (result) => {
        console.log(
          result.failures.length
            ? `FAILED ${result.stem}: ${result.failures.join("; ")}`
            : `Wrote ${path.relative(webRoot, result.outFile)}`,
        );
        const missing = new Set(
          result.avatars?.flatMap((avatar) => avatar.missingPoseRefs ?? []) ??
            [],
        );
        if (missing.size)
          console.log(
            `Warning: ${result.stem} clip poses not in the app catalog rendered as the base pose: ${[...missing].join(", ")}`,
          );
      },
    });
    if (ids.length === 0)
      for (const rendered of kind ? [kind] : EFFECT_TEMPLATE_KINDS)
        for (const name of await removeStaleThumbnails(rendered))
          console.log(`Removed stale ${name}`);
    return 0;
  } catch (error) {
    if (error instanceof EffectSourceError) {
      console.log(`${error.message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof EffectRenderFailure) {
      const failed = error.results.filter((result) => result.failures.length);
      console.log(`${failed.length} of ${error.results.length} failed.`);
      return 1;
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
