// @vitest-environment happy-dom
import { act, createRef } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PyAnimaChatProfileUpdateRequest,
  PyModelProviderCatalogItem,
  WebSearchCapability,
} from "@animama/runtime-contracts/api-types";

import type { ChatFeatureChoice } from "@/lib/chat/chat-request-options";
import {
  ChatInputModelSelector,
  type ChatModelSelectorControl,
} from "./chat-input";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Profile = {
  default_model_provider_id: string;
  reasoning_effort: string | null;
};

/** External stores standing in for the Anima query and SettingsProvider. */
const fixture = vi.hoisted(() => {
  function store<T>(initial: T) {
    let value = initial;
    const listeners = new Set<() => void>();
    return {
      get: () => value,
      set: (next: T) => {
        value = next;
        for (const listener of listeners) listener();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }
  return {
    profile: store<Profile>({
      default_model_provider_id: "",
      reasoning_effort: null,
    }),
    featureChoice: store<ChatFeatureChoice | null>(null),
    catalog: [] as PyModelProviderCatalogItem[],
    /** Every chat-profile PATCH body; throws to fail a save. */
    save: vi.fn((body: PyAnimaChatProfileUpdateRequest) => body),
    /** Saves wait for this before they settle. */
    hold: Promise.resolve(),
    toastError: vi.fn(),
    webSearch: undefined as WebSearchCapability | undefined,
  };
});

vi.mock("@/query/hooks/useAnima", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAnima: () => {
      const profile = useSyncExternalStore(
        fixture.profile.subscribe,
        fixture.profile.get,
      );
      return { data: { chat_profile: profile } };
    },
  };
});
vi.mock("@/query/hooks/useModelProviders", () => ({
  useModelProviders: () => ({ data: fixture.catalog, isSuccess: true }),
}));
vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({ data: { web_search: fixture.webSearch } }),
}));
/** Applies a PATCH the way the backend does: an omitted effort is kept for the same model and cleared by a new one. */
vi.mock("@/query/mutations/useUpdateAnimaChatProfile", () => ({
  useUpdateAnimaChatProfile: () => ({
    isPending: false,
    mutateAsync: async (variables: {
      body: PyAnimaChatProfileUpdateRequest;
    }) => {
      await fixture.hold;
      const body = fixture.save(variables.body);
      const current = fixture.profile.get();
      fixture.profile.set({
        default_model_provider_id: body.default_model_provider_id,
        reasoning_effort:
          body.reasoning_effort !== undefined
            ? body.reasoning_effort
            : body.default_model_provider_id ===
                current.default_model_provider_id
              ? current.reasoning_effort
              : null,
      });
    },
  }),
}));
vi.mock("@/ui/settings/SettingsProvider", async () => {
  const { useSyncExternalStore } = await import("react");
  type Choice = ChatFeatureChoice | null;
  return {
    useSettings: () => ({
      chatFeatureChoice: useSyncExternalStore(
        fixture.featureChoice.subscribe,
        fixture.featureChoice.get,
      ),
      setChatFeatureChoice: (update: Choice | ((current: Choice) => Choice)) =>
        fixture.featureChoice.set(
          typeof update === "function"
            ? update(fixture.featureChoice.get())
            : update,
        ),
    }),
  };
});
vi.mock("sonner", () => ({ toast: { error: fixture.toastError } }));
vi.mock("@/ui/components/tooltip", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Tooltip: Pass, TooltipTrigger: Pass, TooltipContent: () => null };
});

const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];
const LUNA = "OpenAIResponsesHTTPAgent:gpt-6-luna";
const HAIKU = "AnthropicMessagesHTTPAgent:claude-haiku-5-5";
const PLAN = "ChatGPTPlanResponsesHTTPAgent:gpt-5.6-luna";

const catalogRow = (
  id: string,
  extra: Partial<PyModelProviderCatalogItem>,
): PyModelProviderCatalogItem =>
  ({
    id,
    model: id.split(":")[1],
    model_label: id.split(":")[1],
    model_kind: "chat",
    source: "builtin",
    hidden: false,
    accepts: ["text"],
    produces: ["text"],
    supports_tools: true,
    supports_streaming: true,
    supports_reasoning: true,
    supported_reasoning_efforts: EFFORTS,
    requestable_native_tool_support: ["web_search"],
    context_window_tokens: 400000,
    ...extra,
  }) as PyModelProviderCatalogItem;

