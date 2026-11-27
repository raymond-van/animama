import { getI18n } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";

import type { GenerationRunFailure } from "@/stores/generation-store";
import {
  describeGenerationActionFailure,
  describeGenerationFailure,
  draftFailureText,
} from "./generationFailure";

const failure = (
  overrides: Partial<GenerationRunFailure>,
): GenerationRunFailure => ({
  code: "generation_run_failed",
  category: "internal",
  reason: null,
  details: {},
  status: null,
  network: false,
  request: { message: "a shy wave", draftId: null, answers: null },
  ...overrides,
});

afterEach(async () => {
  await getI18n().changeLanguage("en");
});

describe("describeGenerationFailure", () => {
  it("words a model or plan failure as chat does, naming the connection", () => {
    const text = describeGenerationFailure(
      failure({
        code: "chatgpt_plan_usage_limit",
        category: "rate_limited",
        details: { connection_name: "ChatGPT plan" },
      }),
    );
    if (text.source !== "model") throw new Error("Expected chat's wording.");
    expect(text.code).toBe("chatgpt_plan_usage_limit");
    expect(text.failure.title).toBe(
      "You've reached your ChatGPT plan's usage limit.",
    );
    // The plan's usage page is offered, as in chat.
    expect(text.failure.link?.href).toBe("https://chatgpt.com/settings/usage");
    expect(text.failure.originalText).toBe("a shy wave");

    const local = describeGenerationFailure(
      failure({
        code: "openai_connection_error",
        category: "connection",
        details: {
          connection_name: "My Ollama",
          connection_preset: "ollama",
          connection_base_url: "http://localhost:11434/v1",
        },
      }),
    );
    if (local.source !== "model") throw new Error("Expected chat's wording.");
    expect(local.failure.title).toBe("Animama couldn't reach My Ollama.");
    expect(local.failure.guidance).toContain("Is Ollama running");
    // The catalog references let the notice word it in the active locale.
    expect(local.failure.copy?.title).toEqual({
      key: "chatFailure.codes.openai_connection_error.title",
      params: {
        name: "My Ollama",
        localServer: "Ollama",
        baseUrl: "http://localhost:11434/v1",
      },
    });
  });

  it("words a model failure by its neutral category where chat does", () => {
    const text = describeGenerationFailure(
      failure({
        code: "openai_bad_request",
        category: "context_exceeded",
        details: { category: "context_exceeded", connection_name: "OpenAI" },
      }),
    );
    if (text.source !== "model") throw new Error("Expected chat's wording.");
    expect(text.failure.title).toContain("too long");
  });

  it("words the assistant's own failures from the generation area", () => {
    expect(
      describeGenerationFailure(
        failure({ code: "generation_no_valid_draft", category: "generation" }),
      ),
    ).toEqual({
      source: "assistant",
      code: "generation_no_valid_draft",
      message:
        "The assistant did not produce a draft that works. Try again, or describe it differently.",
      detail: null,
    });
    expect(
      describeGenerationFailure(
        failure({
          code: "generation_run_in_progress",
          category: "request",
          status: 409,
        }),
      ).source,
    ).toBe("assistant");
  });

  it("says why a refused model cannot be used", () => {
    const refused = (reason: string | null) =>
      describeGenerationFailure(
        failure({
          code: "generation_model_unusable",
          category: "request",
          reason,
          status: 422,
        }),
      );
    expect(refused("tools_unsupported")).toMatchObject({
      message:
        "The chosen model cannot call tools, which the assistant needs. Choose another model.",
    });
    expect(refused("connection_inactive")).toMatchObject({
      message: expect.stringContaining("connection is turned off"),
    });
    // A reason from a newer backend, or none, reads as the general refusal.
    for (const reason of ["quota_policy", null])
      expect(refused(reason)).toMatchObject({
        message:
          "The assistant cannot use the chosen model. Choose another model.",
      });
  });

  it("words the page's own failures of a request", () => {
    expect(
      describeGenerationFailure(
        failure({
          code: "generation_stream_interrupted",
          category: "request",
        }),
      ),
    ).toMatchObject({
      source: "assistant",
      message: expect.stringContaining("connection was lost"),
    });
    expect(
      describeGenerationFailure(
        failure({
          code: "generation_request_failed",
          category: "request",
          network: true,
        }),
      ),
    ).toMatchObject({
      message: "The request did not reach the assistant. Try again.",
    });
  });

  it("falls back to the general failure for a code nothing words", () => {
    const general = "The assistant ran into an unexpected problem. Try again.";
    // A model client's code chat has no wording for.
    expect(
      describeGenerationFailure(
        failure({ code: "provider_melted", category: "provider_error" }),
      ),
    ).toEqual({
      source: "assistant",
      code: "provider_melted",
      message: general,
      detail: null,
    });
    // A generation code from a newer backend.
    expect(
      describeGenerationFailure(
        failure({ code: "generation_budget_spent", category: "generation" }),
      ),
    ).toMatchObject({ source: "assistant", message: general });
    expect(
      describeGenerationFailure(failure({ code: "generation_run_failed" })),
    ).toMatchObject({ message: general });
  });

  it("follows the UI Locale", async () => {
    await getI18n().changeLanguage("ja");
    getI18n().addResourceBundle("ja", "errors", {
      generation: { generation_not_found: "存在しません。" },
    });
    expect(
      describeGenerationFailure(
        failure({ code: "generation_not_found", category: "generation" }),
      ),
    ).toMatchObject({ message: "存在しません。" });
  });
});

describe("describeGenerationActionFailure", () => {
  it("words a refused action from the error a mutation rejects with", () => {
    expect(
      describeGenerationActionFailure({
        detail: { code: "generation_nothing_to_restore" },
      }),
    ).toEqual({
      message: "This draft has no earlier version to restore.",
      detail: null,
    });
    expect(
      describeGenerationActionFailure({
        detail: { code: "generation_run_in_progress" },
      }).message,
    ).toContain("still working");
  });

  it("falls back to the general failure for an error without a known code", () => {
    expect(
      describeGenerationActionFailure(new TypeError("Failed to fetch")),
    ).toMatchObject({ message: "Failed to fetch" });
    expect(describeGenerationActionFailure({ detail: [] })).toEqual({
      message: "The assistant ran into an unexpected problem. Try again.",
      detail: null,
    });
  });
});

describe("draftFailureText", () => {
  it("says why a draft failed, from its reason", () => {
    expect(
      draftFailureText({
        status: "failed",
        failure_reason: "generation_draft_unloadable",
      }),
    ).toContain("cannot be played");
    expect(
      draftFailureText({
        status: "failed",
        failure_reason: "generation_no_valid_draft",
      }),
    ).toContain("did not produce a draft");
    // An unknown reason, or none, still says something.
    for (const failure_reason of ["generation_new_reason", null])
      expect(draftFailureText({ status: "failed", failure_reason })).toBe(
        "The assistant ran into an unexpected problem. Try again.",
      );
  });

  it("says nothing for a draft that did not fail", () => {
    expect(
      draftFailureText({ status: "ready", failure_reason: null }),
    ).toBeNull();
    // A reason is kept only until the status changes; a stale one is ignored.
    expect(
      draftFailureText({
        status: "warnings",
        failure_reason: "generation_draft_unloadable",
      }),
    ).toBeNull();
  });
});
