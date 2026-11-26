// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  rememberAvatarFileMaterials,
  useAvatarFileTraitsStore,
} from "@/lib/avatar/avatarSettings";
import { AnimaSettingsModal } from "./AnimaSettingsModal";

const mocks = vi.hoisted(() => ({
  available: true,
  settings: undefined as Record<string, string> | undefined,
  mutate: vi.fn(),
}));

vi.mock("@/ui/settings/SettingsProvider", () => ({
  useSettings: () => ({
    userPreferences: {},
    animaPreferences: {},
    updateAnimaPreferences: vi.fn(),
    isLoading: false,
    isUpdating: false,
  }),
}));
vi.mock("@/ui/animas/AvatarDiagnosticsDialog", () => ({
  AvatarDiagnosticsDialog: () => null,
}));
vi.mock("@/query/hooks/useAvatarSettings", () => ({
  useAvatarSettingsAvailable: () => ({
    available: mocks.available,
    checking: false,
  }),
  useAvatarSettings: () => ({ data: mocks.settings, isLoading: false }),
}));
vi.mock("@/query/mutations/useSaveAvatarSettings", () => ({
  useSaveAvatarSettings: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock("@/query/hooks/useAnimaLoadout", () => ({
  useAnimaLoadout: () => ({
    data: { avatar_source: { source: "local", catalog_item_id: "avatar-1" } },
  }),
}));
vi.mock("@/query/hooks/useAnimaRuntimeCatalog", () => ({
  useAnimaRuntimeCatalog: () => ({ data: {} }),
}));
vi.mock("@/lib/runtime-content/runtimeSnapshotAdapter", () => ({
  adaptRuntimeSnapshot: () => ({ avatar_model: {} }),
}));
vi.mock("@/lib/runtime-content/runtimeAvatarFaceParts", () => ({
  runtimeAvatarModelSha256: () => "sha-1",
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));
// Each option is a button, so a test can choose one without a popover.
vi.mock("@/ui/components/select", async () => {
  const React = await import("react");
  const Choose = React.createContext<(value: string) => void>(() => {});
  return {
    Select: ({
      children,
      onValueChange,
    }: {
      children: React.ReactNode;
      onValueChange: (value: string) => void;
    }) => <Choose.Provider value={onValueChange}>{children}</Choose.Provider>,
    SelectTrigger: ({ "aria-label": label }: { "aria-label": string }) => (
      <span data-select={label} />
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: React.ReactNode;
    }) => {
      const choose = React.useContext(Choose);
      return (
        <button type="button" data-option={value} onClick={() => choose(value)}>
          {children}
        </button>
      );
    },
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const container = () => document.body;

function render() {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(<AnimaSettingsModal animaId="anima-1" />);
  });
}

const select = (label: string) =>
  container().querySelector(`[data-select="${label}"]`);

/** The options of the setting whose select is labelled `label`. */
function options(label: string): string[] {
  const row = select(label)?.closest("div.rounded-lg");
  return [...(row?.querySelectorAll<HTMLElement>("[data-option]") ?? [])].map(
    (option) => option.dataset.option!,
  );
}

/** Choose an option of the setting whose select is labelled `label`. */
function choose(label: string, value: string) {
  const row = select(label)!.closest("div.rounded-lg")!;
  const option = row.querySelector<HTMLButtonElement>(
    `[data-option="${value}"]`,
  );
  act(() => option!.click());
}

beforeEach(() => {
  mocks.available = true;
  mocks.settings = undefined;
  mocks.mutate.mockReset();
  useAvatarFileTraitsStore.setState({ materialsBySha256: {} });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("Anima settings: Avatar settings", () => {
  it("offers the wind setting and saves Automatic as no value", () => {
    render();
    expect(select("Wind and ambient forces")).not.toBeNull();
    expect(container().textContent).toContain("Springs off");

    choose("Wind and ambient forces", "springs_off");
    expect(mocks.mutate).toHaveBeenLastCalledWith(
      { spring_mode: "springs_off" },
      expect.anything(),
    );
    choose("Wind and ambient forces", "automatic");
    expect(mocks.mutate).toHaveBeenLastCalledWith(
      { spring_mode: null },
      expect.anything(),
    );
  });

  it("offers Materials only for a file with lilToon materials", () => {
    render();
    expect(select("Materials")).toBeNull();

    act(() => rememberAvatarFileMaterials("sha-1", "other"));
    expect(select("Materials")).toBeNull();

    act(() => rememberAvatarFileMaterials("sha-1", "liltoon"));
    expect(select("Materials")).not.toBeNull();
    expect(options("Materials")).toEqual(["automatic", "liltoon", "simple"]);
    choose("Materials", "simple");
    expect(mocks.mutate).toHaveBeenLastCalledWith(
      { material_mode: "simple" },
      expect.anything(),
    );
  });

  it("offers Automatic and Simple for a file whose materials all ignore light", () => {
    render();
    act(() => rememberAvatarFileMaterials("sha-1", "unlit"));
    expect(options("Materials")).toEqual(["automatic", "simple"]);
    expect(container().textContent).toContain("toon shading");
    choose("Materials", "simple");
    expect(mocks.mutate).toHaveBeenLastCalledWith(
      { material_mode: "simple" },
      expect.anything(),
    );
  });

  it("keeps a stored lilToon choice on an unlit file selectable", () => {
    mocks.settings = {
      item_id: "avatar-1",
      spring_mode: "automatic",
      spring_mode_source: "default",
      material_mode: "liltoon",
      material_mode_source: "stored",
    };
    render();
    act(() => rememberAvatarFileMaterials("sha-1", "unlit"));
    expect(options("Materials")).toEqual(["automatic", "liltoon", "simple"]);
  });

  it("keeps a stored material choice reachable before the file is known", () => {
    mocks.settings = {
      item_id: "avatar-1",
      spring_mode: "automatic",
      spring_mode_source: "default",
      material_mode: "simple",
      material_mode_source: "stored",
    };
    render();
    expect(select("Materials")).not.toBeNull();
  });

  it("shows no Avatar settings where the runtime keeps none", () => {
    mocks.available = false;
    render();
    expect(select("Wind and ambient forces")).toBeNull();
    expect(select("Materials")).toBeNull();
  });
});