const luna = catalogRow(LUNA, {
  model_provider: "OpenAIResponsesHTTPAgent",
  connection_name: "OpenAI",
  logo_provider: "openai",
  api_standard: "responses",
  default_reasoning_effort: null,
});
const haiku = catalogRow(HAIKU, {
  model_provider: "AnthropicMessagesHTTPAgent",
  connection_name: "Anthropic",
  logo_provider: "anthropic",
  api_standard: "anthropic_messages",
  default_reasoning_effort: "medium",
});

const planLuna = catalogRow(PLAN, {
  model_provider: "ChatGPTPlanResponsesHTTPAgent",
  connection_id: "chatgpt_plan",
  connection_name: "ChatGPT plan",
  logo_provider: "openai",
  api_standard: "responses",
  default_reasoning_effort: null,
});

let root: Root | null = null;
let container: HTMLElement | null = null;

async function renderPicker(
  activeModelId: string,
  props: Partial<React.ComponentProps<typeof ChatInputModelSelector>> = {},
  openPicker = true,
  savedEffort: string | null = null,
) {
  fixture.profile.set({
    default_model_provider_id: activeModelId,
    reasoning_effort: savedEffort,
  });
  await mountPicker(props, openPicker);
}

/** Mounts the picker over the current fixture state, as returning to the chat page does. */
async function mountPicker(
  props: Partial<React.ComponentProps<typeof ChatInputModelSelector>> = {},
  openPicker = true,
) {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<ChatInputModelSelector animaId="anima-1" {...props} />);
  });
  if (openPicker) await click(trigger());
}

function trigger() {
  return document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Model and reasoning:"]',
  )!;
}

function button(label: string) {
  return document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
}

function popover() {
  return document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
}

function row(model: string) {
  const element = [
    ...document.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
  ].find((candidate) => candidate.textContent?.includes(model));
  if (!element) throw new Error(`No ${model} row`);
  return element;
}

async function chooseModel(model: string) {
  await click(button("Select model"));
  await click(row(model));
}

async function toggleSearch() {
  await click(button("Chat features"));
  await click(webSearch());
  await click(button("Back to model and reasoning"));
}

function slider() {
  return document.querySelector<HTMLElement>('[role="slider"]')!;
}

function webSearch() {
  return document.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
}

