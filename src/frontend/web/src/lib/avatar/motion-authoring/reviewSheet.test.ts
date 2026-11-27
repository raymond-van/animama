import type { WebGLRenderer } from "three";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_REVIEW_SHEET_ROWS,
  renderIncludedAvatarReviewSheets,
  reviewSheetColumns,
} from "./reviewSheet";
import wave from "../../../../../../../content/included/gestures/wave-hello/wave-hello.json";

/**
 * What the app's entry refuses before it draws. The drawing itself needs
 * WebGL: `scripts/generation-trial.browser.test.mjs` compares its sheets with
 * `animation:render`'s in a real page.
 */
describe("renderIncludedAvatarReviewSheets", () => {
  /** A renderer that fails the test if the entry touches it. */
  const untouched = new Proxy({} as WebGLRenderer, {
    get(_target, property) {
      throw new Error(`The renderer's ${String(property)} was used.`);
    },
  });
  const request = (times: number[], clip: unknown = wave) => {
    const avatarFile = vi.fn(() => new ArrayBuffer(0));
    const sheets = renderIncludedAvatarReviewSheets({
      renderer: untouched,
      clip,
      times,
      avatarFile,
    });
    return { avatarFile, sheets };
  };

  it("refuses more rows than a frame review has, or none", async () => {
    const tooMany = request(
      Array.from({ length: MAX_REVIEW_SHEET_ROWS + 1 }, (_, index) => index),
    );
    await expect(tooMany.sheets).rejects.toThrow(RangeError);
    await expect(tooMany.sheets).rejects.toThrow("1 to 6 rows, not 7");
    expect(tooMany.avatarFile).not.toHaveBeenCalled();
    await expect(request([]).sheets).rejects.toThrow(RangeError);
  });

  it("refuses a time that is not a number of seconds from the start", async () => {
    for (const time of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const refused = request([0, time]);
      await expect(refused.sheets).rejects.toThrow(RangeError);
      expect(refused.avatarFile).not.toHaveBeenCalled();
    }
  });

  it("refuses a clip that cannot play before it reads any Avatar", async () => {
    const refused = request([0, 1], { ...wave, beats: [] });
    await expect(refused.sheets).rejects.toThrow("animaPoseClip/2.0");
    expect(refused.avatarFile).not.toHaveBeenCalled();
  });
});

describe("reviewSheetColumns", () => {
  it("keeps a Gesture's four views as they were", () => {
    expect(reviewSheetColumns("right")).toEqual([
      { name: "front", angle: 0, face: false },
      { name: "3/4 right", angle: -Math.PI / 4, face: false },
      { name: "right side", angle: -Math.PI / 2, face: false },
      { name: "face", angle: 0, face: true },
    ]);
    expect(reviewSheetColumns("left", "body").map(({ name }) => name)).toEqual([
      "front",
      "3/4 left",
      "left side",
      "face",
    ]);
    expect(reviewSheetColumns("right", "hands")).toHaveLength(4);
  });

  it("gives a Reaction face close-ups only: the front and three-quarters", () => {
    const columns = reviewSheetColumns("right", "face");
    expect(columns).toEqual([
      { name: "face", angle: 0, face: true },
      { name: "face 3/4 right", angle: -Math.PI / 4, face: true },
    ]);
    // No column shows the body, and the front face is the Gesture sheet's own.
    expect(columns.every((column) => column.face)).toBe(true);
    expect(columns[0]).toEqual(reviewSheetColumns("right").at(-1));
  });
});
