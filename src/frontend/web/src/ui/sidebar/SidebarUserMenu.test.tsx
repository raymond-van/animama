// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UpdateStatus } from "../../../../shared/desktop-runtime";
import type { AppSettingsRequest } from "@/stores/app-settings-request-store";
import { SidebarUserMenu } from "./SidebarUserMenu";

const updates = vi.hoisted(() => ({
  status: { state: "unavailable" } as UpdateStatus,
  run: vi.fn<(action: "check" | "download" | "restart") => Promise<void>>(),
}));
const settings = vi.hoisted(() => ({
  open: false,
  reveal: null as AppSettingsRequest | null,
}));

vi.mock("@/hooks/useDesktopUpdates", () => ({
  useDesktopUpdates: () => ({
    status: updates.status,
    pending: false,
    error: false,
    run: updates.run,
  }),
}));
vi.mock("@/query/hooks/useUserProfile", () => ({
  useUserProfile: () => ({ data: { display_name: "Sam" } }),
}));
vi.mock("@/ui/sidebar/Sidebar", () => ({
  useSidebar: () => ({ open: true }),
  useCloseMobileSidebar: () => () => {},
}));
vi.mock("@/app/runtime/RuntimeAdmissionProvider", () => ({
  useOptionalRuntimeController: () => null,
  useOptionalAccountAffordances: () => null,
}));
vi.mock("@/ui/sidebar/ApplicationSettingsModal", () => ({
  ApplicationSettingsModal: ({
    open,
    reveal,
  }: {
    open: boolean;
    reveal?: AppSettingsRequest | null;
  }) => {
    settings.open = open;
    settings.reveal = reveal ?? null;
    return null;
  },
}));
// Radix renders menu content in a portal only while open; render it inline so
// the items can be inspected and chosen.
vi.mock("@/ui/components/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: (event: Event) => void;
  }) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => onSelect?.(new Event("select", { cancelable: true }))}
    >
      {children}
    </button>
  ),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  updates.status = { state: "unavailable" };
  updates.run.mockReset();
  settings.open = false;
  settings.reveal = null;
});

function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<SidebarUserMenu />));
}

function menuItems(): HTMLElement[] {
  return [...container!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

function checkForUpdates(): HTMLElement | undefined {
  return menuItems().find((item) =>
    item.textContent?.includes("Check for updates…"),
  );
}

describe("SidebarUserMenu", () => {
  it("offers no update check where this app cannot update", () => {
    render();

    expect(menuItems().map((item) => item.textContent)).toEqual([
      "App Settings",
    ]);
  });

  it("checks for updates and opens App Settings at the update panel", () => {
    updates.status = { state: "idle" };
    render();

    const item = checkForUpdates();
    expect(item).toBeDefined();
    act(() => item!.click());

    expect(updates.run).toHaveBeenCalledWith("check");
    expect(settings.open).toBe(true);
    expect(settings.reveal?.target).toBe("updates");
  });

  it("opens the update panel without a second check while one runs", () => {
    updates.status = { state: "checking" };
    render();

    act(() => checkForUpdates()!.click());

    expect(updates.run).not.toHaveBeenCalled();
    expect(settings.reveal?.target).toBe("updates");
  });
});
