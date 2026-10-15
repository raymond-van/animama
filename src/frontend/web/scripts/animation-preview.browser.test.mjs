import assert from "node:assert/strict";
import {
  copyFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { chromium } from "playwright";

import { startPreviewServer } from "./animation-preview.mjs";
import { INCLUDED_EFFECT_ROOT } from "./effect-render-sources.mjs";

const clip = (headTurn) => ({
  schema: "animaPoseClip/2.0",
  id: "preview-probe",
  name: "Preview Probe",
  duration: 1,
  basePose: "relaxedRest",
  beats: [
    { id: "a", label: "A", time: 0 },
    { id: "b", label: "B", time: 1 },
  ],
  rotations: {
    head: [
      { beat: "a", q: [0, 0, 0, 1] },
      { beat: "b", q: [0, headTurn, 0, 0.9659] },
    ],
  },
});

// One Chromium serves every test, and each page has its own context and
// closes after its test. The checks read preview state, never pixels, so
// pages are as small as the side-by-side layout allows (it stacks below
// 900 px and hides the Scene cells). At the default 1280×720, software
// WebGL spent about a third of each test drawing the two Avatars.
let browser;
const pages = [];
before(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
});
afterEach(() => Promise.all(pages.splice(0).map((page) => page.close())));
after(() => browser?.close());

/** Open a 960×540 page in its own context; it closes after the test. */
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  pages.push(page);
  return page;
}

