import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFile(new URL(path, import.meta.url), "utf8");

describe("application entrypoints", () => {
  it("load the theme's DM Sans font in both compositions", async () => {
    const [theme, local, hosted] = await Promise.all([
      source("../styles/globals.css"),
      source("../main.local.tsx"),
      source("../main.hosted.tsx"),
    ]);
    expect(theme).toContain('"DM Sans Variable"');
    for (const entry of [local, hosted])
      expect(entry).toContain('import "@fontsource-variable/dm-sans";');
  });

  it("import application modules only after i18n exists", async () => {
    // Code that runs while a module loads may translate; a static import of the
    // application would run it before i18n exists and blank the app.
    const allowed = [
      "@fontsource-variable/dm-sans",
      "react",
      "react-dom/client",
      "@web/i18n/locale-preference",
      "@web/i18n/web-i18n",
      "./i18n/locale-preference",
      "./i18n/web-i18n",
      "./app/hosted-runtime/hosted-context",
      "@animama/product-ui/styles.css",
      "./index.css",
    ];
    for (const entry of await Promise.all([
      source("../main.local.tsx"),
      source("../main.hosted.tsx"),
    ])) {
      const staticImports = [
        ...entry.matchAll(/^import\s+(?:[^"']*\sfrom\s+)?["']([^"']+)["']/gm),
      ].map((match) => match[1]);
      expect(staticImports.length).toBeGreaterThan(0);
      for (const specifier of staticImports)
        expect(allowed, specifier).toContain(specifier);
      expect(entry).toMatch(/import\("(?:@web|\.)\/app\/router"\)/);
      // Stylesheet order matches the static graph before i18n moved first:
      // product UI, then the app's own CSS, whose utilities must win.
      expect(
        staticImports.filter((specifier) => specifier.endsWith(".css")),
      ).toEqual(["@animama/product-ui/styles.css", "./index.css"]);
    }
    // The one early application-path helper only parses display hints and
    // reads same-origin context; it cannot load application or i18n modules.
    const context = await source("./hosted-runtime/hosted-context.ts");
    const contextImports = [
      ...context.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g),
    ].map((match) => match[1]);
    expect(contextImports).toEqual(["@animama/runtime-contracts/locale"]);
  });
});
