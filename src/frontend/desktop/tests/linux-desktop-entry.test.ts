import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopEntry,
  entryState,
  entryTarget,
  LinuxDesktopEntries,
  xdgFolder,
} from "../src/main-process/login-item/linux-desktop-entry.js";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "animama-entry-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Linux desktop entries", () => {
  it("resolves XDG folders, ignoring a relative value", () => {
    const home = "/home/owner";
    expect(xdgFolder({}, "XDG_CONFIG_HOME", home)).toBe(
      path.join(home, ".config"),
    );
    expect(xdgFolder({}, "XDG_DATA_HOME", home)).toBe(
      path.join(home, ".local", "share"),
    );
    expect(xdgFolder({ XDG_DATA_HOME: "/data" }, "XDG_DATA_HOME", home)).toBe(
      "/data",
    );
    expect(xdgFolder({ XDG_DATA_HOME: "data" }, "XDG_DATA_HOME", home)).toBe(
      path.join(home, ".local", "share"),
    );
  });

  it.each([
    "/home/owner/Apps/Animama-0.1.6-x86_64.AppImage",
    "/home/owner/My Apps/Animama.AppImage",
    '/tmp/a "quoted" name.AppImage',
    "/tmp/cost$HOME`id`.AppImage",
    "/tmp/back\\slash.AppImage",
    "/tmp/100%done.AppImage",
    "/tmp/naïve-名前.AppImage",
  ])("writes %s so that a launcher runs exactly that file", (appImage) => {
    const text = desktopEntry({ name: "Animama", exec: appImage });
    expect(text.startsWith("[Desktop Entry]\n")).toBe(true);
    expect(text).toContain("\nType=Application\n");
    expect(text).toContain("\nName=Animama\n");
    expect(text).toContain("\nTerminal=false\n");
    // One Exec line, one quoted argument, and never a sandbox switch.
    const exec = text.split("\n").filter((line) => line.startsWith("Exec="));
    expect(exec).toHaveLength(1);
    expect(exec[0]).toMatch(/^Exec="[^\n]*"$/u);
    expect(text).not.toContain("--no-sandbox");
    expect(entryTarget(text)).toBe(appImage);
  });

  it("refuses a path that a desktop entry cannot carry", () => {
    for (const bad of ["/tmp/line\nbreak.AppImage", "/tmp/nul\0.AppImage", ""])
      expect(() => desktopEntry({ name: "Animama", exec: bad })).toThrow(
        "desktop_entry_path_invalid",
      );
    expect(() =>
      desktopEntry({ name: "Animama", exec: "relative.AppImage" }),
    ).toThrow("desktop_entry_path_invalid");
  });

  it("escapes a literal percent, which Exec would read as a field code", () => {
    expect(
      desktopEntry({ name: "Animama", exec: "/tmp/100%done.AppImage" }),
    ).toContain('Exec="/tmp/100%%done.AppImage"');
  });

  it("carries an icon and extra keys when given", () => {
    const text = desktopEntry({
      name: "Animama",
      exec: "/tmp/Animama.AppImage",
      icon: "com.animama.desktop",
      extra: { Categories: "Utility;", StartupWMClass: "Animama" },
    });
    expect(text).toContain("\nIcon=com.animama.desktop\n");
    expect(text).toContain("\nCategories=Utility;\n");
    expect(text).toContain("\nStartupWMClass=Animama\n");
  });

  it("reads nothing from an entry it did not write", () => {
    expect(entryTarget("")).toBeNull();
    expect(entryTarget("[Desktop Entry]\nName=Other\n")).toBeNull();
    // Unquoted or multi-argument commands are not ours.
    expect(
      entryTarget("[Desktop Entry]\nExec=/usr/bin/foo --bar\n"),
    ).toBeNull();
  });

  it("tells an absent, current and stale entry apart", () => {
    const root = fixture();
    const file = path.join(root, "entry.desktop");
    const current = "/apps/Animama.AppImage";
    expect(entryState(file, current)).toBe("absent");
    writeFileSync(file, desktopEntry({ name: "Animama", exec: current }));
    expect(entryState(file, current)).toBe("current");
    // The AppImage was moved or replaced by a file with another name.
    expect(entryState(file, "/apps/new/Animama.AppImage")).toBe("stale");
    writeFileSync(file, "not a desktop entry");
    expect(entryState(file, current)).toBe("stale");
  });
});

