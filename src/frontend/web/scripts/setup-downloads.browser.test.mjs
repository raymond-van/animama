import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { selfHostedRuntimeCapabilities } from "./fixtures/runtime-capabilities.mjs";
import { BROWSER_STEP_TIMEOUT_MS } from "./fixtures/browser-timeouts.mjs";

// Real interaction coverage for the stepped first-run setup: step navigation,
// focus, the unsaved-key prompt, model choice, voice choices, downloads and
// the Finish payload. Only native IPC and HTTP are simulated.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const fixture = path.join(webRoot, "tests/fixtures/setup-downloads");
let server, browser, origin;
before(async () => {
  server = await createServer({
    configFile: false,
    root: webRoot,
    publicDir: false,
    cacheDir: path.join(webRoot, "node_modules/.vite-setup-downloads"),
    logLevel: "error",
    define: {
      __ANIMAMA_DEV_BUILD__: "false",
      __ANIMAMA_APP_VERSION__: '"test"',
    },
    optimizeDeps: { entries: [path.join(fixture, "main.tsx")] },
    resolve: {
      alias: {
        "@": path.join(webRoot, "src"),
        "@web": path.join(webRoot, "src"),
      },
    },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

const OPENAI_MODEL = "OpenAIResponsesHTTPAgent:gpt-6-luna";
const HAIKU = "AnthropicMessagesHTTPAgent:claude-haiku-5-5";
const COMPATIBILITY = {
  fold_developer_role: false,
  send_openai_extensions: false,
  send_stream_usage: true,
  strip_function_strict: false,
  reasoning_mode: "omit",
};
const preset = (id, label, local, url) => ({
  id,
  label,
  local,
  default_base_url: url,
  expects_key: !local,
  compatibility: COMPATIBILITY,
  timeout_seconds: 60,
  suggested_credential_env: null,
  logo_provider: null,
});
const PRESETS = [
  preset("deepseek", "DeepSeek", false, "https://api.deepseek.com/v1"),
  preset("huggingface", "Hugging Face", false, "https://router.hf.co/v1"),
  preset("openrouter", "OpenRouter", false, "https://openrouter.ai/api/v1"),
  preset("custom", "Custom", false, null),
  preset("ollama", "Ollama", true, "http://127.0.0.1:11434/v1"),
  preset("lmstudio", "LM Studio", true, "http://127.0.0.1:1234/v1"),
  preset("llamacpp", "llama.cpp", true, "http://127.0.0.1:8080/v1"),
  preset("vllm", "vLLM", true, "http://127.0.0.1:8000/v1"),
];

/**
 * Mount setup with intercepted HTTP. `options.modelConfiguration` false is
 * the hosted composition; `options.detect` maps a local preset to its models.
 */
async function mount(options = {}) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.setDefaultTimeout(BROWSER_STEP_TIMEOUT_MS);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const operations = [];
  const requests = [];
  const bodies = {};
  const statuses = [
    "openai",
    "anthropic",
    "deepseek",
    "huggingface",
    "gemini",
    "elevenlabs",
  ].map((provider) => ({
    provider,
    configured: false,
    updatedAt: null,
    restartRequired: false,
  }));
  const native = { hold: null };
  const asset = (id, size, extra = {}) => ({
    id,
    status: "not_installed",
    size_bytes: size,
    required_free_bytes: size,
    media_type: null,
    license_ref: "CC-BY-4.0",
    files_total: 1,
    files_verified: 0,
    ...extra,
  });
  // Backend model-asset state; installs apply in place without a reload.
  const assets = [
    asset("parakeet-stt", 661332409, { files_total: 7 }),
    asset("parakeet-stt-webgpu", 1238962007, {
      files_total: 3,
      requires: ["parakeet-stt"],
    }),
  ];
  const context = {
    principal_id: "00000000-0000-4000-8000-000000000188",
    bootstrap_status: "ready",
    failed_steps: [],
    first_run_complete: false,
    display_name: null,
  };
  const settings = {
    user_id: context.principal_id,
    theme: "anima",
    locale: "en-US",
    last_active_anima_id: null,
    preferences: {
      chat: { markdown_enabled: false },
      speech: { stt_provider: "parakeet" },
    },
  };
  const configured = (provider) =>
    statuses.find((status) => status.provider === provider).configured;
  const openAiConfigured = () => configured("openai");
  const connections = [];
  const ownerModels = [];
  const builtinConnection = () => ({
    id: "builtin-openai",
    name: "OpenAI",
    preset: "openai",
    source: "builtin",
    base_url: null,
    credential_env: null,
    credential_state: openAiConfigured() ? "configured" : "missing",
    compatibility: COMPATIBILITY,
    timeout_seconds: null,
    models: [
      {
        id: OPENAI_MODEL,
        model: "gpt-6-luna",
        model_label: "GPT-6 Luna",
        provider_type: "OpenAIResponsesHTTPAgent",
        source: "builtin",
        model_kind: "chat",
        hidden: false,
        connection_id: "builtin-openai",
        context_window_tokens: 400000,
        allow_memory_writes: true,
        capabilities: {
          accepts: ["text"],
          supports_streaming: true,
          supports_tools: true,
          tools_with_structured_output: true,
          structured_output_transport: "json_schema",
        },
      },
    ],
  });
  const haiku = {
    model: "claude-haiku-5-5",
    model_label: "Claude Haiku 5.5",
    source: "builtin",
    model_kind: "chat",
    hidden: false,
    connection_id: "anthropic",
    context_window_tokens: 1000000,
  };
  const anthropicConnection = () => ({
    id: "anthropic",
    name: "Anthropic",
    preset: "anthropic",
    source: "builtin",
    base_url: null,
    credential_env: null,
    credential_state: configured("anthropic") ? "configured" : "missing",
    compatibility: COMPATIBILITY,
    timeout_seconds: null,
    models: [
      {
        ...haiku,
        id: HAIKU,
        provider_type: "AnthropicMessagesHTTPAgent",
        allow_memory_writes: true,
        early_compaction: true,
        capabilities: {
          accepts: ["text", "image"],
          supports_streaming: true,
          supports_tools: true,
          tools_with_structured_output: true,
          structured_output_transport: "json_schema",
        },
      },
    ],
  });
  const catalog = () => [
    {
      ...haiku,
      id: HAIKU,
      model_provider: "AnthropicMessagesHTTPAgent",
      api_standard: "anthropic_messages",
      provider_label: "Anthropic",
      connection_name: "Anthropic",
      supports_streaming: true,
      supports_tools: true,
    },
    {
      id: OPENAI_MODEL,
      model: "gpt-6-luna",
      model_label: "GPT-6 Luna",
      model_provider: "OpenAIResponsesHTTPAgent",
      api_standard: "responses",
      provider_label: "OpenAI",
      connection_id: "builtin-openai",
      connection_name: "OpenAI",
      source: "builtin",
      model_kind: "chat",
      hidden: false,
      supports_streaming: true,
      supports_tools: true,
      context_window_tokens: 400000,
    },
    ...ownerModels.map((model) => ({
      id: model.id,
      model: model.model,
      model_label: model.model_label,
      model_provider: "OpenAIHTTPAgent",
      api_standard: "chat_completions",
      provider_label: "Ollama",
      connection_id: model.connection_id,
      connection_name: connections.find(
        (item) => item.id === model.connection_id,
      ).name,
      source: "owner",
      model_kind: "chat",
      hidden: false,
      supports_streaming: model.capabilities.supports_streaming,
      supports_tools: model.capabilities.supports_tools,
      context_window_tokens: model.context_window_tokens,
    })),
  ];

  await page.exposeFunction("fixtureNative", async (method, args) => {
    if (method === "credentials") return statuses;
    // Record only status and action names, never key values.
    operations.push({ method });
    if (method === "credentials.apply") {
      if (native.hold) await native.hold;
      for (const change of args.filter((item) => item.connection))
        statuses.push({
          connection: change.connection,
          configured: Boolean(change.value),
          updatedAt: "2026-09-28T00:00:00Z",
          restartRequired: false,
        });
      for (const change of args.filter((item) => item.provider))
        Object.assign(
          statuses.find((status) => status.provider === change.provider),
          {
            configured: Boolean(change.value),
            updatedAt: change.value ? "2026-09-28T00:00:00Z" : null,
          },
        );
      return statuses;
    }
  });
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    requests.push({ pathname, method });
    if (pathname === "/v1/animas")
      return route.fulfill({ json: [{ id: "annie" }] });
    if (pathname === "/v1/runtime-context")
      return route.fulfill({ json: context });
    if (pathname === "/v1/users/me/profile")
      return route.fulfill({
        json: {
          user_id: context.principal_id,
          display_name: context.display_name,
        },
      });
    if (pathname === "/v1/runtime/onboarding:complete") {
      const input = request.postDataJSON();
      bodies.onboarding = input;
      if (options.refuseModel && input.chat_model_provider_id)
        return route.fulfill({
          status: 422,
          json: { detail: { code: "chat_model_unavailable" } },
        });
      context.first_run_complete = true;
      context.display_name = input.display_name;
      return route.fulfill({ json: context });
    }
    if (pathname === "/v1/users/me/settings") {
      if (method === "PATCH") {
        bodies.settings = request.postDataJSON();
        Object.assign(settings, bodies.settings);
      }
      return route.fulfill({ json: settings });
    }
    if (pathname === "/v1/runtime-capabilities")
      return route.fulfill({
        json: selfHostedRuntimeCapabilities({
          model_configuration: options.modelConfiguration ?? true,
        }),
      });
    if (pathname === "/v1/model-connection-presets")
      return route.fulfill({ json: PRESETS });
    if (pathname === "/v1/model-connections" && method === "GET")
      return route.fulfill({
        json: [anthropicConnection(), builtinConnection(), ...connections],
      });
    if (pathname === "/v1/model-connections" && method === "POST") {
      const body = request.postDataJSON();
      const created = {
        id: `conn-${connections.length + 1}`,
        name: body.name,
        preset: body.preset,
        source: "owner",
        base_url: body.base_url,
        credential_env:
          body.credential?.mode === "managed"
            ? `ANIMAMA_CONNECTION_${connections.length + 1}`
            : null,
        credential_state:
          body.credential?.mode === "managed" ? "configured" : "not_required",
        compatibility: COMPATIBILITY,
        timeout_seconds: body.timeout_seconds,
        models: [],
      };
      connections.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    const addModel = /^\/v1\/model-connections\/([^/]+)\/models$/u.exec(
      pathname,
    );
    if (addModel && method === "POST") {
      const body = request.postDataJSON();
      const connection = connections.find((item) => item.id === addModel[1]);
      const model = {
        id: `OpenAIHTTPAgent:${connection.id}:${body.model}`,
        model: body.model,
        model_label: body.label ?? body.model,
        provider_type: "OpenAIHTTPAgent",
        source: "owner",
        model_kind: "chat",
        hidden: false,
        connection_id: connection.id,
        context_window_tokens: body.context_window_tokens,
        allow_memory_writes: true,
        capabilities: { accepts: ["text"], ...body.capabilities },
      };
      connection.models.push(model);
      ownerModels.push(model);
      return route.fulfill({ status: 201, json: model });
    }
    if (pathname === "/v1/model-providers")
      return route.fulfill({ json: catalog() });
    if (pathname === "/v1/model-roles")
      return route.fulfill({
        json: {
          roles: [
            {
              role: "chat",
              source: "default",
              model_provider_id: OPENAI_MODEL,
              assignment_available: true,
            },
          ],
          embeddings_refresh: { state: "off" },
        },
      });
    const detect = /^\/v1\/model-connection-presets\/([a-z]+)\/detect$/u.exec(
      pathname,
    );
    if (detect) {
      const id = detect[1];
      const found = options.detect?.[id];
      return route.fulfill({
        json: {
          preset: id,
          base_url: PRESETS.find((item) => item.id === id).default_base_url,
          reachable: Boolean(found),
          models: found ?? [],
          category: found ? null : "unreachable",
        },
      });
    }
    if (pathname === "/v1/model-assets")
      return route.fulfill({ json: { assets, free_bytes: 10000000000 } });
    const install = /^\/v1\/model-assets\/([a-z0-9-]+):install$/u.exec(
      pathname,
    );
    if (install && method === "POST") {
      const target = assets.find((item) => item.id === install[1]);
      Object.assign(target, {
        status: "downloading",
        bytes_downloaded: 0,
        total_bytes: target.size_bytes,
        reason: null,
      });
      return route.fulfill({ status: 202, json: target });
    }
    return route.fulfill({
      status: 404,
      json: { detail: "Unexpected fixture route" },
    });
  });
  await page.goto(`${origin}/tests/fixtures/setup-downloads/index.html`);
  try {
    await page.getByLabel("Display name", { exact: true }).waitFor();
  } catch (error) {
    console.error({
      errors,
      requests,
      body: await page.locator("body").innerText(),
    });
    throw error;
  }
  return {
    page,
    assets,
    statuses,
    operations,
    requests,
    bodies,
    native,
    errors,
  };
}

const button = (page, name) => page.getByRole("button", { name, exact: true });
// Provider tabs carry screen-reader "(connected)" text, so match the start.
const providerTab = (page, name) =>
  page.getByRole("tab", {
    name: new RegExp(`^${name}( \\(connected\\))?$`, "u"),
  });
/** The visible provider panel; hidden panels stay mounted but are excluded. */
const providerPanel = (page, name) =>
  page.getByRole("tabpanel", {
    name: new RegExp(`^${name}( \\(connected\\))?$`, "u"),
  });
// The OpenAI provider tab panel is also labelled "OpenAI"; take the key field.
/** The Voice step's ElevenLabs key, after opening its provider tab. */
async function elevenLabsKey(page) {
  await page.getByRole("tab", { name: "ElevenLabs", exact: true }).click();
  return page
    .getByRole("tabpanel", { name: "ElevenLabs" })
    .getByLabel("ElevenLabs", { exact: true });
}
const openAiKey = (page) =>
  page.locator("input").and(page.getByLabel("OpenAI", { exact: true }));
const anthropicKey = (page) =>
  page.locator("input").and(page.getByLabel("Anthropic", { exact: true }));
const detects = (requests) =>
  requests
    .filter((request) => request.pathname.endsWith("/detect"))
    .map((request) => request.pathname.split("/").at(-2));
const heading = (page, name) =>
  page.getByRole("heading", { level: 1, name, exact: true });
const focusedText = (page) =>
  page.evaluate(() => document.activeElement?.textContent ?? "");
const currentStep = (page) =>
  page.locator('nav[aria-label="Setup progress"] [aria-current="step"]');
const installs = (requests) =>
  requests
    .filter((request) => request.pathname.endsWith(":install"))
    .map((request) => request.pathname);
const writes = (requests) =>
  requests
    .filter((request) => request.method !== "GET")
    .map((request) => `${request.method} ${request.pathname}`)
    .filter((entry) => !entry.endsWith("/detect"));

async function welcome(page) {
  await page.getByLabel("Display name", { exact: true }).fill("Ada Lovelace");
  await button(page, "Continue").click();
  await heading(page, "Choose your AI").waitFor();
}
async function toVoice(page) {
  await welcome(page);
  await button(page, "Skip for now").click();
  await heading(page, "Set up voice").waitFor();
}
const draftKeys = (page) =>
  page.evaluate(() =>
    Object.keys(localStorage).filter((key) =>
      key.startsWith("animama:setup-draft:"),
    ),
  );

test("only Welcome gates; steps move focus to their headings and Skip finishes without a model", async () => {
  const { page, operations, requests, bodies, errors } = await mount();
  try {
    assert.equal(await page.getByText("Step 1 of 3").count(), 1);
    assert.equal(await currentStep(page).innerText(), "Welcome");
    const next = button(page, "Continue");
    assert.equal(await next.isEnabled(), false);
    await page.getByLabel("Display name", { exact: true }).fill("   ");
    assert.equal(await next.isEnabled(), false);
    await page.getByLabel("Display name", { exact: true }).fill("Ada Lovelace");
    // Age confirmation belongs after the wizard.
    assert.equal(await next.isEnabled(), true);
    assert.equal(await button(page, "I am 18 or older").count(), 0);
    await next.click();

    await heading(page, "Choose your AI").waitFor();
    assert.equal(await focusedText(page), "Choose your AI");
    assert.equal(await page.getByText("Step 2 of 3").count(), 1);
    assert.equal(await currentStep(page).innerText(), "AI(optional)");
    await button(page, "Skip for now").click();
    await heading(page, "Set up voice").waitFor();
    assert.equal(await focusedText(page), "Set up voice");
    assert.equal(await currentStep(page).innerText(), "Voice(optional)");
    await button(page, "Skip for now").click();
    const ageDialog = page.getByRole("dialog", { name: "Before you start" });
    await ageDialog.waitFor();
    const loadedApp = page.getByTestId("loaded-application");
    await loadedApp.waitFor();
    assert.equal(
      await loadedApp.evaluate((element) =>
        Boolean(element.closest("[inert]")),
      ),
      true,
    );
    await loadedApp.locator("button").evaluate((element) => element.focus());
    assert.equal(
      await ageDialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      true,
    );
    assert.equal(bodies.onboarding, undefined);
    assert.equal(
      await page.getByText("Setup complete", { exact: true }).count(),
      0,
    );
    await page.keyboard.press("Escape");
    assert.equal(await ageDialog.isVisible(), true);
    await page.mouse.click(5, 5);
    assert.equal(await ageDialog.isVisible(), true);
    assert.equal(
      await ageDialog
        .getByRole("link", { name: "Safety and crisis protocol" })
        .getAttribute("href"),
      "/safety",
    );
    await button(page, "I'm under 18").click();
    await page.getByText(/only for adults 18 and older/u).waitFor();
    assert.equal(await button(page, "I am 18 or older").count(), 0);
    assert.equal(bodies.onboarding, undefined);
    await page.reload();
    await page.getByRole("dialog", { name: "Before you start" }).waitFor();
    assert.equal(bodies.onboarding, undefined);
    const instance = await loadedApp.getAttribute("data-instance");
    await page
      .getByTestId("profile-name")
      .filter({ hasText: /^You$/u })
      .waitFor();
    assert.equal(await page.getByTestId("profile-name").innerText(), "You");
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    await page
      .getByTestId("profile-name")
      .filter({ hasText: "Ada Lovelace" })
      .waitFor();
    assert.equal(await loadedApp.getAttribute("data-instance"), instance);
    assert.equal(
      await loadedApp.evaluate((element) =>
        Boolean(element.closest("[inert]")),
      ),
      false,
    );
    await button(page, "Application control").focus();
    assert.equal(await focusedText(page), "Application control");

    assert.deepEqual(bodies.onboarding, {
      display_name: "Ada Lovelace",
      adult_confirmed: true,
    });
    assert.equal(bodies.settings, undefined);
    assert.deepEqual(operations, []);
    assert.deepEqual(writes(requests), [
      "POST /v1/runtime/onboarding:complete",
    ]);
    assert.deepEqual(await draftKeys(page), []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Back keeps values, and the step and choices survive renderer recreation", async () => {
  const { page } = await mount();
  try {
    await welcome(page);
    await page.getByRole("tab", { name: "Local" }).click();
    await page.getByText(/No Ollama server found/u).waitFor();
    await button(page, "Back").click();
    await heading(page, "What should Animama call you?").waitFor();
    assert.equal(await focusedText(page), "What should Animama call you?");
    assert.equal(
      await page.getByLabel("Display name", { exact: true }).inputValue(),
      "Ada Lovelace",
    );
    await button(page, "Continue").click();
    await heading(page, "Choose your AI").waitFor();
    assert.equal(
      await page
        .getByRole("tab", { name: "Local" })
        .getAttribute("aria-selected"),
      "true",
    );
    await page.reload();
    await heading(page, "Choose your AI").waitFor();
    assert.equal(
      await page
        .getByRole("tab", { name: "Local" })
        .getAttribute("aria-selected"),
      "true",
    );
  } finally {
    await page.close();
  }
});

test("saving the OpenAI key chooses OpenAI; Finish keeps the default voice settings", async () => {
  const { page, operations, requests, bodies } = await mount();
  try {
    await welcome(page);
    await openAiKey(page).fill("fixture-key");
    await button(page, "Save").click();
    await page.getByText("Saved.", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }).includes(
          "fixture-key",
        ),
      ),
      false,
    );
    await button(page, "Continue").click();
    await heading(page, "Set up voice").waitFor();
    // Text-to-Speech is on with built-in voices by default.
    assert.equal(
      await page
        .getByRole("tab", { name: "PocketTTS (built-in)" })
        .getAttribute("aria-selected"),
      "true",
    );
    assert.equal(await page.getByRole("switch").count(), 0);
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();

    assert.deepEqual(operations, [{ method: "credentials.apply" }]);
    assert.deepEqual(bodies.onboarding, {
      display_name: "Ada Lovelace",
      adult_confirmed: true,
      chat_model_provider_id: OPENAI_MODEL,
    });
    // An untouched default writes no voice settings.
    assert.deepEqual(writes(requests), [
      "POST /v1/runtime/onboarding:complete",
    ]);
  } finally {
    await page.close();
  }
});

test("saving the Anthropic key chooses Claude Haiku 5.5, and Finish sends it", async () => {
  const { page, operations, bodies } = await mount();
  try {
    await welcome(page);
    // OpenAI opens first; Anthropic is its own tab with its own key.
    assert.equal(
      await providerTab(page, "OpenAI").getAttribute("aria-selected"),
      "true",
    );
    await providerTab(page, "Anthropic").click();
    await anthropicKey(page).fill("fixture-key");
    // An unsaved Anthropic key prompts before leaving, like the others.
    const dialog = page.getByRole("dialog", { name: "Save your API key?" });
    await button(page, "Continue").click();
    await dialog.waitFor();
    await button(page, "Keep editing").click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(operations, []);
    await button(page, "Save").click();
    await page.getByText("Saved.", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Anthropic (connected)" }).waitFor();
    assert.equal(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }).includes(
          "fixture-key",
        ),
      ),
      false,
    );
    await button(page, "Continue").click();
    await heading(page, "Set up voice").waitFor();
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    assert.deepEqual(operations, [{ method: "credentials.apply" }]);
    assert.equal(bodies.onboarding.chat_model_provider_id, HAIKU);
  } finally {
    await page.close();
  }
});

