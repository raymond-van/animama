import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { symlinksAvailable } from "./fixtures/symlinks.mjs";

import {
  keepLocalizedTitle,
  readCachedLocale,
  ShellLocale,
  shellStrings,
} from "../src/main-process/locale/shell-locale.js";
import {
  applicationMenuTemplate,
  MENU_COMMAND_TTL_MS,
  PendingMenuCommand,
} from "../src/main-process/ui/application-menu.js";

vi.mock("electron", () => ({ Menu: {} }));
// A beta catalog with a missing key, to show the English fallback.
vi.mock("../src/locales/ko.json", () => ({
  default: { menu: { file: "파일" } },
}));

const roots: string[] = [];
function cacheFile(): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "shell-locale-"));
  roots.push(root);
  return path.join(root, "ui-locale.json");
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("shell strings", () => {
  it("translate, interpolate and fall back to English for a missing key", () => {
    expect(shellStrings("ja").text("menu.about", { name: "Animama" })).toBe(
      "Animama について",
    );
    expect(shellStrings("ko").text("menu.file")).toBe("파일");
    expect(shellStrings("ko").text("menu.edit")).toBe("Edit");
    // An unknown placeholder name stays visible rather than vanishing.
    expect(shellStrings("en").text("menu.about")).toBe("About {{name}}");
    expect(shellStrings("zh-Hant")).toMatchObject({
      locale: "zh-Hant",
      dir: "ltr",
    });
  });
});

describe("shell locale resolution and cache", () => {
  it("follows the OS languages on first launch, then the last applied locale", () => {
    const file = cacheFile();
    expect(new ShellLocale(file, () => ["fr-FR", "zh-TW"]).strings.locale).toBe(
      "zh-Hant",
    );
    expect(new ShellLocale(file, () => ["fr-FR"]).strings.locale).toBe("en");

    new ShellLocale(file, () => ["en-US"]).apply("ja");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      locale: "ja",
    });
    // A restart with the backend stopped still knows the applied locale.
    expect(new ShellLocale(file, () => ["ko-KR"]).strings.locale).toBe("ja");
  });

  it.each([
    ["malformed JSON", "{"],
    ["another version", JSON.stringify({ version: 2, locale: "ja" })],
    ["a legacy tag", JSON.stringify({ version: 1, locale: "en-US" })],
    ["the pseudo-locale", JSON.stringify({ version: 1, locale: "en-XA" })],
    [
      "an oversized file",
      JSON.stringify({ version: 1, locale: "ja", pad: "x".repeat(2048) }),
    ],
  ])(
    "ignores %s and repairs it on the next applied locale",
    (_name, content) => {
      const file = cacheFile();
      writeFileSync(file, content);
      expect(readCachedLocale(file)).toBeNull();
      const locale = new ShellLocale(file, () => ["ko-KR"]);
      expect(locale.strings.locale).toBe("ko");
      locale.apply("ko");
      expect(readCachedLocale(file)).toBe("ko");
    },
  );

  it("never reads a directory or a link in place of the cache", () => {
    const directory = cacheFile();
    mkdirSync(directory);
    expect(readCachedLocale(directory)).toBeNull();
    if (!symlinksAvailable) return;
    const target = cacheFile();
    writeFileSync(target, JSON.stringify({ version: 1, locale: "ja" }));
    const link = cacheFile();
    symlinkSync(target, link);
    expect(readCachedLocale(link)).toBeNull();
  });

  it("announces only real changes and still switches when the cache cannot be written", () => {
    const file = cacheFile();
    mkdirSync(file); // atomicWrite refuses to replace a directory
    const locale = new ShellLocale(file, () => ["en-US"]);
    const changes: string[] = [];
    locale.onChange((strings) => changes.push(strings.locale));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    locale.apply("en");
    locale.apply("zh-Hans");
    locale.apply("zh-Hans");
    expect(changes).toEqual(["zh-Hans"]);
    expect(locale.strings.text("menu.window")).toBe("窗口");
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("Locale cache write failed"),
    );
  });
});

