import { describe, expect, it } from "vitest";
import type {
  PyConfiguredModel,
  PyModelConnection,
  PyModelProviderCatalogItem,
} from "@animama/runtime-contracts/api-types";

import {
  DEFAULT_CAPABILITIES_DRAFT,
  MODEL_LOCATION_PROVIDERS,
  MODEL_LOCATION_TABS,
  capabilitiesFromProbe,
  connectionLocation,
  connectionStatusText,
  detectionMessage,
  embeddingsStatusText,
  formatContextWindow,
  isPrivateNetworkUrl,
  keyOrigin,
  keyOriginVariable,
  keyWouldTravelInsecurely,
  defaultLocationProvider,
  locationProviderGroups,
  providerConnected,
  modelApiLabel,
  modelCapabilityChips,
  modelConfigurationErrorCode,
  modelConfigurationErrorMessage,
  modelInUseUsage,
  modelKeyMissing,
  modelLocationLabel,
  modelProviderLabel,
  modelProviderPurpose,
  modelSettingsAvailability,
  builtinConnectionKey,
  ownerModelRules,
  removalConsequences,
  removalUsageSummary,
  replacementChatModel,
  roleCandidates,
  draftAfterProbe,
  visibleModelLocations,
} from "./model-configuration-state";
import {
  alternateModelIds,
  modelConnectionLabel,
  modelDisplayName,
  modelOptionDetail,
  modelPickerGroupLabel,
  modelOptionLabel,
  selectableChatModels,
} from "@/lib/chat/model-catalog";

function row(
  id: string,
  extra: Partial<PyModelProviderCatalogItem> = {},
): PyModelProviderCatalogItem {
  return {
    id,
    model: id,
    model_label: id,
    model_provider: "OpenAIHTTPAgent",
    api_standard: "chat_completions",
    provider_label: "Ollama",
    accepts: ["text"],
    produces: ["text"],
    supports_streaming: true,
    supports_tools: true,
    model_kind: "chat",
    source: "owner",
    hidden: false,
    context_window_tokens: 8192,
    ...extra,
  } as PyModelProviderCatalogItem;
}

