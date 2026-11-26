// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PyModelConnection,
  PyModelProviderCatalogItem,
} from "@animama/runtime-contracts/api-types";

import { useAppSettingsRequestStore } from "@/stores/app-settings-request-store";
import type { ChatModelSelectorControl } from "@/ui/components/chat-input";

import { ChatModelKeyNotice } from "./ChatModelKeyNotice";
import { useAnimaModelKeyState } from "./useAnimaModelKeyState";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  capabilities: { model_configuration: true } as Record<string, unknown>,
  animaModel: "gpt",
  catalog: [] as unknown[],
  connections: [] as unknown[],
  chatDefault: "gpt" as string | null,
}));

vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({ data: fixture.capabilities }),
}));
vi.mock("@/query/hooks/useAnima", () => ({
  useAnima: () => ({
    data: { chat_profile: { default_model_provider_id: fixture.animaModel } },
  }),
}));
vi.mock("@/query/hooks/useModelProviders", () => ({
  useModelProviders: () => ({ data: fixture.catalog }),
}));
vi.mock("@/query/hooks/useModelConfiguration", () => ({
  useModelConnections: (enabled: boolean) => ({
    data: enabled ? fixture.connections : undefined,
  }),
  useModelRoles: (enabled: boolean) => ({
    data: enabled
      ? { roles: [{ role: "chat", model_provider_id: fixture.chatDefault }] }
      : undefined,
  }),
}));

const model = (
  id: string,
  connection: string,
  name: string,
): PyModelProviderCatalogItem =>
  ({
    id,
    model: id,
    model_label: id,
    model_provider: "OpenAIHTTPAgent",
    api_standard: "chat_completions",
    connection_id: connection,
    connection_name: name,
    model_kind: "chat",
    source: connection === "openai" ? "builtin" : "owner",
    hidden: false,
    supports_streaming: true,
    context_window_tokens: 8192,
  }) as PyModelProviderCatalogItem;
const connection = (
  id: string,
  credential_state: PyModelConnection["credential_state"],
) => ({ id, credential_state });

const gpt = model("gpt", "openai", "OpenAI");
const routed = model("routed", "openrouter", "OpenRouter");
const local = model("local", "ollama", "Ollama");

let root: Root | null = null;
let container: HTMLElement;
const control = {
  openModels: vi.fn(),
  select: vi.fn(async () => undefined),
} satisfies ChatModelSelectorControl;

/** The chat view's wiring: the notice shows only while the hook reports a state. */
function Composer() {
  const state = useAnimaModelKeyState("annie");
  return state ? (
    <ChatModelKeyNotice
      animaName="Annie"
      state={state}
      selector={() => control}
    />
  ) : null;
}

function render() {
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container);
    root.render(<Composer />);
  });
}
const buttons = () =>
  [...container.querySelectorAll("button")].map((node) => node.textContent);
async function press(label: string) {
  const target = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  )!;
  await act(async () => target.click());
}

beforeEach(() => {
  fixture.capabilities = { model_configuration: true };
  fixture.animaModel = "gpt";
  fixture.catalog = [gpt, routed];
  fixture.connections = [
    connection("openai", "missing"),
    connection("openrouter", "configured"),
    connection("ollama", "not_required"),
  ];
  fixture.chatDefault = "gpt";
  control.openModels.mockClear();
  control.select.mockClear();
  // The main window hosts App Settings.
  useAppSettingsRequestStore.setState({ hosts: 1, request: null });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  useAppSettingsRequestStore.setState({ hosts: 0, request: null });
});

describe("an Anima whose model has no key", () => {
  it("names the model and switches to the only model that can reply", async () => {
    render();

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Annie uses gpt, but OpenAI has no API key yet.",
    );
    expect(buttons()).toEqual(["Use routed", "Model settings"]);

    await press("Use routed");
    expect(control.select).toHaveBeenCalledWith(routed);
  });

  it("prefers the Chat default the owner set", () => {
    fixture.catalog = [gpt, routed, local];
    fixture.chatDefault = "local";
    render();

    expect(buttons()).toEqual(["Use local", "Model settings"]);
  });

  it("opens the model list when the owner has several models to choose from", async () => {
    fixture.catalog = [gpt, routed, local];
    render();

    expect(buttons()).toEqual(["Choose a model", "Model settings"]);
    await press("Choose a model");
    expect(control.openModels).toHaveBeenCalled();
    expect(control.select).not.toHaveBeenCalled();
  });

  it("leads to Models in App Settings, the only way out with no usable model", async () => {
    fixture.catalog = [gpt];
    render();

    expect(buttons()).toEqual(["Model settings"]);
    await press("Model settings");
    expect(useAppSettingsRequestStore.getState().request?.target).toBe(
      "model-connections",
    );
  });

  it("offers no settings action in a window without App Settings", () => {
    useAppSettingsRequestStore.setState({ hosts: 0 });
    render();

    expect(buttons()).toEqual(["Use routed"]);
  });
});

describe("an Anima whose model can reply", () => {
  it("shows nothing", () => {
    fixture.animaModel = "routed";
    render();
    expect(container.textContent).toBe("");
  });

  it("shows nothing where the owner does not configure connections", () => {
    fixture.capabilities = {};
    render();
    expect(container.textContent).toBe("");
  });

  it("shows nothing until the model lists have loaded", () => {
    fixture.connections = undefined as unknown as unknown[];
    render();
    expect(container.textContent).toBe("");
  });
});
