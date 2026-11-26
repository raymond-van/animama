import { beforeAll, describe, expect, it } from "vitest";

import { checkMotion, type MotionCheckAvatar } from "./checks";
import { runDraftChecks } from "./draftChecks";
import { INCLUDED_AVATAR_FILES, type IncludedAvatarId } from "./headlessVrm";
import { loadTestAvatar } from "./testing/includedAvatars";
import wave from "../../../../../../../content/included/gestures/wave-hello/wave-hello.json";

let avatars: MotionCheckAvatar[];

beforeAll(async () => {
  avatars = await Promise.all(
    (Object.keys(INCLUDED_AVATAR_FILES) as IncludedAvatarId[]).map(
      async (id) => ({ id, vrm: await loadTestAvatar(id) }),
    ),
  );
});

const beats = [
  { id: "a", label: "A", time: 0 },
  { id: "b", label: "B", time: 1 },
];
const headClip = (component: string, degrees: number) => ({
  schema: "animaPoseClip/2.0",
  id: "draft",
  name: "Draft",
  duration: 1,
  basePose: "relaxedRest",
  beats,
  joints: {
    head: {
      [component]: [
        { beat: "a", v: 0 },
        { beat: "b", v: degrees },
      ],
    },
  },
});

describe("runDraftChecks", () => {
  it("passes a clean clip", () => {
    expect(runDraftChecks(wave, avatars)).toEqual({
      ok: true,
      loadable: true,
      issues: [],
      findings: [],
    });
  }, 30000);

  it("reports the validation issue and the motion findings of a clip that still plays", () => {
    // 60° is past the head's anatomical limit of 25°, yet the app loads it.
    const clip = headClip("flexion", 60);
    const report = runDraftChecks(clip, avatars);
    expect(report.ok).toBe(false);
    expect(report.loadable).toBe(true);
    expect(report.issues).toEqual([
      {
        path: "joints.head.flexion[1].v",
        message: "60° is beyond the anatomical limit -30..25.",
      },
    ]);
    // The findings `animation check` reports for the same clip.
    expect(report.findings).toEqual(checkMotion(clip, avatars).findings);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        category: "range",
        severity: "fail",
        subject: "head.flexion",
      }),
    );
  }, 30000);

  it("stays ok when the checks only warn", () => {
    // Past the natural range of -24..20, within the anatomical limit.
    const report = runDraftChecks(headClip("flexion", 23), avatars);
    expect(report.issues).toEqual([]);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every(({ severity }) => severity === "warn")).toBe(
      true,
    );
    expect(report.ok).toBe(true);
  }, 30000);

  it("runs no motion check on a clip the app cannot load", () => {
    const clip = {
      ...headClip("rotation", 12),
      expressions: { happy: [{ beat: "nowhere", v: 1 }] },
    };
    expect(runDraftChecks(clip, avatars)).toEqual({
      ok: false,
      loadable: false,
      issues: [
        {
          path: "expressions.happy[0].beat",
          message: 'Unknown beat "nowhere".',
        },
      ],
      findings: [],
    });
    expect(runDraftChecks("not a clip", avatars).loadable).toBe(false);
  });

  it("returns plain data that survives a structured clone", () => {
    const report = runDraftChecks(headClip("flexion", 60), avatars);
    expect(structuredClone(report)).toEqual(report);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  }, 30000);
});
