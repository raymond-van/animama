// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PyModelConnection,
  PyModelConnectionPreset,
} from "@animama/runtime-contracts/api-types";

import type { CredentialChange } from "../../../../../shared/desktop-runtime";
import { ModelConnectionForm } from "./ModelConnectionDialog";

const fixture = vi.hoisted(() => ({
  desktop: true,
  apply: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/platform/RuntimePlatformProvider", () => ({
  useRuntimePlatform: () =>
    fixture.desktop
      ? {
          kind: "desktop",
          isDesktop: true,
          desktopBridge: {
            credentials: { list: async () => [], apply: fixture.apply },
          },
        }
      : { kind: "web", isDesktop: false },
}));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeCacheKey: () => "owner-1",
}));
vi.mock("@/query/mutations/useModelConfiguration", () => ({
  useCreateModelConnection: () => ({ mutateAsync: vi.fn() }),
  useUpdateModelConnection: () => ({ mutateAsync: fixture.update }),
  useDetectModelServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  // The key field's storage note reads protection status; none is cached here.
  useQuery: () => ({ data: undefined }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const KEY_ENV = "ANIMAMA_CONNECTION_C_LAB_API_KEY";
const preset: PyModelConnectionPreset = {
  id: "vllm",
  label: "vLLM",
  local: false,
  expects_key: true,
  logo_provider: "vllm",
  compatibility: {},
  timeout_seconds: 60,
};
const labConnection = {
  id: "c_lab",
  name: "Lab",
  preset: "vllm",
  source: "owner",
  base_url: "https://lab.example.test/v1",
  credential_env: KEY_ENV,
  credential_state: "configured",
  compatibility: {},
  timeout_seconds: null,
} as unknown as PyModelConnection;

let root: Root | null = null;
let container: HTMLElement;

/** Renders the form for a saved connection, or for a new one from `from`. */
function renderForm(
  connection: PyModelConnection | undefined,
  managedKeys: boolean,
  from: PyModelConnectionPreset = preset,
) {
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container);
    root.render(
      <ModelConnectionForm
        presets={[from]}
        connection={connection}
        managedKeys={managedKeys}
        onSaved={() => undefined}
        footer={({ valid }) => (
          <button type="submit" disabled={!valid}>
            Save
          </button>
        )}
      />,
    );
  });
}

function input(selector: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(selector)!;
}

function typeInto(field: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setValue.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const urlField = () => input('input[inputmode="url"]');
const saveButton = () =>
  container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const alerts = () =>
  [...container.querySelectorAll('[role="alert"]')].map(
    (node) => node.textContent,
  );

beforeEach(() => {
  fixture.desktop = true;
  fixture.apply.mockReset();
  fixture.update.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("a new connection to a provider that needs a key", () => {
  const cloudPreset: PyModelConnectionPreset = {
    ...preset,
    id: "openrouter",
    label: "OpenRouter",
    default_base_url: "https://openrouter.ai/api/v1",
  };

  it("cannot be saved on desktop until its key is typed", () => {
    renderForm(undefined, true, cloudPreset);

    expect(saveButton().disabled).toBe(true);

    typeInto(input('input[type="password"]'), "sk-or-new");
    expect(saveButton().disabled).toBe(false);
  });

  it("cannot be saved on self-hosted web until its key variable is named", () => {
    fixture.desktop = false;
    renderForm(undefined, false, cloudPreset);

    expect(saveButton().disabled).toBe(true);

    typeInto(input("input[autocapitalize]"), "OPENROUTER_API_KEY");
    expect(saveButton().disabled).toBe(false);
  });

  it("saves without a key when the provider needs none", () => {
    renderForm(undefined, true, { ...cloudPreset, expects_key: false });

    expect(saveButton().disabled).toBe(false);
  });

  it("leaves editing a saved connection without a key as it was", () => {
    renderForm(
      {
        ...labConnection,
        credential_env: null,
        credential_state: "missing",
      } as PyModelConnection,
      true,
    );

    expect(saveButton().disabled).toBe(false);
  });
});

describe("connection keys and their address", () => {
  it("saves a desktop key with the origin of the connection's address", async () => {
    fixture.update.mockResolvedValue({
      ...labConnection,
      base_url: "https://LAB.example.test:443/v2",
    });
    fixture.apply.mockImplementation(async (changes: CredentialChange[]) =>
      changes.map((change) => ({
        connection: "connection" in change ? change.connection : "",
        configured: true,
        updatedAt: null,
        restartRequired: false,
      })),
    );
    renderForm(labConnection, true);

    typeInto(input('input[type="password"]'), "sk-lab-new");
    await act(async () => saveButton().click());

    expect(fixture.apply).toHaveBeenCalledWith([
      {
        connection: KEY_ENV,
        value: "sk-lab-new",
        origin: "https://lab.example.test",
      },
    ]);
  });

  it("deletes a withheld desktop key when a save drops it", async () => {
    // The key was entered for another address, so the backend withholds it.
    const withheld = { ...labConnection, credential_state: "missing" };
    fixture.update.mockResolvedValue({
      ...withheld,
      credential_env: null,
      credential_state: "not_required",
    });
    fixture.apply.mockResolvedValue([]);
    renderForm(withheld as PyModelConnection, true);

    await act(async () => saveButton().click());

    expect(fixture.update).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ credential: { mode: "none" } }),
      }),
    );
    expect(fixture.apply).toHaveBeenCalledWith([{ connection: KEY_ENV }]);
  });

  it("asks for the key again when the address moves to another origin", () => {
    renderForm(labConnection, true);

    // Another path on the same origin keeps the saved key.
    typeInto(urlField(), "https://lab.example.test/v2");
    expect(saveButton().disabled).toBe(false);
    expect(alerts()).toEqual([]);

    typeInto(urlField(), "https://lab.example.test:8443/v1");
    expect(saveButton().disabled).toBe(true);
    expect(alerts()).toEqual([
      "The saved key was entered for another address. Enter the key again for this address, or remove it.",
    ]);

    typeInto(input('input[type="password"]'), "sk-lab-new");
    expect(saveButton().disabled).toBe(false);
    expect(alerts()).toEqual([]);
  });

  it("refuses to send a key over plain http to another computer", () => {
    renderForm(labConnection, true);

    typeInto(urlField(), "http://192.168.1.20:8000/v1");

    expect(saveButton().disabled).toBe(true);
    expect(alerts()).toContain(
      "Keys are sent only over https, or plain http to this computer. Use https or a local server.",
    );
  });

  it("tells a self-hosted operator which origin to set beside a connection key", () => {
    fixture.desktop = false;
    renderForm(
      { ...labConnection, credential_env: "ANIMAMA_CONNECTION_LAB_API_KEY" },
      false,
    );
    const variable = input(`input[placeholder]:not([inputmode])`);

    expect(container.textContent).toContain(
      "Also set ANIMAMA_CONNECTION_LAB_ORIGIN=https://lab.example.test on the server, so the key is sent only to this address.",
    );
    expect(container.textContent).toContain("Set on the server.");
    typeInto(variable, "OPENAI_API_KEY");
    expect(container.textContent).not.toContain("_ORIGIN");
  });

  it("says a self-hosted connection key is not usable until its origin is set", () => {
    fixture.desktop = false;
    renderForm(
      {
        ...labConnection,
        credential_env: "ANIMAMA_CONNECTION_LAB_API_KEY",
        credential_state: "missing",
      } as PyModelConnection,
      false,
    );

    expect(container.textContent).toContain(
      "Not usable yet. Set this variable to your API key on the server, and add the line below.",
    );
  });
});
