import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nodeCheckReports,
  runGenerationTrial,
  sheetFileStem,
} from "./generation-trial.mjs";

const beats = [
  { id: "a", label: "A", time: 0 },
  { id: "b", label: "B", time: 1 },
];

/** A small head turn that passes every check. */
const cleanClip = {
  schema: "animaPoseClip/2.0",
  id: "trial-clean",
  name: "Trial Clean",
  duration: 1,
  basePose: "relaxedRest",
  beats,
  joints: {
    head: {
      rotation: [
        { beat: "a", v: 0 },
        { beat: "b", v: 12 },
      ],
    },
  },
};

/** The head bends forward past its anatomical limit of 25°. */
const faultyClip = {
  ...cleanClip,
  id: "trial-faulty",
  name: "Trial Faulty",
  joints: {
    head: {
      flexion: [
        { beat: "a", v: 0 },
        { beat: "b", v: 60 },
      ],
    },
  },
};

const clips = [
  { id: cleanClip.id, clip: cleanClip },
  { id: faultyClip.id, clip: faultyClip },
];

// One page run serves both tests: starting Vite and Chromium is the slow part.
const trial = runGenerationTrial({
  clips,
  frames: true,
  rows: 2,
  tile: { width: 96, height: 144 },
});
trial.catch(() => undefined);

test("motion checks agree between the command line, a page and a worker", async () => {
  const [result, nodeReports] = [await trial, await nodeCheckReports(clips)];
  assert.equal(result.checks.length, 2);
  result.checks.forEach((check, index) => {
    assert.equal(check.workerMatchesMain, true, `${check.clip}: worker`);
    assert.equal(
      check.report,
      nodeReports[index].report,
      `${check.clip}: page`,
    );
  });
  const [clean, faulty] = result.checks;
  assert.equal(clean.findings, 0, clean.report);
  assert.ok(faulty.fails > 0, faulty.report);
});

test("a render target on an existing renderer draws the same review sheets", async () => {
  const { frames } = await trial;
  for (const strategy of [frames.ownRenderer, frames.renderTarget]) {
    assert.deepEqual(
      strategy.sheets.map((sheet) => sheet.avatar),
      ["Andrew", "Annie"],
    );
    for (const sheet of strategy.sheets) {
      assert.match(sheet.dataUrl, /^data:image\/png;base64,/);
      // 64 px labels + four views wide, 28 px header + two rows tall.
      assert.equal(sheet.width, 64 + 4 * 96);
      assert.equal(sheet.height, 28 + 2 * 144);
      assert.ok(
        sheet.pngBytes > 10_000,
        `sheet is only ${sheet.pngBytes} bytes`,
      );
    }
  }
  // Read back as they are, the pixels are linear; encoded to sRGB they match
  // what a renderer draws on its own canvas.
  assert.ok(
    frames.renderTargetSrgbDifference < 2,
    `sRGB difference ${frames.renderTargetSrgbDifference}`,
  );
  assert.ok(
    frames.renderTargetRawDifference > frames.renderTargetSrgbDifference * 4,
    `raw difference ${frames.renderTargetRawDifference}`,
  );
});

test("a clip's id names a sheet file only through plain characters", () => {
  assert.equal(sheetFileStem("wave-hello"), "wave-hello");
  assert.equal(sheetFileStem("../../escaped"), "-escaped");
  assert.equal(sheetFileStem("a/b c"), "a-b-c");
  assert.equal(sheetFileStem("../.."), "clip");
  assert.equal(sheetFileStem(undefined), "clip");
  assert.equal(sheetFileStem("x".repeat(200)).length, 64);
});
