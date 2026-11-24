import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  clickThroughSupported,
  floatingWindowType,
  floatOnAllWorkspaces,
  linuxSessionType,
} from "../src/main-process/window/floating-window.js";

describe("floating windows", () => {
  it("uses a macOS panel and a Windows toolbar window", () => {
    expect(floatingWindowType("darwin")).toBe("panel");
    expect(floatingWindowType("win32")).toBe("toolbar");
    expect(floatingWindowType("linux")).toBe("toolbar");
  });

  it("tells an X11 session from a Wayland one", () => {
    expect(linuxSessionType({ XDG_SESSION_TYPE: "x11" })).toBe("x11");
    expect(linuxSessionType({ XDG_SESSION_TYPE: "wayland" })).toBe("wayland");
    // A session that does not say is Wayland if a compositor socket is named.
    expect(linuxSessionType({ WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
    expect(linuxSessionType({ XDG_SESSION_TYPE: "tty", DISPLAY: ":0" })).toBe(
      "x11",
    );
    expect(linuxSessionType({})).toBe("x11");
  });

  it("lets clicks through on macOS, Windows and Linux X11, never on Wayland", () => {
    expect(clickThroughSupported("darwin", {})).toBe(true);
    expect(clickThroughSupported("win32", {})).toBe(true);
    expect(clickThroughSupported("linux", { XDG_SESSION_TYPE: "x11" })).toBe(
      true,
    );
    // A Wayland app cannot see the pointer outside its own windows, so a
    // window that ignored the mouse could never take it back.
    expect(
      clickThroughSupported("linux", { XDG_SESSION_TYPE: "wayland" }),
    ).toBe(false);
    expect(
      clickThroughSupported("linux", { WAYLAND_DISPLAY: "wayland-1" }),
    ).toBe(false);
  });

  it("joins full-screen workspaces without hiding the app from the Dock", () => {
    const setVisibleOnAllWorkspaces = vi.fn();
    floatOnAllWorkspaces({
      setVisibleOnAllWorkspaces,
    } as unknown as BrowserWindow);
    expect(setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  });
});
