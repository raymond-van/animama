import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  EffectRenderFailure,
  diffImages,
  renderEffectThumbnails,
} from "./effect-render.mjs";
import {
  EffectSourceError,
  INCLUDED_CONTENT_ROOT,
} from "./effect-render-sources.mjs";
import {
  BODY_FRAMING_DROP,
  BODY_FRAMING_SCALE,
  THUMBNAIL_DIR,
  WIDE_FRAMING_SCALE,
  selectTemplates,
  thumbnailJob,
} from "./effect-thumbnails.mjs";

const includedClip = async (slug) =>
  JSON.parse(
    await readFile(
      path.join(INCLUDED_CONTENT_ROOT, "gestures", slug, `${slug}.json`),
      "utf8",
    ),
  );

test("resolves a template's Included Gesture clip into its thumbnail job", async () => {
  const [posed, plain] = selectTemplates(["idea_bulb_fingertip", "eye_vv"]);
  assert.equal(posed.thumbnail?.clip, "have-an-idea");

  const job = await thumbnailJob(posed);
  assert.equal(job.effect.stem, "idea_bulb_fingertip");
  assert.deepEqual(job.clip, await includedClip("have-an-idea"));
  assert.equal(job.time, posed.thumbnail.time);
  assert.equal(job.framingScale, WIDE_FRAMING_SCALE);
  assert.equal(job.framingDrop, undefined);
  assert.equal(
    job.outFile,
    path.join(THUMBNAIL_DIR, "idea_bulb_fingertip.webp"),
  );

  const rest = await thumbnailJob(plain);
  assert.equal(rest.clip, null);
  assert.equal(rest.time, undefined);
  assert.equal(rest.framingScale, 1);
  assert.equal(rest.framingDrop, undefined);

  const [body] = selectTemplates(["impact_burst"]);
  assert.equal(body.thumbnail?.framing, "body");
  const bodyJob = await thumbnailJob(body);
  assert.equal(bodyJob.framingScale, BODY_FRAMING_SCALE);
  assert.equal(bodyJob.framingDrop, BODY_FRAMING_DROP);

  await assert.rejects(
    thumbnailJob({ ...posed, thumbnail: { clip: "no-such-gesture" } }),
    (error) =>
      error instanceof EffectSourceError &&
      /No gesture matches "library:included\/no-such-gesture"/.test(
        error.message,
      ),
  );
});

// A real WebGL batch: the clip reaches the renderer and poses Annie, so the
// same effect and moment render differently with and without it.
test("poses Annie with the job's clip in a thumbnail batch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-thumbs-"));
  try {
    const [template] = selectTemplates(["idea_bulb_fingertip"]);
    const job = await thumbnailJob(template);
    const posedFile = path.join(dir, "posed.webp");
    const restFile = path.join(dir, "rest.webp");
    const results = await renderEffectThumbnails({
      jobs: [
        { ...job, outFile: posedFile },
        { ...job, clip: null, outFile: restFile },
      ],
      size: 256,
    });

    for (const result of results) {
      assert.deepEqual(result.failures, [], result.outFile);
      assert.deepEqual(result.avatars[0].missingPoseRefs, []);
      assert.equal(result.avatars[0].activeEffectIds.length, 1);
    }
    const difference = await diffImages(posedFile, restFile);
    assert.ok(
      difference.differingShare > 0.05,
      `posed and rest thumbnails differ in only ${difference.differingPixels} pixels`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Mind Blown Burst's template plays it from the Mind Blown Gesture's event
// (1.01 s), so its time is the clip's: before the event nothing shows.
test("plays a fromEvent template's effect from its Gesture's event", async () => {
  const [template] = selectTemplates(["mind_blown_burst"]);
  assert.equal(template.thumbnail?.fromEvent, true);
  const job = await thumbnailJob(template);
  assert.deepEqual(job.clipMedia.replaced, ["mind_blown_burst"]);
  assert.deepEqual(
    job.clipMedia.avatarEffects.map(({ alias, effect }) => [
      alias,
      effect.stem,
    ]),
    [["mind_blown_burst", "mind_blown_burst"]],
  );
  assert.ok(
    job.clip.events.every(
      (event) => event.kind === "sfx" || event.effectId === "mind_blown_burst",
    ),
  );

  for (const thumbnail of [
    { fromEvent: true },
    { fromEvent: true, clip: "fist-bump" },
  ])
    await assert.rejects(
      thumbnailJob({ ...template, thumbnail }),
      EffectSourceError,
      JSON.stringify(thumbnail),
    );

  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-thumbs-"));
  try {
    const [played] = await renderEffectThumbnails({
      jobs: [{ ...job, outFile: path.join(dir, "played.webp") }],
      size: 256,
    });
    assert.deepEqual(played.failures, []);
    assert.deepEqual(played.avatars[0].activeEffectIds, ["mind_blown_burst"]);

    await assert.rejects(
      renderEffectThumbnails({
        jobs: [{ ...job, time: 0.5, outFile: path.join(dir, "early.webp") }],
        size: 256,
      }),
      (error) =>
        error instanceof EffectRenderFailure &&
        /mind_blown_burst is not active/.test(error.results[0].failures[0]),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
