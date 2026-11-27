// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PyModelConnection } from "@animama/runtime-contracts/api-types";

import { useModelRemoval, type ModelRemoval } from "./useModelRemoval";

const mocks = vi.hoisted(() => ({
  removeConnection: vi.fn(),
  removeModel: vi.fn(),
  deleteConnectionKey: vi.fn(),
  credentials: { list: async () => [], apply: async () => [] },
}));
vi.mock("@/platform/RuntimePlatformProvider", () => ({
  useRuntimePlatform: () => ({
    kind: "desktop",
    isDesktop: true,
    desktopBridge: { credentials: mocks.credentials },
  }),
}));
vi.mock("@/query/mutations/useModelConfiguration", () => ({
  useRemoveModelConnection: () => ({ mutateAsync: mocks.removeConnection }),
  useRemoveModel: () => ({ mutateAsync: mocks.removeModel }),
}));
vi.mock("./ModelConnectionDialog", () => ({
  deleteConnectionKey: mocks.deleteConnectionKey,
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
/** The probe's latest `startRemoval`, published after each render. */
const probe: { start: (target: ModelRemoval) => void } = {
  start: () => undefined,
};

function Probe({ managedKeys }: { managedKeys: boolean }) {
  const removal = useModelRemoval(managedKeys);
  useEffect(() => {
    probe.start = removal.startRemoval;
  });
  return removal.dialog;
}

const server = (extra: Partial<PyModelConnection> = {}): PyModelConnection => ({
  id: "c1",
  name: "Work proxy",
  preset: "custom",
  source: "owner",
  base_url: "https://llm.example.com/v1",
  compatibility: {},
  credential_state: "not_required",
  models: [],
  ...extra,
});
const removeServer = (connection: PyModelConnection) =>
  act(async () => probe.start({ kind: "connection", connection, usage: null }));

const dialog = () => document.body.querySelector('[role="dialog"]');
const button = (name: string) =>
  [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );

beforeEach(() => {
  for (const mock of [
    mocks.removeConnection,
    mocks.removeModel,
    mocks.deleteConnectionKey,
    toast.error,
    toast.success,
  ])
    mock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Probe managedKeys />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("removing a model connection", () => {
  it("removes an unused connection at once", async () => {
    await removeServer(server());
    expect(mocks.removeConnection).toHaveBeenCalledExactlyOnceWith({
      connectionId: "c1",
      confirm: false,
    });
    expect(dialog()).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Connection removed.");
    expect(mocks.deleteConnectionKey).not.toHaveBeenCalled();
  });

  it("shows what uses a connection, and removes it once confirmed", async () => {
    mocks.removeConnection.mockRejectedValueOnce({
      detail: {
        code: "model_in_use",
        usage: {
          animas: [
            { anima_id: "a", display_name: "Mira", model_provider_id: "m" },
          ],
          roles: [],
        },
      },
    });
    await removeServer(server());
    expect(dialog()?.textContent).toContain("Remove Work proxy?");
    expect(dialog()?.textContent).toContain("Mira");

    await act(async () => button("Remove")?.click());
    expect(mocks.removeConnection).toHaveBeenLastCalledWith({
      connectionId: "c1",
      confirm: true,
    });
    expect(dialog()).toBeNull();
  });

  it("asks before deleting a saved desktop key, then deletes it with the connection", async () => {
    const keyed = server({
      credential_state: "configured",
      credential_env: "ANIMAMA_CONNECTION_C1",
    });
    await removeServer(keyed);
    expect(mocks.removeConnection).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain(
      "Its saved key is deleted too and cannot be recovered.",
    );

    await act(async () => button("Remove")?.click());
    expect(mocks.removeConnection).toHaveBeenCalledExactlyOnceWith({
      connectionId: "c1",
      confirm: false,
    });
    expect(mocks.deleteConnectionKey).toHaveBeenCalledExactlyOnceWith(
      mocks.credentials,
      "ANIMAMA_CONNECTION_C1",
    );
  });

  it("reports a failed removal and keeps the connection", async () => {
    mocks.removeConnection.mockRejectedValueOnce(new Error("offline"));
    await removeServer(server());
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