describe("model pickers", () => {
  it("offers chat models only and keeps a hidden current choice", () => {
    const items = [
      row("chat"),
      row("hidden", { hidden: true }),
      row("embed", { model_kind: "embedding" }),
    ];
    expect(selectableChatModels(items).map((item) => item.id)).toEqual([
      "chat",
    ]);
    expect(
      selectableChatModels(items, "hidden").map((item) => item.id),
    ).toEqual(["chat", "hidden"]);
  });

  it("offers each role only the models the server accepts for it", () => {
    const items = [
      row("tools"),
      row("no-tools", { supports_tools: false }),
      row("no-window", { context_window_tokens: null }),
      row("builtin-no-window", {
        source: "builtin",
        context_window_tokens: null,
      }),
      row("batch", { supports_streaming: false }),
      row("embed", { model_kind: "embedding", supports_streaming: false }),
      row("hidden", { hidden: true }),
    ];
    const ids = (role: Parameters<typeof roleCandidates>[1]) =>
      roleCandidates(items, role).map((item) => item.id);
    expect(ids("utility")).toEqual(["tools", "no-tools", "builtin-no-window"]);
    expect(ids("memory_manager")).toEqual([
      "tools",
      "no-window",
      "builtin-no-window",
      "batch",
    ]);
    expect(ids("embeddings")).toEqual(["embed"]);
    // The Chat default also needs a model direct chat can send to.
    expect(
      roleCandidates(
        [...items, row("unsupported", { api_standard: null })],
        "chat",
      ).map((item) => item.id),
    ).toEqual(["tools", "no-tools", "builtin-no-window"]);
    // A hidden model stays listed while it is the role's current choice.
    expect(
      roleCandidates(items, "utility", "hidden").map((item) => item.id),
    ).toContain("hidden");
  });

  it("offers a ChatGPT plan model for chat, Utility and the Memory Manager, never Embeddings", () => {
    const plan = row("ChatGPTPlanResponsesHTTPAgent:gpt-6-luna", {
      source: "builtin",
      connection_id: "chatgpt_plan",
      model_provider: "ChatGPTPlanResponsesHTTPAgent",
      context_window_tokens: 272000,
    });
    for (const role of ["chat", "utility", "memory_manager"] as const)
      expect(roleCandidates([plan], role).map((item) => item.id)).toEqual([
        plan.id,
      ]);
    expect(roleCandidates([plan], "embeddings")).toEqual([]);
  });

  it("groups the built-in OpenAI connection's models under one name", () => {
    const builtin = row("gpt-6-luna", {
      connection_id: "openai",
      connection_name: "OpenAI",
      provider_label: "OpenAI Responses HTTP",
      model_provider: "OpenAIResponsesHTTPAgent",
    });
    const owner = row("gpt-6.1-luna", {
      connection_id: "openai",
      connection_name: "OpenAI",
      provider_label: "OpenAI",
      model_provider: "OpenAIResponsesHTTPAgent",
    });
    expect(modelConnectionLabel(builtin)).toBe("OpenAI");
    expect(modelConnectionLabel(owner)).toBe("OpenAI");
    // Pickers never name the API; the app picks it. Beside ChatGPT plan models
    // they say a key is used, to tell the two ways apart; otherwise not.
    expect(modelOptionDetail(owner)).toBe("OpenAI");
    expect(modelPickerGroupLabel(owner, false)).toBe("OpenAI");
    expect(modelOptionDetail(owner, true)).toBe("API key");
    expect(modelPickerGroupLabel(owner, true)).toBe("OpenAI · API key");
    expect(modelOptionLabel(builtin)).toBe("OpenAI: gpt-6-luna");
    expect(
      modelOptionLabel({ ...builtin, model_provider: "OpenAIHTTPAgent" }),
    ).toBe("OpenAI: gpt-6-luna");
    const local = row("qwen3:8b", {
      connection_id: "c_0123456789ab",
      connection_name: "Ollama",
    });
    expect(modelOptionDetail(local)).toBe("Ollama");
    expect(modelOptionDetail(local, true)).toBe("Ollama");
    expect(modelPickerGroupLabel(local, true)).toBe("Ollama");
    const plan = row("gpt-5.6-luna", {
      connection_id: "chatgpt_plan",
      connection_name: "ChatGPT plan",
      model_provider: "ChatGPTPlanResponsesHTTPAgent",
    });
    expect(modelOptionDetail(plan, true)).toBe("ChatGPT plan");
    expect(modelPickerGroupLabel(plan, true)).toBe("OpenAI · ChatGPT plan");
  });

  it("marks only the non-Responses twin of a visible duplicate name as alternate", () => {
    const responses = row("gpt-6-luna", {
      connection_id: "openai",
      model_provider: "OpenAIResponsesHTTPAgent",
    });
    const completions = row("gpt-6-luna:cc", {
      model: "gpt-6-luna",
      model_label: "gpt-6-luna",
      connection_id: "openai",
      model_provider: "OpenAIHTTPAgent",
    });
    const elsewhere = row("gpt-6-luna:or", {
      model: "gpt-6-luna",
      model_label: "gpt-6-luna",
      connection_id: "c_router",
    });
    // Order does not matter; the Responses row keeps the plain name.
    expect([...alternateModelIds([completions, responses, elsewhere])]).toEqual(
      ["gpt-6-luna:cc"],
    );
    // A hidden twin left out of the list renames nothing.
    expect(alternateModelIds([responses, elsewhere]).size).toBe(0);
    // Configured models name the API in provider_type.
    expect([
      ...alternateModelIds([
        {
          ...completions,
          model_provider: undefined,
          provider_type: "OpenAIHTTPAgent",
        },
        {
          ...responses,
          model_provider: undefined,
          provider_type: "OpenAIResponsesHTTPAgent",
        },
      ]),
    ]).toEqual(["gpt-6-luna:cc"]);
    // Embedding rows never take part.
    expect(
      alternateModelIds([
        responses,
        { ...completions, model_kind: "embedding" },
      ]).size,
    ).toBe(0);
    expect(modelOptionLabel(completions, true)).toBe(
      "Ollama: gpt-6-luna (alternate)",
    );
    expect(modelDisplayName(completions, true)).toBe("gpt-6-luna (alternate)");
    expect(modelDisplayName(completions, true)).not.toMatch(
      /Responses|Completions/u,
    );
  });

  it("labels models with fallbacks", () => {
    expect(modelOptionLabel(row("qwen3:8b", { connection_id: "c_1" }))).toBe(
      "Ollama: qwen3:8b",
    );
    expect(
      modelOptionLabel({
        model: "qwen3:8b",
        model_label: null,
        provider_label: null,
      }),
    ).toBe("qwen3:8b");
  });
});