/** Save the Anthropic key on the AI step, which chooses Claude Haiku 5.5. */
async function saveAnthropicKey(page) {
  await providerTab(page, "Anthropic").click();
  await anthropicKey(page).fill("fixture-key");
  await button(page, "Save").click();
  await page.getByRole("tab", { name: "Anthropic (connected)" }).waitFor();
}

test("saving the OpenAI key after the Anthropic key makes OpenAI the setup model", async () => {
  const { page, bodies } = await mount();
  try {
    await welcome(page);
    await saveAnthropicKey(page);
    // The model set up last wins.
    await providerTab(page, "OpenAI").click();
    await openAiKey(page).fill("fixture-key");
    await button(page, "Save").click();
    await page.getByRole("tab", { name: "OpenAI (connected)" }).waitFor();
    await button(page, "Continue").click();
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    assert.equal(bodies.onboarding.chat_model_provider_id, OPENAI_MODEL);
  } finally {
    await page.close();
  }
});

test("adding a model after the Anthropic key makes it the setup model", async () => {
  const { page, bodies } = await mount({ detect: { ollama: ["qwen3:8b"] } });
  try {
    await welcome(page);
    await saveAnthropicKey(page);
    await page.getByRole("tab", { name: "Local" }).click();
    await button(page, "Add qwen3:8b").click();
    const dialog = page.getByRole("dialog", { name: "Add a model to Ollama" });
    await dialog
      .getByLabel("Context window (tokens)", { exact: true })
      .fill("8192");
    await dialog
      .getByRole("button", { name: "Add model", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await button(page, "Continue").click();
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    assert.equal(
      bodies.onboarding.chat_model_provider_id,
      "OpenAIHTTPAgent:conn-1:qwen3:8b",
    );
  } finally {
    await page.close();
  }
});

test("an unsaved key prompts before leaving: keep editing, save and continue, or discard", async () => {
  const { page, operations } = await mount();
  try {
    await welcome(page);
    const key = openAiKey(page);
    await key.fill("fixture-key");
    const dialog = page.getByRole("dialog", { name: "Save your API key?" });

    await button(page, "Continue").click();
    await dialog.waitFor();
    await button(page, "Keep editing").click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await key.inputValue(), "fixture-key");
    assert.equal(await heading(page, "Choose your AI").count(), 1);

    await button(page, "Continue").click();
    await button(page, "Save key").click();
    await heading(page, "Set up voice").waitFor();
    assert.deepEqual(operations, [{ method: "credentials.apply" }]);

    // Voice: the ElevenLabs key, discarded on Back.
    await (await elevenLabsKey(page)).fill("fixture-voice");
    await button(page, "Back").click();
    await dialog.waitFor();
    await button(page, "Discard").click();
    await heading(page, "Choose your AI").waitFor();
    assert.deepEqual(operations, [{ method: "credentials.apply" }]);

    // Skip also asks.
    await openAiKey(page).fill("another-key");
    await button(page, "Skip for now").click();
    await dialog.waitFor();
    await button(page, "Discard").click();
    await heading(page, "Set up voice").waitFor();
    assert.deepEqual(operations, [{ method: "credentials.apply" }]);
  } finally {
    await page.close();
  }
});

test("a key typed into another provider's connect form prompts before leaving", async () => {
  const { page, operations, requests } = await mount();
  try {
    await welcome(page);
    const dialog = page.getByRole("dialog", { name: "Save your API key?" });
    const connectDeepSeek = async () => {
      await providerTab(page, "DeepSeek").click();
      await providerPanel(page, "DeepSeek")
        .getByLabel("API key (required)")
        .fill("fixture-deepseek");
    };

    await connectDeepSeek();
    await button(page, "Continue").click();
    await dialog.waitFor();
    await button(page, "Discard").click();
    await heading(page, "Set up voice").waitFor();
    assert.deepEqual(operations, []);
    assert.equal(
      writes(requests).includes("POST /v1/model-connections"),
      false,
    );

    await button(page, "Back").click();
    await heading(page, "Choose your AI").waitFor();
    await connectDeepSeek();
    await button(page, "Skip for now").click();
    await dialog.waitFor();
    await button(page, "Save key").click();
    await heading(page, "Set up voice").waitFor();
    // Saving connects the provider and stores its key.
    assert.equal(writes(requests).includes("POST /v1/model-connections"), true);
    assert.deepEqual(operations, [{ method: "credentials.apply" }]);
  } finally {
    await page.close();
  }
});

test("a key that cannot be saved from the prompt keeps the step and says why", async () => {
  const { page, operations, requests } = await mount();
  try {
    await welcome(page);
    await providerTab(page, "Custom").click();
    // Custom has no default address, so the form cannot connect yet.
    await button(page, "Add a custom server").click();
    await providerPanel(page, "Custom")
      .getByLabel("API key (required)")
      .fill("fixture-custom");
    await button(page, "Continue").click();
    await page.getByRole("dialog", { name: "Save your API key?" }).waitFor();
    await button(page, "Save key").click();
    await page.getByText(/Your key wasn't saved/u).waitFor();
    await heading(page, "Choose your AI").waitFor();
    assert.deepEqual(operations, []);
    assert.equal(
      writes(requests).includes("POST /v1/model-connections"),
      false,
    );
  } finally {
    await page.close();
  }
});

test("a typed connect-form key survives provider tab switches and still prompts", async () => {
  const { page, operations } = await mount();
  try {
    await welcome(page);
    // OpenAI opens first; other providers wait on their own tabs.
    assert.equal(
      await providerTab(page, "OpenAI").getAttribute("aria-selected"),
      "true",
    );
    await providerTab(page, "DeepSeek").click();
    const key = providerPanel(page, "DeepSeek").getByLabel(
      "API key (required)",
    );
    await key.fill("fixture-deepseek");
    await providerTab(page, "OpenRouter").click();
    await providerPanel(page, "OpenRouter").getByLabel("Base URL").waitFor();
    await page.getByRole("tab", { name: "Local" }).click();
    await page.getByRole("tab", { name: "Cloud" }).click();

    const dialog = page.getByRole("dialog", { name: "Save your API key?" });
    await button(page, "Continue").click();
    await dialog.waitFor();
    await button(page, "Keep editing").click();
    await providerTab(page, "DeepSeek").click();
    assert.equal(await key.inputValue(), "fixture-deepseek");
    assert.deepEqual(operations, []);
  } finally {
    await page.close();
  }
});

test("connecting from a provider tab stays there and opens Add model", async () => {
  const { page, requests } = await mount();
  try {
    await welcome(page);
    await providerTab(page, "DeepSeek").click();
    await providerPanel(page, "DeepSeek")
      .getByLabel("API key (required)")
      .fill("fixture-deepseek");
    await providerPanel(page, "DeepSeek")
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Add a model to DeepSeek",
    });
    await dialog.waitFor();
    // Templates are built-in OpenAI models, so another connection offers none.
    assert.equal(await dialog.getByText("Copy capabilities from").count(), 0);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("tab", { name: "DeepSeek (connected)" }).waitFor();
    assert.equal(
      await providerTab(page, "DeepSeek").getAttribute("aria-selected"),
      "true",
    );
    await providerPanel(page, "DeepSeek")
      .getByRole("button", { name: "Add model to DeepSeek" })
      .waitFor();
    assert.equal(writes(requests).includes("POST /v1/model-connections"), true);
  } finally {
    await page.close();
  }
});