// Real Avatars and WebGL: notes, live reload and the previous version.
test("previews a clip, saves a review note and reloads a changed source", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-preview-"));
  const source = path.join(dir, "probe.json");
  await writeFile(source, JSON.stringify(clip(0.2588)));
  const preview = await startPreviewServer({
    sources: ["probe.json"],
    cwd: dir,
    localContent: null,
  });
  try {
    const page = await newPage();
    // Avatar loads and rebuilds under SwiftShader can be slow on two-core CI runners.
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(preview.url);
    await page.waitForFunction(() => window.animationPreview?.ready, null, {
      timeout: 90_000,
    });
    assert.deepEqual(errors, []);
    assert.equal(await page.locator(".view-label").count(), 2);
    assert.equal(await page.locator(".marker").count(), 2);

    // Scrubbing pauses and moves every Avatar to that time.
    await page.evaluate(() => {
      const scrubber = document.querySelector("#scrubber");
      scrubber.value = "0.5";
      scrubber.dispatchEvent(new Event("input"));
    });
    assert.equal(await page.evaluate(() => window.animationPreview.time), 0.5);
    assert.equal(await page.textContent("#play"), "Play");

    // A note added in the page lands in the sidecar beside the source.
    await page.fill("#note-text", "Turn the head further");
    await page.selectOption("#note-region", "head");
    await page.click("#note-add");
    await page.locator(".note").first().waitFor();
    const sidecar = JSON.parse(
      await readFile(path.join(dir, "probe.review.json"), "utf8"),
    );
    assert.equal(sidecar.notes.length, 1);
    assert.equal(sidecar.notes[0].text, "Turn the head further");
    assert.equal(sidecar.notes[0].region, "head");

    // A changed source reloads and offers the previous version.
    const generation = await page.evaluate(
      () => window.animationPreview.generation,
    );
    await writeFile(source, JSON.stringify(clip(0.5)));
    await page.waitForFunction(
      (before) => window.animationPreview.generation > before,
      generation,
      { timeout: 90_000 },
    );
    await page.waitForFunction(
      () => !document.querySelector("#previous").disabled,
    );
    await page.check("#previous");
    await page.waitForFunction(
      () => document.querySelectorAll(".view-label").length === 4,
    );

    // Cross-site writes are refused.
    const refused = await fetch(`${preview.origin}/__preview/notes`, {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ time: 0, text: "x" }),
    });
    assert.equal(refused.status, 403);
    assert.deepEqual(errors, []);
  } finally {
    await preview.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// A 2.0 clip plays through the real Avatar with its beats as markers.
test("previews an animaPoseClip/2.0 clip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-preview-v2-"));
  await writeFile(
    path.join(dir, "wave.clip.json"),
    JSON.stringify({
      schema: "animaPoseClip/2.0",
      id: "wave",
      name: "Wave",
      duration: 1.5,
      basePose: "relaxedRest",
      plantFeet: true,
      beats: [
        { id: "start", label: "Start", time: 0 },
        { id: "raise", label: "Raise", time: 0.6 },
        { id: "settle", label: "Settle", time: 1.5 },
      ],
      joints: {
        rightUpperArm: {
          elevation: [
            { beat: "start", v: "base" },
            { beat: "raise", v: 110 },
            { beat: "settle", v: "base" },
          ],
        },
        hips: { flexion: [{ beat: "raise", v: 6 }] },
      },
      hands: { right: [{ beat: "raise", preset: "open-together" }] },
    }),
  );
  const preview = await startPreviewServer({
    sources: ["wave.clip.json"],
    cwd: dir,
    localContent: null,
  });
  try {
    const page = await newPage();
    // Avatar loads and rebuilds under SwiftShader can be slow on two-core CI runners.
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(preview.url);
    await page.waitForFunction(() => window.animationPreview?.ready, null, {
      timeout: 90_000,
    });
    assert.deepEqual(await page.locator(".marker").allTextContents(), [
      "Start",
      "Raise",
      "Settle",
    ]);
    await page.evaluate(() => {
      const scrubber = document.querySelector("#scrubber");
      scrubber.value = "0.6";
      scrubber.dispatchEvent(new Event("input"));
    });
    assert.equal(await page.evaluate(() => window.animationPreview.time), 0.6);

    // Portrait frames each Avatar as the chat's Portrait camera preset does:
    // 1.6 m in front of the rest head, 35° field of view, aimed 0.1 m below.
    await page.click('#cameras button[data-camera="portrait"]');
    assert.equal(
      await page.getAttribute(
        '#cameras button[data-camera="portrait"]',
        "aria-pressed",
      ),
      "true",
    );
    await page.waitForFunction(() =>
      window.animationPreview.cameras.every((view) => view.fov === 35),
    );
    const views = await page.evaluate(() => window.animationPreview.cameras);
    assert.equal(views.length, 2);
    for (const view of views) {
      const [x, y, z] = view.position;
      assert.ok(Math.abs(x) < 1e-6 && Math.abs(z - 1.6) < 1e-6, view.position);
      assert.ok(y > 1 && y < 1.7, `head height ${y}`);
      assert.ok(Math.abs(view.target[1] - (y - 0.1)) < 1e-6, view.target);
    }
    // The other presets keep their own framing.
    await page.click('#cameras button[data-camera="front"]');
    await page.waitForFunction(() =>
      window.animationPreview.cameras.every((view) => view.fov === 30),
    );
    assert.deepEqual(errors, []);
  } finally {
    await preview.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// The pickers switch sources without a restart, and only to listed ones.
test("picks another source and a comparison in the page", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-preview-pick-"));
  await writeFile(path.join(dir, "first.json"), JSON.stringify(clip(0.2588)));
  await writeFile(path.join(dir, "second.json"), JSON.stringify(clip(0.5)));
  const preview = await startPreviewServer({
    sources: ["first.json"],
    notes: "custom.review.json",
    cwd: dir,
    localContent: null,
  });
  try {
    const page = await newPage();
    // Avatar loads and rebuilds under SwiftShader can be slow on two-core CI runners.
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(preview.url);
    await page.waitForFunction(() => window.animationPreview?.ready, null, {
      timeout: 90_000,
    });
    const second = path.join(dir, "second.json");
    assert.equal(
      await page.inputValue("#pick-source"),
      path.join(dir, "first.json"),
    );
    // Included Library items are offered too.
    assert.ok(
      await page
        .locator("#pick-source option[value^='library:included/']")
        .count(),
    );

    // Pause past the middle, so the switch's reset to 0 is observable.
    await page.click("#play");
    await page.evaluate(() => {
      const scrubber = document.querySelector("#scrubber");
      scrubber.value = "0.8";
      scrubber.dispatchEvent(new Event("input"));
    });
    await page.selectOption("#pick-source", second);
    await page.waitForFunction(() =>
      document.querySelector(".view-label")?.textContent?.includes("second"),
    );
    assert.equal(preview.session.state().rows[0].path, second);
    assert.equal(await page.evaluate(() => window.animationPreview.time), 0);

    await page.selectOption("#pick-compare", path.join(dir, "first.json"));
    await page.waitForFunction(
      () => document.querySelectorAll(".view-label").length === 4,
    );

    // Anything not listed is refused, and the open session stays.
    const refused = await page.evaluate(async () => {
      const response = await fetch("/__preview/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "/etc/hosts" }),
      });
      return response.status;
    });
    assert.equal(refused, 400);
    assert.equal(preview.session.state().rows[0].path, second);

    // --notes stays with the source it was given for.
    assert.equal(
      preview.session.reviewPaths.sidecar,
      path.join(dir, "second.review.json"),
    );
    await page.selectOption("#pick-source", path.join(dir, "first.json"));
    await page.waitForFunction(() =>
      document.querySelector(".view-label")?.textContent?.includes("first"),
    );
    assert.equal(
      preview.session.reviewPaths.sidecar,
      path.join(dir, "custom.review.json"),
    );
    assert.deepEqual(errors, []);
  } finally {
    await preview.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Wait until every cell shows `label` among its active Avatar Effects. */
function waitForActiveEffect(page, label, timeout = 90_000) {
  return page.waitForFunction(
    (wanted) => {
      const cells = window.animationPreview.effects;
      return (
        cells.length === 2 &&
        cells.every(({ active }) => active.includes(wanted))
      );
    },
    label,
    { timeout },
  );
}

/** Each cell's completed effect applies. */
const appliesOf = (page) =>
  page.evaluate(() =>
    window.animationPreview.effects.map(({ applies }) => applies),
  );

/** Wait until every cell has applied its effect again since `before`. */
const waitForApplies = (page, before) =>
  page.waitForFunction(
    (counts) =>
      window.animationPreview.effects.every(
        ({ applies }, index) => applies > counts[index],
      ),
    before,
    { timeout: 90_000 },
  );

const scrubTo = (page, time) =>
  page.evaluate((value) => {
    const scrubber = document.querySelector("#scrubber");
    scrubber.value = String(value);
    scrubber.dispatchEvent(new Event("input"));
  }, time);

// An effect folder: applied through the runtime path, reloaded on change.
test("previews an effect source and reloads it when its image changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-preview-effect-"));
  const folder = path.join(dir, "eye_confused_swirl");
  await cp(path.join(INCLUDED_EFFECT_ROOT, "eye_confused_swirl"), folder, {
    recursive: true,
  });
  const preview = await startPreviewServer({
    sources: ["eye_confused_swirl"],
    cwd: dir,
    localContent: null,
  });
  try {
    const page = await newPage();
    // Avatar loads and rebuilds under SwiftShader can be slow on two-core CI runners.
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(preview.url);
    await page.waitForFunction(() => window.animationPreview?.ready, null, {
      timeout: 90_000,
    });
    await waitForActiveEffect(page, "Eye Confused Swirl");
    assert.deepEqual(
      await page.evaluate(() => window.animationPreview.notices),
      [],
    );
    assert.ok(await page.isHidden("#effect-notices"));

    // Scrubbing re-applies the effect and steps it to the time.
    await page.click("#play");
    const applies = await appliesOf(page);
    await scrubTo(page, 1.5);
    assert.equal(await page.evaluate(() => window.animationPreview.time), 1.5);
    await waitForApplies(page, applies);
    await waitForActiveEffect(page, "Eye Confused Swirl");

    // A note on an effect is saved beside its folder, not inside it.
    await page.fill("#note-text", "Spin slower");
    await page.click("#note-add");
    await page.locator(".note").first().waitFor();
    const sidecar = JSON.parse(
      await readFile(path.join(dir, "eye_confused_swirl.review.json"), "utf8"),
    );
    assert.equal(sidecar.notes[0].text, "Spin slower");

    // Changing only the image is a new version, re-applied on both Avatars.
    const version = preview.session.state().rows[0].version;
    const generation = await page.evaluate(
      () => window.animationPreview.generation,
    );
    await copyFile(
      path.join(INCLUDED_EFFECT_ROOT, "eye_vv/eye_vv_r.png"),
      path.join(folder, "eye_confused_swirl-sheet.png"),
    );
    await page.waitForFunction(
      (before) => window.animationPreview.generation > before,
      generation,
      { timeout: 90_000 },
    );
    const reloaded = preview.session.state().rows[0];
    assert.notEqual(reloaded.version, version);
    assert.ok(reloaded.effect.imageUrl.endsWith(`?v=${reloaded.version}`));
    // Both Avatars were rebuilt for the new version and applied it.
    await page.waitForFunction(
      (wanted) =>
        window.animationPreview.effects.length === 2 &&
        window.animationPreview.effects.every(
          ({ version, applies }) => version === wanted && applies > 0,
        ),
      reloaded.version,
      { timeout: 90_000 },
    );
    await waitForActiveEffect(page, "Eye Confused Swirl");

    // An invalid definition is reported by field; the last valid one plays.
    const descriptorPath = path.join(folder, "eye_confused_swirl.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.definition.region = "nowhere";
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    await page.waitForFunction(
      () =>
        document
          .querySelector("#errors")
          ?.textContent?.includes("definition.region"),
      null,
      { timeout: 90_000 },
    );
    await waitForActiveEffect(page, "Eye Confused Swirl");
    assert.deepEqual(errors, []);
  } finally {
    await preview.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// #289's preview applied no Library Reaction effects; they now play as in chat.
test("plays a Library Reaction with its Avatar and Particle Effects", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-preview-reaction-"));
  const preview = await startPreviewServer({
    sources: ["library:included/confusion-3"],
    cwd: dir,
    localContent: null,
  });
  try {
    const page = await newPage();
    // Avatar loads and rebuilds under SwiftShader can be slow on two-core CI runners.
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(preview.url);
    await page.waitForFunction(() => window.animationPreview?.ready, null, {
      timeout: 90_000,
    });
    const media = preview.session.state().rows[0].media;
    assert.deepEqual(
      media.avatarEffects.map(({ alias }) => alias),
      ["eye_confused_swirl"],
    );
    assert.deepEqual(
      media.particleEffects.map(({ alias }) => alias),
      ["question-orbit"],
    );
    await waitForActiveEffect(page, "Eye Confused Swirl");
    await page.waitForFunction(
      () =>
        window.animationPreview.effects.every(({ particles }) => particles > 0),
      null,
      { timeout: 90_000 },
    );

    // Pausing and scrubbing replays the events before the time.
    await page.click("#play");
    await scrubTo(page, 0.3);
    await waitForActiveEffect(page, "Eye Confused Swirl");
    const state = await page.evaluate(() => window.animationPreview);
    assert.deepEqual(state.notices, []);
    assert.ok(state.effects.every(({ warnings }) => warnings.length === 0));
    assert.deepEqual(errors, []);
  } finally {
    await preview.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// --duration: applied, removed at the duration, a 0.5 s tail, then the loop.
test("applies a timed effect source, removes it and loops", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-preview-timed-"));
  await cp(
    path.join(INCLUDED_EFFECT_ROOT, "eye_confused_swirl"),
    path.join(dir, "eye_confused_swirl"),
    { recursive: true },
  );
  const preview = await startPreviewServer({
    sources: ["eye_confused_swirl"],
    cwd: dir,
    localContent: null,
    duration: 1,
  });
  try {
    const page = await newPage();
    // Avatar loads and rebuilds under SwiftShader can be slow on two-core CI runners.
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(preview.url);
    await page.waitForFunction(() => window.animationPreview?.ready, null, {
      timeout: 90_000,
    });
    // The timeline is the duration plus the tail.
    assert.match(await page.textContent("#time"), /\/ 1\.50 s$/);
    await waitForActiveEffect(page, "Eye Confused Swirl");

    await page.click("#play");
    await scrubTo(page, 0.5);
    await waitForActiveEffect(page, "Eye Confused Swirl");
    // In the tail the effect is removed.
    await scrubTo(page, 1.2);
    await page.waitForFunction(
      () =>
        window.animationPreview.effects.length === 2 &&
        window.animationPreview.effects.every(
          ({ active }) => active.length === 0,
        ),
      null,
      { timeout: 90_000 },
    );
    // Playing on wraps to the start and applies it again.
    const applies = await appliesOf(page);
    await page.click("#play");
    await waitForApplies(page, applies);
    await waitForActiveEffect(page, "Eye Confused Swirl");
    assert.deepEqual(errors, []);
  } finally {
    await preview.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Open the preview page and wait until it plays. */
async function openPreview(preview) {
  const page = await newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(preview.url);
  await page.waitForFunction(() => window.animationPreview?.ready, null, {
    timeout: 90_000,
  });
  return { page, errors };
}

/** Wait until every view shows the Scene `id`, drawn in its own layers. */
async function waitForScene(page, id, timeout = 60_000) {
  await page.waitForFunction(
    (wanted) =>
      window.animationPreview.effects.length === 2 &&
      window.animationPreview.effects.every(({ scenes }) =>
        scenes.includes(wanted),
      ) &&
      [...document.querySelectorAll(".scene-cell")].every((host) =>
        host.querySelector("[data-scene-vfx-id]"),
      ),
    id,
    { timeout },
  );
}

// Particle and Scene Effect sources play through the runtime path, the
// Scene in each view's own layers behind and in front of the canvas.
test("previews Particle and Scene Effect sources", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-preview-kinds-"));
  const preview = await startPreviewServer({
    sources: ["library:particle-effect/hearts-v1"],
    cwd: dir,
    localContent: null,
  });
  try {
    const { page, errors } = await openPreview(preview);
    assert.equal(
      preview.session.state().rows[0].effect.kind,
      "particle_effect",
    );
    await page.waitForFunction(
      () =>
        window.animationPreview.effects.length === 2 &&
        window.animationPreview.effects.every(({ particles }) => particles > 0),
      null,
      { timeout: 60_000 },
    );

    const choices = await page.evaluate(async () =>
      (await fetch("/__preview/choices")).json(),
    );
    for (const group of ["Included Particle Effects", "Included Scene Effects"])
      assert.ok(
        choices.some((choice) => choice.group === group),
        `the pickers list ${group}`,
      );
    await page.selectOption(
      "#pick-source",
      "library:scene-effect/included/scene-vfx-emotion-joy",
    );
    await waitForScene(
      page,
      "builtin:scene-effect:background:scene-vfx-emotion-joy",
    );
    // Each view's layers fill its own cell and stack around the canvas.
    const stacking = await page.evaluate(() => {
      const canvas = getComputedStyle(document.querySelector("#canvas"));
      const hosts = [...document.querySelectorAll(".scene-cell")];
      return {
        canvas: canvas.zIndex,
        hosts: hosts.map((host) => getComputedStyle(host).zIndex),
        sizes: hosts.map((host) => host.getBoundingClientRect().width > 0),
      };
    });
    assert.deepEqual(stacking, {
      canvas: "10",
      hosts: ["auto", "auto"],
      sizes: [true, true],
    });
    // Paused, the Scene's animations hold the playhead's time.
    await page.click("#play");
    await scrubTo(page, 1);
    // The page seeks Scene animations as it draws the next frame.
    const times = await page.evaluate(async () => {
      for (let frame = 0; frame < 2; frame += 1)
        await new Promise((resolve) => requestAnimationFrame(resolve));
      return document
        .querySelector(".scene-cell")
        .getAnimations({ subtree: true })
        .map((animation) => Math.round(Number(animation.currentTime)));
    });
    assert.ok(times.length > 0 && times.every((time) => time === 1000), times);
    const state = await page.evaluate(() => window.animationPreview);
    assert.deepEqual(state.notices, []);
    assert.deepEqual(errors, []);
  } finally {
    await preview.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// A Reaction's Scene event shows its Scene with its Avatar and Particle
// Effects, as chat applies it.
test("plays a Library Reaction with its Avatar, Particle and Scene Effects", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-preview-joy-"));
  const preview = await startPreviewServer({
    sources: ["library:included/joy-4"],
    cwd: dir,
    localContent: null,
  });
  try {
    const { page, errors } = await openPreview(preview);
    const media = preview.session.state().rows[0].media;
    assert.deepEqual(
      media.sceneEffects.map(({ alias }) => alias),
      ["scene-vfx-emotion-joy"],
    );
    await waitForScene(page, "scene-vfx-emotion-joy");
    await waitForActiveEffect(page, "Star3");
    await page.waitForFunction(
      () =>
        window.animationPreview.effects.every(({ particles }) => particles > 0),
      null,
      { timeout: 60_000 },
    );
    // Scrubbing replays the events before the time, Scene included.
    await page.click("#play");
    await scrubTo(page, 0.4);
    await waitForScene(page, "scene-vfx-emotion-joy");
    const state = await page.evaluate(() => window.animationPreview);
    assert.deepEqual(state.notices, []);
    assert.ok(state.effects.every(({ warnings }) => warnings.length === 0));
    assert.deepEqual(errors, []);
  } finally {
    await preview.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// A Scene drawn in front of the Avatar sits above the canvas, as in chat; a
// Scene event whose dependency is the other kind fails as a clip event.
test("stacks a front Scene above the Avatar and reports a Scene of the wrong kind", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-preview-front-"));
  const folder = path.join(dir, "front-lines");
  await cp(path.join(INCLUDED_EFFECT_ROOT, "../scene/light-streak"), folder, {
    recursive: true,
  });
  const descriptor = JSON.parse(
    await readFile(path.join(folder, "light-streak.json"), "utf8"),
  );
  await rm(path.join(folder, "light-streak.json"));
  descriptor.definition.renderPlacement = "front_of_avatar";
  await writeFile(
    path.join(folder, "front-lines.json"),
    JSON.stringify(descriptor),
  );
  await writeFile(
    path.join(dir, "wrong-kind.project.json"),
    JSON.stringify({
      schema: "animamaActionProject/1.0",
      sequence: {
        ...clip(0.1),
        events: [
          {
            id: "scene",
            time: 0.1,
            kind: "scene_vfx",
            sceneKind: "background_layers",
            presetId: "lines",
          },
        ],
      },
      dependencies: [
        {
          ref: descriptor.content_id,
          alias: "lines",
          content_type: "scene_effect",
          config: {},
        },
      ],
    }),
  );
  /** Preview `source` in a fresh server and page, then close both. */
  const withPreview = async (source, check) => {
    const preview = await startPreviewServer({
      sources: [source],
      cwd: dir,
      localContent: null,
    });
    try {
      const { page, errors } = await openPreview(preview);
      await check(page);
      assert.deepEqual(errors, []);
    } finally {
      await preview.close();
    }
  };
  try {
    await withPreview("front-lines", async (page) => {
      await waitForScene(page, descriptor.content_id);
      const zIndexes = await page.evaluate(() =>
        [...document.querySelectorAll(".scene-cell [data-scene-vfx-id]")].map(
          (layer) => getComputedStyle(layer.parentElement).zIndex,
        ),
      );
      assert.deepEqual(zIndexes, ["20", "20"]);
    });
    await withPreview("wrong-kind.project.json", (page) =>
      page.waitForFunction(
        () =>
          window.animationPreview.notices.some((line) =>
            line.includes("“lines” has no background dependency"),
          ),
        null,
        { timeout: 60_000 },
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
