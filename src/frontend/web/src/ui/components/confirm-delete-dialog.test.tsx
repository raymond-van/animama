// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmDeleteDialog } from "./confirm-delete-dialog";

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

function render(props: {
  pending?: boolean;
  error?: string | null;
  onConfirm?: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <ConfirmDeleteDialog
        open
        title="Delete chat?"
        description="Its messages will be deleted."
        pending={props.pending ?? false}
        error={props.error ?? null}
        onConfirm={props.onConfirm ?? (() => {})}
        onOpenChange={props.onOpenChange ?? (() => {})}
      />,
    ),
  );
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (name: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === name,
  )!;

describe("the shared delete confirmation", () => {
  it("names what is deleted and offers Cancel and Delete", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render({ onConfirm, onOpenChange });

    expect(dialog().textContent).toContain("Delete chat?");
    expect(dialog().textContent).toContain("Its messages will be deleted.");

    act(() => button("Delete").click());
    expect(onConfirm).toHaveBeenCalledTimes(1);

    act(() => button("Cancel").click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cannot be confirmed again or closed while the delete runs", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render({ pending: true, onConfirm, onOpenChange });

    expect(button("Delete").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    expect(dialog().getAttribute("aria-busy")).toBe("true");

    act(() => {
      dialog().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows why a delete failed and stays open", () => {
    render({ error: "The reply is still stopping. Try again in a moment." });

    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
      "The reply is still stopping. Try again in a moment.",
    );
    expect(button("Delete").disabled).toBe(false);
  });

  it("returns focus to the element the caller names when it closes", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "More";
    document.body.append(trigger);
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <ConfirmDeleteDialog
          open={open}
          onOpenChange={setOpen}
          title="Delete chat?"
          description="Its messages will be deleted."
          pending={false}
          onConfirm={() => {}}
          returnFocus={() => trigger}
        />
      );
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Harness />));

    act(() => button("Cancel").click());
    // Radix restores focus a task after the dialog unmounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