test("each local provider tab looks for its own server when opened", async () => {
  const { page, requests } = await mount({
    detect: { lmstudio: ["gemma-3"] },
  });
  try {
    await welcome(page);
    await page.getByRole("tab", { name: "Local" }).click();
    await page.getByText(/No Ollama server found/u).waitFor();
    assert.deepEqual(detects(requests), ["ollama"]);
    await providerTab(page, "LM Studio").click();
    await providerPanel(page, "LM Studio")
      .getByText(/Found 1 model at/u)
      .waitFor();
    await button(page, "Add gemma-3").waitFor();
    assert.deepEqual(detects(requests), ["ollama", "lmstudio"]);
    // Returning to a tab keeps its result rather than searching again.
    await providerTab(page, "Ollama").click();
    await page.getByText(/No Ollama server found/u).waitFor();
    assert.deepEqual(detects(requests), ["ollama", "lmstudio"]);
    // vLLM's default port is shared with other servers: search only on request.
    await providerTab(page, "vLLM").click();
    const vllm = providerPanel(page, "vLLM");
    await vllm.getByRole("button", { name: "Search", exact: true }).waitFor();
    assert.deepEqual(detects(requests), ["ollama", "lmstudio"]);
    await vllm.getByRole("button", { name: "Search", exact: true }).click();
    await vllm.getByText(/No vLLM server found/u).waitFor();
    assert.deepEqual(detects(requests), ["ollama", "lmstudio", "vllm"]);
  } finally {
    await page.close();
  }
});

