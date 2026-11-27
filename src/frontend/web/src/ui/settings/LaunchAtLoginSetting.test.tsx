import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LoginItemStatus } from "../../../../shared/desktop-runtime";
import { LaunchAtLoginSetting } from "./LaunchAtLoginSetting";

const platform = vi.hoisted(() => ({
  kind: "desktop",
  desktopBridge: { platform: "darwin" },
}));
vi.mock("@/platform/RuntimePlatformProvider", () => ({
  useRuntimePlatform: () => platform,
}));

function render(status: LoginItemStatus) {
  return renderToStaticMarkup(
    <LaunchAtLoginSetting
      loginItem={{ status, pending: false, setEnabled: vi.fn() }}
    />,
  );
}

describe("Launch at login setting", () => {
  it("renders nothing where the OS setting is unavailable", () => {
    expect(render({ available: false })).toBe("");
  });

  it("shows the switch in the OS state", () => {
    const html = render({
      available: true,
      enabled: true,
      blockedBySystem: false,
    });
    expect(html).toContain("Launch at login");
    expect(html).toContain("when you log in to your computer");
    expect(html).toContain('aria-checked="true"');
  });

  it("says where to allow a login item the OS is blocking", () => {
    const blocked = {
      available: true,
      enabled: true,
      blockedBySystem: true,
    } as const;
    expect(render(blocked)).toContain("Login Items &amp; Extensions");
    platform.desktopBridge.platform = "win32";
    expect(render(blocked)).toContain("Settings → Apps → Startup");
    // On Linux nothing in the system blocks it: the AppImage has moved.
    platform.desktopBridge.platform = "linux";
    expect(render(blocked)).toContain("has moved");
  });
});
