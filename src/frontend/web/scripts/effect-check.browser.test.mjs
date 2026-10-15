import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";

import { checkEffects } from "./effect-check.mjs";
import {
  INCLUDED_CONTENT_ROOT,
  resolveAnyEffectSource,
  resolveEffectSource,
} from "./effect-render-sources.mjs";

/** A 128 px PNG: a disc of `alpha`, or nothing visible at all. */
async function disc(alpha, rgb = [230, 40, 60]) {
  const size = 128;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1)
      if ((x - 64) ** 2 + (y - 64) ** 2 <= 56 ** 2)
        data.set([...rgb, alpha], (y * size + x) * 4);
  return sharp(data, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer();
}

async function writeEffect(dir, stem, { definition, alpha = 255, rgb }) {
  const folder = path.join(dir, stem);
  await mkdir(folder);
  await writeFile(path.join(folder, `${stem}.png`), await disc(alpha, rgb));
  await writeFile(
    path.join(folder, `${stem}.json`),
    JSON.stringify({
      content_type: "avatar_effect",
      name: stem,
      definition: {
        schema: "animama/avatar-effect/2",
        art: { image: `${stem}.png` },
        ...definition,
      },
    }),
  );
  return folder;
}

const floating = {
  region: "emote",
  attachment: { kind: "face_landmark", landmark: "top", position: "middle" },
};

