// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAvatarRuntimeStore } from "@/stores/avatar-runtime-store";
import { AnimaAvatarChoiceRow } from "./AnimaAvatarChoiceRow";
import { AnimaAvatarPicker } from "./AnimaAvatarPicker";

const mocks = vi.hoisted(() => ({
  loadout: {
    revision: 4,
    avatar_source: { catalog_item_id: "annie", source: "included" },
  } as Record<string, unknown> | undefined,
  avatars: [] as Array<Record<string, unknown>>,
  refetchAvatars: vi.fn(),
  select: vi.fn(),
  saveAvatar: vi.fn(),
  mounted: null as null | { animaId: string; remountLatest: () => unknown },
  toast: vi.fn(),
}));

vi.mock("@/query/hooks/useAnimaLoadout", () => ({
  useAnimaLoadout: () => ({
    data: mocks.loadout,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/query/hooks/useAnimaCreation", () => ({
  useAvatarContents: () => ({
    data: mocks.avatars,
    isLoading: false,
    isError: false,
    refetch: mocks.refetchAvatars,
  }),
  useAnimaCreationOperations: () => ({
    saveAvatar: { mutateAsync: mocks.saveAvatar },
  }),
}));
vi.mock("@/query/hooks/useAnimas", () => ({
  useAnimas: () => ({ data: [{ id: "anima-1", display_name: "Mika" }] }),
}));
vi.mock("@/query/mutations/useAvatarSelection", () => ({
  useAvatarSelection: () => ({ mutateAsync: mocks.select, isPending: false }),
}));
vi.mock("@/ui/app/AnimaRouteProviders", () => ({
  useOptionalMountedAnimaRuntimeContent: () => mocks.mounted,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toast } }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A GLB holding only `json`, enough for Create Anima's browser checks. */
function vrmFile(name: string): File {
  const text = JSON.stringify({
    asset: { version: "2.0" },
    extensions: { VRMC_vrm: { specVersion: "1.0" } },
  });
  const chunk = new TextEncoder().encode(
    text.padEnd(Math.ceil(text.length / 4) * 4, " "),
  );
  const bytes = new Uint8Array(20 + chunk.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, chunk.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(chunk, 20);
  return new File([bytes], name, { type: "model/vrm" });
}

const avatar = (item_id: string, name: string, source: string) => ({
  item_id,
  name,
  source,
  logical_key: null,
  revision_sha256: "a".repeat(64),
  portrait: null,
});

let root: Root | null = null;
let closed = 0;

function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(node);
  });
}

const picker = () => (
  <AnimaAvatarPicker
    animaId="anima-1"
    animaName="Mika"
    open
    onOpenChange={(open) => {
      if (!open) closed += 1;
    }}
  />
);

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
const option = (name: string) =>
  [
    ...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ].find((input) => input.closest("label")?.textContent?.includes(name))!;

async function settle(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

beforeEach(() => {
  closed = 0;
  mocks.loadout = {
    revision: 4,
    avatar_source: { catalog_item_id: "annie", source: "included" },
  };
  mocks.avatars = [
    avatar("annie", "Annie", "included"),
    avatar("mika", "Mika Test", "local"),
  ];
  mocks.refetchAvatars.mockReset();
  mocks.select.mockReset();
  mocks.select.mockResolvedValue({ revision: 5 });
  mocks.saveAvatar.mockReset();
  mocks.mounted = null;
  mocks.toast.mockReset();
  useAvatarRuntimeStore.setState({
    activeRunId: null,
    activeSpeechRunId: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("Anima Avatar picker", () => {
  it("marks the current Avatar and only offers a different one", () => {
    render(picker());
    expect(option("Annie").checked).toBe(true);
    expect(option("Annie").closest("label")?.textContent).toContain("Current");
    expect(button("Use Avatar")?.disabled).toBe(true);

    act(() => option("Mika Test").click());
    expect(button("Use Avatar")?.disabled).toBe(false);
  });

  it("changes only the Avatar against the Loadout revision it showed", async () => {
    render(picker());
    act(() => option("Mika Test").click());
    await act(async () => button("Use Avatar")!.click());

    expect(mocks.select).toHaveBeenCalledWith({
      avatar: expect.objectContaining({ item_id: "mika", source: "local" }),
      expectedRevision: 4,
    });
    expect(mocks.toast).toHaveBeenCalledWith("Mika now uses Mika Test.");
    expect(closed).toBe(1);
  });

  it("reloads a chat showing this Anima before closing, and only this Anima", async () => {
    let finish: () => void = () => undefined;
    const remount = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    mocks.mounted = { animaId: "anima-1", remountLatest: remount };
    render(picker());
    act(() => option("Mika Test").click());
    await act(async () => button("Use Avatar")!.click());
    expect(remount).toHaveBeenCalledTimes(1);
    // The dialog stays until the reload is under way, so the owner cannot
    // open another Anima's chat while it runs.
    expect(closed).toBe(0);
    await act(async () => finish());
    expect(closed).toBe(1);

    act(() => root?.unmount());
    const other = vi.fn();
    mocks.mounted = { animaId: "anima-2", remountLatest: other };
    render(picker());
    act(() => option("Mika Test").click());
    await act(async () => button("Use Avatar")!.click());
    expect(other).not.toHaveBeenCalled();
  });

  it("waits for this Anima's reply before a change in its chat", () => {
    mocks.mounted = { animaId: "anima-1", remountLatest: vi.fn() };
    useAvatarRuntimeStore.setState({ activeSpeechRunId: "run-1" });
    render(picker());
    act(() => option("Mika Test").click());

    expect(button("Use Avatar")?.disabled).toBe(true);
    expect(text()).toContain("Mika is replying.");

    act(() => useAvatarRuntimeStore.setState({ activeSpeechRunId: null }));
    expect(button("Use Avatar")?.disabled).toBe(false);
    expect(text()).not.toContain("Mika is replying.");
  });

  it("ignores another chat's reply outside this Anima's chat", () => {
    useAvatarRuntimeStore.setState({ activeRunId: "run-1" });
    render(picker());
    act(() => option("Mika Test").click());
    expect(button("Use Avatar")?.disabled).toBe(false);
  });

  it("leaves a reply that began during the save to finish", async () => {
    const remount = vi.fn();
    mocks.mounted = { animaId: "anima-1", remountLatest: remount };
    mocks.select.mockImplementation(async () => {
      // A voice turn starts a reply while the change is saving.
      useAvatarRuntimeStore.setState({ activeRunId: "voice-run" });
      return { revision: 5 };
    });
    render(picker());
    act(() => option("Mika Test").click());
    await act(async () => button("Use Avatar")!.click());

    expect(remount).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      "Mika now uses Mika Test. This chat shows it the next time it loads.",
    );
    expect(closed).toBe(1);
  });

  it("asks for a retry when the Anima changed elsewhere", async () => {
    mocks.select.mockRejectedValue({
      detail: { code: "loadout_revision_conflict", message: "stale" },
    });
    render(picker());
    act(() => option("Mika Test").click());
    await act(async () => button("Use Avatar")!.click());

    expect(text()).toContain("This Anima changed elsewhere.");
    expect(closed).toBe(0);
  });

  it("saves an uploaded VRM as a Local Avatar and chooses it", async () => {
    mocks.saveAvatar.mockImplementation(async () => {
      mocks.avatars = [...mocks.avatars, avatar("new", "Mika v2", "local")];
      return avatar("new", "Mika v2", "local");
    });
    render(picker());
    const input =
      document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [vrmFile("Mika v2.vrm")],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle(() => button("Save Avatar") !== undefined);

    await act(async () => button("Save Avatar")!.click());
    expect(mocks.saveAvatar).toHaveBeenCalledWith({
      file: expect.any(File),
      name: "Mika v2",
    });
    // The list refreshes; re-render so the saved Avatar appears.
    act(() => root?.render(picker()));
    expect(option("Mika v2").checked).toBe(true);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("refuses a file that is not a VRM", async () => {
    render(picker());
    const input =
      document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["not a model"], "notes.vrm")],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle(() => document.body.querySelector('[role="alert"]') !== null);

    expect(button("Save Avatar")).toBeUndefined();
    expect(mocks.saveAvatar).not.toHaveBeenCalled();
  });
});

describe("Anima settings Avatar row", () => {
  it("names the Anima's current Avatar", () => {
    render(<AnimaAvatarChoiceRow animaId="anima-1" />);
    expect(text()).toContain("Uses Annie.");
    expect(button("Change Avatar")?.disabled).toBe(false);
  });
});
