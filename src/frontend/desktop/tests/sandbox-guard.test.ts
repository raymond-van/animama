import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  refuseDisabledSandbox,
  sandboxDisabled,
} from "../src/main-process/security/sandbox-guard.js";

const withSwitches =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name);

describe("packaged Linux sandbox guard", () => {
  it.each([
    "no-sandbox",
    "disable-gpu-sandbox",
    "disable-seccomp-filter-sandbox",
  ])("refuses a packaged Linux app started with --%s", (name) => {
    expect(
      sandboxDisabled({
        isPackaged: true,
        platform: "linux",
        hasSwitch: withSwitches(name),
      }),
    ).toBe(true);
  });

  it("allows a sandboxed launch, unpackaged development and other platforms", () => {
    expect(
      sandboxDisabled({
        isPackaged: true,
        platform: "linux",
        hasSwitch: withSwitches("password-store", "enable-features"),
      }),
    ).toBe(false);
    // Development keeps its explicit diagnostic switch.
    expect(
      sandboxDisabled({
        isPackaged: false,
        platform: "linux",
        hasSwitch: withSwitches("no-sandbox"),
      }),
    ).toBe(false);
    // macOS and Windows behaviour is unchanged.
    for (const platform of ["darwin", "win32"] as const)
      expect(
        sandboxDisabled({
          isPackaged: true,
          platform,
          hasSwitch: withSwitches("no-sandbox"),
        }),
      ).toBe(false);
  });

  it("shows the cause and exits instead of starting", () => {
    const show = vi.fn();
    const exit = vi.fn();
    const text = vi.fn((key: string) => `<${key}>`);
    expect(
      refuseDisabledSandbox({
        isPackaged: true,
        platform: "linux",
        hasSwitch: withSwitches("no-sandbox"),
        text,
        show,
        exit,
      }),
    ).toBe(true);
    expect(show).toHaveBeenCalledWith(
      "<startup.sandbox.title>",
      "<startup.sandbox.message>",
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(show.mock.invocationCallOrder[0]).toBeLessThan(
      exit.mock.invocationCallOrder[0]!,
    );
  });

  it("does nothing when the sandbox is on", () => {
    const show = vi.fn();
    const exit = vi.fn();
    expect(
      refuseDisabledSandbox({
        isPackaged: true,
        platform: "linux",
        hasSwitch: withSwitches(),
        text: (key) => key,
        show,
        exit,
      }),
    ).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("runs in main.ts before any window, service or recovery page", () => {
    const main = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );
    const ready = main.slice(main.indexOf(".whenReady()"));
    const refusal = ready.indexOf("refuseDisabledSandbox(");
    expect(refusal).toBeGreaterThan(0);
    for (const later of [
      "showRecovery()",
      "showApplication()",
      "new RuntimeSupervisor(",
    ])
      expect(ready.indexOf(later)).toBeGreaterThan(refusal);
  });
});
