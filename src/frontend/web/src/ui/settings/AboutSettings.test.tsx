import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AboutVersionSetting } from "./AboutSettings";

const platform = vi.hoisted(() => ({
  current: { kind: "desktop", isDesktop: true, os: "linux" } as {
    kind: string;
    isDesktop: boolean;
    os?: string;
  },
}));
vi.mock("@/platform/RuntimePlatformProvider", () => ({
  useRuntimePlatform: () => platform.current,
}));
vi.mock("@/hooks/useDesktopFeaturePacks", () => ({
  useDesktopFeaturePacks: () => ({ statuses: [], busy: false }),
}));

const REBUILD = "updated by pulling the source and rebuilding";

describe("About version", () => {
  it("says a Linux desktop build is updated by rebuilding from source", () => {
    platform.current = { kind: "desktop", isDesktop: true, os: "linux" };
    const html = renderToStaticMarkup(<AboutVersionSetting />);
    expect(html).toContain("Linux");
    expect(html).toContain(REBUILD);
  });

  it("says nothing of the kind on macOS, Windows or the web", () => {
    for (const current of [
      { kind: "desktop", isDesktop: true, os: "darwin" },
      { kind: "desktop", isDesktop: true, os: "win32" },
      { kind: "web", isDesktop: false },
    ]) {
      platform.current = current;
      expect(renderToStaticMarkup(<AboutVersionSetting />)).not.toContain(
        REBUILD,
      );
    }
  });
});
