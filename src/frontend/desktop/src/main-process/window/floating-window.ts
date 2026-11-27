import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

/**
 * Window type for the always-on-top PiP and Quick Chat windows. On macOS a
 * non-activating panel floats over other apps' full-screen spaces by itself;
 * elsewhere `toolbar` keeps the window off the Windows taskbar.
 */
export function floatingWindowType(
  platform: NodeJS.Platform = process.platform,
): BrowserWindowConstructorOptions["type"] {
  return platform === "darwin" ? "panel" : "toolbar";
}

/** The kind of Linux desktop session, from the variables the session sets. */
export function linuxSessionType(env: NodeJS.ProcessEnv): "x11" | "wayland" {
  return env.XDG_SESSION_TYPE === "wayland" ||
    (env.XDG_SESSION_TYPE !== "x11" && Boolean(env.WAYLAND_DISPLAY))
    ? "wayland"
    : "x11";
}

/**
 * Whether PiP and Quick Chat may pass clicks through their empty area. The
 * main process decides that from the pointer's position on the whole screen,
 * which a Wayland app cannot read outside its own windows: a window that
 * ignored the mouse there could never take it back.
 */
export function clickThroughSupported(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform !== "linux" || linuxSessionType(env) === "x11";
}

/** Keep a floating window on every workspace, including full-screen ones. */
export function floatOnAllWorkspaces(window: BrowserWindow): void {
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    // Otherwise Electron calls `app.dock.hide()` on macOS, which leaves the
    // whole app out of the Dock and Command-Tab. The panel type above already
    // lets the window float over full-screen apps.
    skipTransformProcessType: true,
  });
}
