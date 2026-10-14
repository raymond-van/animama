import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  EffectRenderFailure,
  diffImages,
  renderEffectSheets,
} from "./effect-render.mjs";
import {
  EffectSourceError,
  INCLUDED_CONTENT_ROOT,
  resolveAnyEffectSource,
  resolveClipSource,
  resolveDependencies,
  resolveEffectSource,
} from "./effect-render-sources.mjs";

// Real WebGL renders of Included effects on both Included Avatars, plus an
// effect whose image cannot decode: its controller warning fails the run.
test("renders effect sheets and fails on a controller warning", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-render-"));
  try {
    const broken = path.join(dir, "broken");
    await mkdir(broken);
    await writeFile(path.join(broken, "broken.png"), "not an image");
    await writeFile(
      path.join(broken, "broken.json"),
      JSON.stringify({
        content_type: "avatar_effect",
        name: "Broken",
        definition: {
          schema: "animama/avatar-effect/2",
          region: "full_face",
          attachment: { kind: "face_surface", part: "face_skin", area: "full" },
          art: { image: "broken.png" },
        },
      }),
    );
    const effects = await Promise.all(
      ["library:eye", "library:texture_sick_1", broken].map((spec) =>
        resolveEffectSource(spec),
      ),
    );
    const tile = { width: 96, height: 120 };
    const error = await renderEffectSheets({
      effects,
      outFileFor: (effect) => path.join(dir, `${effect.stem}.png`),
      times: [0.1, 0.5],
      tile,
    }).then(
      () => null,
      (rejection) => rejection,
    );

    assert.ok(error instanceof EffectRenderFailure, String(error));
    const [hover, texture, failed] = error.results;
    for (const result of [hover, texture]) {
      assert.deepEqual(result.failures, [], result.stem);
      assert.deepEqual(
        result.avatars.map((avatar) => avatar.activeEffectIds.length),
        [1, 1],
      );
      const png = await readFile(result.outFile);
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      // 64 px labels + 2 Avatars × 3 views wide; 28 px header + 2 rows tall.
      assert.equal(png.readUInt32BE(16), 64 + 6 * tile.width);
      assert.equal(png.readUInt32BE(20), 28 + 2 * tile.height);
    }
    assert.equal(failed.stem, "broken");
    assert.match(failed.failures.join("\n"), /warning: Failed to load VFX/);
    assert.match(error.message, /^broken: /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Body, sticker and silhouette effects applied together on both Avatars:
// each attachment is active and none leaves a warning.
test("renders body, sticker and silhouette attachments together", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-attach-"));
  try {
    const { default: sharp } = await import("sharp");
    const attachments = {
      heart: { kind: "body", bone: "chest", offset: { z: 0.15 }, size: 0.1 },
      doki: { kind: "sticker", around: "head", offset: { x: 0.15 } },
      shade: { kind: "silhouette", patternScale: 0.5, scroll: { x: 0.2 } },
    };
    const sources = [];
    for (const [stem, attachment] of Object.entries(attachments)) {
      const folder = path.join(dir, stem);
      await mkdir(folder);
      await sharp({
        create: {
          width: 32,
          height: 32,
          channels: 4,
          background: { r: 255, g: 40, b: 120, alpha: 0.8 },
        },
      })
        .png()
        .toFile(path.join(folder, "art.png"));
      await writeFile(
        path.join(folder, `${stem}.json`),
        JSON.stringify({
          content_type: "avatar_effect",
          name: stem,
          definition: {
            schema: "animama/avatar-effect/2",
            region: attachment.kind,
            attachment,
            art: { image: "art.png" },
          },
        }),
      );
      sources.push(await resolveEffectSource(folder));
    }
    const tile = { width: 96, height: 120 };
    const [result] = await renderEffectSheets({
      effects: sources,
      together: true,
      outFileFor: (effect) => path.join(dir, `${effect.stem}.png`),
      times: [0.1],
      tile,
    });

    assert.equal(result.stem, "heart+doki+shade");
    assert.deepEqual(result.failures, []);
    for (const avatar of result.avatars) {
      assert.deepEqual(avatar.activeEffectIds.sort(), [
        "doki",
        "heart",
        "shade",
      ]);
    }
    const png = await readFile(result.outFile);
    assert.equal(png.readUInt32BE(16), 64 + 6 * tile.width);
    assert.equal(png.readUInt32BE(20), 28 + tile.height);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Avatar, Particle and Scene Effects applied together, and a Reaction whose
// events start all three, render as the chat draws them; a Reaction with one
// Particle Effect renders the same on every run, however long its effects take
// to load (two Particle Effects started in one frame can differ by a few
// pixels between runs; see avatar-vfx.md).
test("renders every effect kind together and a Reaction's effects", async () => {
  const dir = await mkdtemp(
    path.join(tmpdir(), "animama-effect-render-kinds-"),
  );
  try {
    const effects = await Promise.all(
      [
        "library:star3",
        "library:particle-effect/confetti",
        "library:scene-effect/scene-vfx-emotion-joy",
      ].map((spec) => resolveAnyEffectSource(spec)),
    );
    const tile = { width: 96, height: 120 };
    const [together] = await renderEffectSheets({
      effects,
      together: true,
      outFileFor: () => path.join(dir, "together.png"),
      times: [0.5],
      views: ["front"],
      tile,
    });
    assert.equal(together.stem, "star3+confetti+scene-vfx-emotion-joy");
    assert.deepEqual(together.failures, []);
    for (const avatar of together.avatars)
      assert.deepEqual(avatar.activeEffectIds.sort(), [
        "builtin:avatar-effect:star3",
        "builtin:scene-effect:background:scene-vfx-emotion-joy",
        "review:builtin:particle-effect:confetti",
      ]);

    const reaction = await resolveClipSource("library:reaction/sadness-3");
    const clipMedia = await resolveDependencies(reaction.dependencies);
    const renderReaction = async (file) => {
      const [played] = await renderEffectSheets({
        effects: [],
        clip: reaction.clip,
        clipMedia,
        clipStem: "sadness-3",
        outFileFor: () => path.join(dir, file),
        times: [0.5],
        views: ["front"],
        tile,
      });
      return played;
    };
    const played = await renderReaction("sadness-3.png");
    assert.equal(played.stem, "sadness-3");
    assert.deepEqual(played.failures, []);
    for (const avatar of played.avatars)
      for (const id of [
        "texture_black_1",
        "streaming_tears",
        "rain-cloud",
        "scene-vfx-emotion-sadness",
      ])
        assert.ok(
          avatar.activeEffectIds.includes(id),
          `${avatar.id}: ${avatar.activeEffectIds.join(", ")}`,
        );
    const png = await readFile(path.join(dir, "sadness-3.png"));
    assert.equal(png.readUInt32BE(16), 64 + 2 * tile.width);
    // One Particle Effect: a Reaction that starts two in one frame can differ
    // by a few pixels between runs.
    await renderReaction("sadness-3-again.png");
    assert.ok(
      png.equals(await readFile(path.join(dir, "sadness-3-again.png"))),
      "a second render of the Reaction differs",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A copy of Impact Burst standing in for Fist Bump's dependency plays only
// from the Gesture's event (0.6 s), with the event's override: the sheet
// matches the Gesture's own render, where applying the copy at 0 would also
// show it at its default placement.
test("plays a source standing in for a Gesture dependency from its event", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-stand-in-"));
  try {
    const draftFolder = path.join(dir, "impact_burst_draft");
    await cp(
      path.join(INCLUDED_CONTENT_ROOT, "vfx/avatar/impact_burst"),
      draftFolder,
      { recursive: true },
    );
    const draft = await resolveAnyEffectSource(draftFolder);
    const gesture = await resolveClipSource("library:fist-bump");
    const standInMedia = await resolveDependencies(gesture.dependencies, {
      replacement: { key: "impact_burst", source: draft },
    });
    const render = (options) =>
      renderEffectSheets({
        clip: gesture.clip,
        views: ["front"],
        tile: { width: 96, height: 120 },
        ...options,
      });

    const [standIn] = await render({
      effects: [draft],
      clipMedia: standInMedia,
      times: [0.3, 0.8],
      outFileFor: () => path.join(dir, "stand-in.png"),
    });
    assert.deepEqual(standIn.failures, []);
    for (const avatar of standIn.avatars)
      assert.deepEqual(avatar.activeEffectIds, ["impact_burst"], avatar.id);

    await render({
      effects: [],
      clipMedia: await resolveDependencies(gesture.dependencies),
      times: [0.3, 0.8],
      outFileFor: () => path.join(dir, "own.png"),
    });
    const difference = await diffImages(
      path.join(dir, "stand-in.png"),
      path.join(dir, "own.png"),
    );
    // Two renders of the playing Gesture alone can already differ by a hair
    // pixel (Annie, before the event); the copy also applied at 0 adds 128.
    assert.ok(
      difference.differingPixels <= 2,
      `stand-in and own renders differ in ${difference.differingPixels} pixels`,
    );

    // Rendered only before its event, the stand-in never shows.
    await assert.rejects(
      render({
        effects: [draft],
        clipMedia: standInMedia,
        times: [0.3],
        outFileFor: () => path.join(dir, "early.png"),
      }),
      (error) =>
        error instanceof EffectRenderFailure &&
        /impact_burst is not active at any rendered time/.test(error.message),
    );
    await assert.rejects(
      render({
        effects: [draft, draft],
        together: true,
        clipMedia: standInMedia,
        times: [0.8],
        outFileFor: () => path.join(dir, "together.png"),
      }),
      EffectSourceError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A Particle Effect of one large, opaque, normally blended square of grey
 * `level` in front of the head, from hearts-v1 with `toneMapped` (when given)
 * on its material.
 */
async function greySquareEffect(dir, stem, level, toneMapped) {
  const { default: sharp } = await import("sharp");
  const folder = path.join(dir, stem);
  await cp(
    path.join(INCLUDED_CONTENT_ROOT, "vfx/particle/quark/hearts-v1"),
    folder,
    { recursive: true },
  );
  await writeFile(
    path.join(folder, "textures/heart.png"),
    await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: level, g: level, b: level, alpha: 1 },
      },
    })
      .png()
      .toBuffer(),
  );
  const manifestPath = path.join(folder, "particle.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const [material] = manifest.materials;
  material.blending = 1;
  if (toneMapped !== undefined) material.toneMapped = toneMapped;
  const constant = (value) => ({ type: "ConstantValue", value });
  Object.assign(manifest.object.children[0].ps, {
    shape: { type: "point" },
    startLife: constant(10),
    startSpeed: constant(0),
    startSize: constant(3),
    startColor: {
      type: "ConstantColor",
      color: { r: 1, g: 1, b: 1, a: 1 },
    },
    emissionOverTime: constant(0),
    emissionBursts: [
      { time: 0, count: constant(1), probability: 1, interval: 0.01, cycle: 1 },
    ],
    behaviors: [],
  });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const descriptorPath = path.join(folder, "hearts-v1.json");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  await rm(descriptorPath);
  const slot = descriptor.runtime_defaults.slots.particle_vfx;
  slot.transform.offset = { x: 0, y: 0, z: 0 };
  slot.transform.rotation = { x: 0, y: 0, z: 0 };
  slot.transform.depth_offset = 0.3;
  delete descriptor.content_id;
  delete descriptor.version;
  await writeFile(
    path.join(folder, `${stem}.json`),
    JSON.stringify(descriptor),
  );
  return folder;
}

// The chat tone-maps particles (ACES Filmic) unless a material opts out with
// `toneMapped: false`; then the art's stored values reach the canvas as
// authored, with no extra sRGB step.
test("renders particle art without tone mapping when its material opts out", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-tone-"));
  try {
    const { default: sharp } = await import("sharp");
    const squares = [
      ["white_default", 255, undefined],
      ["white_untoned", 255, false],
      ["grey_untoned", 128, false],
    ];
    const effects = await Promise.all(
      squares.map(async ([stem, level, toneMapped]) =>
        resolveAnyEffectSource(
          await greySquareEffect(dir, stem, level, toneMapped),
        ),
      ),
    );
    const tile = { width: 96, height: 120 };
    const results = await renderEffectSheets({
      effects,
      outFileFor: (effect) => path.join(dir, `${effect.stem}.png`),
      times: [0.5],
      views: ["front"],
      tile,
    });
    // The centre pixel of each Avatar's front tile, which the square covers.
    const centres = await Promise.all(
      results.map(async (result) => {
        const { data, info } = await sharp(result.outFile)
          .raw()
          .toBuffer({ resolveWithObject: true });
        return [0, 1].map((avatarIndex) => {
          const x = 64 + avatarIndex * tile.width + tile.width / 2;
          const y = 28 + tile.height / 2;
          const offset = (y * info.width + x) * info.channels;
          return [...data.subarray(offset, offset + 3)];
        });
      }),
    );
    const [whiteDefault, whiteUntoned, greyUntoned] = centres;
    for (const [r, g, b] of whiteDefault)
      assert.ok(r > 170 && r < 215 && r === g && g === b, `${[r, g, b]}`);
    for (const pixel of whiteUntoned) assert.deepEqual(pixel, [255, 255, 255]);
    for (const pixel of greyUntoned)
      for (const channel of pixel)
        assert.ok(Math.abs(channel - 128) <= 2, `${pixel}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