test("OpenAI and Anthropic keys configured before setup do not pin a setup model", async () => {
  const { page, statuses, bodies } = await mount();
  try {
    for (const provider of ["openai", "anthropic"])
      Object.assign(
        statuses.find((status) => status.provider === provider),
        { configured: true, updatedAt: "2026-09-28T00:00:00Z" },
      );
    await page.reload();
    await welcome(page);
    await page.getByRole("tab", { name: "Anthropic (connected)" }).waitFor();
    await button(page, "Continue").click();
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    assert.equal(bodies.onboarding.chat_model_provider_id, undefined);
  } finally {
    await page.close();
  }
});

test("Finish waits for a key save in flight, then saves ElevenLabs as the provider", async () => {
  const { page, native, bodies } = await mount();
  try {
    await toVoice(page);
    const key = await elevenLabsKey(page);
    let release;
    native.hold = new Promise((resolve) => {
      release = resolve;
    });
    await key.fill("fixture-voice");
    await button(page, "Save").click();
    await page.getByText("Saving your key…").waitFor();
    assert.equal(await button(page, "Finish").isEnabled(), false);
    assert.equal(await button(page, "Back").isEnabled(), false);
    native.hold = null;
    release();
    await page.getByText("Saved.", { exact: true }).waitFor();
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    assert.equal(bodies.settings.preferences.speech.tts_provider, "elevenlabs");
    assert.equal(bodies.settings.preferences.speech.tts_enabled, true);
  } finally {
    await page.close();
  }
});