describe("models whose connection has no key", () => {
  const connections = [
    { id: "openai", credential_state: "missing" },
    { id: "openrouter", credential_state: "configured" },
    { id: "ollama", credential_state: "not_required" },
  ] as const;
  const stuck = row("gpt", { connection_id: "openai", source: "builtin" });
  const routed = row("routed", { connection_id: "openrouter" });
  const local = row("local", { connection_id: "ollama" });

  it("reports a model only when its own connection is missing a key", () => {
    expect(modelKeyMissing(stuck, connections)).toBe(true);
    expect(modelKeyMissing(routed, connections)).toBe(false);
    expect(modelKeyMissing(local, connections)).toBe(false);
    // Nothing is reported from lists that do not name the connection.
    expect(modelKeyMissing(row("loose"), connections)).toBe(false);
    expect(modelKeyMissing(stuck, [])).toBe(false);
    expect(modelKeyMissing(null, connections)).toBe(false);
  });

  it("offers the Chat default when it can reply", () => {
    expect(
      replacementChatModel([stuck, routed, local], connections, "local")?.id,
    ).toBe("local");
  });

  it("offers the only model that can reply when the Chat default cannot", () => {
    expect(replacementChatModel([stuck, routed], connections, "gpt")?.id).toBe(
      "routed",
    );
    // Models the Chat default cannot be (hidden, or no context window) do not count.
    expect(
      replacementChatModel(
        [
          stuck,
          routed,
          row("hidden", { connection_id: "ollama", hidden: true }),
          row("no-window", {
            connection_id: "ollama",
            context_window_tokens: null,
          }),
        ],
        connections,
        null,
      )?.id,
    ).toBe("routed");
  });

  it("offers nothing when the owner must choose between models, or has none", () => {
    expect(
      replacementChatModel([stuck, routed, local], connections, "gpt"),
    ).toBeNull();
    expect(replacementChatModel([stuck], connections, "gpt")).toBeNull();
  });
});

describe("connection safety and errors", () => {
  it.each([
    ["http://192.168.1.20:11434/v1", true],
    ["http://models.example.test/v1", true],
    ["https://models.example.test/v1", false],
    ["http://127.0.0.1:11434/v1", false],
    ["http://localhost:1234/v1", false],
    ["http://host.docker.internal:8080/v1", false],
    ["http://[::1]:8080/v1", false],
    ["not a url", false],
  ])("warns about keys sent over plain http to %s: %s", (url, expected) => {
    expect(keyWouldTravelInsecurely(url)).toBe(expected);
  });

  it.each([
    ["https://LAB.example.test:443/v1", "https://lab.example.test"],
    ["http://127.0.0.1:8000/v1", "http://127.0.0.1:8000"],
    ["http://[::1]:8080/v1", "http://[::1]:8080"],
    [" https://lab.example.test:8443/v1 ", "https://lab.example.test:8443"],
    ["ftp://lab.example.test", null],
    ["not a url", null],
    [null, null],
  ])("saves a key for the origin of %s", (url, expected) => {
    expect(keyOrigin(url)).toBe(expected);
  });

  it("names the origin variable only for a connection key", () => {
    expect(keyOriginVariable(" ANIMAMA_CONNECTION_LAB_API_KEY ")).toBe(
      "ANIMAMA_CONNECTION_LAB_ORIGIN",
    );
    expect(keyOriginVariable("OPENAI_API_KEY")).toBeNull();
    expect(keyOriginVariable("MY_SERVER_API_KEY")).toBeNull();
  });

  it("uses category copy for connection failures and never echoes server text", () => {
    expect(
      modelConfigurationErrorMessage({
        detail: {
          code: "unreachable",
          message: "connect ECONNREFUSED secret-host",
        },
      }),
    ).toContain("could not be reached");
    expect(
      modelConfigurationErrorMessage({
        detail: {
          code: "invalid_context_window",
          message: "Context window must be positive",
        },
      }),
    ).toBe("Context window must be positive");
    expect(modelConfigurationErrorMessage(new TypeError("fetch failed"))).toBe(
      "The change could not be saved.",
    );
  });

  it("summarizes what a removal affects", () => {
    const usage = modelInUseUsage({
      detail: {
        code: "model_in_use",
        usage: {
          animas: [
            { anima_id: "a", display_name: "Mira", model_provider_id: "m" },
            { anima_id: "b", display_name: "Luna", model_provider_id: "m" },
          ],
          roles: ["models.utility_model_provider_id"],
        },
      },
    });
    expect(usage && removalUsageSummary(usage)).toBe(
      "Used by Mira and Luna, and as the Compaction model.",
    );
    expect(usage && removalConsequences(usage)).toBe(
      "Those Animas show their model as unavailable until you pick another. That role goes back to its default.",
    );
    expect(removalConsequences({ animas: [], roles: [] })).toBe("");
    expect(modelInUseUsage({ detail: { code: "model_read_only" } })).toBeNull();
  });
});

describe("probe and role status", () => {
  it("prefills capabilities from a probe, keeping undetermined values", () => {
    expect(
      capabilitiesFromProbe(
        {
          model: "qwen",
          steps: [
            { name: "streaming", ok: true },
            { name: "structured_output", ok: false, category: "bad_request" },
            { name: "json_mode", ok: true },
          ],
          supports_streaming: true,
          structured_output_transport: "json_object",
          supports_tools: false,
          tools_with_structured_output: null,
        },
        DEFAULT_CAPABILITIES_DRAFT,
      ),
    ).toEqual({
      ...DEFAULT_CAPABILITIES_DRAFT,
      structured_output_transport: "json_object",
      supports_tools: false,
    });
  });

  it("describes re-embedding progress", () => {
    expect(embeddingsStatusText({ state: "off" })).toContain("keywords");
    expect(
      embeddingsStatusText({ state: "re_embedding", pending: 12 }),
    ).toContain("12 items");
    expect(
      embeddingsStatusText({
        state: "retrying",
        pending: 3,
        error_category: "unreachable",
      }),
    ).toContain("could not be reached");
  });
});

