import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  createGlobalInputHook,
  nativeGlobalInputBindingPath,
  pressToTalkUnsupportedReason,
  validateNativeGlobalInputBinding,
  type NativeGlobalInputBinding,
} from "../src/main-process/shortcuts/global-input-hook.js";

function fixture({ permission = true } = {}) {
  let nativeCallback: ((down: boolean) => void) | undefined;
  const binding: NativeGlobalInputBinding = {
    isSupported: vi.fn(() => true),
    permissionGranted: vi.fn(() => permission),
    requestPermission: vi.fn(() => true),
    start: vi.fn((_shortcut, callback) => {
      nativeCallback = callback;
    }),
    stop: vi.fn(),
  };
  return { binding, emit: (down: boolean) => nativeCallback?.(down) };
}

const keyboard = {
  type: "keyboard" as const,
  code: "Backquote",
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  metaKey: false,
};

describe("first-party global input hook", () => {
  it("loads the native binary only from beside the bundled main process", () => {
    const main = path.resolve("/Applications/Animama/dist/main.js");
    expect(nativeGlobalInputBindingPath(pathToFileURL(main).href)).toBe(
      path.join(path.dirname(main), "native", "animama_input_hook.node"),
    );
    expect(() => validateNativeGlobalInputBinding({ start() {} })).toThrow(
      "invalid interface",
    );
  });

  it("reports permission and forwards only matched down/up transitions", () => {
    const current = fixture({ permission: false });
    const hook = createGlobalInputHook(current.binding);
    const listener = vi.fn();

    expect(hook.supported).toBe(true);
    expect(hook.requiresPermission).toBe(true);
    expect(hook.requestPermission()).toBe(true);
    hook.start(keyboard, listener);
    current.emit(true);
    current.emit(false);

    expect(current.binding.start).toHaveBeenCalledWith(
      keyboard,
      expect.any(Function),
    );
    expect(listener.mock.calls).toEqual([[true], [false]]);
  });

  it("retains an unchanged native registration and restarts a changed one", () => {
    const current = fixture();
    const hook = createGlobalInputHook(current.binding);
    const first = vi.fn();
    const replacement = vi.fn();

    hook.start(keyboard, first);
    hook.start(keyboard, replacement);
    current.emit(true);
    expect(current.binding.start).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledWith(true);

    hook.start({ ...keyboard, code: "Slash" }, replacement);
    expect(current.binding.stop).toHaveBeenCalledTimes(1);
    expect(current.binding.start).toHaveBeenCalledTimes(2);
    hook.stop();
    hook.stop();
    expect(current.binding.stop).toHaveBeenCalledTimes(2);
  });

  it("does not retain a stale registration after a native restart fails", () => {
    const current = fixture();
    const hook = createGlobalInputHook(current.binding);
    hook.start(keyboard, vi.fn());
    vi.mocked(current.binding.start).mockImplementationOnce(() => {
      throw new Error("native failure");
    });

    expect(() => hook.start({ ...keyboard, code: "Slash" }, vi.fn())).toThrow(
      "native failure",
    );
    hook.start(keyboard, vi.fn());

    expect(current.binding.start).toHaveBeenCalledTimes(3);
  });
});

describe("unsupported global Press to talk", () => {
  it("tells a Linux owner that the session, not the app, is the limit", () => {
    const linux = pressToTalkUnsupportedReason("linux");
    expect(linux).toContain("X11 session");
    expect(linux).toContain("Wayland");
    // The old wording named macOS and Windows as the only platforms.
    for (const platform of ["linux", "darwin", "win32"] as const)
      expect(pressToTalkUnsupportedReason(platform)).not.toMatch(
        /only on macOS and Windows/u,
      );
  });
});
