// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compactContentLibrarySearch,
  type ContentLibrarySearch,
} from "@/lib/content/librarySearch";
import { useLibrarySearchNavigation } from "./useLibrarySearchNavigation";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const view: {
  updateSearch: (update: Partial<ContentLibrarySearch>) => void;
} = { updateSearch: () => {} };
let openEditor: () => void;

function LibraryHarness() {
  view.updateSearch = useLibrarySearchNavigation();
  return <p>Library</p>;
}

/** The Library and an editor whose page keeps loading until it is released. */
function createLibraryRouter() {
  const rootRoute = createRootRoute({ component: Outlet });
  const libraryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "library",
    validateSearch: compactContentLibrarySearch,
    component: LibraryHarness,
  });
  const editorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "gestures/$gestureId/edit",
    loader: () =>
      new Promise<void>((resolve) => {
        openEditor = resolve;
      }),
    component: () => <p>Gesture editor</p>,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([libraryRoute, editorRoute]),
    history: createMemoryHistory({ initialEntries: ["/library"] }),
  });
}

let container: HTMLElement;
let root: Root;
let router: ReturnType<typeof createLibraryRouter>;

beforeEach(async () => {
  router = createLibraryRouter();
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root.render(<RouterProvider router={router} />);
    await router.load();
  });
});

afterEach(() => {
  act(() => root.unmount());
});

describe("Library search navigation", () => {
  it("writes a search update to the Library URL", async () => {
    await act(async () => {
      view.updateSearch({ query: "wave" });
      await router.latestLoadPromise;
    });
    expect(router.state.location.pathname).toBe("/library");
    expect(router.state.location.search).toMatchObject({ query: "wave" });
  });

  it("drops a search update that arrives after a link left the Library", async () => {
    let editorOpened!: Promise<void>;
    await act(async () => {
      editorOpened = router.navigate({
        to: "/gestures/$gestureId/edit",
        params: { gestureId: "have-an-idea" },
      });
      await Promise.resolve();
    });
    // The Library stays on screen while the editor loads, and its search box
    // commits a query typed just before the click.
    expect(container.textContent).toBe("Library");
    await act(async () => {
      view.updateSearch({ query: "Have an Idea" });
      openEditor();
      await editorOpened;
    });
    expect(router.state.location.pathname).toBe("/gestures/have-an-idea/edit");
    expect(container.textContent).toBe("Gesture editor");
  });
});