describe("detectionMessage", () => {
  const base = { preset: "ollama", base_url: "http://127.0.0.1:11434/v1" };

  it("counts the models found at the address", () => {
    expect(
      detectionMessage(
        { ...base, reachable: true, models: ["qwen3:8b", "gemma3"] },
        "Ollama",
      ),
    ).toBe("Found 2 models at http://127.0.0.1:11434/v1.");
    expect(
      detectionMessage({ ...base, reachable: true, models: ["a"] }, "Ollama"),
    ).toBe("Found 1 model at http://127.0.0.1:11434/v1.");
  });

  it("names the server to start when nothing answers", () => {
    expect(
      detectionMessage({ ...base, reachable: false, models: [] }, "Ollama"),
    ).toBe(
      "Nothing is running at http://127.0.0.1:11434/v1. Start Ollama and try again.",
    );
  });
});

describe("Cloud and Local tabs", () => {
  const owner = (preset: string, base_url: string | null = null) => ({
    source: "owner" as const,
    preset,
    base_url,
  });
  type Conn = Pick<PyModelConnection, "source" | "preset" | "base_url"> & {
    credential_state?: PyModelConnection["credential_state"];
  };

  it("hides Local only behind its flag, except for an existing local connection", () => {
    const cloud: Conn = {
      source: "owner",
      preset: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
    };
    const lan: Conn = {
      source: "owner",
      preset: "custom",
      base_url: "http://192.168.1.20:11434/v1",
    };
    expect(visibleModelLocations([cloud], false)).toEqual(["cloud"]);
    expect(visibleModelLocations([cloud], true)).toEqual(["cloud", "local"]);
    expect(visibleModelLocations([cloud, lan], false)).toEqual([
      "cloud",
      "local",
    ]);
  });

  it("offers the planned providers on each tab, OpenAI and Anthropic recommended", () => {
    expect(MODEL_LOCATION_TABS.map(modelLocationLabel)).toEqual([
      "Cloud",
      "Local",
    ]);
    expect(MODEL_LOCATION_PROVIDERS.cloud.map(modelProviderLabel)).toEqual([
      "OpenAI",
      "Anthropic",
      "DeepSeek",
      "Hugging Face",
      "OpenRouter",
      "Custom",
    ]);
    expect(MODEL_LOCATION_PROVIDERS.local.map(modelProviderLabel)).toEqual([
      "Ollama",
      "LM Studio",
      "llama.cpp",
      "vLLM",
      "Custom",
    ]);
    expect(
      MODEL_LOCATION_PROVIDERS.cloud.filter((entry) => entry.recommended),
    ).toEqual([
      expect.objectContaining({ id: "openai" }),
      expect.objectContaining({ id: "anthropic" }),
    ]);
  });

  it("puts the built-in connection and cloud presets on Cloud, local servers on Local", () => {
    for (const preset of ["openai", "anthropic"])
      expect(
        connectionLocation({ source: "builtin", preset, base_url: "" }),
      ).toBe("cloud");
    for (const preset of ["deepseek", "huggingface", "openrouter", "unknown"])
      expect(connectionLocation(owner(preset))).toBe("cloud");
    for (const preset of ["ollama", "lmstudio", "llamacpp", "vllm"])
      // Even when pointed at another computer, a local server type stays Local.
      expect(
        connectionLocation(owner(preset, "https://gpu.example.test/v1")),
      ).toBe("local");
  });

  it.each([
    ["http://127.0.0.1:8080/v1", "local"],
    ["http://localhost:1234/v1", "local"],
    ["http://ollama.localhost/v1", "local"],
    ["http://host.docker.internal:8000/v1", "local"],
    ["http://[::1]:8080/v1", "local"],
    ["http://192.168.1.20:11434/v1", "local"],
    ["http://10.0.0.5/v1", "local"],
    ["http://172.20.1.1:8000/v1", "local"],
    ["http://gpu-box.local:8000/v1", "local"],
    ["http://[fd12::1]:8000/v1", "local"],
    ["192.168.1.20:8000/v1", "local"],
    ["http://gpu-box:8000/v1", "local"],
    ["http://nas.lan:8000/v1", "local"],
    ["http://llm.home.arpa/v1", "local"],
    ["http://models.corp.internal/v1", "local"],
    ["http://100.64.0.1:11434/v1", "local"],
    ["http://100.127.255.254/v1", "local"],
    ["http://gpu-box.tail1234.ts.net:8000/v1", "local"],
    ["http://100.128.0.1/v1", "cloud"],
    ["https://lan.example.com/v1", "cloud"],
    ["https://internal.example.com/v1", "cloud"],
    ["http://172.32.0.1/v1", "cloud"],
    ["https://api.together.xyz/v1", "cloud"],
    ["https://8.8.8.8/v1", "cloud"],
    ["", "cloud"],
  ])("places a custom connection at %s on %s", (baseUrl, location) => {
    expect(connectionLocation(owner("custom", baseUrl))).toBe(location);
    expect(isPrivateNetworkUrl(baseUrl)).toBe(location === "local");
  });

  it("groups connections under their provider tabs in tab order", () => {
    const connections = [
      { id: "lan", ...owner("custom", "http://192.168.1.4:8000/v1") },
      { id: "or", ...owner("openrouter", "https://openrouter.ai/api/v1") },
      { id: "builtin", source: "builtin" as const, preset: "openai" },
      { id: "claude", source: "builtin" as const, preset: "anthropic" },
      { id: "vllm", ...owner("vllm", "http://127.0.0.1:8000/v1") },
      { id: "remote", ...owner("custom", "https://api.example.test/v1") },
      { id: "remote2", ...owner("custom", "https://api.other.test/v1") },
      { id: "odd", ...owner("unknown-preset", "https://odd.test/v1") },
    ];
    const cloud = locationProviderGroups(connections, "cloud", true);
    expect(cloud.map((group) => group.entry.id)).toEqual([
      "openai",
      "anthropic",
      "deepseek",
      "huggingface",
      "openrouter",
      "custom-cloud",
    ]);
    // Each built-in connection is on its own provider's tab.
    expect(cloud[0].connections.map((item) => item.id)).toEqual(["builtin"]);
    expect(cloud[1].connections.map((item) => item.id)).toEqual(["claude"]);
    expect(cloud[2].connections).toEqual([]);
    expect(cloud[4].connections.map((item) => item.id)).toEqual(["or"]);
    // Custom collects every custom (and unknown) connection in its location.
    expect(cloud[5].connections.map((item) => item.id)).toEqual([
      "remote",
      "remote2",
      "odd",
    ]);
    const local = locationProviderGroups(connections, "local");
    expect(local.map((group) => group.entry.id)).toEqual([
      "ollama",
      "lmstudio",
      "llamacpp",
      "vllm",
      "custom-local",
    ]);
    expect(local[3].connections.map((item) => item.id)).toEqual(["vllm"]);
    expect(local[4].connections.map((item) => item.id)).toEqual(["lan"]);
  });

  it("offers DeepSeek and Hugging Face only behind their flag or for an existing connection", () => {
    const ids = (connections: Conn[]) =>
      locationProviderGroups(connections, "cloud", false).map(
        (group) => group.entry.id,
      );
    expect(ids([])).toEqual([
      "openai",
      "anthropic",
      "openrouter",
      "custom-cloud",
    ]);
    expect(ids([owner("huggingface", "https://router.hf.co/v1")])).toEqual([
      "openai",
      "anthropic",
      "huggingface",
      "openrouter",
      "custom-cloud",
    ]);
  });

  it("puts the ChatGPT plan on OpenAI's tab only where the runtime offers it", () => {
    const connections = [
      { source: "builtin", preset: "openai", base_url: null },
      { source: "builtin", preset: "chatgpt_plan", base_url: null },
    ] as const;
    const openai = (available: boolean) =>
      locationProviderGroups(connections, "cloud", false, available)[0];
    // No tab of its own: the plan is the other way to use OpenAI's models.
    expect(
      locationProviderGroups(connections, "cloud", false, true).map(
        (group) => group.entry.id,
      ),
    ).toEqual(["openai", "anthropic", "openrouter", "custom-cloud"]);
    expect(openai(true).connections.map((c) => c.preset)).toEqual([
      "openai",
      "chatgpt_plan",
    ]);
    expect(openai(false).connections.map((c) => c.preset)).toEqual(["openai"]);
    expect(modelProviderPurpose(openai(true).entry, true)).toContain(
      "ChatGPT plan",
    );
    expect(modelProviderPurpose(openai(true).entry)).not.toContain(
      "ChatGPT plan",
    );
  });

  it("keeps the chosen provider tab only while it is offered", () => {
    const groups = locationProviderGroups([], "cloud", false);
    expect(defaultLocationProvider(groups, "openrouter")).toBe("openrouter");
    // A removed DeepSeek connection's tab is gone with the flag off.
    expect(defaultLocationProvider(groups, "deepseek")).toBe("openai");
  });

  it("marks providers connected, counting built-in connections only with their key", () => {
    const builtin = (
      credential_state: PyModelConnection["credential_state"],
      preset = "openai",
    ): Conn => ({
      source: "builtin",
      preset,
      base_url: null,
      credential_state,
    });
    const flags = (connections: Conn[], location: "cloud" | "local") =>
      locationProviderGroups(connections, location)
        .filter(providerConnected)
        .map((group) => group.entry.id);
    expect(
      flags([builtin("missing"), builtin("missing", "anthropic")], "cloud"),
    ).toEqual([]);
    expect(
      flags([builtin("missing"), builtin("configured", "anthropic")], "cloud"),
    ).toEqual(["anthropic"]);
    expect(
      flags(
        [
          builtin("configured"),
          { ...owner("deepseek"), credential_state: "missing" },
        ],
        "cloud",
      ),
    ).toEqual(["openai", "deepseek"]);
    expect(
      flags([owner("custom", "http://127.0.0.1:9000/v1")], "local"),
    ).toEqual(["custom-local"]);
    // A signed-in ChatGPT plan lights OpenAI's tab where the plan is offered.
    const planOnly = [
      builtin("missing"),
      builtin("configured", "chatgpt_plan"),
    ];
    expect(
      locationProviderGroups(planOnly, "cloud", false, true)
        .filter(providerConnected)
        .map((group) => group.entry.id),
    ).toEqual(["openai"]);
    expect(
      locationProviderGroups(planOnly, "cloud", false, false).filter(
        providerConnected,
      ),
    ).toEqual([]);
  });

  it("opens a location on its first connected provider, else the first one", () => {
    const pick = (connections: Conn[], location: "cloud" | "local") =>
      defaultLocationProvider(locationProviderGroups(connections, location));
    const keyless: Conn = {
      source: "builtin",
      preset: "openai",
      base_url: null,
      credential_state: "missing",
    };
    expect(pick([keyless], "cloud")).toBe("openai");
    expect(
      pick(
        [keyless, owner("openrouter", "https://openrouter.ai/api/v1")],
        "cloud",
      ),
    ).toBe("openrouter");
    expect(
      pick(
        [
          { ...keyless, credential_state: "configured" },
          owner("openrouter", "https://openrouter.ai/api/v1"),
        ],
        "cloud",
      ),
    ).toBe("openai");
    expect(pick([], "local")).toBe("ollama");
    expect(
      pick(
        [
          owner("custom", "http://192.168.1.4:8000/v1"),
          owner("lmstudio", "http://127.0.0.1:1234/v1"),
        ],
        "local",
      ),
    ).toBe("lmstudio");
  });

  it("shows key state on Cloud and reachability on Local", () => {
    const cloud = {
      ...owner("deepseek"),
      credential_state: "missing" as const,
    };
    expect(connectionStatusText(cloud)).toBe("Key missing");
    expect(
      connectionStatusText({ ...cloud, credential_state: "configured" }),
    ).toBe("Key set");
    const local = {
      ...owner("ollama", "http://127.0.0.1:11434/v1"),
      credential_state: "not_required" as const,
    };
    expect(connectionStatusText(local)).toBe("Checking…");
    expect(connectionStatusText(local, { state: "reachable" })).toBe(
      "Running at 127.0.0.1:11434",
    );
    expect(
      connectionStatusText(local, { state: "failed", category: "unreachable" }),
    ).toBe("Not reachable");
    expect(
      connectionStatusText(local, { state: "failed", category: "timeout" }),
    ).toBe("Not reachable");
    expect(
      connectionStatusText(local, {
        state: "failed",
        category: "credential_missing",
      }),
    ).toBe("Key missing");
    expect(
      modelConfigurationErrorCode({ detail: { code: "unreachable" } }),
    ).toBe("unreachable");
    expect(modelConfigurationErrorCode(new Error("x"))).toBeNull();
  });
});

