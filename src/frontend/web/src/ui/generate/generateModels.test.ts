import { describe, expect, it } from "vitest";
import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";

import { CHATGPT_PLAN_PROVIDER_TYPE } from "@/lib/chat/model-catalog";
import {
  chosenGenerationModel,
  eligibleGenerationModels,
  generationModelIneligibility,
  generationModelReviewsFrames,
  isChatGPTPlanModel,
} from "./generateModels";

const model = (
  id: string,
  overrides: Partial<PyModelProviderCatalogItem> = {},
): PyModelProviderCatalogItem => ({
  id,
  model: id,
  model_provider: "OpenAIResponsesHTTPAgent",
  api_standard: "responses",
  model_kind: "chat",
  source: "builtin",
  hidden: false,
  supports_tools: true,
  supports_streaming: true,
  accepts: ["text", "image"],
  ...overrides,
});

const CATALOG = [
  model("key-model"),
  model("embedding", { model_kind: "embedding", supports_tools: false }),
  model("hidden-model", { hidden: true }),
  model("plan-a", { model_provider: CHATGPT_PLAN_PROVIDER_TYPE }),
  model("no-tools", { supports_tools: false }),
  model("local-model", {
    model_provider: "OpenAIHTTPAgent",
    accepts: ["text"],
  }),
  model("plan-b", { model_provider: CHATGPT_PLAN_PROVIDER_TYPE }),
  model("plan-hidden", {
    model_provider: CHATGPT_PLAN_PROVIDER_TYPE,
    hidden: true,
  }),
  // The owner's own models: chat needs their context window before it uses one.
  model("own-no-window", {
    model_provider: "OpenAIHTTPAgent",
    api_standard: "chat_completions",
    source: "owner",
    context_window_tokens: null,
  }),
  model("own-model", {
    model_provider: "OpenAIHTTPAgent",
    api_standard: "chat_completions",
    source: "owner",
    context_window_tokens: 32_768,
  }),
  // A row the app has no API to talk to.
  model("no-api", { api_standard: null }),
  // The owner turned streaming off for it; a run streams its replies.
  model("no-streaming", {
    source: "owner",
    context_window_tokens: 8192,
    supports_streaming: false,
  }),
];

describe("generationModelIneligibility", () => {
  it("accepts a visible chat model that calls tools, on any connection", () => {
    for (const id of ["key-model", "plan-a", "local-model", "own-model"])
      expect(
        generationModelIneligibility(CATALOG.find((item) => item.id === id)!),
      ).toBeNull();
  });

  it("says why a model cannot be used", () => {
    const reason = (id: string) =>
      generationModelIneligibility(CATALOG.find((item) => item.id === id)!);
    expect(reason("embedding")).toBe("not_chat_model");
    expect(reason("hidden-model")).toBe("hidden");
    expect(reason("no-tools")).toBe("tools_unsupported");
    // A row that does not say it calls tools is not assumed to.
    expect(generationModelIneligibility({ api_standard: "responses" })).toBe(
      "tools_unsupported",
    );
    // A row from before model kinds existed counts as a chat model.
    expect(
      generationModelIneligibility({
        api_standard: "responses",
        supports_tools: true,
        supports_streaming: true,
      }),
    ).toBeNull();
  });

  it("refuses a model that cannot stream, as the backend does at run start", () => {
    expect(
      generationModelIneligibility(
        CATALOG.find((item) => item.id === "no-streaming")!,
      ),
    ).toBe("streaming_unsupported");
    // A row that does not say it streams is not assumed to.
    expect(
      generationModelIneligibility({
        api_standard: "responses",
        supports_tools: true,
      }),
    ).toBe("streaming_unsupported");
  });

  it("refuses the models chat itself cannot use, as the backend does at run start", () => {
    const reason = (id: string) =>
      generationModelIneligibility(CATALOG.find((item) => item.id === id)!);
    // The owner's own model without a context window.
    expect(reason("own-no-window")).toBe("context_window_missing");
    expect(reason("no-api")).toBe("chat_unsupported");
    // Tools are asked about first: no window would make such a model usable.
    expect(
      generationModelIneligibility({
        api_standard: "chat_completions",
        source: "owner",
        context_window_tokens: null,
        supports_tools: false,
      }),
    ).toBe("tools_unsupported");
  });
});

describe("eligibleGenerationModels", () => {
  it("lists the eligible models, the ChatGPT plan's first, otherwise in catalog order", () => {
    expect(eligibleGenerationModels(CATALOG).map(({ id }) => id)).toEqual([
      "plan-a",
      "plan-b",
      "key-model",
      "local-model",
      // Not the owner's model without a context window, nor the row without an API.
      "own-model",
    ]);
  });

  it("lists nothing when no model can be used", () => {
    expect(eligibleGenerationModels([])).toEqual([]);
    expect(
      eligibleGenerationModels(
        CATALOG.filter(({ id }) => id === "embedding" || id === "no-tools"),
      ),
    ).toEqual([]);
  });

  it("tells plan models from the others", () => {
    expect(CATALOG.filter(isChatGPTPlanModel).map(({ id }) => id)).toEqual([
      "plan-a",
      "plan-b",
      "plan-hidden",
    ]);
  });
});

describe("chosenGenerationModel", () => {
  it("is the saved choice while the assistant can use it", () => {
    expect(chosenGenerationModel(CATALOG, "local-model")?.id).toBe(
      "local-model",
    );
  });

  it("is no model, never another one, when the choice is missing or unusable", () => {
    for (const saved of [
      null,
      undefined,
      "",
      "removed-model",
      "hidden-model",
      "no-tools",
      "embedding",
      // Chosen while it had a context window, which was removed since.
      "own-no-window",
      "no-api",
      "no-streaming",
    ])
      expect(chosenGenerationModel(CATALOG, saved)).toBeNull();
  });
});

describe("generationModelReviewsFrames", () => {
  it("is true only for a model that takes images", () => {
    expect(generationModelReviewsFrames(model("a"))).toBe(true);
    expect(
      generationModelReviewsFrames(model("b", { accepts: ["text"] })),
    ).toBe(false);
    expect(generationModelReviewsFrames({})).toBe(false);
  });
});
