// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";

import { GeneratePage } from "./GeneratePage";
import {
  click,
  mountInDocument,
  type MountedInDocument,
} from "./testing/generationHarness";
import { enterPseudoLocale, unmarkedText } from "./testing/pseudoLocale";
import type { GenerationConversationChoice } from "./useGenerationConversationChoice";
import type { GenerationModelChoice } from "./useGenerationModel";

const fixture = vi.hoisted(() => ({
  model: null as unknown,
  conversations: null as unknown,
  openSettings: null as ((target: string) => void) | null,
  toastError: vi.fn(),
}));

vi.mock("./useGenerationModel", () => ({
  useGenerationModel: () => fixture.model,
}));
vi.mock("./useGenerationConversationChoice", () => ({
  useGenerationConversationChoice: () => fixture.conversations,
}));
vi.mock("@/stores/app-settings-request-store", () => ({
  useAppSettingsOpener: () => fixture.openSettings,
}));
vi.mock("@/ui/app/AppShellPage", () => ({
  AppShellPage: ({ children }: { children: ReactNode }) => (
    <div data-testid="page">{children}</div>
  ),
}));
// The plan connection's own card reads the plan's status; it has its own tests.
vi.mock("@/ui/settings/models/ChatGPTPlanCard", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/ui/settings/models/ChatGPTPlanCard")
  >()),
  ChatGPTPlanCard: () => <section data-testid="chatgpt-plan-card" />,
}));
vi.mock("sonner", () => ({ toast: { error: fixture.toastError } }));

const row = (
  id: string,
  extra: Partial<PyModelProviderCatalogItem> = {},
): PyModelProviderCatalogItem =>
  ({
    id,
    model: id,
    model_label: id,
    model_kind: "chat",
    hidden: false,
    supports_tools: true,
    supports_streaming: true,
    accepts: ["text", "image"],
    model_provider: "OpenAIResponsesHTTPAgent",
    api_standard: "responses",
    connection_name: "OpenAI",
    logo_provider: "openai",
    ...extra,
  }) as PyModelProviderCatalogItem;

function modelChoice(
  overrides: Partial<GenerationModelChoice> = {},
): GenerationModelChoice {
  return {
    models: [],
    // Every model given can be chosen, unless the test lists others too.
    listed: (overrides.models ?? []).map((item) => ({
      item,
      unavailable: null,
    })),
    model: null,
    isPending: false,
    isError: false,
    retry: vi.fn(),
    choose: vi.fn(async () => {}),
    isChoosing: false,
    efforts: [],
    effort: null,
    chooseEffort: vi.fn(async () => {}),
    ...overrides,
  };
}

function conversationChoice(
  overrides: Partial<GenerationConversationChoice> = {},
): GenerationConversationChoice {
  return {
    conversations: [],
    // No conversation yet: the page waits for one, so no workspace mounts.
    conversationId: null,
    isError: false,
    retry: vi.fn(),
    open: vi.fn(),
    startNew: vi.fn(async () => {}),
    isStarting: false,
    discard: vi.fn(async () => {}),
    isDiscarding: false,
    ...overrides,
  };
}

let mounted: MountedInDocument | null = null;
const page = () => {
  if (mounted) mounted.rerender(<GeneratePage />);
  else mounted = mountInDocument(<GeneratePage />);
  return mounted.container;
};
const find = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );

