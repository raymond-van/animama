import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isAnimaPoseClipV2, parseAnimaPoseClip } from "./animaPoseClip";
import originalInventory from "./fixtures/starter-inventory-before-content.json";
import { parseAnimaPose, resolveAnimaPose } from "./animaPose";
import {
  AVATAR_POSE_CATALOG,
  AVATAR_POSE_CLIP_CATALOG,
  AVATAR_POSE_IDS,
  AVATAR_REACTION_CLIP_CATALOG,
  DEFAULT_AVATAR_POSE_IDS,
  getAvatarPoseClip,
  getResolvedAvatarPose,
} from "./catalog";

const includedRoot = fileURLToPath(
  new URL("../../../../../../../content/included/poses/", import.meta.url),
);

/** Ignore sub-picometre normalization noise while protecting every effective value. */
function roundedCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(roundedCanonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, roundedCanonical(entry)]),
    );
  }
  return typeof value === "number"
    ? Number(value.toFixed(originalInventory.numeric_precision))
    : value;
}

/** The five Starter Poses, the default selection's sources. */
const STARTER_POSE_IDS = [
  "relaxedRest",
  "shy-finger-poke-1",
  "shy-finger-poke-2",
  "thinking-head-scratch-1",
  "thinking-head-scratch-2",
];

/**
 * Poses that 1.0 Gestures referenced as runtime-only dependencies until #337,
 * now Included content. Some were renamed for the Library; values are kept.
 */
const PROMOTED_POSE_NAMES: Record<string, string> = {
  "arms-crossed": "Arms Crossed",
  "cat-monster-rawr": "Cat Monster Rawr 1",
  "cat-monster-rawr-2": "Cat Monster Rawr 2",
  "cheeky-finger-guns": "Cheeky Finger Guns 1",
  "cheeky-finger-guns-2": "Cheeky Finger Guns 2",
  "double-peace-sign": "Double Peace Sign",
  "double-thumbs-down": "Double Thumbs Down",
  "double-thumbs-up": "Double Thumbs Up",
  "hands-on-hips": "Hands On Hips",
  "heart-hands": "Heart Hands",
  "left-ok-sign": "Left OK Sign",
  "left-peace-sign": "Left Peace Sign",
  "meme-dab": "Meme Dab",
  "right-face-palm": "Right Face Palm",
  "right-finger-point": "Right Finger Point",
  "right-thumbs-down": "Right Thumbs Down",
  "right-thumbs-up": "Right Thumbs Up",
  "single-hand-on-heart": "Single Hand On Heart",
  "soldier-salute": "Soldier Salute 1",
  "soldier-salute-2": "Soldier Salute 2",
  "thinking-hand-on-chin": "Thinking Hand On Chin",
};