describe("model row chips", () => {
  const model = (
    extra: Partial<PyConfiguredModel> = {},
    capabilities: Partial<PyConfiguredModel["capabilities"]> = {},
  ): PyConfiguredModel => ({
    id: "m",
    connection_id: "c",
    model: "m",
    model_label: "m",
    model_kind: "chat",
    provider_type: "OpenAIHTTPAgent",
    source: "owner",
    hidden: false,
    allow_memory_writes: true,
    context_window_tokens: 131072,
    ...extra,
    capabilities: {
      accepts: ["text"],
      supports_streaming: true,
      supports_tools: true,
      tools_with_structured_output: true,
      ...capabilities,
    },
  });
  const search = {
    configuration: true,
    configured: true,
    backend: "searxng" as const,
    credential_state: "not_required" as const,
  };
  const labels = (
    item: PyConfiguredModel,
    capability?: Parameters<typeof modelCapabilityChips>[1],
  ) => modelCapabilityChips(item, capability).map((chip) => chip.label);

  it("shows Tools, Context, Web search and Vision in order, never the API", () => {
    expect(labels(model({}, { accepts: ["text", "image"] }), search)).toEqual([
      "Tools",
      "128K",
      "App search",
      "Vision",
    ]);
    const responses = model(
      {
        provider_type: "OpenAIResponsesHTTPAgent",
        context_window_tokens: 400000,
      },
      { native_tool_support: ["web_search", "apply_patch"] },
    );
    expect(labels(responses, null)).toEqual([
      "Tools",
      "400K",
      "Built-in search",
    ]);
    for (const item of [model(), responses])
      expect(labels(item, search).join(" ")).not.toMatch(
        /Responses|Completions/u,
      );
  });

  it("offers app search only to tool-calling models with a ready search service", () => {
    expect(labels(model({}, { supports_tools: false }), search)).toEqual([
      "128K",
    ]);
    expect(labels(model(), { ...search, configured: false })).toEqual([
      "Tools",
      "128K",
    ]);
    expect(
      labels(model(), {
        ...search,
        backend: "brave",
        credential_state: "missing",
      }),
    ).toEqual(["Tools", "128K"]);
    // Built-in search needs the Responses API, as the backend requires.
    expect(
      labels(model({}, { native_tool_support: ["web_search"] }), null),
    ).toEqual(["Tools", "128K"]);
  });

  it("labels embedding models by kind and omits an unknown context window", () => {
    expect(labels(model({ model_kind: "embedding" }), search)).toEqual([
      "Embeddings",
    ]);
    expect(labels(model({ context_window_tokens: null }), null)).toEqual([
      "Tools",
    ]);
  });

  it("formats context windows", () => {
    expect(formatContextWindow(8192)).toBe("8K");
    expect(formatContextWindow(128000)).toBe("128K");
    expect(formatContextWindow(200000)).toBe("200K");
    expect(formatContextWindow(1048576)).toBe("1M");
    expect(formatContextWindow(1050000)).toBe("1.1M");
    expect(formatContextWindow(512)).toBe("512");
  });

  it("names the API only for the Info panel", () => {
    expect(
      modelApiLabel(model({ provider_type: "OpenAIResponsesHTTPAgent" })),
    ).toBe("Responses");
    // A ChatGPT plan model uses Responses through the plan.
    expect(
      modelApiLabel(model({ provider_type: "ChatGPTPlanResponsesHTTPAgent" })),
    ).toBe("Responses");
    expect(
      modelApiLabel(model({ provider_type: "AnthropicMessagesHTTPAgent" })),
    ).toBe("Anthropic Messages");
    expect(modelApiLabel(model())).toBe("Chat Completions");
  });

  it("shows Anthropic's own web search as built-in search", () => {
    const haiku = model(
      {
        provider_type: "AnthropicMessagesHTTPAgent",
        context_window_tokens: 1000000,
      },
      { accepts: ["text", "image"], native_tool_support: ["web_search"] },
    );
    expect(labels(haiku, null)).toEqual([
      "Tools",
      "1M",
      "Built-in search",
      "Vision",
    ]);
  });

  it("says Anthropic bills each built-in search to the owner's account", () => {
    const searchChip = (item: PyConfiguredModel) =>
      modelCapabilityChips(item, search).find(
        (chip) => chip.id === "web-search",
      );
    const haiku = model(
      { provider_type: "AnthropicMessagesHTTPAgent" },
      { native_tool_support: ["web_search"] },
    );
    expect(searchChip(haiku)?.description).toMatch(
      /Anthropic bills each search to your Anthropic account/u,
    );
    const responses = model(
      { provider_type: "OpenAIResponsesHTTPAgent" },
      { native_tool_support: ["web_search"] },
    );
    expect(searchChip(responses)?.label).toBe("Built-in search");
    expect(searchChip(responses)?.description).not.toMatch(/bills/u);
    expect(searchChip(model())?.description).not.toMatch(/bills/u);
  });

  it("shows no search on Anthropic models without their own search", () => {
    const owner = model(
      { provider_type: "AnthropicMessagesHTTPAgent" },
      { native_tool_support: [] },
    );
    // Anthropic models never use the app's search service.
    expect(labels(owner, search)).toEqual(["Tools", "128K"]);
  });
});

