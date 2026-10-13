// @vitest-environment happy-dom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAdmittedRouter } from "./admitted-router";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** TanStack routers start tracking scroll positions as soon as they exist. */
type FakeRouter = { client: string; isScrollRestoring: boolean };

const create = vi.fn(
  (client: string): FakeRouter => ({ client, isScrollRestoring: true }),
);
let current: FakeRouter | null = null;

function Harness({ client, ready }: { client: string; ready: boolean }) {
  const router = useAdmittedRouter(create, client, ready);
  useEffect(() => {
    current = router;
  }, [router]);
  return null;
}

let container: HTMLDivElement;
let root: Root;

function render(client: string, ready: boolean, strict = false) {
  const tree = <Harness client={client} ready={ready} />;
  act(() => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
}

beforeEach(() => {
  create.mockClear();
  current = null;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("useAdmittedRouter", () => {
  it("builds no router while admission is not ready", () => {
    render("loading-client", false);

    expect(create).not.toHaveBeenCalled();
    expect(current).toBeNull();
  });

  it("keeps one router for a ready session across renders", () => {
    render("session-a", true);
    const router = current;
    render("session-a", true);

    expect(create).toHaveBeenCalledOnce();
    expect(current).toBe(router);
    expect(router?.isScrollRestoring).toBe(true);
  });

  it("stops a replaced router from tracking scroll positions", () => {
    render("session-a", true);
    const first = current!;
    render("session-b", true);

    expect(current?.client).toBe("session-b");
    expect(current?.isScrollRestoring).toBe(true);
    expect(first.isScrollRestoring).toBe(false);
  });

  it("stops tracking when admission ends or the app unmounts", () => {
    render("session-a", true);
    const first = current!;
    render("loading-client", false);
    expect(first.isScrollRestoring).toBe(false);

    render("session-b", true);
    const second = current!;
    act(() => root.unmount());
    root = createRoot(container);
    expect(second.isScrollRestoring).toBe(false);
  });

  it("keeps only the mounted router tracking under StrictMode", () => {
    render("session-a", true, true);

    // Development StrictMode builds a second router during render and keeps
    // one; the discarded router never mounts and must not track scrolls.
    const built = create.mock.results.map((result) => result.value);
    expect(built.length).toBeGreaterThan(1);
    expect(current?.isScrollRestoring).toBe(true);
    expect(
      built.filter((router) => router !== current && router.isScrollRestoring),
    ).toEqual([]);
  });
});