beforeEach(() => {
  fixture.model = modelChoice();
  fixture.conversations = conversationChoice();
  fixture.openSettings = vi.fn();
  fixture.toastError.mockClear();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the Generate page", () => {
  it("shows setup while the assistant has no model it can use", async () => {
    const root = page();
    const setup = find("generate-setup")!;
    expect(setup.textContent).toContain("Set up Generate");
    // The plan connection's own sign-in.
    expect(find("chatgpt-plan-card")).not.toBeNull();
    expect(setup.textContent).toContain(
      "No model can be used yet. Continue with ChatGPT above, or add a model under model connections.",
    );
    expect(setup.textContent).toContain("A Claude API key works too.");
    // No workspace behind setup.
    expect(root.textContent).not.toContain("Opening Generate…");
    expect(find("generate-setup-done")).toBeNull();

    await click(find("generate-setup-model-connections"));
    expect(fixture.openSettings).toHaveBeenCalledWith("model-connections");
  });

  it("lists the eligible models in setup and leaves it once one is chosen", async () => {
    const choose = vi.fn(async () => {
      fixture.model = modelChoice({ models, model: models[1]!, choose });
    });
    const models = [
      row("gpt-plan", {
        model_provider: "ChatGPTPlanResponsesHTTPAgent",
        connection_name: "ChatGPT plan",
      }),
      row("gpt-key"),
    ];
    fixture.model = modelChoice({ models, choose });
    page();
    const options = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="generate-model-option"]',
      ),
    ];
    expect(options.map((option) => option.dataset.modelId)).toEqual([
      "gpt-plan",
      "gpt-key",
    ]);

    await click(options[1]);
    expect(choose).toHaveBeenCalledWith("gpt-key");
    const root = page();
    expect(find("generate-setup")).toBeNull();
    expect(root.textContent).toContain("Opening Generate…");
  });

  it("lists a model the assistant cannot use with the reason, and says what to expect of a model", () => {
    const models = [row("gpt-key")];
    fixture.model = modelChoice({
      models,
      listed: [
        { item: models[0]!, unavailable: null },
        { item: row("no-tools"), unavailable: "tools_unsupported" },
        { item: row("tiny"), unavailable: "context_too_small" },
      ],
    });
    page();
    const setup = find("generate-setup")!;
    const unavailable = [
      ...setup.querySelectorAll<HTMLElement>(
        '[data-testid="generate-model-unavailable"]',
      ),
    ];
    expect(
      unavailable.map((item) => [
        item.dataset.modelId,
        item.dataset.reason,
        item.getAttribute("aria-disabled"),
      ]),
    ).toEqual([
      ["no-tools", "tools_unsupported", "true"],
      ["tiny", "context_too_small", "true"],
    ]);
    expect(unavailable[0]!.textContent).toContain("Cannot call tools");
    expect(unavailable[1]!.textContent).toContain(
      "Needs a context window of at least 64,000 tokens",
    );
    // Only the model that can be chosen is an option.
    expect(
      [
        ...setup.querySelectorAll<HTMLElement>(
          '[data-testid="generate-model-option"]',
        ),
      ].map((option) => option.dataset.modelId),
    ).toEqual(["gpt-key"]);
    expect(setup.textContent).toContain(
      "Models the assistant cannot use are listed with the reason.",
    );
    expect(setup.textContent).toContain(
      "Larger models write better motion; smaller ones need more repairs or leave more warnings.",
    );
  });

  it("still lists the models that cannot be chosen when none can", () => {
    fixture.model = modelChoice({
      listed: [{ item: row("no-tools"), unavailable: "tools_unsupported" }],
    });
    page();
    const setup = find("generate-setup")!;
    expect(setup.textContent).toContain("No model can be used yet.");
    expect(
      setup.querySelector('[data-testid="generate-model-unavailable"]'),
    ).not.toBeNull();
    expect(
      setup.querySelector('[data-testid="generate-model-option"]'),
    ).toBeNull();
  });

  it("opens on the workspace, not setup, once a model is chosen", () => {
    const models = [row("gpt-key")];
    fixture.model = modelChoice({ models, model: models[0]! });
    const root = page();
    expect(find("generate-setup")).toBeNull();
    expect(root.textContent).toContain("Opening Generate…");
  });

  it("says when the models or the conversations could not be read", async () => {
    const retry = vi.fn();
    fixture.model = modelChoice({ isError: true, retry });
    const root = page();
    expect(root.textContent).toContain("Your models could not be loaded.");
    expect(find("generate-setup")).toBeNull();
    await click(button(root, "Try again"));
    expect(retry).toHaveBeenCalledTimes(1);

    const models = [row("gpt-key")];
    const retryConversations = vi.fn();
    fixture.model = modelChoice({ models, model: models[0]! });
    fixture.conversations = conversationChoice({
      isError: true,
      retry: retryConversations,
    });
    page();
    expect(root.textContent).toContain(
      "Your conversations with the assistant could not be loaded.",
    );
    await click(button(root, "Try again"));
    expect(retryConversations).toHaveBeenCalledTimes(1);
  });

  it("waits while the models are read", () => {
    fixture.model = modelChoice({ isPending: true });
    const root = page();
    expect(root.textContent).toContain("Opening Generate…");
    expect(find("generate-setup")).toBeNull();
  });

  it("takes every word of setup from the catalogs", async () => {
    const leave = await enterPseudoLocale();
    const models = [row("gpt-key")];
    try {
      // The first visit, with a model to choose from.
      fixture.model = modelChoice({ models });
      page();
      expect(unmarkedText(document.body, ["gpt-key", "OpenAI"])).toEqual([]);
      mounted!.unmount();
      mounted = null;

      // Without any model, and without App Settings to open.
      fixture.model = modelChoice();
      fixture.openSettings = null;
      page();
      expect(find("generate-setup-model-connections")).toBeNull();
      expect(unmarkedText(document.body)).toEqual([]);
    } finally {
      await leave();
    }
  });
});
