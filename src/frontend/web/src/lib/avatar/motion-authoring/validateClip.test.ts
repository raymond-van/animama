import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MAX_ANIMA_POSE_CLIP_BYTES } from "../poses/animaPoseClip";
import { validateClip } from "./validateClip";

const example = fileURLToPath(
  new URL(
    "../../../../../../../content/included/gestures/wave-hello/wave-hello.json",
    import.meta.url,
  ),
);
const waveHello = async () => JSON.parse(await readFile(example, "utf8"));

describe("validateClip", () => {
  it("returns a valid clip with the compact file the creator saves", async () => {
    const result = validateClip(await waveHello());
    if (!result.ok) throw new Error(result.message);
    expect(result.issues).toEqual([]);
    expect(result.loadable).toBe(true);
    expect(result.clip.id).toBe("wave-hello");
    expect(result.saved).not.toContain("\n  ");
    expect(JSON.parse(result.saved).id).toBe("wave-hello");
    expect(result.savedBytes).toBe(
      new TextEncoder().encode(result.saved).byteLength,
    );
  });

  it("counts the saved size in bytes, not characters", async () => {
    const clip = await waveHello();
    clip.name = "こんにちは";
    const result = validateClip(clip);
    if (!result.ok) throw new Error(result.message);
    expect(result.savedBytes).toBeGreaterThan(result.saved.length);
  });

  it("lists structural and anatomical problems together, by path", async () => {
    const clip = await waveHello();
    clip.joints.rightUpperArm.elevation[1].v = 250;
    clip.expressions = { happy: [{ beat: "nowhere", v: 1 }] };
    const result = validateClip(clip);
    expect(result).toEqual({
      ok: false,
      loadable: false,
      issues: [
        {
          path: "expressions.happy[0].beat",
          message: 'Unknown beat "nowhere".',
        },
        {
          path: "joints.rightUpperArm.elevation[1].v",
          message: "250° is beyond the anatomical limit 0..180.",
        },
      ],
      // The text `animation validate` prints.
      message: [
        "Invalid animaPoseClip/2.0 (2 issue(s)):",
        '  expressions.happy[0].beat: Unknown beat "nowhere".',
        "  joints.rightUpperArm.elevation[1].v: 250° is beyond the anatomical limit 0..180.",
      ].join("\n"),
    });
  });

  it("keeps a clip loadable when only an anatomical limit is exceeded", async () => {
    const clip = await waveHello();
    clip.joints.rightUpperArm.elevation[1].v = 250;
    const result = validateClip(clip);
    expect(result.ok).toBe(false);
    expect(result.loadable).toBe(true);
    expect(result.issues).toEqual([
      {
        path: "joints.rightUpperArm.elevation[1].v",
        message: "250° is beyond the anatomical limit 0..180.",
      },
    ]);
  });

  it("refuses a clip whose saved file is larger than the app loads", async () => {
    const clip = await waveHello();
    // Expression names have no length limit, so one name can pass it.
    clip.expressions = {
      ["x".repeat(MAX_ANIMA_POSE_CLIP_BYTES)]: [{ beat: "start", v: 1 }],
    };
    const result = validateClip(clip);
    if (result.ok) throw new Error("Expected the clip to be too large.");
    expect(result.loadable).toBe(false);
    expect(result.message).toMatch(
      /^Too large: the clip saves as \d+ KB, over the 2048 KB the app will load\.$/,
    );
    expect(result.issues).toEqual([{ path: "$", message: result.message }]);
  });

  it("reports a value that is not a clip without throwing", () => {
    for (const value of [null, "clip", 3, [], { schema: "animamaMotion/1" }]) {
      const result = validateClip(value);
      expect(result.ok).toBe(false);
      expect(result.loadable).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });
});
