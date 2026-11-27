import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { App } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopDataRoot,
  prepareDesktopIdentity,
} from "../src/main-process/runtime/paths.js";

const roots: string[] = [];
function fixture(): string {
  // Private state refuses symlinked parents; macOS's temporary folder is one.
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "a-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("desktop data root", () => {
  const folders = { appData: "/home/owner/.config", home: "/home/owner" };

  it("keeps Linux data under the XDG data home", () => {
    // Expectations use the host's separator, like the code: only a Linux
    // host ever resolves this root for real.
    const fallback = path.join("/home/owner", ".local", "share", "Animama");
    expect(desktopDataRoot("linux", {}, folders)).toBe(fallback);
    expect(desktopDataRoot("linux", { XDG_DATA_HOME: "/data" }, folders)).toBe(
      path.join("/data", "Animama"),
    );
    // The XDG specification says a relative value is invalid and ignored.
    for (const value of ["data", "./data", ""])
      expect(desktopDataRoot("linux", { XDG_DATA_HOME: value }, folders)).toBe(
        fallback,
      );
  });

  it("leaves the macOS and Windows roots where they were", () => {
    const mac = {
      appData: "/Users/owner/Library/Application Support",
      home: "/Users/owner",
    };
    expect(desktopDataRoot("darwin", { XDG_DATA_HOME: "/data" }, mac)).toBe(
      path.join(mac.appData, "Animama"),
    );
    const windows = { appData: "C:\\Roaming", home: "C:\\Users\\owner" };
    expect(
      desktopDataRoot("win32", { LOCALAPPDATA: "C:\\Local" }, windows),
    ).toBe(path.join("C:\\Local", "Animama"));
    expect(desktopDataRoot("win32", {}, windows)).toBe(
      path.join("C:\\Roaming", "Animama"),
    );
  });
});

describe("Linux desktop identity", () => {
  function linuxApp(appData: string, home: string) {
    return {
      isPackaged: true,
      setName: vi.fn(),
      setPath: vi.fn(),
      getPath: (name: string) => (name === "home" ? home : appData),
    } as unknown as App & { setPath: ReturnType<typeof vi.fn> };
  }

  it("uses the data home and adopts nothing from the configuration folder", () => {
    const home = fixture();
    const appData = path.join(home, ".config");
    // Profiles earlier development runs left behind stay where they are.
    for (const name of ["Anima", "Animama"]) {
      mkdirSync(path.join(appData, name), { recursive: true });
      writeFileSync(path.join(appData, name, "keep"), "development profile");
    }
    const data = path.join(home, "xdg-data");
    vi.stubEnv("XDG_DATA_HOME", data);
    const app = linuxApp(appData, home);
    const paths = prepareDesktopIdentity(app, false, "linux");
    expect(paths.base).toBe(path.join(data, "Animama"));
    expect(app.setPath).toHaveBeenCalledWith("userData", paths.base);
    expect(paths.vault).toBe(path.join(data, "Animama/secrets/vault.bin"));
    for (const name of ["Anima", "Animama"])
      expect(readFileSync(path.join(appData, name, "keep"), "utf8")).toBe(
        "development profile",
      );
  });

  it("still honours the development profile override in an unpackaged run", () => {
    const home = fixture();
    const override = path.join(home, "profile");
    vi.stubEnv("ANIMAMA_DESKTOP_DEV_USER_DATA", override);
    const app = { ...linuxApp(path.join(home, ".config"), home) };
    (app as { isPackaged: boolean }).isPackaged = false;
    expect(
      prepareDesktopIdentity(app as unknown as App, false, "linux").base,
    ).toBe(override);
  });
});