describe("built-in connections and the add-model dialog", () => {
  const connection = (
    preset: string,
    source: PyModelConnection["source"] = "builtin",
  ) => ({ id: preset, preset, source });
  const template = (
    id: string,
    provider_type: string,
    connection_id: string,
  ): PyConfiguredModel => ({
    id,
    connection_id,
    model: id.split(":").at(-1)!,
    model_label: id,
    model_kind: "chat",
    provider_type,
    source: "builtin",
    hidden: false,
    allow_memory_writes: true,
    capabilities: {
      accepts: ["text"],
      supports_streaming: true,
      supports_tools: true,
      tools_with_structured_output: true,
    },
  });
  const haiku = template(
    "AnthropicMessagesHTTPAgent:claude-haiku-5-5",
    "AnthropicMessagesHTTPAgent",
    "anthropic",
  );
  const luna = template(
    "OpenAIResponsesHTTPAgent:gpt-6-luna",
    "OpenAIResponsesHTTPAgent",
    "openai",
  );
  const lunaCc = template(
    "OpenAIHTTPAgent:gpt-6-luna",
    "OpenAIHTTPAgent",
    "openai",
  );
  const templates = [luna, lunaCc, haiku];

  it("gives each built-in connection its own key", () => {
    expect(builtinConnectionKey(connection("openai"))).toEqual({
      provider: "openai",
      env: "OPENAI_API_KEY",
    });
    expect(builtinConnectionKey(connection("anthropic"))).toEqual({
      provider: "anthropic",
      env: "ANTHROPIC_API_KEY",
    });
    expect(builtinConnectionKey(connection("deepseek", "owner"))).toBeNull();
  });

  it("fixes the Anthropic connection to Anthropic chat models, its templates and Haiku 5.5", () => {
    const rules = ownerModelRules(connection("anthropic"), templates);
    expect(rules).toMatchObject({
      providerType: "AnthropicMessagesHTTPAgent",
      embeddings: false,
      jsonMode: false,
      defaultTemplateId: haiku.id,
    });
    expect(rules.templates).toEqual([haiku]);
  });

  it("keeps the OpenAI and owner connections' rules", () => {
    const openai = ownerModelRules(connection("openai"), templates);
    expect(openai).toMatchObject({
      providerType: "OpenAIResponsesHTTPAgent",
      embeddings: true,
      jsonMode: true,
      defaultTemplateId: null,
    });
    expect(openai.templates).toEqual([luna]);
    const owner = ownerModelRules(connection("ollama", "owner"), templates);
    expect(owner).toMatchObject({
      providerType: "OpenAIHTTPAgent",
      embeddings: true,
      jsonMode: true,
      defaultTemplateId: null,
    });
    expect(owner.templates).toEqual([]);
  });

  /** A draft that copied Haiku 5.5: its efforts, schema output and window. */
  const fromHaiku = {
    templateId: haiku.id,
    capabilities: {
      ...DEFAULT_CAPABILITIES_DRAFT,
      accepts_images: true,
      supports_tools: true,
      structured_output_transport: "json_schema" as const,
    },
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    contextWindow: "1000000",
    label: "kept",
  };
  const described = {
    model: "claude-older",
    steps: [{ name: "available", ok: true }],
    supports_streaming: true,
    supports_tools: true,
    context_window_tokens: 200000,
    max_output_tokens: 32000,
  };

  it("takes a described Anthropic model's limits from the Models API, not the template", () => {
    // The Models API reported no efforts and no structured outputs.
    const next = draftAfterProbe(connection("anthropic"), fromHaiku, {
      ...described,
      structured_output_transport: null,
      supported_reasoning_efforts: null,
    });
    expect(next).toEqual({
      ...fromHaiku,
      templateId: null,
      capabilities: {
        ...fromHaiku.capabilities,
        structured_output_transport: null,
      },
      reasoningEfforts: [],
      contextWindow: "200000",
    });
  });

  it("uses the efforts and structured output a described Anthropic model supports", () => {
    const next = draftAfterProbe(connection("anthropic"), fromHaiku, {
      ...described,
      structured_output_transport: "json_schema",
      tools_with_structured_output: true,
      supported_reasoning_efforts: ["low", "medium", "high"],
    });
    expect(next.templateId).toBeNull();
    expect(next.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(next.capabilities.structured_output_transport).toBe("json_schema");
  });

  it("keeps the template after a failed Anthropic test", () => {
    const next = draftAfterProbe(connection("anthropic"), fromHaiku, {
      model: "claude-missing",
      steps: [{ name: "available", ok: false, category: "model_not_found" }],
    });
    expect(next).toEqual(fromHaiku);
  });

  it("keeps the OpenAI and owner connections' probe merge", () => {
    const draft = {
      ...fromHaiku,
      templateId: luna.id,
      reasoningEfforts: ["low"],
    };
    const report = {
      model: "qwen",
      steps: [{ name: "streaming", ok: true }],
      supports_streaming: true,
      context_window_tokens: null,
    };
    for (const target of [connection("openai"), connection("ollama", "owner")])
      // Behaviour probes keep the template, the efforts and an untested schema.
      expect(draftAfterProbe(target, draft, report)).toEqual(draft);
  });
});

describe("Models in App Settings by composition", () => {
  it("retains hosted role choices independently of administration", () => {
    expect(
      modelSettingsAvailability({
        model_configuration: false,
        model_role_selection: true,
        web_search: { configuration: false },
      }),
    ).toEqual({
      modelConfiguration: false,
      modelRoleSelection: true,
      webSearchConfiguration: false,
    });
    expect(
      modelSettingsAvailability({
        model_configuration: true,
        model_role_selection: true,
        web_search: { configuration: true },
      }),
    ).toEqual({
      modelConfiguration: true,
      modelRoleSelection: true,
      webSearchConfiguration: true,
    });
  });
  it("withholds role choices when the permission is false or unreadable", () => {
    for (const capabilities of [
      undefined,
      {},
      { model_configuration: true, model_role_selection: false },
    ]) {
      expect(modelSettingsAvailability(capabilities).modelRoleSelection).toBe(
        false,
      );
    }
  });
});
