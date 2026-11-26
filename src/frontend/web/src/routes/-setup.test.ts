import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "@/test/runtime-markup";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getI18n } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import type {
  PyModelConnection,
  PyModelConnectionDetection,
  PyModelProviderCatalogItem,
} from "@animama/runtime-contracts/api-types";
import {
  emptySetupDraft,
  type SetupDraft,
} from "@/app/local-runtime/setup-draft";
import { Route } from "@/routes/setup";
import { normalizeLocalDisplayName } from "@/lib/user-profile/display-name";
import {
  adjacentSetupStep,
  anthropicDefaultModel,
  detectedModelsToAdd,
  openAiDefaultModel,
  ownerModelChoices,
  resolveSetupTtsProvider,
  setupBuiltins,
  setupChatGPTPlan,
  setupChatModelReady,
  setupStepPosition,
  setupTtsOptions,
  resolveSetupSttChoice,
  setupTtsPatch,
} from "@/app/local-runtime/setup/setup-state";
import {
  recommendedSttChoice,
  sttChoicePatch as setupSttPatch,
  availableSttChoices,
} from "@/lib/speech/stt-choices";

// Rendering is static here; scripts/setup-downloads.browser.test.mjs drives
// navigation, focus, the unsaved-key prompt and the Finish payload in a browser.
const OPENAI_MODEL = "OpenAIResponsesHTTPAgent:gpt-6-luna";
const HAIKU = "AnthropicMessagesHTTPAgent:claude-haiku-5-5";
const fixture = vi.hoisted(() => ({
  draft: null as SetupDraft | null,
  capabilities: {
    isPending: false,
    isError: false,
    data: { model_configuration: true } as Record<string, unknown>,
  },
  connections: [] as unknown[],
  providers: [] as unknown[],
  desktopKeys: true,
  localModels: true,
  deepseekHuggingface: true,
  /** The offline speech set shown as downloading, if any. */
  downloadingAsset: null as string | null,
}));
// The plan card reads its own session; setup's layout around it is what these tests check.
vi.mock("@/ui/settings/models/ChatGPTPlanCard", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/ui/settings/models/ChatGPTPlanCard")
  >()),
  ChatGPTPlanCard: () => createElement("p", null, "Plan card"),
}));
vi.mock("@/platform/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableLocalModels() {
        return fixture.localModels;
      },
      get enableDeepseekHuggingface() {
        return fixture.deepseekHuggingface;
      },
    },
  };
});
vi.mock("@/app/local-runtime/LocalRuntimeProvider", () => ({
  useLocalRuntime: () => ({
    state: {
      status: "ready",
      firstRunComplete: false,
      principalId: "test-owner",
    },
  }),
}));
vi.mock("@/app/local-runtime/setup-draft", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/local-runtime/setup-draft")>();
  return {
    ...actual,
    readSetupDraft: () => fixture.draft ?? actual.emptySetupDraft(),
  };
});
vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => fixture.capabilities,
}));
vi.mock("@/query/hooks/useModelProviders", () => ({
  useModelProviders: () => ({
    data: fixture.providers,
    isSuccess: true,
    isError: false,
    isFetching: false,
  }),
}));
vi.mock("@/query/hooks/useModelConfiguration", () => {
  const ok = (data: unknown) => ({
    data,
    isSuccess: true,
    isError: false,
    isFetching: false,
    isFetched: true,
  });
  return {
    useModelConnections: () => ok(fixture.connections),
    useModelConnectionPresets: () => ok([]),
    useModelRoles: () =>
      ok({ roles: [{ role: "chat", model_provider_id: OPENAI_MODEL }] }),
  };
});
vi.mock("@/ui/settings/OfflineSpeechDownloads", () => {
  const asset = (id: string, size: number) => ({
    id,
    status: fixture.downloadingAsset === id ? "downloading" : "not_installed",
    size_bytes: size,
    required_free_bytes: size,
  });
  return {
    assetFailureText: () => "",
    OfflineSpeechDownloads: () => null,
    useOfflineSpeechDownloads: (engine: "parakeet" | "sensevoice") => ({
      engine,
      cpu: asset(`${engine}-stt`, 631_000_000),
      gpu: asset(`${engine}-stt-webgpu`, 1_200_000_000),
      freeBytes: null,
      gpuSupport: "available",
      pending: false,
      onChange: () => {},
    }),
  };
});
// Variant tabs label each set with its size.
vi.mock("@/query/hooks/useModelAssets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/query/hooks/useModelAssets")>()),
  useModelAssets: () => ({
    data: {
      assets: ["parakeet", "sensevoice"].flatMap((engine) => [
        { id: `${engine}-stt`, size_bytes: 631_000_000 },
        { id: `${engine}-stt-webgpu`, size_bytes: 1_200_000_000 },
      ]),
    },
  }),
}));
vi.mock("@/ui/settings/DesktopCredentialsPanel", () => ({
  DesktopCredentialsPanel: ({ providers }: { providers: string[] }) =>
    createElement("div", { "data-key-panel": providers.join(",") }),
  useDesktopCredentialsAvailable: () => fixture.desktopKeys,
  useDesktopCredentialConfigured: () => false,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }) => createElement("a", { href: to, className }, children),
}));

