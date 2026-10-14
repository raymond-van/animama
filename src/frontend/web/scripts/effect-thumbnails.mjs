import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AVATAR_EFFECT_TEMPLATES } from "../src/lib/effects/effectTemplates.ts";
import {
  EffectRenderFailure,
  renderEffectThumbnails,
} from "./effect-render.mjs";
import {
  EffectSourceError,
  resolveClipSource,
  resolveEffectSource,
  resolveStandIn,
  thumbnailClip,
} from "./effect-render-sources.mjs";

/**
 * Regenerate the Avatar FX template thumbnails shown by the Effects template
 * picker:
 *
 *   pnpm -s effects:thumbnails [template-id...]
 *
 * Each template in `src/lib/effects/effectTemplates.ts` is rendered on Annie
 * with the `effects:render --thumbnail` renderer (portrait head framing;
 * `WIDE_FRAMING_SCALE` times wider for a `wide` template; `BODY_FRAMING_SCALE`
 * times wider and aimed `BODY_FRAMING_DROP` of the view lower for a `body`
 * template; live expression;
 * 1 s after applying unless the template names another time; posed by the
 * template's Included Gesture `clip`, sampled at that time, when it names
 * one, or with `fromEvent` played by that clip from its own events, the time
 * then being the clip's) into `src/assets/effect-templates/<id>.webp`. A full run also removes
 * thumbnails whose template no longer exists. Renders are deterministic, so
 * unchanged effects reproduce identical files.
 */
const webRoot = fileURLToPath(new URL("..", import.meta.url));
export const THUMBNAIL_DIR = path.join(webRoot, "src/assets/effect-templates");
/** Edge in pixels; cards show them at up to about 160 CSS px. */
export const THUMBNAIL_SIZE = 320;
/** Seconds after applying, so motion and fades have settled. */
export const THUMBNAIL_TIME = 1;
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

/** The templates a run renders: all of them, or the named IDs. */
export function selectTemplates(ids) {
  if (ids.length === 0) return [...AVATAR_EFFECT_TEMPLATES];
  return ids.map((id) => {
    const template = AVATAR_EFFECT_TEMPLATES.find((entry) => entry.id === id);
    if (!template)
      throw new EffectSourceError(`Unknown Avatar FX template ${id}.`);
    return template;
  });
}

/**
 * Resolve one template into a `renderEffectThumbnails` job: its Included
 * effect and, when `thumbnail.clip` names an Included Gesture by folder stem,
 * that Gesture's clip. With `thumbnail.fromEvent`, the job also carries the
 * clip media in which the effect stands in for the Gesture's dependency on
 * it, and a clip that plays only that effect. An unknown effect or Gesture,
 * or a `fromEvent` Gesture with no event that plays the effect, throws
 * `EffectSourceError`.
 */
export async function thumbnailJob(template) {
  const sourceOptions = { cwd: webRoot, localContent: null };
  const { framing, time, clip, fromEvent } = template.thumbnail ?? {};
  const effect = await resolveEffectSource(
    `library:included/${template.contentId}`,
    sourceOptions,
  );
  if (fromEvent && !clip)
    throw new EffectSourceError(
      `Template ${template.id}: fromEvent needs a thumbnail clip.`,
    );
  const clipSource = clip
    ? await resolveClipSource(`library:included/${clip}`, sourceOptions)
    : null;
  let clipMedia = null;
  if (fromEvent)
    ({ media: clipMedia } = await resolveStandIn(clipSource, {
      key: template.contentId,
      source: effect,
      only: true,
    }));
  return {
    effect,
    clip: clipMedia
      ? thumbnailClip(clipSource.clip, clipMedia.replaced)
      : (clipSource?.clip ?? null),
    clipMedia,
    outFile: path.join(THUMBNAIL_DIR, `${template.id}.webp`),
    framingScale: 1,
    ...FRAMINGS[framing],
    time,
  };
}

async function removeStaleThumbnails() {
  const known = new Set(AVATAR_EFFECT_TEMPLATES.map(({ id }) => `${id}.webp`));
  const removed = [];
  for (const name of await readdir(THUMBNAIL_DIR).catch(() => [])) {
    if (name.endsWith(".webp") && !known.has(name)) {
      await rm(path.join(THUMBNAIL_DIR, name));
      removed.push(name);
    }
  }
  return removed;
}

async function main(argv) {
  if (argv.includes("--help") || argv.some((arg) => arg.startsWith("--"))) {
    console.log("Usage: pnpm -s effects:thumbnails [template-id...]");
    return argv.includes("--help") ? 0 : 2;
  }
  try {
    const templates = selectTemplates(argv);
    const jobs = [];
    for (const template of templates) jobs.push(await thumbnailJob(template));
    await renderEffectThumbnails({
      jobs,
      time: THUMBNAIL_TIME,
      size: THUMBNAIL_SIZE,
      onResult: (result) => {
        console.log(
          result.failures.length
            ? `FAILED ${result.stem}: ${result.failures.join("; ")}`
            : `Wrote ${path.relative(webRoot, result.outFile)}`,
        );
        const missing = new Set(
          result.avatars?.flatMap((avatar) => avatar.missingPoseRefs) ?? [],
        );
        if (missing.size)
          console.log(
            `Warning: ${result.stem} clip poses not in the app catalog rendered as the base pose: ${[...missing].join(", ")}`,
          );
      },
    });
    if (argv.length === 0)
      for (const name of await removeStaleThumbnails())
        console.log(`Removed stale ${name}`);
    return 0;
  } catch (error) {
    if (error instanceof EffectSourceError) {
      console.log(error.message);
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
