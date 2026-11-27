import type { ReactNode } from "react";
import { renderToStaticMarkup } from "@/test/runtime-markup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hostedExclusionReasons } from "@/app/runtime/route-admission";
import { CreateHubPage } from "@/ui/create/CreateHubPage";
import { SidebarCreateMenu } from "@/ui/sidebar/SidebarCreateMenu";

const fixture = vi.hoisted(() => ({
  capabilities: undefined as Record<string, boolean> | undefined,
}));

vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({
    data: fixture.capabilities,
    isLoading: false,
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  useLocation: () => "/",
  useNavigate: () => vi.fn(),
}));
vi.mock("@/ui/components/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverAnchor: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/ui/sidebar/Sidebar", () => ({
  SidebarLink: () => null,
  useCloseMobileSidebar: () => () => {},
}));
vi.mock("@/ui/app/AppShellPage", () => ({
  AppShellPage: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const entryPoints = () => [
  renderToStaticMarkup(<SidebarCreateMenu />),
  renderToStaticMarkup(<CreateHubPage />),
];

describe("the Generate page's entry points", () => {
  beforeEach(() => {
    fixture.capabilities = undefined;
  });

  it("are offered when the runtime reports the content assistant", () => {
    fixture.capabilities = { anima_creation: true, content_generation: true };
    const [sidebar, hub] = entryPoints();
    expect(sidebar).toContain('href="/generate"');
    expect(sidebar).toContain("Generate");
    expect(hub).toContain('href="/generate"');
    expect(hub).toContain("Open Generate");
  });

  it.each([
    ["withholds it", { anima_creation: true, content_generation: false }],
    ["does not report it", { anima_creation: true }],
    ["has not answered yet", undefined],
  ])("are hidden when the runtime %s", (_label, capabilities) => {
    fixture.capabilities = capabilities;
    for (const html of entryPoints()) {
      expect(html).not.toContain("/generate");
      expect(html).not.toContain("Generate");
      // Hidden, not shown disabled with a reason.
      expect(html).not.toContain(hostedExclusionReasons.content_generation);
    }
  });

  it("leave the other creators' entry points as they were", () => {
    fixture.capabilities = { anima_creation: true, content_generation: false };
    for (const html of entryPoints()) {
      expect(html).toContain('href="/gestures/new"');
      expect(html).toContain('href="/reactions/new"');
    }
  });
});
