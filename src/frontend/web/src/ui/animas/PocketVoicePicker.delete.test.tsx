// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withRuntime } from "@/test/runtime-markup";
import type { DeleteFocusTargets } from "@/ui/components/useDeleteReturnFocus";
import { PocketVoicePicker } from "./PocketVoicePicker";

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

const clones = [
  { id: "clone:narrator", name: "Narrator", previewUrl: "/narrator.wav" },
  { id: "clone:guide", name: "Guide", previewUrl: "/guide.wav" },
];

function render(
  onDeleteClone: (id: string, focus: DeleteFocusTargets) => void,
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      withRuntime(
        <PocketVoicePicker
          value="clone:narrator"
          disabled={false}
          hasCustomVoice={false}
          clones={clones}
          onSelect={async () => undefined}
          onDeleteClone={onDeleteClone}
          availability={() => null}
          onDownload={() => undefined}
        />,
      ),
    ),
  );
}

const trigger = () =>
  container!.querySelector<HTMLButtonElement>(
    '[aria-label="PocketTTS voice: Narrator"]',
  )!;
const deleteButton = (name: string) =>
  document.querySelector<HTMLButtonElement>(`[aria-label="Delete ${name}"]`)!;

describe("deleting a voice clone from the voice picker", () => {
  it("asks about the selected clone, returning focus to its button or the picker", () => {
    const onDeleteClone =
      vi.fn<(id: string, focus: DeleteFocusTargets) => void>();
    render(onDeleteClone);

    const selected = deleteButton("Narrator");
    act(() => selected.click());

    expect(onDeleteClone).toHaveBeenCalledWith(
      "clone:narrator",
      expect.anything(),
    );
    const focus = onDeleteClone.mock.calls[0]![1];
    expect(focus.kept()).toBe(selected);
    // A deleted clone takes its button with it; the picker stays.
    expect(focus.deleted()).toBe(trigger());
  });

  it("asks about a listed clone once the list has closed, returning focus to the picker", async () => {
    const onDeleteClone =
      vi.fn<(id: string, focus: DeleteFocusTargets) => void>();
    render(onDeleteClone);

    await act(async () => trigger().click());
    await act(async () => deleteButton("Guide").click());

    expect(onDeleteClone).toHaveBeenCalledWith(
      "clone:guide",
      expect.anything(),
    );
    expect(document.querySelector('[aria-label="Delete Guide"]')).toBeNull();
    const focus = onDeleteClone.mock.calls[0]![1];
    expect(focus.kept()).toBe(trigger());
    expect(focus.deleted()).toBe(trigger());
  });
});
