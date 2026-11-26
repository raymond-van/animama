import { describe, expect, it } from "vitest";
import { describeChatFailure } from "@animama/product-ui/chat";
import { ChatSseHttpError } from "@animama/product-ui/query";

const ollama = {
  category: "unreachable",
  connection_name: "Home Ollama",
  connection_preset: "ollama",
  connection_base_url: "http://127.0.0.1:11434/v1",
  provider_error_message: "secret server text",
};

describe("provider-neutral chat failures", () => {
  it("names the failed connection and asks whether a local server is running", () => {
    const failure = describeChatFailure(
      { code: "openai_connection_error", details: ollama },
      "hello",
    );
    expect(failure.title).toBe("Animama couldn't reach Home Ollama.");
    expect(failure.guidance).toBe(
      "Is Ollama running at http://127.0.0.1:11434/v1? Start it, then try again.",
    );
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("uses cloud guidance for a cloud connection and names OpenAI from its details", () => {
    const failure = describeChatFailure(
      {
        code: "openai_connection_error",
        details: {
          category: "unreachable",
          connection_name: "OpenAI",
          connection_preset: "openai",
        },
      },
      "hello",
    );
    expect(failure.title).toBe("Animama couldn't reach OpenAI.");
    expect(failure.guidance).toContain("internet connection");
  });

  it("explains an oversized conversation from the category", () => {
    const failure = describeChatFailure(
      {
        code: "openai_bad_request",
        details: { ...ollama, category: "context_exceeded" },
      },
      "hello",
    );
    expect(failure.code).toBe("openai_bad_request");
    expect(failure.title).toBe(
      "The conversation is too long for Home Ollama's model.",
    );
    expect(failure.guidance).toContain("larger context window");
  });

  it("does not name a provider it was not told about", () => {
    const failure = describeChatFailure({ code: "openai_timeout" }, "hello");
    expect(failure.title).toBe("The model server took too long to respond.");
    expect(failure.title).not.toContain("OpenAI");
  });

  it.each([
    ["too_many_images", "This message has too many images."],
    ["attached_image_unavailable", "An attached image is no longer available."],
    ["model_does_not_accept_images", "This model can't see images."],
  ])(
    "explains the image refusal %s from the response detail",
    (code, title) => {
      const failure = describeChatFailure(
        { status: 400, detail: { code, message: "English detail" } },
        "hello",
      );
      expect(failure.code).toBe(code);
      expect(failure.title).toBe(title);
      expect(failure.guidance).not.toContain("English detail");
    },
  );

  it("describes a removed connection", () => {
    expect(
      describeChatFailure({ code: "connection_unavailable" }, "hello").title,
    ).toBe("The selected model's connection was removed.");
  });

  it("says the model declined, without naming a provider or trying another model", () => {
    const failure = describeChatFailure(
      {
        code: "model_refused",
        details: {
          category: "provider_error",
          connection_name: "Anthropic",
          connection_preset: "anthropic",
          stop_details_category: "cyber",
        },
      },
      "hello",
    );
    expect(failure.code).toBe("model_refused");
    expect(`${failure.title} ${failure.guidance}`).toBe(
      "The model declined to respond to this message. Try rephrasing it.",
    );
    expect(JSON.stringify(failure)).not.toContain("cyber");
  });

  const anthropic = {
    connection_name: "Anthropic",
    connection_preset: "anthropic",
  };

  it("names the Anthropic connection and API Keys when its key is missing", () => {
    const failure = describeChatFailure(
      {
        code: "missing_api_key",
        details: { ...anthropic, category: "credential_missing" },
      },
      "hello",
    );
    expect(failure.title).toBe("Anthropic has no API key configured.");
    expect(failure.guidance).toContain("API Keys");
  });

  it.each([
    ["anthropic_authentication_error", "openai_authentication_error"],
    ["anthropic_permission_denied", "openai_permission_denied"],
    ["anthropic_not_found", "openai_not_found"],
    ["anthropic_quota_exceeded", "openai_quota_exceeded"],
    ["anthropic_rate_limit", "openai_rate_limit"],
    ["anthropic_overloaded", "openai_overloaded"],
    ["anthropic_server_error", "openai_server_error"],
    ["anthropic_timeout", "openai_timeout"],
    ["anthropic_connection_error", "openai_connection_error"],
    ["anthropic_bad_request", "openai_bad_request"],
  ])("describes %s like %s, naming Anthropic", (code, equivalent) => {
    const failure = describeChatFailure({ code, details: anthropic }, "hello");
    const openAiCopy = describeChatFailure(
      { code: equivalent, details: anthropic },
      "hello",
    );
    expect(failure.code).toBe(code);
    expect([failure.title, failure.guidance]).toEqual([
      openAiCopy.title,
      openAiCopy.guidance,
    ]);
    expect(failure.title).toContain("Anthropic");
  });

  it("explains Anthropic's context, credit and interrupted-stream failures", () => {
    expect(
      describeChatFailure(
        {
          code: "anthropic_context_exceeded",
          details: { ...anthropic, category: "context_exceeded" },
        },
        "hello",
      ).title,
    ).toBe("The conversation is too long for Anthropic's model.");
    expect(
      describeChatFailure(
        { code: "anthropic_context_exceeded", details: anthropic },
        "hello",
      ).title,
    ).toBe("The conversation is too long for Anthropic's model.");
    expect(
      describeChatFailure(
        { code: "anthropic_quota_exceeded", details: anthropic },
        "hello",
      ).guidance,
    ).toContain("billing");
    const interrupted = describeChatFailure(
      { code: "anthropic_stream_incomplete", details: anthropic },
      "hello",
      "Partial",
    );
    expect(interrupted.title).toBe("The reply was interrupted.");
  });

  it("waits out Anthropic's rate limit like OpenAI's", () => {
    expect(
      describeChatFailure(
        {
          code: "anthropic_rate_limit",
          details: { ...anthropic, retry_after_seconds: 1.2 },
        },
        "hello",
      ).retryAfterSeconds,
    ).toBe(2);
  });
});

describe("hosted denials", () => {
  /** A hosted denial body as chat creation rejects with it. */
  const denial = (code: string, fields: Record<string, unknown> = {}) => ({
    error: code,
    code,
    ...fields,
  });
  const failureFor = (error: unknown, partialText?: string) =>
    describeChatFailure(error, "hello", partialText);
  const expectHostedCopy = (failure: { title: string; guidance: string }) => {
    const copy = `${failure.title} ${failure.guidance}`;
    expect(copy).not.toMatch(/installation|owner|restart/i);
  };

  it.each([
    "account_daily_turns",
    "account_daily_spend",
    "account_monthly_spend",
    "operation_requests",
  ])("explains the %s usage limit and when it resets", (limit) => {
    const failure = failureFor(
      denial("quota_exceeded", { limit, retry_after_seconds: 7200 }),
    );
    expect(failure).toMatchObject({
      code: "quota_exceeded",
      title: "You've reached this account's hosted usage limit.",
      guidance: "It resets in about 2 hours.",
    });
    expect(failure.retryAfterSeconds).toBeUndefined();
    expectHostedCopy(failure);
  });

  it("omits the reset time when the denial does not state one", () => {
    const failure = failureFor(
      denial("quota_exceeded", { limit: "account_monthly_spend" }),
    );
    expect(failure.title).toBe(
      "You've reached this account's hosted usage limit.",
    );
    expect(failure.guidance).toBe("Try again after it resets.");
    expectHostedCopy(failure);
  });

  it("asks for a shorter conversation when one turn's input is too large", () => {
    const failure = failureFor(
      denial("quota_exceeded", { limit: "model_input_tokens" }),
    );
    expect(failure.title).toBe(
      "This conversation is too long for one hosted turn.",
    );
    expect(failure.guidance).toBe("Start a new chat or shorten your message.");
    expectHostedCopy(failure);
  });

  it.each(["capacity_busy", "budget_paused"])(
    "asks to retry %s with the stream response's Retry-After time",
    (code) => {
      const failure = failureFor(
        new ChatSseHttpError(
          503,
          "Service Unavailable",
          { error: code },
          new Headers({ "Retry-After": "30" }),
        ),
      );
      expect(failure).toMatchObject({
        code,
        title: "Animama is busy right now.",
        guidance: "Try again in about 30 seconds.",
      });
      expectHostedCopy(failure);
    },
  );

  it("asks to retry in a moment when busy without a stated time", () => {
    const failure = failureFor(
      new ChatSseHttpError(503, "Service Unavailable", {
        error: "capacity_busy",
      }),
    );
    expect(failure.guidance).toBe("Try again in a moment.");
  });

  it("prefers the body's retry time and reads an HTTP-date Retry-After", () => {
    const body = failureFor(
      new ChatSseHttpError(
        429,
        "Too Many Requests",
        denial("quota_exceeded", {
          limit: "account_daily_turns",
          retry_after_seconds: 90,
        }),
        new Headers({ "Retry-After": "7200" }),
      ),
    );
    expect(body.guidance).toBe("It resets in about 2 minutes.");
    const date = failureFor(
      new ChatSseHttpError(
        429,
        "Too Many Requests",
        denial("quota_exceeded", { limit: "account_daily_spend" }),
        new Headers({
          "Retry-After": new Date(Date.now() + 3 * 86_400_000).toUTCString(),
        }),
      ),
    );
    expect(date.guidance).toBe("It resets in about 3 days.");
  });

  it("states the message length limit, including a detail-wrapped code", () => {
    const failure = failureFor({
      detail: { code: "message_too_long", max_characters: 8000 },
    });
    expect(failure).toMatchObject({
      code: "message_too_long",
      title: "This message is too long.",
      guidance: "Messages can be up to 8,000 characters.",
    });
    expectHostedCopy(failure);
  });

  it.each([500, "500"])("states the chat limit (%s chats)", (limit) => {
    const failure = failureFor(denial("chat_limit_reached", { limit }));
    expect(failure.code).toBe("chat_limit_reached");
    expect(failure.title).toBe(
      "This account has reached its chat limit (500 chats).",
    );
    expect(failure.guidance).toBe("Continue one of your existing chats.");
    expectHostedCopy(failure);
  });

  it("names a hosted denial frame that ends a started reply", () => {
    const failure = failureFor(
      {
        run_id: "run-1",
        error: "quota_exceeded",
        code: "quota_exceeded",
        details: { limit: "account_daily_turns", retry_after_seconds: 1800 },
      },
      "Partial reply",
    );
    expect(failure).toMatchObject({
      code: "quota_exceeded",
      guidance: "It resets in about 30 minutes.",
      partialText: "Partial reply",
    });
  });

  it("keeps self-hosted provider quota copy for an existing code", () => {
    const failure = failureFor({
      code: "openai_quota_exceeded",
      error: "Quota exceeded",
      details: { category: "quota_exceeded", connection_name: "OpenAI" },
    });
    expect(failure.code).toBe("openai_quota_exceeded");
    expect(failure.title).toBe("OpenAI's account has reached its usage limit.");
  });

  describe("completed trial", () => {
    const download = "https://animama.example/download";
    const trialComplete = (fields: Record<string, unknown> = {}) =>
      denial("trial_complete", { limit: "account_trial_ai", ...fields });
    const expectTrialComplete = (failure: ReturnType<typeof failureFor>) => {
      expect(failure).toMatchObject({
        code: "trial_complete",
        title: "Your Animama trial is complete.",
        guidance: "Download Animama to keep chatting with your Animas.",
      });
      expectHostedCopy(failure);
    };

    it.each([
      ["chat creation", trialComplete({ download_url: download })],
      [
        "the chat request",
        new ChatSseHttpError(
          403,
          "Forbidden",
          trialComplete({ download_url: download }),
        ),
      ],
      [
        "a detail-wrapped body",
        { detail: { code: "trial_complete", download_url: download } },
      ],
    ])("links %s's denial to the desktop download", (_, error) => {
      const failure = failureFor(error);
      expectTrialComplete(failure);
      expect(failure.link).toEqual({
        label: "Download Animama",
        href: download,
      });
    });

    it("links a denial frame that ends a started reply, with fields in details", () => {
      const failure = failureFor(
        {
          run_id: "run-1",
          error: "trial_complete",
          code: "trial_complete",
          details: { limit: "account_trial_ai", download_url: download },
        },
        "Partial reply",
      );
      expectTrialComplete(failure);
      expect(failure.partialText).toBe("Partial reply");
      expect(failure.link?.href).toBe(download);
    });

    it.each([
      undefined,
      null,
      42,
      "",
      "not a url",
      "/download",
      "//animama.example/download",
      "http://animama.example/download",
      "https://user:secret@animama.example/download",
      "javascript:alert(1)",
      "data:text/html,download",
    ])("keeps the copy but withholds the link for download_url %s", (url) => {
      const failure = failureFor(trialComplete({ download_url: url }));
      expectTrialComplete(failure);
      expect(failure.link).toBeUndefined();
    });

    it("adds no link to other failures, even with a download_url", () => {
      for (const error of [
        denial("quota_exceeded", { download_url: download }),
        denial("chat_limit_reached", { limit: 5, download_url: download }),
        { code: "missing_api_key", download_url: download },
        { code: "secret_code", download_url: download },
      ]) {
        expect(failureFor(error).link).toBeUndefined();
      }
    });
  });
});

describe("ChatGPT plan failures", () => {
  const plan = {
    connection_name: "ChatGPT plan",
    connection_preset: "chatgpt_plan",
  };

  it("links a usage limit and an ineligible plan to the plan's usage page", () => {
    for (const code of [
      "chatgpt_plan_usage_limit",
      "chatgpt_plan_not_eligible",
    ]) {
      const failure = describeChatFailure(
        { code, details: { ...plan, category: "usage_limit" } },
        "hello",
      );
      expect(failure.link).toEqual({
        label: "Manage usage",
        href: "https://chatgpt.com/settings/usage",
      });
      expect(failure.copy?.linkLabel).toEqual({
        key: "chatFailure.manageUsage",
      });
    }
    expect(
      describeChatFailure(
        { code: "chatgpt_plan_usage_limit", details: plan },
        "hello",
      ).title,
    ).toBe("You've reached your ChatGPT plan's usage limit.");
  });

  it("names App Settings → Models when the plan needs a sign-in or plan use", () => {
    const signIn = describeChatFailure(
      { code: "chatgpt_plan_sign_in_required", details: plan },
      "hello",
    );
    const planUse = describeChatFailure(
      { code: "chatgpt_plan_use_not_granted", details: plan },
      "hello",
    );
    expect(signIn.title).toBe("Sign in with ChatGPT again.");
    expect(signIn.guidance).toContain("App Settings → Models");
    expect(planUse.guidance).toContain("App Settings → Models");
    expect(signIn.link).toBeUndefined();
  });

  it("quotes the route's reason for an unsupported request, and only there", () => {
    const refused = describeChatFailure(
      {
        code: "chatgpt_plan_unsupported_request",
        details: {
          ...plan,
          provider_error_message: "Unsupported tool type: apply_patch",
        },
      },
      "hello",
    );
    expect(refused.guidance).toBe(
      "OpenAI said: “Unsupported tool type: apply_patch” Choose another model for this chat.",
    );
    const bare = describeChatFailure(
      { code: "chatgpt_plan_unsupported_request", details: plan },
      "hello",
    );
    expect(bare.guidance).toBe("Choose another model for this chat.");
    const unavailable = describeChatFailure(
      {
        code: "chatgpt_plan_unavailable",
        details: {
          ...plan,
          provider_error_message: "secret server text",
          retry_after_seconds: 30,
        },
      },
      "hello",
    );
    expect(JSON.stringify(unavailable)).not.toContain("secret");
    expect(unavailable.retryAfterSeconds).toBe(30);
  });
});
