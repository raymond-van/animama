import { createElement } from "react";
import { renderToStaticMarkup } from "@/test/runtime-markup";
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Route as AppLayoutRoute } from "./_app";
import { Route as ChatLaunchRoute } from "./_app/index";

type RedirectProps = {
  to: string;
  params?: { animaId: string };
  replace?: boolean;
  ignoreBlocker?: boolean;
};
const fixture = vi.hoisted(() => ({
  navigate: vi.fn<(props: RedirectProps) => void>(),
  ready: true,
  firstRunComplete: true,
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouterState: () => "/",
  Navigate: (props: RedirectProps) => {
    fixture.navigate(props);
    return null;
  },
}));
vi.mock("@web/app/runtime/RuntimeAdmissionProvider", () => ({
  useRuntimeAdmission: () => ({
    admission: fixture.ready
      ? {
          status: "ready",
          onboardingRequired: !fixture.firstRunComplete,
          capabilities: {
            runtime_kind: "self_hosted_web",
            anima_creation: true,
          },
        }
      : { status: "loading" },
  }),
}));
vi.mock("@web/app/local-runtime/LocalRuntimeProvider", () => ({
  useLocalRuntime: () => ({
    state: { status: "ready", principalId: "entry-test-owner" },
  }),
}));
// The app shell is irrelevant to entry redirects and never renders here.
vi.mock("@/ui/app/AppShell", () => ({ AppShell: () => null }));
vi.mock("@/ui/content-preview/ContentPreviewDockProvider", () => ({
  ContentPreviewDockProvider: () => null,
}));
vi.mock("@/ui/settings/SettingsGate", () => ({ SettingsGate: () => null }));
vi.mock("@/ui/settings/DesktopUpdatesPanel", () => ({
  DesktopUpdatesPanel: () => null,
}));
vi.mock("@/ui/sidebar", () => ({ SidebarShell: () => null }));
vi.mock("@/query/hooks/useAnimas", () => ({
  useAnimas: () => ({
    isSuccess: true,
    data: [{ id: "annie" }, { id: "janna" }],
  }),
}));
vi.mock("@/query/hooks/useUserSettings", () => ({
  useUserSettings: () => ({
    isSuccess: true,
    data: { last_active_anima_id: "janna" },
  }),
}));

beforeEach(() => {
  fixture.navigate.mockClear();
  fixture.ready = true;
  fixture.firstRunComplete = true;
});
afterEach(() => vi.unstubAllGlobals());

describe("home entry navigation", () => {
  it("waits for local readiness and sends incomplete installations to setup", () => {
    fixture.ready = false;
    renderToStaticMarkup(createElement(AppLayoutRoute.options.component!));
    expect(fixture.navigate).not.toHaveBeenCalled();
    fixture.ready = true;
    fixture.firstRunComplete = false;
    renderToStaticMarkup(createElement(AppLayoutRoute.options.component!));
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/setup",
      replace: true,
      ignoreBlocker: true,
    });
  });

  it("finishes an approved home-to-chat redirect while the departed creator blocker awaits cleanup", async () => {
    // TanStack's browser history invokes blockers only with a document present.
    vi.stubGlobal("document", {});
    const history = createMemoryHistory({
      initialEntries: ["/reactions/new"],
    });
    let approve!: (blocked: boolean) => void;
    const blocker = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        }),
    );
    const unblock = history.block({ blockerFn: blocker });
    try {
      history.push("/");
      expect(blocker).toHaveBeenCalledOnce();
      expect(history.location.pathname).toBe("/reactions/new");
      approve(false);
      await vi.waitFor(() => expect(history.location.pathname).toBe("/"));

      // The new route's layout-effect redirects can precede useBlocker's
      // passive cleanup. Keep the real history blocker registered for both.
      for (const route of [ChatLaunchRoute]) {
        renderToStaticMarkup(createElement(route.options.component!));
        const redirect = fixture.navigate.mock.lastCall![0];
        const destination = redirect.to.replace(
          "$animaId",
          redirect.params?.animaId ?? "",
        );
        history.replace(destination, undefined, {
          ignoreBlocker: redirect.ignoreBlocker,
        });
      }
      expect(history.location.pathname).toBe("/janna");
      expect(blocker).toHaveBeenCalledOnce();
    } finally {
      unblock();
    }
  });
});
