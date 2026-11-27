// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PyGenerationConversationUsage,
  PyModelProviderCatalogItem,
} from "@animama/runtime-contracts/api-types";

import { supportedReasoningEfforts } from "@/lib/chat/model-catalog";
import { CHATGPT_MANAGE_USAGE_URL } from "@/query/hooks/useChatGPTPlan";
import { GenerateModelControl } from "./GenerateModelControl";
import {
  chosenGenerationModel,
  eligibleGenerationModels,
  listedGenerationModels,
} from "./generateModels";
import { generationUsage } from "./testing/generationFixtures";
import {
  click,
  mountInDocument,
  type MountedInDocument,
} from "./testing/generationHarness";
import { enterPseudoLocale, unmarkedText } from "./testing/pseudoLocale";
import type { GenerationModelChoice } from "./useGenerationModel";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const row = (
  id: string,
  extra: Partial<PyModelProviderCatalogItem> = {},
): PyModelProviderCatalogItem =>
  ({
    id,
    model: id,
    model_label: id,
    model_kind: "chat",
    source: "builtin",
    hidden: false,
    accepts: ["text", "image"],
    produces: ["text"],
    supports_tools: true,
    supports_streaming: true,
    model_provider: "OpenAIResponsesHTTPAgent",
    api_standard: "responses",
    connection_name: "OpenAI",
    logo_provider: "openai",
    ...extra,
  }) as PyModelProviderCatalogItem;

const CATALOG = [
  row("gpt-key"),
  row("no-tools", { supports_tools: false }),
  row("hidden-model", { hidden: true }),
  row("embedder", { model_kind: "embedding" }),
  // The owner's own model without a context window: chat cannot use it yet.
  row("own-no-window", {
    model_provider: "OpenAIHTTPAgent",
    api_standard: "chat_completions",
    connection_name: "My server",
    source: "owner",
    context_window_tokens: null,
  }),
  row("claude-haiku", {
    model_provider: "AnthropicMessagesHTTPAgent",
    connection_name: "Anthropic",
    logo_provider: "anthropic",
    accepts: ["text"],
  }),
  row("gpt-plan", {
    model_provider: "ChatGPTPlanResponsesHTTPAgent",
    connection_id: "chatgpt_plan",
    connection_name: "ChatGPT plan",
    supported_reasoning_efforts: ["low", "medium", "high"],
  }),
  // Room for a chat turn, not for the assistant's passes.
  row("small-window", {
    model_provider: "OpenAIHTTPAgent",
    api_standard: "chat_completions",
    connection_name: "My server",
    source: "owner",
    context_window_tokens: 8192,
  }),
  row("no-stream", { supports_streaming: false }),
  // A row the app has no API to talk to.
  row("no-api", { api_standard: null }),
];

/** The choice as `useGenerationModel` gives it for a catalog and a saved id. */
function choice(
  savedId: string | null,
  overrides: Partial<GenerationModelChoice> = {},
): GenerationModelChoice {
  const model = chosenGenerationModel(CATALOG, savedId);
  return {
    models: eligibleGenerationModels(CATALOG),
    listed: listedGenerationModels(CATALOG),
    model,
    isPending: false,
    isError: false,
    retry: vi.fn(),
    choose: vi.fn(async () => {}),
    isChoosing: false,
    efforts: supportedReasoningEfforts(model),
    effort: null,
    chooseEffort: vi.fn(async () => {}),
    ...overrides,
  };
}

let mounted: MountedInDocument | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  toastError.mockClear();
});

const trigger = () =>
  document.querySelector<HTMLButtonElement>(
    '[data-testid="generate-model-control"]',
  )!;
const options = () => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-testid="generate-model-option"]',
  ),
];
const unavailable = () => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-testid="generate-model-unavailable"]',
  ),
];
const popover = () =>
  document.querySelector<HTMLElement>('[data-slot="popover-content"]');
const find = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const slider = () => document.querySelector<HTMLElement>('[role="slider"]');

type ControlProps = {
  disabled?: boolean;
  onOpenSetup?: () => void;
  usage?: PyGenerationConversationUsage | null;
};

const control = (selected: GenerationModelChoice, props: ControlProps = {}) => (
  <GenerateModelControl
    choice={selected}
    disabled={props.disabled}
    usage={props.usage}
    onOpenSetup={props.onOpenSetup ?? (() => {})}
  />
);

async function open(selected: GenerationModelChoice, props: ControlProps = {}) {
  mounted = mountInDocument(control(selected, props));
  await click(trigger());
}

