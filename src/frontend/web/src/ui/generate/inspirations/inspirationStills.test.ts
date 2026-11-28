import { describe, expect, it } from "vitest";

import { inspirationStillFrames, restingFrame } from "./inspirationStills";

describe("an inspiration's still", () => {
  it("cuts the front view's tile of each row from a Gesture's sheet", () => {
    // A sheet of six rows: a label column, a header row, four views a row.
    const frames = inspirationStillFrames({ width: 944, height: 2008 }, 6);
    expect(frames).toHaveLength(6);
    expect(frames[0]).toEqual({ x: 64, y: 28, width: 220, height: 330 });
    expect(frames[5]).toEqual({ x: 64, y: 1678, width: 220, height: 330 });
  });

  it("reads a sheet of any number of rows", () => {
    expect(inspirationStillFrames({ width: 944, height: 358 }, 1)).toEqual([
      { x: 64, y: 28, width: 220, height: 330 },
    ]);
  });

  it("cuts nothing from a sheet that is not a Gesture's", () => {
    // Narrower than four views, or shorter than its rows.
    expect(inspirationStillFrames({ width: 500, height: 2008 }, 6)).toEqual([]);
    expect(inspirationStillFrames({ width: 944, height: 300 }, 6)).toEqual([]);
    expect(inspirationStillFrames({ width: 944, height: 2008 }, 0)).toEqual([]);
  });

  it("rests on the beat in the middle of the clip", () => {
    expect(restingFrame(1)).toBe(0);
    expect(restingFrame(2)).toBe(1);
    expect(restingFrame(5)).toBe(2);
    expect(restingFrame(6)).toBe(3);
  });
});