function renderSetup(draft: Partial<SetupDraft> | null = null): string {
  fixture.draft = draft ? { ...emptySetupDraft(), ...draft } : null;
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Route.options.component!),
    ),
  );
}

const welcomeDone = { displayName: "Ada" };

const builtinConnection = {
  id: "builtin-openai",
  name: "OpenAI",
  preset: "openai",
  source: "builtin",
  base_url: null,
  credential_state: "configured",
  models: [],
} as unknown as PyModelConnection;
// Listed before OpenAI so setup cannot mistake it for the OpenAI connection.
const anthropicConnection = {
  id: "anthropic",
  name: "Anthropic",
  preset: "anthropic",
  source: "builtin",
  base_url: null,
  credential_state: "missing",
  models: [],
} as unknown as PyModelConnection;
const ollama = {
  id: "conn-ollama",
  name: "Ollama",
  preset: "ollama",
  source: "owner",
  base_url: "http://127.0.0.1:11434/v1/",
  credential_state: "not_required",
  models: [{ model: "qwen3:8b" }],
} as unknown as PyModelConnection;
const deepseek = {
  id: "conn-deepseek",
  name: "DeepSeek",
  preset: "deepseek",
  source: "owner",
  base_url: "https://api.deepseek.com/v1",
  credential_state: "configured",
  models: [],
} as unknown as PyModelConnection;
const item = (
  id: string,
  connection: PyModelConnection,
  patch: Partial<PyModelProviderCatalogItem> = {},
): PyModelProviderCatalogItem =>
  ({
    id,
    model: id.split(":").at(-1),
    model_label: id.split(":").at(-1),
    model_provider: "OpenAIHTTPAgent",
    api_standard: "chat_completions",
    connection_id: connection.id,
    connection_name: connection.name,
    source: connection.source === "builtin" ? "builtin" : "owner",
    model_kind: "chat",
    hidden: false,
    supports_streaming: true,
    context_window_tokens: 8192,
    ...patch,
  }) as PyModelProviderCatalogItem;
const catalog = [
  item("OpenAIHTTPAgent:gpt-6-luna", builtinConnection),
  item("OpenAIResponsesHTTPAgent:gpt-6-mini", builtinConnection, {
    model_provider: "OpenAIResponsesHTTPAgent",
    api_standard: "responses",
  }),
  item(OPENAI_MODEL, builtinConnection, {
    model_provider: "OpenAIResponsesHTTPAgent",
    api_standard: "responses",
    model_label: "GPT-6 Luna",
  }),
  item("OpenAIHTTPAgent:conn-ollama:qwen3:8b", ollama, {
    model: "qwen3:8b",
    model_label: "qwen3:8b",
  }),
  item("OpenAIHTTPAgent:conn-ollama:hidden", ollama, { hidden: true }),
  item("OpenAIHTTPAgent:conn-ollama:no-context", ollama, {
    context_window_tokens: null,
  }),
  item("OpenAIHTTPAgent:conn-deepseek:deepseek-chat", deepseek),
  item(HAIKU, anthropicConnection, {
    model_provider: "AnthropicMessagesHTTPAgent",
    api_standard: "anthropic_messages",
    model_label: "Claude Haiku 5.5",
  }),
];

