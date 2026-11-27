import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nodeCheckReports,
  reportMatchesNode,
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

/** A key names a beat the clip does not have, so the app cannot load it. */
const brokenClip = {
  ...cleanClip,
  id: "trial-broken",
  name: "Trial Broken",
  expressions: { happy: [{ beat: "nowhere", v: 1 }] },
};

const clips = [
  { id: cleanClip.id, clip: cleanClip },
  { id: faultyClip.id, clip: faultyClip },
  { id: brokenClip.id, clip: brokenClip },
];

// One page run serves both tests: starting Vite and Chromium is the slow part.
const trial = runGenerationTrial({
  clips,
  frames: true,
  rows: 2,
  tile: { width: 96, height: 144 },
});
trial.catch(() => undefined);

/** As the report travels: without `undefined` fields or the sign of zero. */
const plain = (value) => JSON.parse(JSON.stringify(value));

// The app's draft checks (`draftChecks.ts`, in a page and in its worker)
// against what `pnpm animation validate` and `check` report for the same clip.
test("draft checks agree between the command line, a page and a worker", async () => {
  const [result, nodeReports] = [await trial, await nodeCheckReports(clips)];
  assert.equal(result.checks.length, clips.length);
  result.checks.forEach((check, index) => {
    const node = nodeReports[index];
    assert.equal(check.workerMatchesMain, true, `${check.clip}: worker`);
    assert.deepEqual(
      plain(check.report.issues),
      plain(node.issues),
      `${check.clip}: validation issues`,
    );
    assert.deepEqual(
      plain(check.report.findings),
      plain(node.findings ?? []),
      `${check.clip}: motion findings`,
    );
    assert.equal(reportMatchesNode(check.report, node), true, check.clip);
  });
  const [clean, faulty, broken] = result.checks.map((check) => check.report);
  assert.deepEqual(clean, {
    ok: true,
    loadable: true,
    issues: [],
    findings: [],
  });

  // The seeded fault is both a validation issue and a failed motion check.
  assert.equal(faulty.ok, false);
  assert.equal(faulty.loadable, true);
  assert.deepEqual(
    faulty.issues.map((issue) => issue.path),
    ["joints.head.flexion[1].v"],
  );
  assert.ok(
    faulty.findings.some(
      (finding) =>
        finding.severity === "fail" && finding.subject === "head.flexion",
    ),
    JSON.stringify(faulty.findings),
  );

  // A clip that does not load is a report with no findings, not an error.
  assert.equal(nodeReports[2].findings, null);
  assert.equal(broken.ok, false);
  assert.equal(broken.loadable, false);
  assert.deepEqual(broken.findings, []);
  assert.deepEqual(
    broken.issues.map((issue) => issue.path),
    ["expressions.happy[0].beat"],
  );
});

// The app's review sheets (`renderIncludedAvatarReviewSheets`) against the
// sheets `pnpm animation:render`'s page draws for the same clip and times.
test("the app's review sheets match animation:render's", async () => {
  const { frames } = await trial;
  for (const strategy of [frames.ownRenderer, frames.renderTarget]) {
    // One sheet for each Included Avatar, and no other.
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
      assert.ok(sheet.jpegBytes > 5_000 && sheet.jpegBytes < sheet.pngBytes);
    }
  }
  // Read back from a render target and encoded to sRGB, the pixels match
  // what a renderer draws on its own canvas (unencoded they differ by ~15).
  assert.ok(
    frames.renderTargetSrgbDifference < 2,
    `sRGB difference ${frames.renderTargetSrgbDifference}`,
  );
  // Each round read the two Included Avatars' files and no other.
  assert.deepEqual(frames.requestedAvatars, [
    "Andrew",
    "Annie",
    "Andrew",
    "Annie",
  ]);
  // The renderer the page already had kept its own state throughout.
  assert.equal(frames.rendererUndisturbed, true);
});

test("a clip's id names a sheet file only through plain characters", () => {
  assert.equal(sheetFileStem("wave-hello"), "wave-hello");
  assert.equal(sheetFileStem("../../escaped"), "-escaped");
  assert.equal(sheetFileStem("a/b c"), "a-b-c");
  assert.equal(sheetFileStem("../.."), "clip");
  assert.equal(sheetFileStem(undefined), "clip");
  assert.equal(sheetFileStem("x".repeat(200)).length, 64);
});