test("a local server's model is added and becomes the setup model", async () => {
  const { page, bodies, requests, errors } = await mount({
    detect: { ollama: ["qwen3:8b"] },
  });
  try {
    await welcome(page);
    await page.getByRole("tab", { name: "Local" }).click();
    await page.getByText(/Found 1 model at/u).waitFor();
    await button(page, "Add qwen3:8b").click();
    const dialog = page.getByRole("dialog", {
      name: "Add a model to Ollama",
    });
    await dialog.waitFor();
    assert.equal(
      await dialog.getByLabel("Model ID", { exact: true }).inputValue(),
      "qwen3:8b",
    );
    await dialog
      .getByLabel("Context window (tokens)", { exact: true })
      .fill("8192");
    await dialog
      .getByRole("button", { name: "Add model", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    // With a local model available, an empty server tab skips "Set up later".
    await providerTab(page, "llama.cpp").click();
    await providerPanel(page, "llama.cpp")
      .getByText(/No llama.cpp server found/u)
      .waitFor();
    assert.equal(
      await providerPanel(page, "llama.cpp")
        .getByRole("button", { name: "Set up later" })
        .count(),
      0,
    );
    await button(page, "Continue").click();
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    assert.equal(
      bodies.onboarding.chat_model_provider_id,
      "OpenAIHTTPAgent:conn-1:qwen3:8b",
    );
    assert.deepEqual(writes(requests).slice(0, 2), [
      "POST /v1/model-connections",
      "POST /v1/model-connections/conn-1/models",
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("saving the OpenAI key after adding a local model makes OpenAI the setup model", async () => {
  const { page, bodies } = await mount({ detect: { ollama: ["qwen3:8b"] } });
  try {
    await welcome(page);
    await page.getByRole("tab", { name: "Local" }).click();
    await button(page, "Add qwen3:8b").click();
    const dialog = page.getByRole("dialog", { name: "Add a model to Ollama" });
    await dialog
      .getByLabel("Context window (tokens)", { exact: true })
      .fill("8192");
    await dialog
      .getByRole("button", { name: "Add model", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    // The model set up last wins.
    await page.getByRole("tab", { name: /^Cloud/u }).click();
    await openAiKey(page).fill("fixture-key");
    await button(page, "Save").click();
    await page.getByText("Saved.", { exact: true }).waitFor();
    await button(page, "Continue").click();
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    assert.equal(bodies.onboarding.chat_model_provider_id, OPENAI_MODEL);
  } finally {
    await page.close();
  }
});

test("with no local server, Set up later moves on without a model", async () => {
  const { page, bodies } = await mount();
  try {
    await welcome(page);
    await page.getByRole("tab", { name: "Local" }).click();
    await page.getByText(/No Ollama server found/u).waitFor();
    await button(page, "Set up later").click();
    await heading(page, "Set up voice").waitFor();
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    assert.equal(bodies.onboarding.chat_model_provider_id, undefined);
  } finally {
    await page.close();
  }
});

test("a refused setup model is explained and Finish can retry after skipping it", async () => {
  const { page, bodies } = await mount({ refuseModel: true });
  try {
    await welcome(page);
    await openAiKey(page).fill("fixture-key");
    await button(page, "Save").click();
    await page.getByText("Saved.", { exact: true }).waitFor();
    await button(page, "Continue").click();
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText(/chosen model can no longer be used/u).waitFor();
    await button(page, "Back to setup").click();
    await button(page, "Back").click();
    await button(page, "Skip for now").click();
    await heading(page, "Set up voice").waitFor();
    // Skipping AI clears the choice; OpenAI is chosen again only if returning.
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    assert.equal(bodies.onboarding.chat_model_provider_id, undefined);
  } finally {
    await page.close();
  }
});

test("the hosted composition's AI step offers no model choice", async () => {
  const { page, bodies } = await mount({ modelConfiguration: false });
  try {
    await welcome(page);
    await page.getByText(/provides its own models/u).waitFor();
    assert.equal(await page.getByRole("tab").count(), 0);
    assert.equal(await page.getByRole("radio").count(), 0);
    await button(page, "Continue").click();
    await button(page, "Finish").click();
    await page.getByRole("dialog", { name: "Before you start" }).waitFor();
    // A restored legacy draft cannot attest age or override withheld model configuration.
    await page.evaluate((chatModelId) => {
      const key = Object.keys(localStorage).find((key) =>
        key.startsWith("animama:setup-draft:"),
      );
      const draft = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(
        key,
        JSON.stringify({ ...draft, chatModelId, adultConfirmed: true }),
      );
    }, OPENAI_MODEL);
    await page.reload();
    await page.getByRole("dialog", { name: "Before you start" }).waitFor();
    assert.equal(bodies.onboarding, undefined);
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    assert.equal(bodies.onboarding.chat_model_provider_id, undefined);
  } finally {
    await page.close();
  }
});

test("a speech download keeps running after Finish and survives renderer recreation", async () => {
  const { page, assets, requests } = await mount();
  try {
    await toVoice(page);
    await button(page, "Download").click();
    await page
      .getByText(/Downloading \d+%/u)
      .first()
      .waitFor();
    assert.deepEqual(installs(requests), [
      "/v1/model-assets/parakeet-stt:install",
    ]);
    await page.reload();
    await heading(page, "Set up voice").waitFor();
    await button(page, "Cancel").first().waitFor();
    await button(page, "Back").click();
    await button(page, "Back").click();
    assert.equal(
      await page.getByLabel("Display name", { exact: true }).inputValue(),
      "Ada Lovelace",
    );
    await button(page, "Continue").click();
    await button(page, "Continue").click();
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
    assert.equal(assets[0].status, "downloading");
  } finally {
    await page.close();
  }
});

test("a failed download offers retry without blocking Finish", async () => {
  const { page, assets, requests } = await mount();
  try {
    await toVoice(page);
    await button(page, "Download").click();
    await page
      .getByText(/Downloading \d+%/u)
      .first()
      .waitFor();
    Object.assign(assets[0], {
      status: "failed",
      reason: "asset_download_failed",
    });
    await page.reload();
    const retry = button(page, "Retry download");
    await retry.waitFor();
    assert.equal(await button(page, "Finish").isEnabled(), true);
    await retry.click();
    await page
      .getByText(/Downloading \d+%/u)
      .first()
      .waitFor();
    assert.equal(installs(requests).length, 2);
  } finally {
    await page.close();
  }
});

test("steps, keys and downloads work when setup details cannot be retained", async () => {
  const { page, operations, requests } = await mount();
  try {
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new Error("storage unavailable");
      };
    });
    await welcome(page);
    await openAiKey(page).fill("fixture-key");
    await button(page, "Save").click();
    await page.getByText("Saved.", { exact: true }).waitFor();
    await button(page, "Continue").click();
    await heading(page, "Set up voice").waitFor();
    await button(page, "Download").click();
    await page
      .getByText(/Downloading \d+%/u)
      .first()
      .waitFor();
    assert.deepEqual(operations, [{ method: "credentials.apply" }]);
    assert.equal(installs(requests).length, 1);
    await button(page, "Finish").click();
    await button(page, "I am 18 or older").click();
    await page.getByText("Setup complete", { exact: true }).waitFor();
  } finally {
    await page.close();
  }
});

test("a failed key change is reported again after renderer recreation, keeping the step", async () => {
  const { page, statuses, operations } = await mount();
  try {
    await welcome(page);
    statuses[0].configured = true;
    statuses[0].updatedAt = "2026-09-28T00:00:00Z";
    statuses[0].error = "secure_storage_unavailable";
    await page.reload();
    await heading(page, "Choose your AI").waitFor();
    await page.getByText(/OpenAI: The key change could not finish/u).waitFor();
    await button(page, "Remove OpenAI key").click();
    delete statuses[0].error;
    await button(page, "Save").click();
    await page.getByText("Saved.", { exact: true }).waitFor();
    assert.equal(statuses[0].configured, false);
    assert.deepEqual(operations, [{ method: "credentials.apply" }]);
    await button(page, "Back").click();
    assert.equal(
      await page.getByLabel("Display name", { exact: true }).inputValue(),
      "Ada Lovelace",
    );
  } finally {
    await page.close();
  }
});