describe("local first-run setup", () => {
  it("normalizes the required name consistently for setup and personalization", () => {
    expect(normalizeLocalDisplayName("  Ada   Lovelace  ")).toBe(
      "Ada Lovelace",
    );
    expect(normalizeLocalDisplayName("x".repeat(30))).toBe("x".repeat(30));
  });

  it.each(["", "   ", "\t\n", " ", "x".repeat(31)])(
    "rejects an unsavable name: %j",
    (value) => {
      expect(normalizeLocalDisplayName(value)).toBeNull();
    },
  );

  it("starts on Welcome, which gates only on the private name", () => {
    const html = renderSetup();
    expect(html).toContain("Step 1 of 3");
    expect(html).toMatch(/<li aria-current="step"[^>]*>Welcome<\/li>/u);
    expect(html).toMatch(/<input[^>]*id="local-display-name"[^>]*required=""/u);
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*disabled=""[^>]*>Continue<\/button>/u,
    );
    expect(html).not.toContain("adult-confirmed");
    expect(html).not.toContain("I am 18 or older");
    expect(html).not.toContain("Skip for now");
    expect(html).not.toContain("Back");
    // Keys and downloads moved to later steps.
    expect(html).not.toContain("data-key-panel");
    expect(html).not.toContain("Download CPU model");
  });

  it("enables Continue with a name before age confirmation", () => {
    const html = renderSetup({ displayName: "Ada" });
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Continue<\/button>/u);
    expect(html).not.toMatch(/type="submit"[^>]*disabled=""/u);
  });

  it("offers Cloud | Local and provider tabs on the AI step, with the OpenAI key and Skip", () => {
    fixture.connections = [anthropicConnection, builtinConnection];
    fixture.providers = catalog;
    const html = renderSetup({
      ...welcomeDone,
      step: "ai",
      chatModelId: OPENAI_MODEL,
    });
    expect(html).toContain("Step 2 of 3");
    expect(html).toMatch(
      /<li aria-current="step"[^>]*>AI<span[^>]*>\(optional\)<\/span><\/li>/u,
    );
    // OpenAI and Anthropic carry the Recommended tag, not a location; the
    // step no longer lists models.
    expect(html).toMatch(/role="tab"[^>]*><span[^>]*>Cloud<\/span>/u);
    for (const provider of ["OpenAI", "Anthropic"])
      expect(html).toMatch(
        new RegExp(
          `role="tab"[^>]*><span[^>]*>${provider}<span[^>]*>Recommended</span>`,
          "u",
        ),
      );
    expect(html).toMatch(/role="tab"[^>]*><span[^>]*>Local</u);
    expect(html).not.toContain("Model for new Animas");
    expect(html).not.toContain("App Settings → Models");
    expect(html).toContain('data-key-panel="openai"');
    expect(html).toContain('aria-label="Cloud providers"');
    expect(html).toContain('aria-label="Local providers"');
    for (const provider of ["DeepSeek", "OpenRouter", "Ollama", "vLLM"])
      expect(html).toMatch(
        new RegExp(`role="tab"[^>]*><span[^>]*>${provider}`, "u"),
      );
    // Anthropic sits beside OpenAI with its own key; neither lists models.
    expect(html).toMatch(/role="tab"[^>]*><span[^>]*>Anthropic</u);
    expect(html).toContain('data-key-panel="anthropic"');
    expect(html).not.toContain('role="radio"');
    expect(html).not.toContain("Use Anthropic");
    expect(html).not.toContain("Save your Anthropic key");
    // OpenAI (key set) opens first and is marked connected.
    expect(html).toMatch(
      /role="tab" aria-selected="true"[^>]*><span[^>]*>OpenAI<span[^>]*>Recommended<\/span><span aria-hidden="true"[^>]*><\/span><span class="sr-only"> \(connected\)/u,
    );
    expect(html).toMatch(/<button[^>]*>Back<\/button>/u);
    expect(html).toMatch(/<button[^>]*>Skip for now<\/button>/u);
    expect(html).toMatch(/<button[^>]*>Continue<\/button>/u);
    expect(html).not.toContain("Finish");
  });

  it("opens on Anthropic when only its key is set", () => {
    fixture.connections = [
      { ...anthropicConnection, credential_state: "configured" },
      { ...builtinConnection, credential_state: "missing" },
    ];
    fixture.providers = catalog;
    const html = renderSetup({
      ...welcomeDone,
      step: "ai",
      chatModelId: HAIKU,
    });
    // Anthropic (key set) is the first connected provider, so it opens first.
    expect(html).toMatch(
      /role="tab" aria-selected="true"[^>]*><span[^>]*>Anthropic<span[^>]*>Recommended<\/span><span aria-hidden="true"[^>]*><\/span><span class="sr-only"> \(connected\)/u,
    );
    expect(html).toMatch(/<h3[^>]*>Anthropic<\/h3>/u);
    // Only the OpenAI and Anthropic tabs are tagged; no panel is.
    expect(html.match(/Recommended/gu)).toHaveLength(2);
  });

  it("offers only Cloud providers while local models are behind their flag", () => {
    fixture.localModels = false;
    fixture.connections = [anthropicConnection, builtinConnection];
    fixture.providers = catalog;
    try {
      // A draft saved on Local falls back to Cloud.
      const html = renderSetup({
        ...welcomeDone,
        step: "ai",
        modelLocation: "local",
      });
      expect(html).not.toContain('aria-label="Local providers"');
      expect(html).not.toMatch(/role="tab"[^>]*><span[^>]*>Local</u);
      expect(html).not.toContain("Ollama");
      expect(html).toContain('aria-label="Cloud providers"');
      expect(html).toContain('data-key-panel="openai"');
    } finally {
      fixture.localModels = true;
    }
  });

  it("names each built-in key variable on self-hosted web", () => {
    fixture.desktopKeys = false;
    fixture.connections = [anthropicConnection, builtinConnection];
    fixture.providers = catalog;
    try {
      let html = renderSetup({ ...welcomeDone, step: "ai" });
      expect(html).toContain(
        "Set ANTHROPIC_API_KEY on the server to use Anthropic.",
      );
      expect(html).toContain("Uses the OpenAI key configured on this server.");
      expect(html).not.toContain("data-key-panel");
      fixture.connections = [
        { ...anthropicConnection, credential_state: "configured" },
        { ...builtinConnection, credential_state: "missing" },
      ];
      html = renderSetup({ ...welcomeDone, step: "ai" });
      expect(html).toContain(
        "Uses the Anthropic key configured on this server.",
      );
      expect(html).toContain("Set OPENAI_API_KEY on the server to use OpenAI.");
    } finally {
      fixture.desktopKeys = true;
    }
  });

  it("shows the ChatGPT plan above the API key on OpenAI's tab where the plan is offered", () => {
    const data = fixture.capabilities.data;
    fixture.capabilities.data = { ...data, chatgpt_plan: true };
    fixture.desktopKeys = false;
    fixture.connections = [anthropicConnection, builtinConnection];
    fixture.providers = catalog;
    try {
      const html = renderSetup({ ...welcomeDone, step: "ai" });
      // No tab of its own: the plan is the other way to use OpenAI's models.
      expect(html).not.toContain("-chatgpt-plan");
      const positions = [
        "through your ChatGPT plan or with an API key",
        "Plan card",
        "Use an API key",
        "Pay OpenAI per request",
        "Uses the OpenAI key configured on this server.",
      ].map((text) => html.indexOf(text));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);

      // Where the runtime does not offer it, OpenAI's tab is the key alone.
      fixture.capabilities.data = { ...data, chatgpt_plan: false };
      const keyOnly = renderSetup({ ...welcomeDone, step: "ai" });
      expect(keyOnly).not.toContain("Plan card");
      expect(keyOnly).not.toContain("Use an API key");
    } finally {
      fixture.capabilities.data = data;
      fixture.desktopKeys = true;
    }
  });

  it("shows no model choice on the hosted composition's AI step", () => {
    fixture.capabilities = {
      isPending: false,
      isError: false,
      data: { model_configuration: false },
    };
    try {
      const html = renderSetup({ ...welcomeDone, step: "ai" });
      expect(html).toContain("provides its own models");
      expect(html).not.toContain('role="tab"');
      expect(html).not.toContain('role="radio"');
      expect(html).toMatch(/<button[^>]*>Continue<\/button>/u);
    } finally {
      fixture.capabilities = {
        isPending: false,
        isError: false,
        data: { model_configuration: true },
      };
    }
  });

  it("says setup can finish while a speech set downloads", () => {
    const step = { ...welcomeDone, step: "voice" as const };
    expect(renderSetup(step)).not.toContain(
      "You can finish setup while this downloads.",
    );
    fixture.downloadingAsset = "sensevoice-stt";
    try {
      expect(renderSetup(step)).toContain(
        "You can finish setup while this downloads.",
      );
    } finally {
      fixture.downloadingAsset = null;
    }
  });

  it("offers speech downloads and Text-to-Speech on the Voice step, which finishes setup", () => {
    const html = renderSetup({
      ...welcomeDone,
      step: "voice",
      ttsProvider: "elevenlabs",
    });
    expect(html).toContain("Step 3 of 3");
    expect(html).toMatch(
      /<li aria-current="step"[^>]*>Voice<span[^>]*>\(optional\)<\/span><\/li>/u,
    );
    // Engines first (the UI Locale's recommended), then its CPU | GPU sets.
    expect(html).toMatch(
      /aria-selected="true"[^>]*><span[^>]*>Parakeet<span[^>]*>Recommended<\/span>/u,
    );
    expect(html).toMatch(/role="tab"[^>]*><span[^>]*>SenseVoice</u);
    expect(html).toMatch(/aria-selected="true"[^>]*>CPU \(/u);
    expect(html).toMatch(/role="tab"[^>]*>GPU \(/u);
    // Text-to-Speech is on by default: provider tabs, no toggle.
    expect(html).not.toContain("Enable Text-to-Speech");
    expect(html).not.toContain("Everything here is optional");
    expect(html).not.toContain("attribution");
    expect(html).toContain("PocketTTS (built-in)");
    // Each local model links to its public source.
    expect(html).toContain(
      'href="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2"',
    );
    expect(html).toContain('href="https://github.com/kyutai-labs/pocket-tts"');
    // Downloads show a ✓/✗ state, not a bare status.
    expect(html).toContain("Not downloaded");
    expect(html).toMatch(
      /<button[^>]*aria-selected="true"[^>]*><span[^>]*>ElevenLabs<\/span><\/button>/u,
    );
    expect(html).toContain('data-key-panel="elevenlabs"');
    expect(html).toMatch(/<button[^>]*>Finish<\/button>/u);
    expect(html).toMatch(/<button[^>]*>Skip for now<\/button>/u);
    expect(html).not.toMatch(/reload/iu);
  });

  it("recommends SenseVoice in Japanese, Korean and Chinese and still lists Parakeet", async () => {
    await getI18n().changeLanguage("zh-Hant");
    try {
      const html = renderSetup({ ...welcomeDone, step: "voice" });
      const tabs = [
        ...html.matchAll(/role="tab"[^>]*>(?:<span[^>]*>)?([^<]+)/gu),
      ].map((match) => match[1]);
      // SenseVoice is recommended and selected, Parakeet still listed, then
      // SenseVoice's CPU | GPU sets.
      expect(tabs.slice(0, 4)).toEqual([
        "SenseVoice",
        "Parakeet",
        expect.stringContaining("CPU（"),
        expect.stringContaining("GPU（"),
      ]);
      expect(html).toMatch(
        /aria-selected="true"[^>]*><span[^>]*>SenseVoice<span[^>]*>推薦<\/span>/u,
      );
      expect(html).toContain(
        'href="https://huggingface.co/FunAudioLLM/SenseVoiceSmall"',
      );
    } finally {
      await getI18n().changeLanguage("en");
    }
  });
});

