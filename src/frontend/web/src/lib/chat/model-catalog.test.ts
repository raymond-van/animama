import { getI18n } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";

import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";

import {
  defaultReasoningEffort,
  effectiveReasoningEffort,
  modelConnectionLabel,
  pickerModelGroups,
  supportedReasoningEfforts,
} from "./model-catalog";

const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

function row(
  extra: Partial<PyModelProviderCatalogItem> = {},
): PyModelProviderCatalogItem {
  return {
    id: "row",
    model: "row",
    model_provider: "OpenAIResponsesHTTPAgent",
    supports_reasoning: true,
    supported_reasoning_efforts: EFFORTS,
    ...extra,
  } as PyModelProviderCatalogItem;
}

describe("chat picker reasoning effort", () => {
  it("preselects the row's reported default, such as Anthropic's medium", () => {
    const haiku = row({
      id: "AnthropicMessagesHTTPAgent:claude-haiku-5-5",
      model_provider: "AnthropicMessagesHTTPAgent",
      default_reasoning_effort: "medium",
    });
    expect(defaultReasoningEffort(haiku)).toBe("medium");
  });

  it("falls back to the first supported effort when the row reports none", () => {
    expect(
      defaultReasoningEffort(row({ default_reasoning_effort: null })),
    ).toBe("none");
    expect(defaultReasoningEffort(row())).toBe("none");
  });

  it("ignores a reported default the row does not offer", () => {
    expect(
      defaultReasoningEffort(
        row({
          supported_reasoning_efforts: ["low", "high"],
          default_reasoning_effort: "medium",
        }),
      ),
    ).toBe("low");
  });

  it("has no effort for rows without efforts", () => {
    expect(defaultReasoningEffort(null)).toBeNull();
    expect(
      defaultReasoningEffort(
        row({
          supported_reasoning_efforts: null,
          default_reasoning_effort: "medium",
        }),
      ),
    ).toBeNull();
    expect(supportedReasoningEfforts(undefined)).toEqual([]);
  });
});

describe("saved reasoning effort", () => {
  it("uses the Anima's saved effort when the row offers it", () => {
    expect(effectiveReasoningEffort(row(), "low")).toBe("low");
  });

  it("uses the row's default without a saved effort", () => {
    const haiku = row({ default_reasoning_effort: "medium" });
    expect(effectiveReasoningEffort(haiku, null)).toBe("medium");
    expect(effectiveReasoningEffort(row(), undefined)).toBe("none");
  });

  it("falls back to the row's default when the row no longer offers the saved effort", () => {
    expect(
      effectiveReasoningEffort(
        row({ supported_reasoning_efforts: ["none", "high"] }),
        "low",
      ),
    ).toBe("none");
    expect(
      effectiveReasoningEffort(row({ supported_reasoning_efforts: [] }), "low"),
    ).toBeNull();
  });
});

describe("the connection a picker names", () => {
  afterEach(async () => {
    await getI18n().changeLanguage("en");
  });

  it("names the ChatGPT plan in the UI Locale, and other connections as saved", async () => {
    const plan = {
      model: "gpt-6-luna",
      model_label: "GPT-6 Luna",
      provider_label: "ChatGPT plan",
      connection_name: "ChatGPT plan",
      model_provider: "ChatGPTPlanResponsesHTTPAgent",
    };
    expect(modelConnectionLabel(plan)).toBe("ChatGPT plan");

    await getI18n().changeLanguage("ja");
    expect(modelConnectionLabel(plan)).toBe("ChatGPT プラン");
    expect(
      modelConnectionLabel({
        ...plan,
        model_provider: "OpenAIHTTPAgent",
        connection_name: "Home Ollama",
      }),
    ).toBe("Home Ollama");
  });
});

describe("chat picker groups", () => {
  const plan = (id: string) =>
    row({
      id,
      connection_id: "chatgpt_plan",
      connection_name: "ChatGPT plan",
      model_provider: "ChatGPTPlanResponsesHTTPAgent",
    });
  const key = (id: string) =>
    row({ id, connection_id: "openai", connection_name: "OpenAI" });
  const claude = (id: string) =>
    row({
      id,
      connection_id: "anthropic",
      connection_name: "Anthropic",
      model_provider: "AnthropicMessagesHTTPAgent",
    });
  const groups = (items: PyModelProviderCatalogItem[]) =>
    pickerModelGroups(items).map((group) => [
      group.providerLabel,
      group.models.map((item) => item.id),
    ]);

  it("names OpenAI's two ways and keeps them side by side, plan first", () => {
    expect(
      groups([key("gpt-6"), claude("opus"), plan("luna"), plan("terra")]),
    ).toEqual([
      ["OpenAI · ChatGPT plan", ["luna", "terra"]],
      ["OpenAI · API key", ["gpt-6"]],
      ["Anthropic", ["opus"]],
    ]);
  });

  it("keeps one OpenAI group, as before, when no plan model is listed", () => {
    // The hosted composition, or a local installation before signing in.
    expect(groups([key("gpt-6"), claude("opus")])).toEqual([
      ["OpenAI", ["gpt-6"]],
      ["Anthropic", ["opus"]],
    ]);
  });

  it("leaves other connections in catalog order", () => {
    expect(groups([claude("opus"), plan("luna")])).toEqual([
      ["Anthropic", ["opus"]],
      ["OpenAI · ChatGPT plan", ["luna"]],
    ]);
  });
});
