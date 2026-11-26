// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MenuCommand } from "../../../shared/desktop-runtime";
import { useAppSettingsRequestStore } from "@/stores/app-settings-request-store";
import { useLibraryImportRequestStore } from "@/stores/library-import-request-store";
import { DesktopMenuCommands } from "@/ui/app/DesktopMenuCommands";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  windowRole: "main" as string,
  listeners: new Set<(command: MenuCommand) => void>(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => fixture.navigate,
}));
vi.mock("@/platform/RuntimePlatformProvider", () => ({
  useRuntimePlatform: () => ({
    kind: "desktop",
    desktopBridge: {
      windowRole: fixture.windowRole,
      menu: {
        onCommand: (listener: (command: MenuCommand) => void) => {
          fixture.listeners.add(listener);
          return () => fixture.listeners.delete(listener);
        },
      },
    },
  }),
}));

let root: Root | null = null;
function mount() {
  act(() => {
    root = createRoot(document.createElement("div"));
    root.render(<DesktopMenuCommands />);
  });
}
/** What main does when a menu item is chosen. */
function choose(command: MenuCommand) {
  act(() => {
    for (const listener of fixture.listeners) listener(command);
  });
}

beforeEach(() => {
  fixture.windowRole = "main";
  fixture.navigate.mockReset();
  // The main window hosts App Settings.
  useAppSettingsRequestStore.setState({ hosts: 1, request: null });
  useLibraryImportRequestStore.setState({ requestedAt: null });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  useAppSettingsRequestStore.setState({ hosts: 0, request: null });
});

describe("desktop application menu commands", () => {
  it("opens App Settings at the update panel for Check for Updates", () => {
    mount();
    choose("check-for-updates");

    expect(useAppSettingsRequestStore.getState().request?.target).toBe(
      "updates",
    );
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("opens the Library's Import for Import Anima", () => {
    mount();
    choose("import-anima");

    expect(useLibraryImportRequestStore.getState().requestedAt).not.toBeNull();
    expect(fixture.navigate).toHaveBeenCalledWith({ to: "/library" });
  });

  it("stops listening when the app shell goes away", () => {
    mount();
    act(() => root?.unmount());
    root = null;

    expect(fixture.listeners.size).toBe(0);
  });

  it("listens only in the main window", () => {
    fixture.windowRole = "quick-chat";
    mount();

    expect(fixture.listeners.size).toBe(0);
  });
});
