// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAvatarFileTraitsStore } from "@/lib/avatar/avatarSettings";
import { LILTOON_MATERIALS_EXTENSION } from "@/lib/avatar/liltoon/lilToon";
import {
  useAvatarLoadSettings,
  type AvatarLoadSettings,
} from "@/query/hooks/useAvatarSettings";
import { LibraryAvatarSettingsDialog } from "./LibraryAvatarSettingsDialog";

const mocks = vi.hoisted(() => ({
  runtimeKind: "desktop" as string,
  // One client, as the real provider keeps it.
  apiClient: {},
  stored: {
    item_id: "item-7",
    spring_mode: "automatic",
    spring_mode_source: "default",
    material_mode: "automatic",
    material_mode_source: "default",
  } as Record<string, string>,
  getAvatarSettings: vi.fn(),
  saveAvatarSettings: vi.fn(),
  itemEntry: vi.fn(),
  release: vi.fn(),
  diagnostics: [] as Array<{ source: unknown; open: boolean }>,
}));

vi.mock("@animama/runtime-contracts/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAvatarSettings: mocks.getAvatarSettings,
  saveAvatarSettings: mocks.saveAvatarSettings,
}));
vi.mock("@animama/product-ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProductApiClient: () => mocks.apiClient,
}));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeCacheKey: () => "owner-1",
}));
vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({
    data: { runtime_kind: mocks.runtimeKind },
    isLoading: false,
  }),
}));
vi.mock("@/lib/content/avatarPreviewTarget", () => ({
  avatarItemRuntimeEntry: mocks.itemEntry,
}));
vi.mock("@/lib/runtime-content/runtimeContentDelivery", () => ({
  runtimeContentDownloadUrl: async () => ({
    url: "http://localhost/avatar-file",
    release: mocks.release,
  }),
}));
vi.mock("@/ui/animas/AvatarDiagnosticsDialog", () => ({
  AvatarDiagnosticsDialog: (props: { source: unknown; open: boolean }) => {
    mocks.diagnostics.push({ source: props.source, open: props.open });
    return null;
  },
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

/** A GLB holding only `json`. */
function glb(json: unknown): ArrayBuffer {
  const text = JSON.stringify(json);
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
  return bytes.buffer;
}

const AVATAR = { itemId: "item-7", source: "local" as const, name: "Mika" };

let root: Root | null = null;
let dockSettings: AvatarLoadSettings | null = null;

/** What the preview dock reads for the same Avatar item. */
function DockProbe() {
  const settings = useAvatarLoadSettings("item-7");
  useEffect(() => {
    dockSettings = settings;
  });
  return null;
}

function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <QueryClientProvider client={client}>
        <DockProbe />
        <LibraryAvatarSettingsDialog avatar={AVATAR} onClose={() => {}} />
      </QueryClientProvider>,
    );
  });
}

async function settle(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

const select = (label: string) =>
  document.body.querySelector(`[data-select="${label}"]`);

beforeEach(() => {
  mocks.runtimeKind = "desktop";
  mocks.diagnostics = [];
  mocks.release.mockReset();
  mocks.getAvatarSettings.mockReset();
  mocks.getAvatarSettings.mockImplementation(async () => ({
    data: mocks.stored,
  }));
  mocks.saveAvatarSettings.mockReset();
  mocks.saveAvatarSettings.mockImplementation(
    async ({ body }: { body: Record<string, string | null> }) => ({
      data: {
        ...mocks.stored,
        spring_mode: body.spring_mode ?? "automatic",
        spring_mode_source: body.spring_mode ? "stored" : "default",
      },
    }),
  );
  mocks.itemEntry.mockReset();
  mocks.itemEntry.mockImplementation(async (_client, itemId: string) => ({
    runtime_id: `preview-${itemId}`,
    config: { avatar_catalog_item_id: itemId },
    source: {
      type: "authorized_files",
      files: [{ role: "model", filename: "m.vrm", sha256: "sha-7" }],
    },
  }));
  useAvatarFileTraitsStore.setState({ materialsBySha256: {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          glb({
            asset: { version: "2.0" },
            extensionsUsed: [LILTOON_MATERIALS_EXTENSION],
          }),
        ),
    ),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  dockSettings = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("Library Avatar settings", () => {
  it("offers both settings once the file is known to have lilToon materials", async () => {
    render();
    await settle(() => select("Materials") !== null);

    expect(select("Wind and ambient forces")).not.toBeNull();
    expect(select("Materials")).not.toBeNull();
    expect(mocks.itemEntry).toHaveBeenCalledWith(
      mocks.apiClient,
      "item-7",
      expect.any(AbortSignal),
    );
    expect(useAvatarFileTraitsStore.getState().materialsBySha256).toEqual({
      "sha-7": "liltoon",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalled();
  });

  it("offers Materials for a file whose materials all ignore light", async () => {
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(
          glb({
            asset: { version: "2.0" },
            extensions: { VRMC_vrm: { specVersion: "1.0" } },
            materials: [
              {
                pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
                extensions: { KHR_materials_unlit: {} },
              },
            ],
          }),
        ),
    );
    render();
    await settle(() => select("Materials") !== null);
    expect(useAvatarFileTraitsStore.getState().materialsBySha256).toEqual({
      "sha-7": "unlit",
    });
  });

  it("does not read a file this session already knows", async () => {
    useAvatarFileTraitsStore.setState({
      materialsBySha256: { "sha-7": "other" },
    });
    render();
    await settle(() => mocks.itemEntry.mock.calls.length > 0);
    await settle(() => select("Wind and ambient forces") !== null);
    expect(fetch).not.toHaveBeenCalled();
    expect(select("Materials")).toBeNull();
  });

  it("applies a wind change to the preview dock's Avatar without a reload", async () => {
    render();
    await settle(() => dockSettings?.materialMode === "automatic");
    const before = dockSettings!;
    expect(before.springMode).toBe("automatic");

    const row = select("Wind and ambient forces")!.closest("div.rounded-lg")!;
    act(() =>
      row
        .querySelector<HTMLButtonElement>('[data-option="springs_off"]')!
        .click(),
    );
    await settle(() => dockSettings?.springMode === "springs_off");

    expect(mocks.saveAvatarSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { item_id: "item-7" },
        body: { spring_mode: "springs_off" },
      }),
    );
    // The material mode a surface loads with is unchanged, so nothing reloads.
    expect(dockSettings!.materialMode).toBe(before.materialMode);
  });

  it("opens Diagnostics for the Avatar item", async () => {
    render();
    const open = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Open diagnostics"),
    )!;
    act(() => open.click());
    expect(mocks.diagnostics.at(-1)).toEqual({
      source: { kind: "avatar", itemId: "item-7", source: "local" },
      open: true,
    });
  });

  it("offers Diagnostics only where the runtime keeps no settings", async () => {
    mocks.runtimeKind = "hosted_web";
    render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(select("Wind and ambient forces")).toBeNull();
    expect(select("Materials")).toBeNull();
    expect(document.body.textContent).toContain("Open diagnostics");
    expect(document.body.textContent).toContain(
      "See what Animama found in Mika.",
    );
    // The hosted app never reads the settings route or the file for them.
    expect(mocks.getAvatarSettings).not.toHaveBeenCalled();
    expect(mocks.itemEntry).not.toHaveBeenCalled();
  });
});