describe("localized window titles", () => {
  it("title from the catalog, ignore the page title and follow locale changes until closed", () => {
    const file = cacheFile();
    const locale = new ShellLocale(file, () => ["ja-JP"]);
    const handlers = new Map<string, (event?: unknown) => void>();
    let destroyed = false;
    const window = {
      setTitle: vi.fn(),
      isDestroyed: () => destroyed,
      on: (name: string, handler: (event?: unknown) => void) =>
        handlers.set(name, handler),
      once: (name: string, handler: (event?: unknown) => void) =>
        handlers.set(name, handler),
    };
    keepLocalizedTitle(window as never, locale, "windows.quickChat");
    expect(window.setTitle).toHaveBeenLastCalledWith("Anima クイックチャット");
    const preventDefault = vi.fn();
    handlers.get("page-title-updated")!({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    locale.apply("zh-Hant");
    expect(window.setTitle).toHaveBeenLastCalledWith("Anima 快速聊天");
    handlers.get("closed")!();
    destroyed = true;
    locale.apply("en");
    expect(window.setTitle).toHaveBeenCalledTimes(2);
  });
});

/** Labels and roles only, separators as "-", so trees compare readably. */
function outline(items: MenuItemConstructorOptions[]): unknown[] {
  return items.map((item) =>
    item.type === "separator"
      ? "-"
      : {
          ...(item.role ? { role: item.role } : {}),
          label: item.label,
          ...(Array.isArray(item.submenu)
            ? { submenu: outline(item.submenu) }
            : {}),
        },
  );
}

describe("application menu", () => {
  it("keeps Electron's default macOS menu, roles and English labels", () => {
    expect(
      outline(applicationMenuTemplate(shellStrings("en"), "darwin", "Animama")),
    ).toEqual([
      {
        role: "appMenu",
        label: "Animama",
        submenu: [
          { role: "about", label: "About Animama" },
          "-",
          { role: "services", label: "Services" },
          "-",
          { role: "hide", label: "Hide Animama" },
          { role: "hideOthers", label: "Hide Others" },
          { role: "unhide", label: "Show All" },
          "-",
          { role: "quit", label: "Quit Animama" },
        ],
      },
      {
        role: "fileMenu",
        label: "File",
        submenu: [{ role: "close", label: "Close Window" }],
      },
      {
        role: "editMenu",
        label: "Edit",
        submenu: [
          { role: "undo", label: "Undo" },
          { role: "redo", label: "Redo" },
          "-",
          { role: "cut", label: "Cut" },
          { role: "copy", label: "Copy" },
          { role: "paste", label: "Paste" },
          { role: "pasteAndMatchStyle", label: "Paste and Match Style" },
          { role: "delete", label: "Delete" },
          { role: "selectAll", label: "Select All" },
          "-",
          {
            label: "Substitutions",
            submenu: [
              { role: "showSubstitutions", label: "Show Substitutions" },
              "-",
              { role: "toggleSmartQuotes", label: "Smart Quotes" },
              { role: "toggleSmartDashes", label: "Smart Dashes" },
              { role: "toggleTextReplacement", label: "Text Replacement" },
            ],
          },
          {
            label: "Speech",
            submenu: [
              { role: "startSpeaking", label: "Start Speaking" },
              { role: "stopSpeaking", label: "Stop Speaking" },
            ],
          },
        ],
      },
      {
        role: "viewMenu",
        label: "View",
        submenu: [
          { role: "reload", label: "Reload" },
          { role: "forceReload", label: "Force Reload" },
          { role: "toggleDevTools", label: "Toggle Developer Tools" },
          "-",
          { role: "resetZoom", label: "Actual Size" },
          { role: "zoomIn", label: "Zoom In" },
          { role: "zoomOut", label: "Zoom Out" },
          "-",
          { role: "togglefullscreen", label: "Toggle Full Screen" },
        ],
      },
      {
        role: "windowMenu",
        label: "Window",
        submenu: [
          { role: "minimize", label: "Minimize" },
          { role: "zoom", label: "Zoom" },
          "-",
          { role: "front", label: "Bring All to Front" },
        ],
      },
      { role: "help", label: "Help", submenu: [] },
    ]);
  });

  it("offers Check for Updates and Import Anima only when the shell can act on them", () => {
    const checkForUpdates = vi.fn();
    const importAnima = vi.fn();
    const menus = (platform: NodeJS.Platform, commands = {}) =>
      applicationMenuTemplate(
        shellStrings("en"),
        platform,
        "Animama",
        true,
        commands,
      );
    const submenu = (items: MenuItemConstructorOptions[], role: string) =>
      items.find((menu) => menu.role === role)!
        .submenu as MenuItemConstructorOptions[];

    // macOS: Check for Updates sits under About; Import Anima opens File.
    const mac = menus("darwin", { checkForUpdates, importAnima });
    expect(outline(submenu(mac, "appMenu")).slice(0, 3)).toEqual([
      { role: "about", label: "About Animama" },
      { label: "Check for Updates…" },
      "-",
    ]);
    expect(outline(submenu(mac, "fileMenu"))).toEqual([
      { label: "Import Anima…" },
      "-",
      { role: "close", label: "Close Window" },
    ]);
    expect(submenu(mac, "help")).toEqual([]);
    submenu(mac, "appMenu")[1]!.click!({} as never, undefined, {} as never);
    submenu(mac, "fileMenu")[0]!.click!({} as never, undefined, {} as never);
    expect(checkForUpdates).toHaveBeenCalledOnce();
    expect(importAnima).toHaveBeenCalledOnce();

    // Without an application menu, Help holds the update check. Windows
    // builds this menu too, though its main window shows no menu bar.
    const windows = menus("win32", { checkForUpdates, importAnima });
    expect(outline(submenu(windows, "help"))).toEqual([
      { label: "Check for Updates…" },
    ]);
    expect(outline(submenu(windows, "fileMenu"))).toEqual([
      { label: "Import Anima…" },
      "-",
      { role: "quit", label: "Exit" },
    ]);

    // A build that cannot update offers no check.
    const sealed = menus("darwin", { importAnima });
    expect(JSON.stringify(outline(sealed))).not.toContain("Check for Updates");
    expect(outline(submenu(sealed, "fileMenu"))[0]).toEqual({
      label: "Import Anima…",
    });

    // The translated catalogs word both items (ko is the stub above).
    for (const locale of ["ja", "zh-Hans", "zh-Hant"] as const) {
      const labels = (key: "menu.checkForUpdates" | "menu.importAnima") =>
        shellStrings(locale).text(key);
      expect(labels("menu.checkForUpdates")).not.toBe("Check for Updates…");
      expect(labels("menu.importAnima")).not.toBe("Import Anima…");
      expect(labels("menu.importAnima")).toContain("Anima");
    }
  });

  it("keeps a chosen command for the app's window to take once, while fresh", () => {
    let now = 1_000;
    const pending = new PendingMenuCommand(() => now);
    expect(pending.take()).toBeNull();

    pending.set("check-for-updates");
    pending.set("import-anima");
    now += MENU_COMMAND_TTL_MS;
    // The latest choice wins, and it is handed over only once.
    expect(pending.take()).toBe("import-anima");
    expect(pending.take()).toBeNull();

    // A command chosen during first-run setup must not fire when setup ends.
    pending.set("import-anima");
    now += MENU_COMMAND_TTL_MS + 1;
    expect(pending.take()).toBeNull();
  });

  it.each(["darwin", "win32"] as const)(
    "drops the DevTools item from a packaged build's View menu on %s",
    (platform) => {
      const view = (packaged: boolean) =>
        outline(
          applicationMenuTemplate(
            shellStrings("en"),
            platform,
            "Animama",
            packaged,
          ),
        ).find((menu) => (menu as { role?: string }).role === "viewMenu") as {
          submenu: unknown[];
        };
      const roles = (packaged: boolean) =>
        view(packaged).submenu.map((item) => (item as { role?: string }).role);

      expect(roles(false)).toContain("toggleDevTools");
      expect(roles(true)).not.toContain("toggleDevTools");
      expect(roles(true)).toContain("reload");
    },
  );

  it("keeps the Windows menu bar's items, with Exit, and localizes every label", () => {
    const english = applicationMenuTemplate(
      shellStrings("en"),
      "win32",
      "Animama",
    );
    expect(
      outline(english).map((menu) => (menu as { role: string }).role),
    ).toEqual(["fileMenu", "editMenu", "viewMenu", "windowMenu", "help"]);
    expect(outline(english)[0]).toEqual({
      role: "fileMenu",
      label: "File",
      submenu: [{ role: "quit", label: "Exit" }],
    });
    expect(outline(english)[1]).toMatchObject({
      submenu: [
        { role: "undo" },
        { role: "redo" },
        "-",
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "delete" },
        "-",
        { role: "selectAll" },
      ],
    });
    expect(outline(english)[3]).toMatchObject({
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "close", label: "Close" },
      ],
    });
    expect(
      applicationMenuTemplate(shellStrings("en"), "linux", "Animama")[0]!
        .submenu,
    ).toEqual([{ role: "quit", label: "Quit" }]);

    // Same roles in Japanese; no English label is left except the app name.
    const japanese = applicationMenuTemplate(
      shellStrings("ja"),
      "darwin",
      "Animama",
    );
    const labels = [
      ...JSON.stringify(outline(japanese)).matchAll(/"label":"([^"]*)"/gu),
    ].map(([, label]) => label!);
    expect(labels).toHaveLength(39);
    expect(
      labels.filter((label) => /[A-Za-z]/u.test(label.replace("Animama", ""))),
    ).toEqual([]);
    const roles = (tree: MenuItemConstructorOptions[]) =>
      JSON.stringify(outline(tree)).match(/"role":"[^"]*"/gu);
    expect(roles(japanese)).toEqual(
      roles(applicationMenuTemplate(shellStrings("en"), "darwin", "Animama")),
    );
    expect(outline(japanese)[0]).toMatchObject({
      submenu: expect.arrayContaining([
        { role: "quit", label: "Animama を終了" },
      ]),
    });
  });
});
