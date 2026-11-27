import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every backend (and creator-made) diagnostic code the interface words, by
// `errors` catalog area. A code worded here must be worded in every locale.
const LOCALES = ["en", "ja", "ko", "zh-Hans", "zh-Hant"] as const;

type Catalog = Record<string, Record<string, unknown> | undefined>;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
}

const codes = readJson<Record<string, string[]>>("./userVisibleCodes.json");
const catalogs = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    readJson<Catalog>(`../../locales/${locale}/errors.json`),
  ]),
) as Record<(typeof LOCALES)[number], Catalog>;

/** A code's wording: its key, or the `_other` plural form for a counted message. */
function wording(catalog: Catalog, area: string, code: string): unknown {
  const entries = catalog[area];
  return entries?.[code] ?? entries?.[`${code}_other`];
}

describe("user-visible diagnostic codes", () => {
  it("lists codes for every wording area", () => {
    expect(Object.keys(codes).sort()).toEqual([
      "contentSave",
      "creation",
      "generation",
      "loadout",
      "modelConfiguration",
      "profile",
      "sharing",
      "uploads",
      "webSearch",
    ]);
    for (const list of Object.values(codes))
      expect(list.length).toBeGreaterThan(0);
  });

  it.each(LOCALES)("are all worded in %s", (locale) => {
    const unworded = Object.entries(codes).flatMap(([area, list]) =>
      list
        .filter((code) => {
          const text = wording(catalogs[locale], area, code);
          return typeof text !== "string" || !text.trim();
        })
        .map((code) => `${area}.${code}`),
    );
    expect(unworded).toEqual([]);
  });
});
