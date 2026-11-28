import { describe, expect, it } from "vitest";

import fixture from "./fixtures/style-presets.json";
import { GENERATION_STYLE_PRESETS, knownStylePreset } from "./stylePresets";

describe("the page's style presets", () => {
  it("are the backend's, in its order", () => {
    // The backend is tested against the same file.
    expect([...GENERATION_STYLE_PRESETS]).toEqual(fixture.presets);
  });

  it("read a stored id the page does not list as no style", () => {
    for (const preset of GENERATION_STYLE_PRESETS)
      expect(knownStylePreset(preset)).toBe(preset);
    expect(knownStylePreset("noir_detective")).toBeNull();
    expect(knownStylePreset("")).toBeNull();
    expect(knownStylePreset(null)).toBeNull();
    expect(knownStylePreset(undefined)).toBeNull();
    // Never an inherited property name.
    expect(knownStylePreset("toString")).toBeNull();
  });
});
