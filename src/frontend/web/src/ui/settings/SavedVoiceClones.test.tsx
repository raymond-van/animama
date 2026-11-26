// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SavedVoiceClones } from "./SavedVoiceClones";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  animaId: "annie" as string | null,
  provider: "pocket_tts" as string | undefined,
  clones: [] as unknown[],
  selected: null as string | null,
  select: vi.fn<(input: unknown) => Promise<void>>(async () => undefined),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/ui/settings/SettingsProvider", () => ({
  useSettings: () => ({
    animaId: fixture.animaId,
    effectivePreferences: { speech: { tts_provider: fixture.provider } },
  }),
}));
vi.mock("@/query/hooks/useVoiceClones", () => ({
  useVoiceClones: () => ({ data: fixture.clones }),
}));
vi.mock("@/query/hooks/useAnima", () => ({
  useAnima: (animaId: string | null) => ({
    data: animaId ? { id: animaId, display_name: "Annie" } : undefined,
  }),
}));
vi.mock("@/query/hooks/useAnimaLoadout", () => ({
  useAnimaLoadout: (animaId: string | null) => ({
    data: animaId
      ? {
          revision: 7,
          voice_source: fixture.selected
            ? { catalog_item_id: fixture.selected }
            : null,
        }
      : undefined,
  }),
}));
vi.mock("@/query/mutations/useVoiceSelection", () => ({
  useVoiceSelection: () => ({ mutateAsync: fixture.select }),
}));
vi.mock("sonner", () => ({ toast: fixture.toast }));

const mine = { item_id: "clone-1", name: "My voice" };
const other = { item_id: "clone-2", name: "Narrator" };

let root: Root | null = null;
let container: HTMLElement;
function render() {
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container);
    root.render(<SavedVoiceClones />);
  });
}
const rows = () =>
  [...container.querySelectorAll("li")].map((node) => node.textContent);

beforeEach(() => {
  fixture.animaId = "annie";
  fixture.provider = "pocket_tts";
  fixture.clones = [mine, other];
  fixture.selected = null;
  fixture.select.mockReset();
  fixture.select.mockResolvedValue(undefined);
  fixture.toast.success.mockReset();
  fixture.toast.error.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("saved voice clones in App Settings", () => {
  it("lists each clone with the action that gives it to the current Anima", async () => {
    render();

    expect(rows()).toEqual(["My voiceUse for Annie", "NarratorUse for Annie"]);
    expect(container.textContent).toContain(
      "Each Anima chooses its own voice under Voices on its page.",
    );

    await act(async () => container.querySelector("button")!.click());
    expect(fixture.select).toHaveBeenCalledWith({
      clone: mine,
      expectedRevision: 7,
    });
    // An open chat keeps its voice until it is next opened, and the toast says so.
    expect(fixture.toast.success).toHaveBeenCalledWith(
      "My voice is now Annie's voice. It applies the next time you open the chat.",
    );
  });

  it("marks the clone the Anima already speaks with", () => {
    fixture.selected = "clone-2";
    render();

    expect(rows()).toEqual(["My voiceUse for Annie", "NarratorAnnie's voice"]);
  });

  it("reports a failed choice and keeps the list", async () => {
    fixture.select.mockRejectedValue(new Error("revision conflict"));
    render();

    await act(async () => container.querySelector("button")!.click());
    expect(fixture.toast.error).toHaveBeenCalledWith(
      "Failed to select PocketTTS voice. Refresh and try again.",
    );
    expect(rows()).toHaveLength(2);
  });

  it("only lists the clones when no Anima is open or it speaks with another provider", () => {
    fixture.animaId = null;
    render();
    expect(rows()).toEqual(["My voice", "Narrator"]);
    act(() => root?.unmount());
    container.remove();

    fixture.animaId = "annie";
    fixture.provider = "elevenlabs";
    render();
    expect(rows()).toEqual(["My voice", "Narrator"]);
    expect(container.textContent).toContain(
      "Each Anima chooses its own voice under Voices on its page.",
    );
  });

  it("shows nothing before a voice has been cloned", () => {
    fixture.clones = [];
    render();
    expect(container.textContent).toBe("");
  });
});
