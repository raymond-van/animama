import { describe, expect, it } from "vitest";

import { buildSpeechTimingEvidence } from "@/lib/speech/speech-timing-evidence";
import {
  audioEnvelope,
  drawLipSyncTimeline,
  timelineWidth,
} from "./lipsync-debug-timeline";

describe("lip-sync debug timeline", () => {
  it("measures the peak level of each column across chunks", () => {
    const envelope = audioEnvelope(
      [new Int16Array([0, 16384, 0, 0]), new Int16Array([-32768, 0, 0, 8192])],
      8,
      4,
    );

    expect(Array.from(envelope)).toEqual([0.5, 0, 1, 0.25]);
  });

  it("scales with the audio but never narrower than the panel", () => {
    expect(timelineWidth(1, 300)).toBe(300);
    expect(timelineWidth(10, 300)).toBe(1200);
  });

  it("draws every lane and the playhead without a real canvas", () => {
    const calls: string[] = [];
    const context = new Proxy(
      {},
      {
        get: (_target, property) =>
          typeof property === "string" &&
          ["fillRect", "fillText", "stroke", "moveTo", "lineTo"].includes(
            property,
          )
            ? () => calls.push(property)
            : () => undefined,
        set: () => true,
      },
    ) as CanvasRenderingContext2D;
    const evidence = buildSpeechTimingEvidence(
      Array.from("[laughs] Hi.").map((char, index) => ({
        char,
        startSec: index / 10,
        endSec: (index + 1) / 10,
      })),
    );

    drawLipSyncTimeline(context, {
      width: 240,
      height: 168,
      durationSec: 1.2,
      envelope: new Float32Array(240).fill(0.5),
      evidence,
      curves: [
        {
          id: "estimated",
          color: "#3b82f6",
          points: [
            { timeSec: 0, openness: 0 },
            { timeSec: 0.5, openness: 1 },
          ],
        },
      ],
      playheadSec: 0.6,
      textColor: "#111",
    });

    expect(calls).toContain("fillRect");
    expect(calls).toContain("fillText");
    expect(calls.filter((call) => call === "stroke").length).toBeGreaterThan(1);
  });
});