async function pressEffortKey(key: string) {
  await act(async () => {
    slider().focus();
    slider().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function unmountPicker() {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
}

/** Model ids of the PATCHes that changed the model (no effort named). */
function modelSaves() {
  return fixture.save.mock.calls
    .map(([body]) => body)
    .filter((body) => body.reasoning_effort === undefined)
    .map((body) => body.default_model_provider_id);
}

/** Efforts of the PATCHes that saved an effort. */
function effortSaves() {
  return fixture.save.mock.calls
    .map(([body]) => body)
    .filter((body) => body.reasoning_effort !== undefined)
    .map((body) => body.reasoning_effort);
}

function searchChecked() {
  return webSearch().getAttribute("aria-checked");
}

beforeEach(() => {
  fixture.hold = Promise.resolve();
  fixture.toastError.mockReset();
  fixture.catalog = [luna, haiku];
  fixture.featureChoice.set(null);
  fixture.save.mockReset();
  fixture.save.mockImplementation((body) => body);
  fixture.webSearch = undefined;
});

afterEach(unmountPicker);

describe("ChatGPT plan models in the picker", () => {
  const headings = () =>
    [...popover().querySelectorAll("[cmdk-group-heading]")].map(
      (heading) => heading.textContent,
    );

  it("ends the open picker with the plan notice while a plan model is selected", async () => {
    fixture.catalog = [{ ...luna, connection_id: "openai" }, haiku, planLuna];
    await renderPicker(PLAN);
    expect(popover().textContent).toContain("Using ChatGPT plan");

    await click(button("Select model"));
    // OpenAI's two ways sit side by side, plan first, and each row says which.
    expect(headings()).toEqual([
      "OpenAI · ChatGPT plan",
      "OpenAI · API key",
      "Anthropic",
    ]);
    expect(row("gpt-6-luna").textContent).toContain("API key");
    expect(popover().textContent).toContain("Using ChatGPT plan");

    await click(button("Back to model and reasoning"));
    await click(button("Chat features"));
    expect(popover().textContent).not.toContain("Using ChatGPT plan");
  });

  it("shows no notice and one OpenAI group without plan models", async () => {
    fixture.catalog = [{ ...luna, connection_id: "openai" }, haiku];
    await renderPicker(LUNA);
    expect(popover().textContent).not.toContain("Using ChatGPT plan");
    await click(button("Select model"));
    expect(headings()).toEqual(["OpenAI", "Anthropic"]);
    expect(popover().textContent).not.toContain("API key");
  });
});

describe("chat model picker settings", () => {
  it("keeps the composer logo-only and removes fast and reset controls", async () => {
    await renderPicker(LUNA, {}, false);

    expect(trigger().textContent).toBe("");
    expect(
      trigger().querySelector('[aria-label="openai provider"]'),
    ).not.toBeNull();
    expect(button("Chat features")).toBeNull();
    expect(popover()).toBeNull();
    await click(trigger());
    expect(popover().contains(button("Chat features"))).toBe(true);
    expect(button("Reset reasoning to model default")).toBeNull();
    expect(document.querySelector(".lucide-zap")).toBeNull();
  });

  it("starts at the selected model's default without saving it", async () => {
    await renderPicker(LUNA);

    expect(slider().getAttribute("aria-label")).toBe("Reasoning effort");
    expect(slider().getAttribute("aria-valuetext")).toBe("None");
    expect(slider().getAttribute("aria-valuemax")).toBe("5");
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it("saves a chosen effort on the Anima and shows it after the picker remounts", async () => {
    await renderPicker(LUNA);
    await pressEffortKey("ArrowRight");

    expect(effortSaves()).toEqual(["low"]);
    expect(fixture.profile.get()).toEqual({
      default_model_provider_id: LUNA,
      reasoning_effort: "low",
    });

    unmountPicker();
    await mountPicker();

    expect(slider().getAttribute("aria-valuetext")).toBe("Low");
    expect(effortSaves()).toEqual(["low"]);
  });

  it("shows a saved effort, or the model's default when the model no longer offers it", async () => {
    await renderPicker(HAIKU, {}, true, "high");
    expect(slider().getAttribute("aria-valuetext")).toBe("High");
    unmountPicker();

    fixture.catalog = [
      luna,
      { ...haiku, supported_reasoning_efforts: ["low", "medium"] },
    ];
    await renderPicker(HAIKU, {}, true, "high");
    expect(slider().getAttribute("aria-valuetext")).toBe("Medium");
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it("shows a committed effort while it saves, and the saved one again if the save fails", async () => {
    await renderPicker(LUNA, {}, true, "low");
    let release!: () => void;
    fixture.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.save.mockImplementationOnce(() => {
      throw new Error("Profile update failed");
    });
    await pressEffortKey("ArrowRight");

    expect(slider().getAttribute("aria-valuetext")).toBe("Medium");
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(effortSaves()).toEqual(["medium"]);
    expect(fixture.profile.get().reasoning_effort).toBe("low");
    expect(slider().getAttribute("aria-valuetext")).toBe("Low");
    expect(fixture.toastError).toHaveBeenCalledWith(
      "Failed to save reasoning effort",
    );
  });

  it("transforms the same popover into models and back without changing the model", async () => {
    await renderPicker(LUNA);
    await pressEffortKey("End");
    const panel = popover();
    await click(button("Select model"));

    expect(popover()).toBe(panel);
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(document.activeElement).toBe(
      document.querySelector('[placeholder="Search models..."]'),
    );
    expect(row("claude-haiku-5-5")).not.toBeNull();
    await click(button("Back to model and reasoning"));

    expect(popover()).toBe(panel);
    expect(slider().getAttribute("aria-valuetext")).toBe("Max");
    expect(document.activeElement).toBe(button("Select model"));
    expect(modelSaves()).toEqual([]);
  });

  it("selecting a different model uses its own default effort and features", async () => {
    await renderPicker(LUNA);
    await pressEffortKey("End");
    await toggleSearch();
    await chooseModel("claude-haiku-5-5");

    expect(modelSaves()).toEqual([HAIKU]);
    expect(fixture.profile.get().reasoning_effort).toBeNull();
    expect(slider().getAttribute("aria-valuetext")).toBe("Medium");
    expect(
      trigger().querySelector('[aria-label="anthropic provider"]'),
    ).not.toBeNull();
    await click(button("Chat features"));
    expect(searchChecked()).toBe("true");
  });

  it("does not carry the Anthropic effort to an OpenAI model", async () => {
    await renderPicker(HAIKU, {}, true, "high");
    await chooseModel("gpt-6-luna");

    expect(modelSaves()).toEqual([LUNA]);
    expect(slider().getAttribute("aria-valuetext")).toBe("None");
  });

  it("keeps feature and reasoning choices across views and picker remounts", async () => {
    await renderPicker(HAIKU);
    await pressEffortKey("ArrowRight");
    const panel = popover();
    await toggleSearch();

    expect(popover()).toBe(panel);
    expect(modelSaves()).toEqual([]);
    expect(fixture.featureChoice.get()).toEqual({
      animaId: "anima-1",
      modelProviderId: HAIKU,
      nativeTools: [],
    });
    await pressEffortKey("ArrowRight");
    expect(slider().getAttribute("aria-valuetext")).toBe("Extra high");
    await chooseModel("claude-haiku-5-5");
    expect(modelSaves()).toEqual([]);

    unmountPicker();
    await mountPicker();

    expect(slider().getAttribute("aria-valuetext")).toBe("Extra high");
    await click(button("Chat features"));
    expect(searchChecked()).toBe("false");
    expect(effortSaves()).toEqual(["high", "xhigh"]);
  });

  it("keeps the current model, effort and chooser when saving a new model fails", async () => {
    const onModelChange = vi.fn();
    await renderPicker(LUNA, { onModelChange });
    await pressEffortKey("End");
    fixture.save.mockImplementationOnce(() => {
      throw new Error("Profile update failed");
    });
    await chooseModel("claude-haiku-5-5");

    expect(fixture.profile.get()).toEqual({
      default_model_provider_id: LUNA,
      reasoning_effort: "max",
    });
    expect(popover().getAttribute("aria-label")).toBe("Select model");
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("retains confirmation for an incompatible chat without saving", async () => {
    const onIncompatibleModelSelect = vi.fn();
    await renderPicker(LUNA, {
      activeChat: { id: "chat-1", api_standard: "responses" },
      onIncompatibleModelSelect,
    });
    await chooseModel("claude-haiku-5-5");

    expect(onIncompatibleModelSelect).toHaveBeenCalledWith(haiku);
    expect(fixture.save).not.toHaveBeenCalled();
    expect(popover().getAttribute("aria-label")).toBe("Select model");
  });

  it("marks the button, still without a label, when the model has no key", async () => {
    await renderPicker(LUNA, { keyMissing: true }, false);

    expect(trigger().getAttribute("aria-label")).toBe(
      "Model and reasoning: OpenAI: gpt-6-luna has no API key",
    );
    expect(trigger().textContent).toBe("");
    expect(trigger().querySelector(".lucide-triangle-alert")).not.toBeNull();
    expect(
      trigger().querySelector('[aria-label="openai provider"]'),
    ).toBeNull();
  });

  it("lets the composer open the model list and switch as the list does", async () => {
    const control = createRef<ChatModelSelectorControl>();
    const onIncompatibleModelSelect = vi.fn();
    await renderPicker(LUNA, { controlRef: control }, false);

    await act(async () => control.current!.openModels());
    expect(popover().getAttribute("aria-label")).toBe("Select model");
    expect(row("claude-haiku-5-5")).not.toBeNull();

    await act(async () => control.current!.select(haiku));
    expect(modelSaves()).toEqual([HAIKU]);

    // An open chat on another API still asks first, as choosing in the list does.
    unmountPicker();
    fixture.save.mockClear();
    await renderPicker(
      LUNA,
      {
        controlRef: control,
        activeChat: { id: "chat-1", api_standard: "responses" },
        onIncompatibleModelSelect,
      },
      false,
    );
    await act(async () => control.current!.select(haiku));
    expect(onIncompatibleModelSelect).toHaveBeenCalledWith(haiku);
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it("explains unavailable web search and omits a slider for fixed models", async () => {
    fixture.catalog = [
      {
        ...luna,
        requestable_native_tool_support: [],
        supported_reasoning_efforts: [],
        supports_reasoning: false,
      },
    ];
    fixture.webSearch = { configuration: true, configured: false };
    await renderPicker(LUNA);

    expect(slider()).toBeNull();
    expect(button("Select model")).not.toBeNull();
    await click(button("Chat features"));
    expect(webSearch().disabled).toBe(true);
    expect(popover().textContent).toContain(
      "Set up web search in App Settings.",
    );
    await click(webSearch());
    expect(fixture.featureChoice.get()).toBeNull();
  });

  it("prevents feature and reasoning changes when chat controls become disabled", async () => {
    await renderPicker(HAIKU);
    await act(async () => {
      root!.render(<ChatInputModelSelector animaId="anima-1" disabled />);
    });
    await pressEffortKey("End");

    expect(fixture.save).not.toHaveBeenCalled();
    expect(slider().getAttribute("aria-valuetext")).toBe("Medium");
    expect(slider().getAttribute("data-disabled")).not.toBeNull();
    expect(button("Chat features").disabled).toBe(true);
    expect(trigger().disabled).toBe(true);
  });
});