/** Move the effort slider by one key press and let the save settle. */
async function pressEffortKey(key: string) {
  await act(async () => {
    slider()!.focus();
    slider()!.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const KEY_RUN = {
  run_id: "run-2",
  model_provider_id: "gpt-key",
  plan: false,
  input_tokens: 61_838,
  cached_input_tokens: 0,
  output_tokens: 1_458,
  reasoning_tokens: 0,
  requests: 3,
  cost: { currency: "USD", amount: "0.138256" },
};
const KEY_USAGE = generationUsage({
  input_tokens: 161_793,
  output_tokens: 3_718,
  requests: 8,
  runs: 2,
  cost: { currency: "USD", amount: "0.360766" },
  cost_complete: true,
  last_run: KEY_RUN,
});

describe("the assistant's model control", () => {
  it("names the chosen model and lists the models the assistant may use", async () => {
    await open(choice("gpt-key"));
    expect(trigger().getAttribute("aria-label")).toBe(
      "Assistant model: gpt-key",
    );
    expect(trigger().dataset.modelId).toBe("gpt-key");
    // The plan's models first; nothing hidden, embedding or without tools,
    // and nothing the backend would refuse when a run starts.
    expect(options().map((option) => option.dataset.modelId)).toEqual([
      "gpt-plan",
      "gpt-key",
      "claude-haiku",
    ]);
    expect(
      options().find((option) => option.dataset.checked === "true")?.dataset
        .modelId,
    ).toBe("gpt-key");
    expect(popover()!.textContent).toContain(
      "The assistant writes and repairs drafts with this model.",
    );
  });

  it("lists the models the assistant cannot use disabled, each with its reason in words", async () => {
    await open(choice("gpt-key"));
    expect(
      unavailable().map((item) => [
        item.dataset.modelId,
        item.dataset.reason,
        item.getAttribute("aria-disabled"),
      ]),
    ).toEqual([
      ["no-tools", "tools_unsupported", "true"],
      ["no-stream", "streaming_unsupported", "true"],
      ["no-api", "chat_unsupported", "true"],
      ["own-no-window", "context_window_missing", "true"],
      ["small-window", "context_too_small", "true"],
    ]);
    const reason = (id: string) =>
      unavailable().find((item) => item.dataset.modelId === id)!.textContent;
    expect(reason("no-tools")).toContain("Cannot call tools");
    expect(reason("no-stream")).toContain("Cannot stream replies");
    expect(reason("small-window")).toContain(
      "Needs a context window of at least 64,000 tokens",
    );
    // The two reasons chat's own picker gives read as they do there.
    expect(reason("own-no-window")).toContain(
      "Set its context window in App Settings → Models",
    );
    expect(reason("no-api")).toContain("Not available for direct chat yet");
    // Nothing the owner hid, and no embedding model, is listed at all.
    const ids = [...options(), ...unavailable()].map(
      (item) => item.dataset.modelId,
    );
    expect(ids).not.toContain("hidden-model");
    expect(ids).not.toContain("embedder");
  });

  it("does not choose a model that cannot be used", async () => {
    const selected = choice("gpt-key");
    await open(selected);
    await click(unavailable()[0]);
    expect(selected.choose).not.toHaveBeenCalled();
    expect(popover()).not.toBeNull();
  });

  it("says what to expect of a larger or a smaller model, naming none", async () => {
    await open(choice("gpt-key"));
    const note = popover()!.querySelector('[role="note"]')!;
    expect(note.textContent).toBe(
      "Larger models write better motion; smaller ones need more repairs or leave more warnings.",
    );
  });

  it("offers the chosen model's effort levels after the model's own default", async () => {
    await open(choice("gpt-plan"));
    expect(find("generate-effort")!.dataset.effort).toBe("default");
    expect(slider()!.getAttribute("aria-label")).toBe("Reasoning effort");
    // No level chosen: the first stop, which names none.
    expect(slider()!.getAttribute("aria-valuetext")).toBe("Model default");
    expect(slider()!.getAttribute("aria-valuenow")).toBe("0");
    // One stop for the default, then the model's three levels.
    expect(slider()!.getAttribute("aria-valuemax")).toBe("3");
    expect(find("generate-effort")!.textContent).toContain("Model default");
  });

  it("shows the saved level and saves the one the person picks", async () => {
    const selected = choice("gpt-plan", { effort: "medium" });
    await open(selected);
    expect(find("generate-effort")!.dataset.effort).toBe("medium");
    expect(slider()!.getAttribute("aria-valuetext")).toBe("Medium");

    await pressEffortKey("ArrowRight");
    expect(selected.chooseEffort).toHaveBeenLastCalledWith("high");
    await pressEffortKey("Home");
    // The first stop returns to the model's default.
    expect(selected.chooseEffort).toHaveBeenLastCalledWith(null);
  });

  it("says when the effort could not be saved", async () => {
    const selected = choice("gpt-plan", {
      chooseEffort: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await open(selected);
    await pressEffortKey("ArrowRight");
    expect(toastError).toHaveBeenCalledWith(
      "The reasoning effort could not be saved.",
    );
    // The level on screen is the saved one again.
    expect(find("generate-effort")!.dataset.effort).toBe("default");
  });

  it("shows no effort control for a model that offers no levels", async () => {
    await open(choice("gpt-key"));
    expect(find("generate-effort")).toBeNull();
    expect(slider()).toBeNull();
  });

  it("shows the last run's tokens and the conversation's, with the estimates", async () => {
    await open(choice("gpt-key"), { usage: KEY_USAGE });
    expect(find("generate-usage")!.textContent).toContain("Token use");
    expect(find("generate-usage-last-run")!.textContent).toBe(
      "Last run: 61,838 input and 1,458 output tokens, about $0.1383.",
    );
    expect(find("generate-usage-conversation")!.textContent).toBe(
      "This conversation: 161,793 input and 3,718 output tokens, about $0.3608.",
    );
    expect(find("generate-usage")!.textContent).toContain(
      "Costs are estimates from the model's listed prices.",
    );
  });

  it("shows tokens alone for a model without a listed price", async () => {
    await open(choice("gpt-key"), {
      usage: {
        ...KEY_USAGE,
        cost: null,
        cost_complete: false,
        last_run: { ...KEY_RUN, cost: null },
      },
    });
    expect(find("generate-usage-last-run")!.textContent).toBe(
      "Last run: 61,838 input and 1,458 output tokens.",
    );
    expect(find("generate-usage-conversation")!.textContent).toBe(
      "This conversation: 161,793 input and 3,718 output tokens.",
    );
    expect(find("generate-usage")!.textContent).not.toContain("estimates");
    expect(popover()!.textContent).not.toContain("$");
  });

  it("says when the estimate leaves runs out", async () => {
    await open(choice("gpt-key"), {
      usage: { ...KEY_USAGE, cost_complete: false },
    });
    expect(find("generate-usage-conversation")!.textContent).toBe(
      "This conversation: 161,793 input and 3,718 output tokens, about $0.3608 for the runs with a known price.",
    );
  });

  it("shows the plan notice instead of any amount on a ChatGPT plan model", async () => {
    // Earlier runs on a key model left estimates; the last run was on the plan.
    const usage = {
      ...KEY_USAGE,
      cost_complete: false,
      last_run: {
        ...KEY_RUN,
        model_provider_id: "gpt-plan",
        plan: true,
        cost: null,
      },
    };
    await open(choice("gpt-plan"), { usage });
    expect(find("generate-usage-last-run")!.textContent).toBe(
      "Last run: 61,838 input and 1,458 output tokens.",
    );
    expect(find("generate-usage-conversation")!.textContent).toBe(
      "This conversation: 161,793 input and 3,718 output tokens.",
    );
    // No currency amount anywhere while a plan model is chosen.
    expect(popover()!.textContent).not.toMatch(/[$€£¥]|USD/);
    expect(popover()!.textContent).not.toContain("estimates");
    expect(popover()!.lastElementChild!.textContent).toContain(
      "Using ChatGPT plan",
    );
    mounted!.unmount();

    // Back on a key model, the plan run itself still shows no amount.
    await open(choice("gpt-key"), { usage });
    expect(find("generate-usage-last-run")!.textContent).not.toContain("$");
    expect(find("generate-usage-conversation")!.textContent).toContain(
      "about $0.3608 for the runs with a known price",
    );
  });

  it("shows no usage before a run has made a model request", async () => {
    await open(choice("gpt-key"), { usage: generationUsage({ runs: 1 }) });
    expect(find("generate-usage")).toBeNull();
    mounted!.unmount();
    await open(choice("gpt-key"));
    expect(find("generate-usage")).toBeNull();
  });

  it("keeps small amounts readable and survives a currency it does not know", async () => {
    await open(choice("gpt-key"), {
      usage: {
        ...KEY_USAGE,
        cost: { currency: "USD", amount: "12.5" },
        last_run: { ...KEY_RUN, cost: { currency: "USD", amount: "0.000004" } },
      },
    });
    expect(find("generate-usage-last-run")!.textContent).toContain(
      "about $0.0001.",
    );
    expect(find("generate-usage-conversation")!.textContent).toContain(
      "about $12.50.",
    );
    mounted!.unmount();

    await open(choice("gpt-key"), {
      usage: { ...KEY_USAGE, cost: { currency: "credits", amount: "3.5" } },
    });
    expect(find("generate-usage-conversation")!.textContent).toContain(
      "about 3.5 credits.",
    );
  });

  it("opens when the page asks, and never while a run is in flight", async () => {
    const onOpenChange = vi.fn();
    const render = (isOpen: boolean, disabled = false) => (
      <GenerateModelControl
        choice={choice("gpt-key")}
        disabled={disabled}
        open={isOpen}
        onOpenChange={onOpenChange}
        onOpenSetup={() => {}}
      />
    );
    mounted = mountInDocument(render(false));
    expect(popover()).toBeNull();
    // "Choose another model" beside a failed run opens the control.
    mounted.rerender(render(true));
    expect(popover()).not.toBeNull();
    await click(options()[0]);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    mounted.rerender(render(true, true));
    expect(popover()).toBeNull();
  });

  it("ends with the plan notice and Manage usage on a plan model only", async () => {
    await open(choice("gpt-plan"));
    expect(popover()!.textContent).toContain("Using ChatGPT plan");
    const link = popover()!.querySelector(
      `a[href="${CHATGPT_MANAGE_USAGE_URL}"]`,
    );
    expect(link?.textContent).toContain("Manage usage");
    // The notice is the control's last row.
    expect(popover()!.lastElementChild!.textContent).toContain(
      "Using ChatGPT plan",
    );
    mounted!.unmount();

    await open(choice("gpt-key"));
    expect(popover()!.textContent).not.toContain("Using ChatGPT plan");
    expect(popover()!.querySelector("a")).toBeNull();
  });

  it("saves the model the person picks", async () => {
    const selected = choice("gpt-key");
    await open(selected);
    await click(
      options().find((option) => option.dataset.modelId === "claude-haiku"),
    );
    expect(selected.choose).toHaveBeenCalledWith("claude-haiku");
    expect(popover()).toBeNull();
  });

  it("says when the choice could not be saved", async () => {
    const selected = choice("gpt-key", {
      choose: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await open(selected);
    await click(options()[0]);
    expect(toastError).toHaveBeenCalledWith(
      "The model choice could not be saved.",
    );
  });

  it("says when the chosen model cannot look at frames", async () => {
    await open(choice("claude-haiku"));
    expect(popover()!.textContent).toContain(
      "This model cannot look at images, so the assistant skips reviewing rendered frames.",
    );
    mounted!.unmount();
    await open(choice("gpt-key"));
    expect(popover()!.textContent).not.toContain("cannot look at images");
  });

  it("reopens setup from its last action", async () => {
    const onOpenSetup = vi.fn();
    await open(choice("gpt-key"), { onOpenSetup });
    await click(document.querySelector('[data-testid="generate-model-setup"]'));
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
    expect(popover()).toBeNull();
  });

  it("stays closed while a run is in flight", async () => {
    await open(choice("gpt-key"), { disabled: true });
    expect(trigger().disabled).toBe(true);
    expect(popover()).toBeNull();
  });

  it("takes every word it shows from the catalogs", async () => {
    const leave = await enterPseudoLocale();
    try {
      await open(choice("gpt-plan", { effort: "high" }), { usage: KEY_USAGE });
      expect(find("generate-usage")).not.toBeNull();
      expect(find("generate-effort")).not.toBeNull();
      expect(
        unmarkedText(document.body, [
          "gpt-plan",
          "gpt-key",
          "claude-haiku",
          "no-tools",
          "no-stream",
          "no-api",
          "own-no-window",
          "small-window",
          // Connection names are the owner's data.
          "ChatGPT plan",
          "OpenAI",
          "Anthropic",
          "My server",
        ]),
      ).toEqual([]);
      mounted!.unmount();
      // With the estimates a key model shows.
      await open(choice("gpt-key"), { usage: KEY_USAGE });
      expect(
        unmarkedText(document.body, [
          "gpt-plan",
          "gpt-key",
          "claude-haiku",
          "no-tools",
          "no-stream",
          "no-api",
          "own-no-window",
          "small-window",
          "ChatGPT plan",
          "OpenAI",
          "Anthropic",
          "My server",
        ]),
      ).toEqual([]);
    } finally {
      await leave();
    }
  });
});
