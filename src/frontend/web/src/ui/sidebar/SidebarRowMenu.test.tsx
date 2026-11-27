// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeleteFocusTargets } from "./useConfirmedDelete";
import { SidebarRowMenu } from "./SidebarRowMenu";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** Three rows in a list whose heading controls it, with the real menus. */
function render(onDelete: (focus: DeleteFocusTargets) => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <>
        <button type="button" aria-controls="test-list">
          Chats
        </button>
        <div id="test-list" data-sidebar-list="">
          {["First", "Second", "Third"].map((name) => (
            <SidebarRowMenu
              key={name}
              name={name}
              pinned={false}
              onTogglePin={() => {}}
              onDelete={onDelete}
            >
              <a href="#">{name}</a>
            </SidebarRowMenu>
          ))}
        </div>
      </>,
    ),
  );
}

const more = (name: string) =>
  container!.querySelector<HTMLButtonElement>(
    `[aria-label="More actions for ${name}"]`,
  )!;
const link = (name: string) =>
  [...container!.querySelectorAll<HTMLElement>("a")].find(
    (candidate) => candidate.textContent === name,
  )!;
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  );

describe("the sidebar row menu", () => {
  it("opens from the keyboard and closes when Delete is chosen", async () => {
    const onDelete = vi.fn<(focus: DeleteFocusTargets) => void>();
    render(onDelete);

    act(() => more("Second").focus());
    await act(async () => {
      more("Second").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent,
      ),
    ).toEqual(["Pin", "Delete"]);

    await act(async () => menuItem("Delete")!.click());

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // While the row stays, focus belongs on its More button; once it is gone,
    // on the next row.
    const focus = onDelete.mock.calls[0]![0];
    expect(focus.kept()).toBe(more("Second"));
    expect(focus.deleted()).toBe(link("Third"));
  });

  it("offers the same items on right-click and closes when Delete is chosen", async () => {
    const onDelete = vi.fn<(focus: DeleteFocusTargets) => void>();
    render(onDelete);

    await act(async () => {
      link("Third").dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent,
      ),
    ).toEqual(["Pin", "Delete"]);

    await act(async () => menuItem("Delete")!.click());

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // The last row's survivor is the row before it.
    expect(onDelete.mock.calls[0]![0].deleted()).toBe(link("Second"));
  });

  it("falls back to the list heading when no row survives", async () => {
    const onDelete = vi.fn<(focus: DeleteFocusTargets) => void>();
    render(onDelete);
    act(() => more("First").focus());
    await act(async () => {
      more("First").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await act(async () => menuItem("Delete")!.click());
    const focus = onDelete.mock.calls[0]![0];

    link("Second").remove();
    link("Third").remove();

    expect(focus.deleted()).toBe(
      container!.querySelector('[aria-controls="test-list"]'),
    );
  });
});
