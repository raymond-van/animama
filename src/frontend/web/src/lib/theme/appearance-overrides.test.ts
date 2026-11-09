import { describe, expect, it } from "vitest";

import {
  buildAppearanceOverrideCss,
  normalizeHexColor,
  parseAppearanceOverrides,
  readableTextOn,
} from "./appearance-overrides";

describe("normalizeHexColor", () => {
  it("accepts #rrggbb, #rgb and a missing hash, normalized to lowercase", () => {
    expect(normalizeHexColor("#EDEDED")).toBe("#ededed");
    expect(normalizeHexColor("f80")).toBe("#ff8800");
    expect(normalizeHexColor("  #000000 ")).toBe("#000000");
  });

  it("rejects anything else", () => {
    for (const value of ["", "#12345", "red", "#gggggg", 12, null, undefined]) {
      expect(normalizeHexColor(value)).toBeNull();
    }
  });
});

describe("parseAppearanceOverrides", () => {
  it("keeps valid colours per mode and drops invalid or unknown values", () => {
    expect(
      parseAppearanceOverrides({
        light: { accent: "#FF6600", background: "nope", extra: "#000000" },
        dark: { foreground: "#ededed" },
        custom: { accent: "#000000" },
      }),
    ).toEqual({
      light: { accent: "#ff6600" },
      dark: { foreground: "#ededed" },
    });
  });

  it("returns no overrides for missing or malformed preferences", () => {
    expect(parseAppearanceOverrides(undefined)).toEqual({});
    expect(parseAppearanceOverrides("dark")).toEqual({});
    expect(parseAppearanceOverrides({ light: "#fff" })).toEqual({});
  });
});

describe("readableTextOn", () => {
  it("chooses black on light colours and white on dark colours", () => {
    expect(readableTextOn("#ffd166")).toBe("#000000");
    expect(readableTextOn("#1d3557")).toBe("#ffffff");
  });
});

describe("buildAppearanceOverrideCss", () => {
  it("is empty without overrides", () => {
    expect(buildAppearanceOverrideCss({})).toBe("");
  });

  it("scopes light and dark overrides to their own mode", () => {
    const css = buildAppearanceOverrideCss({
      light: { primary: "#ff6600" },
      dark: { background: "#000000" },
    });
    const [light, dark] = css.split("\n");
    expect(light).toMatch(/^:root:not\(\.dark\) \{/);
    expect(light).toContain("--primary: #ff6600;");
    expect(light).toContain("--primary-foreground: #000000;");
    expect(light).not.toContain("--background:");
    expect(dark).toMatch(/^:root\.dark \{/);
    expect(dark).toContain("--background: #000000;");
    // Derived surfaces follow a custom background.
    expect(dark).toContain("--card: color-mix(");
    expect(dark).not.toContain("--primary:");
  });

  it("sets secondary and accent with readable text colours", () => {
    const css = buildAppearanceOverrideCss({
      light: { secondary: "#1d3557", accent: "#ffd166" },
    });
    expect(css).toContain("--secondary: #1d3557;");
    expect(css).toContain("--secondary-foreground: #ffffff;");
    expect(css).toContain("--accent: #ffd166;");
    expect(css).toContain("--sidebar-accent: #ffd166;");
    expect(css).toContain("--accent-foreground: #000000;");
  });

  it("draws custom-coloured chat bubbles solid", () => {
    // Black text (light colour) and white text (dark colour) alike: the text
    // colour is chosen for a solid fill, which glass could wash out.
    const css = buildAppearanceOverrideCss({
      light: { primary: "#e05a9a", secondary: "#1d3557" },
    });
    expect(css).toContain("--bubble-user: #e05a9a;");
    expect(css).toContain("--bubble-user-glass: 0;");
    expect(css).toContain("--bubble-anima: #1d3557;");
    expect(css).toContain("--bubble-anima-glass: 0;");
  });

  it("keeps the default glass bubble for a role without an override", () => {
    const css = buildAppearanceOverrideCss({ light: { accent: "#ffd166" } });
    expect(css).not.toContain("--bubble-");
  });

  it("lets advanced colours win over derived and basic values", () => {
    const css = buildAppearanceOverrideCss({
      dark: {
        background: "#000000",
        primary: "#ff6600",
        border: "#333333",
        ring: "#00ff00",
      },
    });
    const derivedBorder = css.indexOf("--border: color-mix(");
    const explicitBorder = css.indexOf("--border: #333333;");
    expect(derivedBorder).toBeGreaterThan(-1);
    expect(explicitBorder).toBeGreaterThan(derivedBorder);
    expect(css.indexOf("--ring: #00ff00;")).toBeGreaterThan(
      css.indexOf("--ring: #ff6600;"),
    );
  });
});