describe("Included Pose starter collection", () => {
  it("exposes the starter and promoted Poses with their original effective values", () => {
    const included = readdirSync(includedRoot).sort();
    expect(included).toEqual(
      [...STARTER_POSE_IDS, ...Object.keys(PROMOTED_POSE_NAMES)].sort(),
    );
    expect([...AVATAR_POSE_IDS].sort()).toEqual(included);
    expect(DEFAULT_AVATAR_POSE_IDS).toEqual(originalInventory.defaultPoseIds);
    // Every original pose except the unused T-pose ships, with its values.
    const originals = originalInventory.poses.filter(
      (pose) => pose.id !== "vrmTPose",
    );
    expect(originals.map(({ id }) => id).sort()).toEqual(included);
    for (const original of originals) {
      const resolved = getResolvedAvatarPose(original.id);
      if (original.id in PROMOTED_POSE_NAMES)
        expect(resolved.name).toBe(PROMOTED_POSE_NAMES[original.id]);
      expect(
        createHash("sha256")
          .update(
            JSON.stringify(
              roundedCanonical({ ...resolved, name: original.name }),
            ),
          )
          .digest("hex"),
        original.id,
      ).toBe(original.resolved_sha256);
    }
  });

  it("exposes every Pose as canonical parent-free Included content", () => {
    expect(existsSync(includedRoot)).toBe(true);
    const entries = readdirSync(includedRoot).sort();
    for (const id of entries) {
      const descriptor = JSON.parse(
        readFileSync(`${includedRoot}/${id}/${id}.json`, "utf8"),
      );
      expect(descriptor).toMatchObject({
        schema_version: 1,
        content_type: "pose",
        content_id: id,
        name: AVATAR_POSE_CATALOG[id].name,
      });
      expect(descriptor.pose).not.toHaveProperty("parent");
      expect(parseAnimaPose(descriptor.pose)).toEqual(AVATAR_POSE_CATALOG[id]);
      expect(roundedCanonical(descriptor.pose)).toEqual(
        roundedCanonical(getResolvedAvatarPose(id)),
      );
    }
  });

  it("ships every Included clip as 2.0 with a resolvable base pose", () => {
    expect(Object.keys(AVATAR_POSE_CLIP_CATALOG)).toHaveLength(133);
    expect(Object.keys(AVATAR_REACTION_CLIP_CATALOG)).toHaveLength(168);
    for (const clip of [
      ...Object.values(AVATAR_POSE_CLIP_CATALOG),
      ...Object.values(AVATAR_REACTION_CLIP_CATALOG),
    ]) {
      expect(isAnimaPoseClipV2(clip), clip.id).toBe(true);
      if (clip.basePose) expect(AVATAR_POSE_IDS).toContain(clip.basePose);
    }
  });

  it("loads every Included clip Gesture straight from content/included", () => {
    const gesturesRoot = `${includedRoot}/../gestures`;
    const clipGestures = readdirSync(gesturesRoot)
      .filter((slug) => {
        const meta = JSON.parse(
          readFileSync(`${gesturesRoot}/${slug}/${slug}.meta.json`, "utf8"),
        );
        return meta.implementation.kind === "anima_clip";
      })
      .sort();
    expect(clipGestures).toEqual(Object.keys(AVATAR_POSE_CLIP_CATALOG).sort());
    const v2Ids: string[] = [];
    for (const slug of clipGestures) {
      const included = parseAnimaPoseClip(
        JSON.parse(
          readFileSync(`${gesturesRoot}/${slug}/${slug}.json`, "utf8"),
        ),
      );
      expect(included).toEqual(AVATAR_POSE_CLIP_CATALOG[slug]);
      if (isAnimaPoseClipV2(included)) v2Ids.push(slug);
    }
    expect(v2Ids).toHaveLength(133);
    // A 2.0 Gesture plays from the built-in catalog as a fresh copy.
    const replaced = getAvatarPoseClip("arms-crossed-clip");
    expect(isAnimaPoseClipV2(replaced) && replaced.loop).toBe(true);
    expect(replaced).toEqual(AVATAR_POSE_CLIP_CATALOG["arms-crossed"]);
    expect(replaced).not.toBe(AVATAR_POSE_CLIP_CATALOG["arms-crossed"]);
  });

  it("uses the current resolver's inheritance flags and partial-transform semantics", () => {
    const parent = parseAnimaPose({
      schema: "animaPose/1.0",
      id: "parent",
      name: "Parent",
      humanoid: {
        hips: { position: [0, 0.1, 0], rotation: [0, 0, 0, 1] },
        head: { rotation: [0, 0, 0, 1] },
      },
      expressions: { happy: 0.7, relaxed: 0.2 },
    });
    const child = {
      schema: "animaPose/1.0",
      id: "child",
      name: "Child",
      parent: { ref: "parent", inheritExpressions: true },
      humanoid: { hips: { position: [0, 0.3, 0] } },
      expressions: { happy: 0.4 },
    };
    const resolved = resolveAnimaPose(parseAnimaPose(child), () => parent);
    expect(resolved).toEqual({
      schema: "animaPose/1.0",
      id: "child",
      name: "Child",
      humanoid: {
        hips: { position: [0, 0.3, 0], rotation: [0, 0, 0, 1] },
        head: { rotation: [0, 0, 0, 1] },
      },
      expressions: { happy: 0.4, relaxed: 0.2 },
    });
    expect(
      resolveAnimaPose(
        parseAnimaPose({
          ...child,
          parent: { ref: "parent", inheritHumanoid: false },
        }),
        () => parent,
      ),
    ).toEqual({
      schema: "animaPose/1.0",
      id: "child",
      name: "Child",
      humanoid: { hips: { position: [0, 0.3, 0] } },
      expressions: { happy: 0.4 },
    });
  });
});
