import { describe, expect, it } from "vitest";
import type { PyTypedContentPreview } from "@animama/runtime-contracts/api-types";
import {
  typedActionPreview,
  typedIdleGesturePreview,
} from "@/lib/content/typedPreviewAdapters";
import { actionPreviewTarget } from "./actionPreviewTarget";
import { idlePreviewTarget } from "./idlePreviewTarget";

function preview(kind: "vrma" | "anima_clip"): PyTypedContentPreview {
  const revision = "a".repeat(64);
  const base = {
    source: "local" as const,
    editable: true,
    revision_sha256: revision,
    dependencies: [],
    files: [],
  };
  const file = {
    file_ref: "motion",
    logical_path: "motion.json",
    filename: "motion.json",
    role: kind === "vrma" ? "animation" : "sequence",
    ordinal: 1,
    media_type: "application/json",
    sha256: revision,
    size_bytes: 30,
    url: "/v1/content/files/motion",
  };
  return {
    idle_playback: {
      "local:gesture:breathing": {
        eligible: true,
        cycle_seconds: 1,
        time_scale: 0.5,
        repetitions: 3,
        duration_seconds: 6,
        loop_type: "repeat",
      },
    },
    preview_id: "gesture-preview",
    revision_sha256: revision,
    expires_at: "2027-01-01T00:00:00Z",
    item: {
      ...base,
      kind: "gesture",
      item_id: "gesture",
      logical_key: "local:gesture:breathing",
      name: "Breathing",
      semantic_key: "breathing",
      implementation: { kind, file_role: file.role },
      config: { time_scale: 0.5, loop_count: 3 },
      files: [file],
      dependencies: [
        {
          kind: "sound_effect",
          ref: "local:sound_effect:bell",
          alias: "bell",
          item_id: "bell",
        },
      ],
    },
    supports: [
      {
        ...base,
        kind: "sound_effect",
        item_id: "bell",
        logical_key: "local:sound_effect:bell",
        name: "Bell",
        duration_seconds: 1,
        codec: "wav",
        defaults: {},
        files: [],
      },
    ],
    files: [{ ...file, url: "/preview/motion" }],
  } as PyTypedContentPreview;
}

describe("Idle Gesture previews", () => {
  it.each(["vrma", "anima_clip"] as const)(
    "previews a %s Gesture with its finite clock, authored config and sound dependency",
    (kind) => {
      const target = idlePreviewTarget(
        typedIdleGesturePreview(preview(kind)),
        "Idle",
      );
      expect(target.kind).toBe(
        kind === "vrma" ? "animation" : "anima_pose_clip",
      );
      expect(target.displayName).toBe("Breathing");
      expect(target.config).toMatchObject({
        time_scale: 0.5,
        loop_count: 3,
        runtime_reference_map: { bell: "bell" },
      });
      expect(target.idlePlayback).toEqual({
        timeScale: 0.5,
        repetitions: 3,
        durationSeconds: 6,
        loopType: "repeat",
      });
      if (target.sourceType !== "resolved_action")
        throw new Error("Action target missing");
      expect(target.runtime.sfx.map((entry) => entry.runtime_id)).toEqual([
        "bell",
      ]);
    },
  );

  it("refuses an ineligible Gesture in the idle context while preserving ordinary Action preview", () => {
    const input = { ...preview("anima_clip"), idle_playback: {} };
    expect(() =>
      idlePreviewTarget(typedIdleGesturePreview(input), "Breathing"),
    ).toThrow("Finite idle playback is unavailable");
    expect(
      actionPreviewTarget(typedActionPreview(input), "Breathing").kind,
    ).toBe("anima_pose_clip");
  });

  it("refuses a preview that is not a Gesture", () => {
    const input = preview("anima_clip");
    const sound = input.supports![0]!;
    expect(() =>
      typedIdleGesturePreview({ ...input, item: sound, supports: [] }),
    ).toThrow();
  });
});