// Real WebGL on both Included Avatars: a visible effect passes; art too faint
// to see and an invalid definition fail with a named reason.
test("effects check passes visible art and fails invisible or invalid effects", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-check-"));
  try {
    const sources = [
      await writeEffect(dir, "visible", { definition: floating }),
      await writeEffect(dir, "faint", { definition: floating, alpha: 5 }),
      // Eye effects close and clean the eyes by default; that alone must not
      // count as visible art.
      await writeEffect(dir, "faint_eye", {
        definition: {
          region: "eyes",
          attachment: {
            kind: "face_landmark",
            landmark: "eyes",
            side: "right",
            mirror: true,
          },
        },
        alpha: 5,
      }),
      // Faint art beside the head, where no Avatar is behind it.
      await writeEffect(dir, "faint_sticker", {
        definition: {
          region: "sticker",
          attachment: { kind: "sticker", around: "head", offset: { x: 0.15 } },
        },
        alpha: 5,
      }),
      // A tinted silhouette with white art is coloured by its tint.
      await writeEffect(dir, "white_tint", {
        definition: {
          region: "silhouette",
          attachment: { kind: "silhouette", fill: "tint" },
          appearance: { tint: "#ff4060", opacity: 0.6 },
        },
        rgb: [255, 255, 255],
      }),
      await writeEffect(dir, "invalid", {
        definition: {
          ...floating,
          appearance: { opacity: 3 },
        },
      }),
    ];
    const effects = await Promise.all(
      sources.map((source) => resolveEffectSource(source)),
    );
    const [visible, faint, faintEye, faintSticker, whiteTint, invalid] =
      await checkEffects({
        effects,
        times: [0.5],
        views: ["front"],
        tile: { width: 96, height: 120 },
      });
    const levels = (result) => result.lines.map((line) => line.level);

    assert.ok(!levels(visible).includes("FAIL"), JSON.stringify(visible.lines));
    assert.equal(
      visible.lines.filter((line) =>
        /visible in 1 of 1 frames/.test(line.message),
      ).length,
      2,
    );

    assert.ok(
      faint.lines.some(
        (line) => line.level === "FAIL" && /no visible art/.test(line.message),
      ),
      JSON.stringify(faint.lines),
    );

    assert.equal(
      faintEye.lines.filter(
        (line) => line.level === "FAIL" && /no visible art/.test(line.message),
      ).length,
      2,
      JSON.stringify(faintEye.lines),
    );

    assert.equal(
      faintSticker.lines.filter(
        (line) => line.level === "FAIL" && /no visible art/.test(line.message),
      ).length,
      2,
      JSON.stringify(faintSticker.lines),
    );
    assert.ok(
      !levels(whiteTint).includes("FAIL"),
      JSON.stringify(whiteTint.lines),
    );

    // The art passes its budget; the definition does not parse.
    assert.deepEqual(levels(invalid), ["PASS", "FAIL"]);
    assert.match(invalid.lines[0].message, /^art .*: within the .* budget$/);
    assert.match(invalid.lines[1].message, /^definition: .*opacity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A copy of an Included Particle or Scene Effect folder, adjusted by `edit`. */
async function copyIncluded(dir, from, stem, edit = async () => {}) {
  const folder = path.join(dir, stem);
  await cp(path.join(INCLUDED_CONTENT_ROOT, from), folder, { recursive: true });
  const original = path.join(folder, `${path.basename(from)}.json`);
  const descriptor = JSON.parse(await readFile(original, "utf8"));
  await rm(original);
  await edit(descriptor, folder);
  await writeFile(
    path.join(folder, `${stem}.json`),
    JSON.stringify(descriptor),
  );
  return folder;
}

// Particle and Scene Effects: art budgets, particle counts and visibility,
// with Scene layers captured from the page as the chat draws them.
test("effects check reviews Particle and Scene Effect folders", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-check-kinds-"));
  try {
    const sources = [
      await copyIncluded(dir, "vfx/particle/quark/hearts-v1", "stream"),
      // Declares fewer particles than its emitters produce.
      await copyIncluded(
        dir,
        "vfx/particle/quark/hearts-v1",
        "crowded",
        async (descriptor) => {
          descriptor.runtime_defaults.slots.particle_vfx.max_particles = 4;
        },
      ),
      // A fully transparent texture: particles play but nothing shows.
      await copyIncluded(
        dir,
        "vfx/particle/quark/hearts-v1",
        "clear",
        async (descriptor, folder) => {
          const transparent = await disc(0);
          for (const file of descriptor.files.filter(
            (file) => file.role === "texture",
          )) {
            await writeFile(path.join(folder, file.path), transparent);
          }
        },
      ),
      await copyIncluded(
        dir,
        "vfx/scene/scene-vfx-emotion-joy",
        "joy_background",
      ),
      // The manifest draws a texture the descriptor does not list.
      await copyIncluded(
        dir,
        "vfx/particle/quark/hearts-v1",
        "unlisted",
        async (descriptor) => {
          descriptor.files = descriptor.files.filter(
            (file) => file.role !== "texture",
          );
        },
      ),
      // Lists an image that no item shows.
      await copyIncluded(
        dir,
        "vfx/scene/scene-vfx-emotion-joy",
        "joy_extra",
        async (descriptor, folder) => {
          await writeFile(path.join(folder, "extra.png"), await disc(255));
          descriptor.files.push({ path: "extra.png", role: "image" });
        },
      ),
    ];
    const effects = await Promise.all(
      sources.map((source) => resolveAnyEffectSource(source)),
    );
    const [stream, crowded, clear, joy, unlisted, joyExtra] =
      await checkEffects({
        effects,
        times: [0.5, 1],
        views: ["front"],
        tile: { width: 96, height: 120 },
      });
    const fails = (result) =>
      result.lines.filter((line) => line.level === "FAIL");

    assert.deepEqual(fails(stream), [], JSON.stringify(stream.lines));
    assert.ok(
      stream.lines.some((line) =>
        /^particles: Save's estimate is up to \d+ at once \(declared budget 50/.test(
          line.message,
        ),
      ),
      JSON.stringify(stream.lines),
    );
    assert.ok(
      fails(crowded).some((line) =>
        /^particles: .*budget 4/.test(line.message),
      ),
      JSON.stringify(crowded.lines),
    );
    assert.equal(
      fails(clear).filter((line) => /no visible art/.test(line.message)).length,
      2,
      JSON.stringify(clear.lines),
    );
    assert.deepEqual(fails(joy), [], JSON.stringify(joy.lines));
    assert.equal(
      joy.lines.filter((line) => /visible in 2 of 2 frames/.test(line.message))
        .length,
      2,
      JSON.stringify(joy.lines),
    );
    assert.ok(
      fails(unlisted).some(
        (line) =>
          /^particles: /.test(line.message) &&
          /textures\/pearl-heart\.png/.test(line.message),
      ),
      JSON.stringify(unlisted.lines),
    );
    assert.deepEqual(
      joyExtra.lines
        .filter((line) => /^scene: /.test(line.message))
        .map(({ level, message }) => `${level} ${message}`),
      [
        "WARN scene: extra.png is listed but no item shows it",
        "PASS scene: within the shared Scene limits",
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Each optional Scene layer (C1–C6) alone, drawn as the chat draws it, is
// visible on both Avatars; the entry flash only while it fades.
test("effects check sees each optional Scene layer on its own", async () => {
  const dir = await mkdtemp(
    path.join(tmpdir(), "animama-effect-check-layers-"),
  );
  try {
    const allLayers = JSON.parse(
      await readFile(
        new URL(
          "../src/lib/content/fixtures/scene-effect-all-layers.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const base = {
      ...allLayers,
      solid: { ...allLayers.solid, enabled: false },
      pattern: { ...allLayers.pattern, enabled: false },
    };
    delete base.gradient;
    delete base.tile;
    delete base.screen;
    delete base.scatters;
    delete base.flash;
    const linesScreen = {
      enabled: true,
      kind: "lines",
      color: "#1d2a40",
      opacity: 0.8,
      count: 40,
      minLength: 0.3,
      maxLength: 0.9,
      minWidthPx: 2,
      maxWidthPx: 4,
      swaySeconds: 5,
      seed: 5,
    };
    const variants = {
      gradient: { gradient: allLayers.gradient },
      tile: { tile: allLayers.tile },
      rays: { screen: allLayers.screen },
      lines: { screen: linesScreen },
      scatter: { scatters: [allLayers.scatters[0]] },
      flash: { flash: { ...allLayers.flash, durationMs: 2000 } },
    };
    const sources = [];
    for (const [stem, layers] of Object.entries(variants)) {
      const folder = path.join(dir, stem);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "petal.png"), await disc(255));
      await writeFile(path.join(folder, "bokeh.png"), await disc(160));
      await writeFile(
        path.join(folder, `${stem}.json`),
        JSON.stringify({
          schema_version: 1,
          content_type: "scene_effect",
          name: stem,
          definition: { ...base, ...layers },
          files: [
            ...(layers.scatters ? [{ path: "petal.png", role: "image" }] : []),
            ...(layers.tile ? [{ path: "bokeh.png", role: "image" }] : []),
          ],
        }),
      );
      sources.push(await resolveAnyEffectSource(folder));
    }
    const results = await checkEffects({
      effects: sources,
      times: [0.1, 1],
      views: ["front"],
      tile: { width: 96, height: 120 },
    });
    for (const result of results) {
      const lines = JSON.stringify(result.lines);
      assert.deepEqual(
        result.lines.filter((line) => line.level === "FAIL"),
        [],
        `${result.stem}: ${lines}`,
      );
      assert.equal(
        result.lines.filter((line) =>
          /visible in [12] of 2 frames/.test(line.message),
        ).length,
        2,
        `${result.stem}: ${lines}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A Scene saved with a Twemoji item (no longer provided) draws without it,
// with no load failure; the check fails the item by name, as Save refuses it.
test("effects check draws a Scene with a Twemoji item without it and fails the item", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-check-emoji-"));
  try {
    const allLayers = JSON.parse(
      await readFile(
        new URL(
          "../src/lib/content/fixtures/scene-effect-all-layers.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const folder = path.join(dir, "old-sparkles");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "petal.png"), await disc(255));
    const plain = { ...allLayers };
    for (const layer of ["gradient", "tile", "screen", "flash"])
      delete plain[layer];
    await writeFile(
      path.join(folder, "old-sparkles.json"),
      JSON.stringify({
        schema_version: 1,
        content_type: "scene_effect",
        name: "Old sparkles",
        definition: {
          ...plain,
          solid: { ...plain.solid, enabled: false },
          pattern: { ...plain.pattern, enabled: false },
          marquee: {
            ...plain.marquee,
            enabled: true,
            items: [
              {
                id: "old",
                kind: "emoji",
                label: "Sparkles",
                emoji: "\u2728",
                provider: "twemoji",
              },
            ],
          },
          scatters: [allLayers.scatters[0]],
        },
        files: [{ path: "petal.png", role: "image" }],
      }),
    );
    const [result] = await checkEffects({
      effects: [await resolveAnyEffectSource(folder)],
      times: [0.1, 1],
      views: ["front"],
      tile: { width: 96, height: 120 },
    });
    const lines = JSON.stringify(result.lines);
    assert.deepEqual(
      result.lines
        .filter((line) => line.level === "FAIL")
        .map((line) => line.message),
      [
        "scene: Sparkles is an emoji, which Animama no longer provides. Replace it with a sticker or image, or remove it.",
      ],
      lines,
    );
    assert.equal(
      result.lines.filter((line) =>
        /visible in [12] of 2 frames/.test(line.message),
      ).length,
      2,
      lines,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Art on a hand is out of frame arms down; posed by a Gesture that raises
// the hand beside the head (as --with-clip does), it is checked where the
// Gesture puts it.
test("effects check poses both Avatars with a Gesture clip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-effect-check-clip-"));
  try {
    const effect = await resolveEffectSource(
      await writeEffect(dir, "fingertip", {
        definition: {
          region: "body",
          // Past the fingertips of a raised right index finger.
          attachment: {
            kind: "body",
            bone: "rightHand",
            offset: { x: -0.21, z: 0.02 },
            size: 0.1,
            facing: "camera",
          },
        },
      }),
    );
    const raiseRightHand = {
      schema: "animaPoseClip/2.0",
      id: "raise-right-hand",
      name: "Raise Right Hand",
      duration: 1,
      beats: [{ id: "up", label: "Hand up", time: 0 }],
      joints: {
        rightUpperArm: {
          elevation: [{ beat: "up", v: 75 }],
          planeOfElevation: [{ beat: "up", v: 40 }],
          rotation: [{ beat: "up", v: 82 }],
        },
        rightLowerArm: { flexion: [{ beat: "up", v: 102 }] },
      },
    };
    const check = (clip) =>
      checkEffects({
        effects: [effect],
        times: [0.5],
        views: ["front"],
        tile: { width: 96, height: 120 },
        clip,
      }).then(([result]) => result.lines);

    const armsDown = await check(null);
    assert.equal(
      armsDown.filter(
        (line) =>
          line.level === "FAIL" &&
          /no visible art .*--with-clip <gesture>/.test(line.message),
      ).length,
      2,
      JSON.stringify(armsDown),
    );
    const posed = await check(raiseRightHand);
    // The clean art's budget line, then each Avatar showing the art.
    assert.deepEqual(
      posed.map((line) => line.level),
      ["PASS", "PASS", "PASS"],
      JSON.stringify(posed),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
