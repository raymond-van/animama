import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { VRM } from "@pixiv/three-vrm";
import { beforeAll, describe, expect, it } from "vitest";

import { getManifestGestureEntries } from "../animationManifest";
import {
  MAX_ANIMA_POSE_CLIP_BYTES,
  serializeAnimaPoseClipFile,
  validateAnimaPoseClipV2,
} from "../poses/animaPoseClip";
import { checkMotion } from "./checks";
import { loadTestAvatar } from "./testing/includedAvatars";

/**
 * Every Included animaPoseClip/2.0 Gesture must validate, save within the
 * size limit and, unless listed below, pass the motion checks on both
 * Included Avatars.
 */

/**
 * Owner-authored Gestures converted from animaPoseClip/1.0 without motion
 * changes (#337) whose hand-made poses touch the body or pass joint limits
 * on purpose, so the motion checks for authored clips do not apply.
 */
const MOTION_CHECK_EXEMPT = new Set(["meme-dab", "shy-finger-poke-loop"]);
const directory = fileURLToPath(
  new URL("../../../../../../../content/included/gestures/", import.meta.url),
);
const clips = readdirSync(directory)
  .map((slug) => `${slug}/${slug}.json`)
  // VRMA-only Gestures have no clip file.
  .filter(
    (file) =>
      existsSync(directory + file) &&
      JSON.parse(readFileSync(directory + file, "utf8")).schema ===
        "animaPoseClip/2.0",
  );

let vrm0: VRM;
let vrm1: VRM;
beforeAll(async () => {
  vrm0 = await loadTestAvatar("AvatarSample_Y_0");
  vrm1 = await loadTestAvatar("AvatarSample_A_1_New");
});

describe("Included 2.0 Gestures", () => {
  it("covers every authored Gesture", () => {
    expect(clips).toHaveLength(133);
  });

  it.each(clips)(
    "%s validates and passes the checks",
    (file) => {
      const result = validateAnimaPoseClipV2(
        JSON.parse(readFileSync(directory + file, "utf8")),
      );
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(
        Buffer.byteLength(serializeAnimaPoseClipFile(result.clip)),
      ).toBeLessThan(MAX_ANIMA_POSE_CLIP_BYTES);
      if (MOTION_CHECK_EXEMPT.has(file.split("/")[0])) return;
      const checks = checkMotion(result.clip, [
        { id: "AvatarSample_Y_0", vrm: vrm0 },
        { id: "AvatarSample_A_1_New", vrm: vrm1 },
      ]);
      expect(checks.findings.filter((f) => f.severity === "fail")).toEqual([]);
    },
    60000,
  );
});

/**
 * The motion manifest repeats each clip-backed Gesture's name, duration and
 * loop kind for chat playback, so they must agree with the clip.
 */
describe("Included Gesture manifest entries", () => {
  const entries = getManifestGestureEntries().filter(
    (entry) => entry.type === "animaPoseClip",
  );

  it.each(entries.map((entry) => [entry.file, entry] as const))(
    "%s matches its clip's name, duration and loop",
    (file, entry) => {
      const clip = JSON.parse(
        readFileSync(`${directory}${file}/${file}.json`, "utf8"),
      );
      expect({
        name: entry.name,
        duration: entry.duration,
        loops: entry.loopType === "repeat",
      }).toEqual({
        name: clip.name,
        duration: clip.duration,
        loops: clip.loop === true,
      });
    },
  );
});