describe("setup speech-to-text choice", () => {
  const browser = { id: "browser_external", label: "", disabled: false };

  it("puts the browser first on the web, then the UI Locale's model and the other", () => {
    const web = availableSttChoices("sensevoice", [browser] as never);
    expect(web).toEqual([
      "browser_external",
      "sensevoice_cpu",
      "sensevoice_gpu",
      "parakeet_cpu",
      "parakeet_gpu",
    ]);
    expect(recommendedSttChoice("sensevoice", web)).toBe("browser_external");
    // Desktop (or a browser without speech recognition) has no browser tab.
    const desktop = availableSttChoices("parakeet", []);
    expect(desktop).toEqual([
      "parakeet_cpu",
      "parakeet_gpu",
      "sensevoice_cpu",
      "sensevoice_gpu",
    ]);
    expect(recommendedSttChoice("parakeet", desktop)).toBe("parakeet_cpu");
    expect(
      availableSttChoices("parakeet", [
        { ...browser, disabled: true },
      ] as never),
    ).not.toContain("browser_external");
  });

  it("selects the pick, else the saved choice, else the recommended one", () => {
    const choices = availableSttChoices("sensevoice", [browser] as never);
    expect(
      resolveSetupSttChoice(
        { sttChoice: "parakeet_gpu" },
        null,
        "sensevoice",
        choices,
      ),
    ).toBe("parakeet_gpu");
    expect(
      resolveSetupSttChoice(
        { sttChoice: null },
        { stt_provider: "parakeet", stt_parakeet_webgpu: true },
        "sensevoice",
        choices,
      ),
    ).toBe("sensevoice_gpu");
    // A saved engine runs whatever the UI Locale, so it is the one shown.
    expect(
      resolveSetupSttChoice(
        { sttChoice: null },
        { stt_provider: "parakeet", stt_offline_engine: "parakeet" },
        "sensevoice",
        choices,
      ),
    ).toBe("parakeet_cpu");
    expect(
      resolveSetupSttChoice(
        { sttChoice: null },
        {
          stt_provider: "parakeet",
          stt_offline_engine: "whisper" as never,
        },
        "sensevoice",
        choices,
      ),
    ).toBe("sensevoice_cpu");
    // Either browser recognizer shows as the single browser choice.
    expect(
      resolveSetupSttChoice(
        { sttChoice: null },
        { stt_provider: "browser_local" },
        "sensevoice",
        choices,
      ),
    ).toBe("browser_external");
    expect(
      resolveSetupSttChoice({ sttChoice: null }, null, "sensevoice", choices),
    ).toBe("browser_external");
  });

  it("saves either model's choice as the offline provider with its GPU preference and engine", () => {
    expect(setupSttPatch("sensevoice_cpu")).toEqual({
      stt_provider: "parakeet",
      stt_parakeet_webgpu: false,
      stt_offline_engine: "sensevoice",
    });
    expect(setupSttPatch("parakeet_gpu")).toEqual({
      stt_provider: "parakeet",
      stt_parakeet_webgpu: true,
      stt_offline_engine: "parakeet",
    });
    expect(setupSttPatch("browser_external")).toEqual({
      stt_provider: "browser_external",
    });
    // An untouched offline default keeps following the UI Locale.
    expect(
      setupSttPatch("sensevoice_gpu", { saveEngine: false }),
    ).toStrictEqual({ stt_provider: "parakeet", stt_parakeet_webgpu: true });
  });
});

