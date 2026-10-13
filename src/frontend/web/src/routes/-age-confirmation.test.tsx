// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Route } from "./_app/$animaId";

const fixture = vi.hoisted(() => ({
  onboardingRequired: true,
  runtimeKind: "self_hosted_web",
  rememberAnima: vi.fn(),
  navigate: vi.fn(),
  chatMounted: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Outlet: () => null,
  useNavigate: () => fixture.navigate,
  useParams: () => ({ animaId: "annie" }),
}));
vi.mock("@/app/runtime/RuntimeAdmissionProvider", () => ({
  useRuntimeAdmission: () => ({
    admission: {
      status: "ready",
      onboardingRequired: fixture.onboardingRequired,
      capabilities: { runtime_kind: fixture.runtimeKind },
    },
  }),
}));
vi.mock("@/hooks/useRememberLastActiveAnima", () => ({
  useRememberLastActiveAnima: (animaId: string | null) =>
    fixture.rememberAnima(animaId),
}));
vi.mock("@/ui/app/AnimaRouteProviders", () => ({
  AnimaRouteProviders: ({ children }: { children: ReactNode }) => (
    <div data-testid="runtime-provider">{children}</div>
  ),
}));
vi.mock("@/ui/safety/CompanionSafetyProvider", () => ({
  CompanionSafetyProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/ui/safety/CompanionSafetySlot", () => ({
  AvatarOnlySafetyOverlay: () => null,
}));
vi.mock("@/ui/main/MainShell", () => ({
  MainShell: ({
    chatPanel,
    children,
  }: {
    chatPanel: (state: { canvasMode: "avatar-chat" }) => ReactNode;
    children: ReactNode;
  }) => (
    <main data-testid="avatar-shell">
      <canvas />
      {chatPanel({ canvasMode: "avatar-chat" })}
      {children}
    </main>
  ),
}));
vi.mock("@/ui/main/chat/ChatInterface", () => ({
  ChatInterface: ({ animaId }: { animaId: string }) => {
    fixture.chatMounted(animaId);
    return <div data-testid="chat-interface" />;
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  fixture.onboardingRequired = true;
  fixture.runtimeKind = "self_hosted_web";
  vi.spyOn(Route, "useParams").mockReturnValue({ animaId: "annie" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderRoute() {
  act(() => root.render(createElement(Route.options.component!)));
}

describe("Anima runtime behind first-run age confirmation", () => {
  it("loads the avatar shell while withholding chat and its interaction handlers", () => {
    renderRoute();

    expect(
      container.querySelector('[data-testid="runtime-provider"]'),
    ).not.toBeNull();
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(
      container.querySelector('[data-testid="chat-interface"]'),
    ).toBeNull();
    expect(fixture.chatMounted).not.toHaveBeenCalled();
    expect(fixture.rememberAnima).toHaveBeenLastCalledWith(null);
  });

  it("enables chat after confirmation without replacing the loaded avatar shell", () => {
    renderRoute();
    const provider = container.querySelector(
      '[data-testid="runtime-provider"]',
    );
    const canvas = container.querySelector("canvas");

    fixture.onboardingRequired = false;
    renderRoute();

    expect(container.querySelector('[data-testid="runtime-provider"]')).toBe(
      provider,
    );
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(
      container.querySelector('[data-testid="chat-interface"]'),
    ).not.toBeNull();
    expect(fixture.chatMounted).toHaveBeenLastCalledWith("annie");
    expect(fixture.rememberAnima).toHaveBeenLastCalledWith("annie");
  });

  it("opens chat immediately for an admitted hosted owner", () => {
    fixture.runtimeKind = "hosted";
    fixture.onboardingRequired = false;
    renderRoute();

    expect(container.querySelector("canvas")).not.toBeNull();
    expect(fixture.chatMounted).toHaveBeenLastCalledWith("annie");
    expect(fixture.rememberAnima).toHaveBeenLastCalledWith("annie");
  });
});