describe("Linux autostart and application-menu entries", () => {
  function entries(appImage: string | undefined, isPackaged = true) {
    const home = fixture();
    const icon = path.join(home, "resources-icon.png");
    writeFileSync(icon, "png-bytes");
    return {
      home,
      entries: new LinuxDesktopEntries({
        isPackaged,
        appImage,
        env: {},
        home,
        iconSource: icon,
      }),
      autostart: path.join(
        home,
        ".config/autostart/com.animama.desktop.desktop",
      ),
      menu: path.join(
        home,
        ".local/share/applications/com.animama.desktop.desktop",
      ),
      icon: path.join(
        home,
        ".local/share/icons/hicolor/512x512/apps/com.animama.desktop.png",
      ),
    };
  }

  it("is unavailable unless the packaged app runs from an AppImage", () => {
    for (const current of [
      entries(undefined).entries,
      entries("/apps/Animama.AppImage", false).entries,
    ]) {
      expect(current.loginItem()).toEqual({ available: false });
      expect(current.menuEntry()).toEqual({ available: false });
      expect(() => current.setLoginItem(true)).toThrow("feature_unavailable");
      expect(() => current.setMenuEntry(true)).toThrow("feature_unavailable");
    }
  });

  it("turns Launch at login on and off through an autostart entry", () => {
    const current = entries("/apps/Animama.AppImage");
    expect(current.entries.loginItem()).toEqual({
      available: true,
      enabled: false,
      blockedBySystem: false,
    });
    expect(current.entries.setLoginItem(true)).toEqual({
      available: true,
      enabled: true,
      blockedBySystem: false,
    });
    expect(entryTarget(readFileSync(current.autostart, "utf8"))).toBe(
      "/apps/Animama.AppImage",
    );
    // Readable by the session that starts it, writable only by the owner.
    expect(statSync(current.autostart).mode & 0o777).toBe(0o644);
    expect(existsSync(current.menu)).toBe(false);
    expect(current.entries.setLoginItem(false)).toMatchObject({
      enabled: false,
    });
    expect(existsSync(current.autostart)).toBe(false);
    // Turning it off twice is not an error.
    expect(current.entries.setLoginItem(false)).toMatchObject({
      enabled: false,
    });
  });

  it("shows that Launch at login will not take effect after the file moved", () => {
    const current = entries("/apps/new/Animama.AppImage");
    mkdirSync(path.dirname(current.autostart), { recursive: true });
    writeFileSync(
      current.autostart,
      desktopEntry({ name: "Animama", exec: "/apps/old/Animama.AppImage" }),
    );
    expect(current.entries.loginItem()).toEqual({
      available: true,
      enabled: true,
      blockedBySystem: true,
    });
    // Turning it on again points it at the running file.
    expect(current.entries.setLoginItem(true)).toEqual({
      available: true,
      enabled: true,
      blockedBySystem: false,
    });
  });

  it("adds and removes the application-menu entry and its icon", () => {
    const current = entries("/apps/Animama.AppImage");
    expect(current.entries.menuEntry()).toEqual({
      available: true,
      enabled: false,
      stale: false,
    });
    // Nothing exists until the setting is turned on.
    expect(existsSync(current.menu)).toBe(false);
    expect(existsSync(current.icon)).toBe(false);
    expect(current.entries.setMenuEntry(true)).toEqual({
      available: true,
      enabled: true,
      stale: false,
    });
    const text = readFileSync(current.menu, "utf8");
    expect(entryTarget(text)).toBe("/apps/Animama.AppImage");
    expect(text).toContain("\nIcon=com.animama.desktop\n");
    expect(text).not.toContain("--no-sandbox");
    expect(readFileSync(current.icon, "utf8")).toBe("png-bytes");
    expect(current.entries.setMenuEntry(false)).toMatchObject({
      enabled: false,
    });
    expect(existsSync(current.menu)).toBe(false);
    expect(existsSync(current.icon)).toBe(false);
  });

  it("reports a moved AppImage and repoints the menu entry when turned on again", () => {
    const current = entries("/apps/new/Animama.AppImage");
    mkdirSync(path.dirname(current.menu), { recursive: true });
    writeFileSync(
      current.menu,
      desktopEntry({ name: "Animama", exec: "/apps/old/Animama.AppImage" }),
    );
    expect(current.entries.menuEntry()).toEqual({
      available: true,
      enabled: true,
      stale: true,
    });
    expect(current.entries.setMenuEntry(true)).toEqual({
      available: true,
      enabled: true,
      stale: false,
    });
    expect(entryTarget(readFileSync(current.menu, "utf8"))).toBe(
      "/apps/new/Animama.AppImage",
    );
  });

  it("honours absolute XDG folders", () => {
    const home = fixture();
    const config = path.join(home, "cfg");
    const data = path.join(home, "dat");
    const current = new LinuxDesktopEntries({
      isPackaged: true,
      appImage: "/apps/Animama.AppImage",
      env: { XDG_CONFIG_HOME: config, XDG_DATA_HOME: data },
      home,
      iconSource: path.join(home, "missing-icon.png"),
    });
    current.setLoginItem(true);
    // A missing icon source still leaves a working entry.
    current.setMenuEntry(true);
    expect(
      existsSync(path.join(config, "autostart/com.animama.desktop.desktop")),
    ).toBe(true);
    expect(
      existsSync(path.join(data, "applications/com.animama.desktop.desktop")),
    ).toBe(true);
  });
});
