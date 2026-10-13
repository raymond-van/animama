import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";

import {
  diffImages,
  renderEffectThumbnails,
  writeThumbnailOnPage,
} from "./effect-render.mjs";
import {
  EffectSourceError,
  INCLUDED_CONTENT_ROOT,
} from "./effect-render-sources.mjs";
import {
  BODY_FRAMING_DROP,
  BODY_FRAMING_SCALE,
  STAGE_FRAMINGS,
  THUMBNAIL_DIR,
  WIDE_FRAMING_SCALE,
  parseThumbnailArgs,
  removeStaleThumbnails,
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
  assert.equal(posed.kind, "avatar");
  assert.equal(posed.template.thumbnail?.clip, "have-an-idea");

  const job = await thumbnailJob(posed);
  assert.equal(job.effect.stem, "idea_bulb_fingertip");
  assert.deepEqual(job.clip, await includedClip("have-an-idea"));
  assert.equal(job.time, posed.template.thumbnail.time);
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

  const [body] = selectTemplates(["badum_burst"]);
  assert.equal(body.template.thumbnail?.framing, "body");
  const bodyJob = await thumbnailJob(body);
  assert.equal(bodyJob.framingScale, BODY_FRAMING_SCALE);
  assert.equal(bodyJob.framingDrop, BODY_FRAMING_DROP);

  await assert.rejects(
    thumbnailJob({
      kind: "avatar",
      template: { ...posed.template, thumbnail: { clip: "no-such-gesture" } },
    }),
    (error) =>
      error instanceof EffectSourceError &&
      /No gesture matches "library:included\/no-such-gesture"/.test(
        error.message,
      ),
  );
});

test("resolves Particle and Scene templates by kind into their own folders", async () => {
  const [burst, love, star] = selectTemplates([
    "heart-burst",
    "scene-vfx-emotion-love",
    "star-burst",
  ]);
  assert.deepEqual(
    [burst.kind, love.kind, star.kind],
    ["particle", "scene", "particle"],
  );

  const burstJob = await thumbnailJob(burst);
  assert.equal(burstJob.effect.kind, "particle");
  assert.equal(
    burstJob.effect.contentId,
    "builtin:particle-effect:heart-burst",
  );
  assert.equal(burstJob.time, burst.template.thumbnail.time);
  assert.equal(burstJob.framingScale, 1);
  assert.equal(burstJob.framingDrop, 0);
  assert.equal(
    burstJob.outFile,
    path.join(THUMBNAIL_DIR, "particle/heart-burst.webp"),
  );

  const loveJob = await thumbnailJob(love);
  assert.equal(loveJob.effect.kind, "scene");
  assert.equal(
    loveJob.effect.contentId,
    "builtin:scene-effect:background:scene-vfx-emotion-love",
  );
  assert.equal(loveJob.time, undefined);
  assert.equal(
    loveJob.outFile,
    path.join(THUMBNAIL_DIR, "scene/scene-vfx-emotion-love.webp"),
  );

  // A `head` template is framed closer and aimed higher.
  assert.equal(star.template.thumbnail?.framing, "head");
  assert.deepEqual(
    (({ framingScale, framingDrop }) => ({ framingScale, framingDrop }))(
      await thumbnailJob(star),
    ),
    STAGE_FRAMINGS.head,
  );
});

test("selects templates by kind and disambiguates IDs with --kind", () => {
  assert.deepEqual(parseThumbnailArgs(["--kind", "scene", "dark"]), {
    kind: "scene",
    ids: ["dark"],
  });
  assert.throws(
    () => parseThumbnailArgs(["--kind", "sound"]),
    EffectSourceError,
  );
  assert.throws(() => parseThumbnailArgs(["--all"]), EffectSourceError);

  const kinds = new Set(selectTemplates([]).map(({ kind }) => kind));
  assert.deepEqual([...kinds], ["particle", "avatar", "scene"]);
  const scenes = selectTemplates([], "scene");
  assert.equal(scenes.length, 26);
  assert.ok(scenes.every(({ kind }) => kind === "scene"));
  assert.throws(
    () => selectTemplates(["heart-burst"], "scene"),
    /Unknown scene effect template heart-burst/,
  );
  assert.throws(
    () => selectTemplates(["no-such-template"]),
    /Unknown effect template no-such-template/,
  );
});

