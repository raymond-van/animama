// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeleteFocusTargets } from "@/ui/components/useDeleteReturnFocus";
import { LibraryItemMenu } from "./LibraryItemMenu";

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

/** Three items in a group whose heading controls it, with the real menus. */
function render(onDelete: (focus: DeleteFocusTargets) => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <>
        <button type="button" aria-controls="library-poses-content">
          Poses
        </button>
        <div id="library-poses-content" data-library-group-items="">
          {["First", "Second", "Third"].map((name) => (
            <article key={name} aria-label={name}>
              <div tabIndex={0}>{name}</div>
              <LibraryItemMenu name={name} onDelete={onDelete} />
            </article>
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
const tile = (name: string) =>
  container!.querySelector<HTMLElement>(`[aria-label="${name}"] [tabindex]`)!;

async function chooseDelete(name: string) {
  act(() => more(name).focus());
  await act(async () => {
    more(name).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  const items = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ];
  expect(items.map((item) => item.textContent)).toEqual(["Delete"]);
  await act(async () => items[0]!.click());
}

describe("the Library item menu", () => {
  it("opens from the keyboard and closes when Delete is chosen", async () => {
    const onDelete = vi.fn<(focus: DeleteFocusTargets) => void>();
    render(onDelete);

    await chooseDelete("Second");

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // While the item stays, focus belongs on its More button; once it is
    // gone, on the next item.
    const focus = onDelete.mock.calls[0]![0];
    expect(focus.kept()).toBe(more("Second"));
    expect(focus.deleted()).toBe(tile("Third"));
  });

  it("returns focus to the previous item, then the heading, as items go", async () => {
    const onDelete = vi.fn<(focus: DeleteFocusTargets) => void>();
    render(onDelete);

    await chooseDelete("Third");
    expect(onDelete.mock.calls[0]![0].deleted()).toBe(tile("Second"));

    await chooseDelete("First");
    const focus = onDelete.mock.calls[1]![0];
    // Its neighbours were deleted meanwhile.
    for (const name of ["Second", "Third"])
      container!.querySelector(`[aria-label="${name}"]`)!.remove();
    expect(focus.deleted()).toBe(
      container!.querySelector('[aria-controls="library-poses-content"]'),
    );
  });
});
