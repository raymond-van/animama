// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";

import { CHATGPT_MANAGE_USAGE_URL } from "@/query/hooks/useChatGPTPlan";
import { GenerateModelControl } from "./GenerateModelControl";
import {
  chosenGenerationModel,
  eligibleGenerationModels,
} from "./generateModels";
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
  }),
];

/** The choice as `useGenerationModel` gives it for a catalog and a saved id. */
function choice(
  savedId: string | null,
  overrides: Partial<GenerationModelChoice> = {},
): GenerationModelChoice {
  return {
    models: eligibleGenerationModels(CATALOG),
    model: chosenGenerationModel(CATALOG, savedId),
    isPending: false,
    isError: false,
    retry: vi.fn(),
    choose: vi.fn(async () => {}),
    isChoosing: false,
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
const popover = () =>
  document.querySelector<HTMLElement>('[data-slot="popover-content"]');

async function open(
  selected: GenerationModelChoice,
  props: { disabled?: boolean; onOpenSetup?: () => void } = {},
) {
  mounted = mountInDocument(
    <GenerateModelControl
      choice={selected}
      disabled={props.disabled}
      onOpenSetup={props.onOpenSetup ?? (() => {})}
    />,
  );
  await click(trigger());
}

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
      await open(choice("gpt-plan"));
      expect(
        unmarkedText(document.body, [
          "gpt-plan",
          "gpt-key",
          "claude-haiku",
          // Connection names are the owner's data.
          "ChatGPT plan",
          "OpenAI",
          "Anthropic",
        ]),
      ).toEqual([]);
    } finally {
      await leave();
    }
  });
});