describe("setup step logic", () => {
  it("orders the three steps", () => {
    expect(setupStepPosition("ai")).toBe("Step 2 of 3");
    expect(adjacentSetupStep("welcome", 1)).toBe("ai");
    expect(adjacentSetupStep("ai", -1)).toBe("welcome");
    expect(adjacentSetupStep("voice", 1)).toBeNull();
  });

  it("writes the Text-to-Speech provider only when chosen, keeping it on", () => {
    const saved = { tts_enabled: true, tts_provider: "elevenlabs" as const };
    expect(setupTtsPatch({ ttsProvider: null })).toBeNull();
    expect(resolveSetupTtsProvider({ ttsProvider: null }, saved)).toBe(
      "elevenlabs",
    );
    expect(
      resolveSetupTtsProvider(
        { ttsProvider: null },
        { tts_provider: "browser" },
      ),
    ).toBe("pocket_tts");
    expect(setupTtsPatch({ ttsProvider: "pocket_tts" })).toEqual({
      tts_enabled: true,
      tts_provider: "pocket_tts",
    });
  });

  it("offers built-in voices and ElevenLabs with App Settings' availability", () => {
    const options = setupTtsOptions([
      {
        id: "pocket_tts",
        label: "PocketTTS",
        description: "",
        disabled: false,
      },
      {
        id: "elevenlabs",
        label: "ElevenLabs",
        description: "",
        disabled: true,
        reason: "WebSocket is not supported in this browser.",
      },
    ]);
    expect(
      options.map((option) => [option.id, option.label, option.disabled]),
    ).toEqual([
      ["pocket_tts", "PocketTTS (built-in)", false],
      ["elevenlabs", "ElevenLabs", true],
    ]);
    expect(options[1].reason).toContain("WebSocket");
  });

  it("chooses OpenAI's default Responses model and lists owner models by location", () => {
    const connections = [
      anthropicConnection,
      builtinConnection,
      ollama,
      deepseek,
    ];
    expect(openAiDefaultModel(catalog, connections, OPENAI_MODEL)?.id).toBe(
      OPENAI_MODEL,
    );
    expect(openAiDefaultModel(catalog, connections, null)?.id).toBe(
      "OpenAIResponsesHTTPAgent:gpt-6-mini",
    );
    expect(openAiDefaultModel([], connections, OPENAI_MODEL)).toBeNull();
    // Anthropic's default is Claude Haiku 5.5 on the built-in connection.
    expect(anthropicDefaultModel(catalog, connections)?.id).toBe(HAIKU);
    expect(anthropicDefaultModel(catalog, [builtinConnection])).toBeNull();
    expect(
      anthropicDefaultModel(
        catalog.map((entry) =>
          entry.id === HAIKU ? { ...entry, hidden: true } : entry,
        ),
        connections,
      ),
    ).toBeNull();
    expect(ownerModelChoices(catalog, connections, "local")).toEqual([
      {
        id: "OpenAIHTTPAgent:conn-ollama:qwen3:8b",
        label: "qwen3:8b",
        connectionName: "Ollama",
      },
    ]);
    expect(
      ownerModelChoices(catalog, connections, "cloud").map(
        (choice) => choice.id,
      ),
    ).toEqual(["OpenAIHTTPAgent:conn-deepseek:deepseek-chat"]);
  });

  it("chooses a built-in provider's model only while its key is set", () => {
    const configured: PyModelConnection = {
      ...anthropicConnection,
      credential_state: "configured",
    };
    // OpenAI's key is set; Anthropic's is not, so saving it is still to come.
    expect(
      setupBuiltins(catalog, [anthropicConnection, builtinConnection], null),
    ).toEqual({
      openai: {
        provider: "openai",
        ready: true,
        modelId: "OpenAIResponsesHTTPAgent:gpt-6-mini",
      },
      anthropic: { provider: "anthropic", ready: false, modelId: null },
    });
    const both = setupBuiltins(
      catalog,
      [configured, builtinConnection],
      OPENAI_MODEL,
    );
    expect(both.openai.modelId).toBe(OPENAI_MODEL);
    expect(both.anthropic).toEqual({
      provider: "anthropic",
      ready: true,
      modelId: HAIKU,
    });
    // A hidden Haiku row, or no Anthropic connection, chooses nothing.
    expect(
      setupBuiltins(
        catalog.map((entry) =>
          entry.id === HAIKU ? { ...entry, hidden: true } : entry,
        ),
        [configured, builtinConnection],
        OPENAI_MODEL,
      ).anthropic,
    ).toEqual({ provider: "anthropic", ready: true, modelId: null });
    expect(
      setupBuiltins(catalog, [builtinConnection], OPENAI_MODEL).anthropic,
    ).toEqual({ provider: "anthropic", ready: false, modelId: null });
  });

  it("chooses a plan model once the ChatGPT plan is usable, preferring the system default's model", () => {
    const plan = (
      credential_state: PyModelConnection["credential_state"],
    ): PyModelConnection => ({
      id: "chatgpt_plan",
      name: "ChatGPT plan",
      preset: "chatgpt_plan",
      source: "builtin",
      compatibility: {},
      credential_state,
      models: [],
    });
    const planRow = (slug: string) => ({
      ...catalog.find((entry) => entry.id === OPENAI_MODEL)!,
      id: `ChatGPTPlanResponsesHTTPAgent:${slug}`,
      model: slug,
      connection_id: "chatgpt_plan",
      model_provider: "ChatGPTPlanResponsesHTTPAgent",
    });
    const items = [
      ...catalog,
      planRow("gpt-5.6-terra"),
      planRow(catalog.find((entry) => entry.id === OPENAI_MODEL)!.model),
    ];

    expect(setupChatGPTPlan(items, [plan("configured")], OPENAI_MODEL)).toEqual(
      {
        ready: true,
        modelId: `ChatGPTPlanResponsesHTTPAgent:${
          catalog.find((entry) => entry.id === OPENAI_MODEL)!.model
        }`,
      },
    );
    expect(setupChatGPTPlan(items, [plan("configured")], null).modelId).toBe(
      "ChatGPTPlanResponsesHTTPAgent:gpt-5.6-terra",
    );
    expect(setupChatGPTPlan(items, [plan("missing")], OPENAI_MODEL)).toEqual({
      ready: false,
      modelId: null,
    });
    expect(setupChatGPTPlan(items, [], OPENAI_MODEL).ready).toBe(false);
  });

  it("counts a chat model as ready only when its connection can reply", () => {
    const connections = [anthropicConnection, builtinConnection, ollama];
    // The system default (OpenAI, key set) and a keyless local model can reply.
    expect(setupChatModelReady(catalog, connections, OPENAI_MODEL)).toBe(true);
    expect(
      setupChatModelReady(
        catalog,
        connections,
        "OpenAIHTTPAgent:conn-ollama:qwen3:8b",
      ),
    ).toBe(true);
    // Anthropic's key is not set, and without any model nothing can reply.
    expect(setupChatModelReady(catalog, connections, HAIKU)).toBe(false);
    expect(setupChatModelReady(catalog, connections, null)).toBe(false);
    // With OpenAI's key missing, the untouched system default cannot reply.
    expect(
      setupChatModelReady(
        catalog,
        [{ ...builtinConnection, credential_state: "missing" }],
        OPENAI_MODEL,
      ),
    ).toBe(false);
    // A model the lists do not describe is not reported.
    expect(setupChatModelReady(catalog, connections, "unlisted")).toBe(true);
  });

  it("offers to add only detected models not yet added at that address", () => {
    const detection = {
      preset: "ollama",
      base_url: "http://127.0.0.1:11434/v1",
      reachable: true,
      models: ["qwen3:8b", "llama3.2"],
    } as PyModelConnectionDetection;
    expect(detectedModelsToAdd(detection, [ollama])).toEqual(["llama3.2"]);
    expect(detectedModelsToAdd(detection, [])).toEqual([
      "qwen3:8b",
      "llama3.2",
    ]);
  });
});