test("removes stale thumbnails only from the kind's own folder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "animama-effect-thumbs-"));
  try {
    const dirs = {
      avatar: root,
      particle: path.join(root, "particle"),
      scene: path.join(root, "scene"),
    };
    await mkdir(dirs.particle);
    await mkdir(dirs.scene);
    const files = [
      "eye_vv.webp",
      "retired.webp",
      "particle/heart-burst.webp",
      "particle/retired.webp",
      "scene/dark.webp",
    ];
    for (const name of files) await writeFile(path.join(root, name), "");

    assert.deepEqual(await removeStaleThumbnails("avatar", dirs), [
      "retired.webp",
    ]);
    assert.deepEqual(await removeStaleThumbnails("scene", dirs), []);
    assert.deepEqual(await removeStaleThumbnails("particle", dirs), [
      path.join("particle", "retired.webp"),
    ]);
    const left = [
      ...(await readdir(root)).filter((name) => name.endsWith(".webp")),
      ...(await readdir(dirs.particle)).map((name) => `particle/${name}`),
      ...(await readdir(dirs.scene)).map((name) => `scene/${name}`),
    ].sort();
    assert.deepEqual(left, [
      "eye_vv.webp",
      "particle/heart-burst.webp",
      "scene/dark.webp",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The page reports an Avatar with nothing applied and no warning: the
// thumbnail must still fail, as a review sheet does (no browser needed).
test("fails a thumbnail whose effect is not active", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-thumbs-"));
  try {
    const avatar = {
      id: "AvatarSample_A_1_New",
      applied: false,
      activeEffectIds: [],
      warnings: [],
      missingPoseRefs: [],
    };
    const page = {
      evaluate: async () => ({
        dataUrl: "data:image/webp;base64,",
        avatars: [avatar],
      }),
    };
    const result = await writeThumbnailOnPage(
      { page, fsUrl: (file) => file, imageUrl: async (file) => file },
      {
        effect: { stem: "inactive", imagePath: "inactive.png" },
        outFile: path.join(dir, "inactive.webp"),
        time: 1,
        size: 256,
      },
    );
    assert.deepEqual(result.failures, [
      "AvatarSample_A_1_New has no active effect",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

// Real review-stage batches: one Particle and one Scene template, each
// rendered twice, against Annie on the bare backdrop (Heart Burst before its
// first frame emits anything).
test("renders Particle and Scene thumbnails visibly and deterministically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-thumbs-"));
  try {
    const [burst, love] = await Promise.all(
      selectTemplates(["heart-burst", "scene-vfx-emotion-love"]).map(
        thumbnailJob,
      ),
    );
    const file = (name) => path.join(dir, `${name}.webp`);
    const results = await renderEffectThumbnails({
      jobs: [
        { ...burst, time: 0, outFile: file("bare") },
        { ...burst, outFile: file("burst-a") },
        { ...love, outFile: file("love-a") },
        { ...burst, outFile: file("burst-b") },
        { ...love, outFile: file("love-b") },
      ],
      size: 256,
      captureSize: 512,
    });
    for (const result of results.slice(1)) {
      assert.deepEqual(result.failures, [], result.outFile);
      assert.equal(result.avatars[0].activeEffectIds.length, 1);
    }
    const metadata = await sharp(file("burst-a")).metadata();
    assert.deepEqual(
      [metadata.format, metadata.width, metadata.height],
      ["webp", 256, 256],
    );

    // The effect is visible: the burst changes part of the frame and the
    // background covers almost all of it.
    const burstShare = (await diffImages(file("burst-a"), file("bare")))
      .differingShare;
    assert.ok(burstShare > 0.02, `burst differs in ${burstShare}`);
    const loveShare = (await diffImages(file("love-a"), file("bare")))
      .differingShare;
    assert.ok(loveShare > 0.6, `background differs in ${loveShare}`);

    // Deterministic: a second render of the same template is byte-identical.
    for (const name of ["burst", "love"])
      assert.ok(
        (await readFile(file(`${name}-a`))).equals(
          await readFile(file(`${name}-b`)),
        ),
        `${name} renders differ`,
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
