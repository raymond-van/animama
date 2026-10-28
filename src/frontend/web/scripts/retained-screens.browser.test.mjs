import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer, loadConfigFromFile } from "vite";
import { observeInitialNavigation } from "./fixtures/initial-navigation-diagnostics.mjs";
import {
  createHostedWorkflowHttp,
  hostedCapabilities,
} from "./fixtures/hosted-workflows-http.mjs";
import { BROWSER_STEP_TIMEOUT_MS } from "./fixtures/browser-timeouts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = "tests/fixtures/retained-screens";
const originalCapabilities = structuredClone(hostedCapabilities);
const evidenceDir = process.env.ANIMAMA_SCREEN_EVIDENCE_DIR;
async function capture(page, name) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, `${name}.png`),
    fullPage: true,
  });
}
let api, server, browser, origin;
before(async () => {
  api = await createHostedWorkflowHttp();
  const shared = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    path.join(root, "vite.config.ts"),
  );
  server = await createServer({
    configFile: false,
    root,
    publicDir: false,
    logLevel: "error",
    cacheDir: path.join(root, "node_modules/.vite/retained-screens-tests"),
    define: {
      __ANIMAMA_DEV_BUILD__: "false",
      __ANIMAMA_APP_VERSION__: '"fixture"',
      __CLIENT_PARAKEET_MODELS__: "null",
    },
    resolve: shared.config.resolve,
    optimizeDeps: { entries: [path.join(root, fixture, "main.tsx")] },
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: { "/v1": api.url, "/api/cloud/auth": api.url },
      fs: { allow: [path.resolve(root, "../../.."), path.resolve(root, "..")] },
    },
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  api.setOrigin(origin);
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await server?.close();
  await api?.close();
});

const model = (id, kind) => ({
  id,
  model: id,
  label: id,
  model_kind: kind,
  model_client: "OpenAIResponsesHTTPAgent",
  api_standard: "openai-responses",
  source: "operator",
  supports_streaming: true,
  supports_tools: true,
  context_window_tokens: 8192,
  settings: {},
});
async function mount(
  route = "/library",
  capabilities = {},
  width = 1440,
  local = false,
) {
  for (const key of Object.keys(hostedCapabilities))
    delete hostedCapabilities[key];
  Object.assign(
    hostedCapabilities,
    originalCapabilities,
    capabilities,
    local ? { runtime_kind: "self_hosted_web" } : {},
  );
  const admitted = api.admit();
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  await context.addCookies([
    {
      name: "fixture_session",
      value: admitted.cookie,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const calls = [],
    errors = [],
    external = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) {
      external.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith("/v1/"))
      calls.push({ path: url.pathname, method: route.request().method() });
    const json = (body) => route.fulfill({ json: body });
    if (
      local &&
      url.pathname === "/v1/users/me/settings" &&
      route.request().method() === "PATCH"
    ) {
      assert.equal(route.request().headers()["x-animama-csrf"], "1");
      Object.assign(admitted.state.settings, route.request().postDataJSON());
      return json(admitted.state.settings);
    }
    if (url.pathname === "/v1/runtime-context")
      return json({
        principal_id: admitted.owner,
        display_name: `${admitted.owner} account`,
        first_run_complete: true,
        bootstrap_status: "ready",
        failed_steps: [],
      });
    if (url.pathname === "/v1/model-providers")
      return json([
        model("chat-choice", "chat"),
        model("embedding-choice", "embedding"),
      ]);
    if (url.pathname === "/v1/model-roles")
      return json({
        roles: [],
        embeddings_refresh: { state: "off", pending: 0 },
      });
    if (url.pathname === "/v1/files") return json({ files: [] });
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(BROWSER_STEP_TIMEOUT_MS);
  const navigate = (next) =>
    page.goto(
      `${origin}/${fixture}/index.html?local=${local ? "1" : "0"}&route=${encodeURIComponent(next)}`,
    );
  const ready = () =>
    page.getByRole("heading", { name: "Library", exact: true }).waitFor();
  const visit = async (next = route) => {
    await navigate(next);
    try {
      await ready();
    } catch (error) {
      const body = await page.locator("body").innerText();
      await context.close();
      throw new Error(`${error.message}; body=${body}; errors=${errors}`);
    }
  };
  await observeInitialNavigation({
    page,
    ownedContext: context,
    navigate: () => navigate(route),
    ready,
  });
  return {
    page,
    calls,
    errors,
    external,
    visit,
    ...admitted,
    close: async () => {
      await context.close();
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    },
  };
}
async function settings(page, owner) {
  await page
    .getByRole("button")
    .filter({ hasText: `${owner} account` })
    .click();
  await page
    .getByRole("menuitem", { name: "App Settings", exact: true })
    .click();
  return page.getByRole("dialog", { name: "App Settings", exact: true });
}

// Mount the actual Library and shared shell in both compositions. A modal closes
// the mobile drawer, so the Library header must let the user open it again.
for (const local of [false, true]) {
  for (const dismissal of ["Escape", "Close"]) {
    test(`actual ${local ? "local" : "hosted"} Library restores mobile navigation after ${dismissal}`, async () => {
      const f = await mount("/library", {}, 390, local);
      const { page } = f;
      try {
        if (!local) {
          // This screen fixture supplies the hosted quota HTTP boundary too.
          await page.route("**/v1/hosted/quotas", (route) =>
            route.fulfill({
              json: {
                turns: { used: 2, limit: 100 },
                chats: { used: 1, limit: 20 },
                storage_bytes: { used: 0, limit: 1024 },
                resets_at: "2027-01-01T00:00:00Z",
              },
            }),
          );
        }
        const openSidebar = page.getByRole("button", {
          name: "Open sidebar",
          exact: true,
        });
        await openSidebar.click();
        await page
          .getByRole("button")
          .filter({ hasText: `${f.owner} account` })
          .click();
        const action = local ? "App Settings" : "Usage and limits";
        await page.getByRole("menuitem", { name: action, exact: true }).click();
        const dialog = page.getByRole("dialog", { name: action, exact: true });
        await dialog.waitFor();
        if (!local) {
          await dialog.getByText("Chat turns", { exact: true }).waitFor();
          assert.equal(
            await dialog
              .getByText("Usage could not be loaded.", { exact: true })
              .count(),
            0,
          );
        }
        if (dismissal === "Escape") await page.keyboard.press("Escape");
        else
          await dialog
            .getByRole("button", {
              name: local ? "Close App Settings" : "Close",
              exact: true,
            })
            .click();
        await dialog.waitFor({ state: "hidden" });

        // Only ordinary clicks establish that navigation is usable again.
        await openSidebar.click();
        const settingsDialog = await settings(page, f.owner);
        await settingsDialog
          .getByRole("button", { name: "Close App Settings", exact: true })
          .click();
        await settingsDialog.waitFor({ state: "hidden" });
        await openSidebar.click();
        await page.getByRole("link", { name: "Library", exact: true }).click();
        await page
          .getByRole("heading", { name: "Library", exact: true })
          .waitFor();
        const pointerEvents = await page.evaluate(() => ({
          body: getComputedStyle(document.body).pointerEvents,
          html: getComputedStyle(document.documentElement).pointerEvents,
        }));
        assert.notEqual(pointerEvents.body, "none");
        assert.notEqual(pointerEvents.html, "none");
      } finally {
        await f.close();
      }
    });
  }
}

const roles = [
  ["Chat", "chat", "default_model_provider_id"],
  ["Memory Manager", "models", "memory_manager_model_provider_id"],
  ["Compaction", "models", "utility_model_provider_id"],
  ["Embeddings", "models", "embedding_model_provider_id"],
];

test("actual hosted App Settings keeps four role choices, search and saved preferences without administration", async () => {
  const f = await mount();
  try {
    let dialog = await settings(f.page, f.owner);
    await dialog.getByRole("button", { name: "Models", exact: true }).click();
    for (const [label, group, key] of roles) {
      const value = label === "Embeddings" ? "embedding-choice" : "chat-choice";
      await dialog
        .getByRole("combobox", { name: `${label} model`, exact: true })
        .click();
      await f.page.getByRole("option", { name: value, exact: true }).click();
      await f.page.waitForFunction(
        ({ group, key, value }) =>
          fetch("/v1/users/me/settings")
            .then((r) => r.json())
            .then((s) => s.preferences?.[group]?.[key] === value),
        { group, key, value },
      );
    }
    assert.equal(
      await dialog.getByText("Connections and models", { exact: true }).count(),
      0,
    );
    assert.equal(
      await dialog.getByText("Search service", { exact: true }).count(),
      0,
    );
    for (const label of [
      "Chat",
      "Memory Manager",
      "Compaction",
      "Embeddings",
    ]) {
      await dialog
        .getByRole("combobox", { name: "Search settings" })
        .fill(label);
      await dialog
        .getByRole("listbox", { name: "Matching settings" })
        .getByText(label, { exact: true })
        .waitFor();
    }
    await dialog
      .getByRole("combobox", { name: "Search settings" })
      .fill("Connections and models");
    assert.equal(
      await dialog
        .getByRole("option", { name: "Connections and models", exact: true })
        .count(),
      0,
    );
    await f.visit();
    dialog = await settings(f.page, f.owner);
    await dialog.getByRole("button", { name: "Models", exact: true }).click();
    for (const [label] of roles)
      await dialog
        .getByRole("combobox", { name: `${label} model`, exact: true })
        .filter({ hasText: /choice/ })
        .waitFor();
    await capture(f.page, "hosted-model-roles-desktop");
    await f.page.setViewportSize({ width: 390, height: 844 });
    await capture(f.page, "hosted-model-roles-narrow");
    for (const [label] of roles) {
      const control = dialog.getByRole("combobox", {
        name: `${label} model`,
        exact: true,
      });
      await control.scrollIntoViewIfNeeded();
      await control.click();
      await f.page
        .getByRole("option", {
          name: label === "Embeddings" ? "embedding-choice" : "chat-choice",
          exact: true,
        })
        .waitFor();
      await f.page.keyboard.press("Escape");
    }
    await capture(f.page, "hosted-model-roles-narrow-scrolled");
    assert.equal(
      f.calls.filter((c) =>
        /model-connections|model-presets|credentials|web-search/.test(c.path),
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("actual Library blocks denied upload permission on direct and legacy URLs at desktop and narrow widths", async () => {
  for (const width of [1440, 390]) {
    const f = await mount(
      "/library?section=chat-uploads",
      { chat_file_uploads: false },
      width,
    );
    try {
      await f.page
        .getByRole("heading", { name: "Chat Uploads unavailable", exact: true })
        .waitFor();
      // Spec R2: the familiar tab stays visible but disabled with its reason.
      const tab = f.page.getByRole("button", {
        name: "Chat Uploads",
        exact: true,
      });
      assert.equal(await tab.count(), 1);
      assert.equal(await tab.getAttribute("aria-disabled"), "true");
      assert.equal(
        await f.page
          .getByRole("button", { name: "Upload", exact: true })
          .count(),
        0,
      );
      await capture(f.page, `hosted-library-unavailable-${width}`);
      await f.page
        .getByRole("button", { name: "Back to Library", exact: true })
        .click();
      assert.equal(new URL(f.page.url()).searchParams.get("section"), null);
      await f.visit("/memories?tab=uploads");
      await f.page
        .getByRole("heading", { name: "Chat Uploads unavailable", exact: true })
        .waitFor();
      assert.equal(
        f.calls.filter((c) => c.path.startsWith("/v1/files")).length,
        0,
      );
      assert.equal(
        await f.page
          .getByRole("button", { name: "Import", exact: true })
          .count(),
        1,
      );
      assert.equal(
        await f.page
          .getByRole("button", { name: "Export", exact: true })
          .count(),
        1,
      );
    } finally {
      await f.close();
    }
  }
});

test("actual Library removes upload workflow on capability loss and retains local-capability navigation", async () => {
  const f = await mount(
    "/library?section=chat-uploads",
    {
      chat_file_uploads: true,
      model_role_selection: true,
      model_configuration: true,
      web_search: { configuration: true, configured: false },
    },
    1440,
    true,
  );
  try {
    await f.page.locator("#library-uploads-heading").waitFor();
    await f.page.getByRole("button", { name: "Upload", exact: true }).waitFor();
    assert.ok(f.calls.some((c) => c.path === "/v1/files"));
    hostedCapabilities.chat_file_uploads = false;
    await f.page.evaluate(() =>
      window.retainedScreenFixture.refreshCapabilities(),
    );
    await f.page
      .getByRole("heading", { name: "Chat Uploads unavailable", exact: true })
      .waitFor();
    assert.equal(await f.page.locator("#library-uploads-heading").count(), 0);
    const after = f.calls.filter((c) => c.path === "/v1/files").length;
    await f.page
      .getByRole("button", { name: "Back to Library", exact: true })
      .click();
    assert.equal(f.calls.filter((c) => c.path === "/v1/files").length, after);
    const dialog = await settings(f.page, f.owner);
    await dialog.getByRole("button", { name: "Models", exact: true }).click();
    assert.equal(
      await dialog
        .getByRole("combobox", {
          name: /^(Chat|Memory Manager|Compaction|Embeddings) model$/,
        })
        .count(),
      4,
    );
    for (const label of ["Connections and models", "Search service"]) {
      await dialog
        .getByRole("combobox", { name: "Search settings" })
        .fill(label);
      await dialog
        .getByRole("listbox", { name: "Matching settings" })
        .getByText(label, { exact: true })
        .waitFor();
    }
  } finally {
    await f.close();
  }
});

test("actual Library unmounts upload queries when current capability metadata is missing", async () => {
  const f = await mount(
    "/library?section=chat-uploads",
    { chat_file_uploads: true },
    1440,
    true,
  );
  try {
    await f.page.locator("#library-uploads-heading").waitFor();
    await f.page.evaluate(() =>
      window.retainedScreenFixture.omitUploadPermission(),
    );
    await f.page
      .getByRole("heading", { name: "Chat Uploads unavailable", exact: true })
      .waitFor();
    assert.equal(await f.page.locator("#library-uploads-heading").count(), 0);
    assert.equal(
      await f.page
        .getByRole("button", { name: "Chat Uploads", exact: true })
        .count(),
      0,
    );
    const fileCalls = f.calls.filter((c) => c.path === "/v1/files").length;
    await f.page
      .getByRole("button", { name: "Back to Library", exact: true })
      .click();
    assert.equal(
      f.calls.filter((c) => c.path === "/v1/files").length,
      fileCalls,
    );
  } finally {
    await f.close();
  }
});

// A runtime that offers no Library previews gets family icons and sends no
// preview, texture or manifest request; one that omits the capability keeps
// today's tiles. The fixture's hosted capabilities withhold previews.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const previewFile = (file_ref, logical_path, media_type, role, ordinal) => ({
  file_ref,
  filename: logical_path,
  logical_path,
  media_type,
  role,
  ordinal,
  size_bytes: 1,
  sha256: "0".repeat(64),
  // These items are Local, so the server names them by registration alone.
  url: `/v1/content/files/${file_ref}`,
});
const previewItems = {
  "/v1/particle-effects": {
    kind: "particle_effect",
    name: "Sparks",
    files: [
      previewFile("sparks-texture", "sparks.png", "image/png", "texture", 0),
      previewFile(
        "sparks-manifest",
        "sparks.quarks.json",
        "application/json",
        "manifest",
        1,
      ),
    ],
  },
  "/v1/scene-effects": {
    kind: "scene_effect",
    name: "Sky",
    files: [previewFile("sky-image", "sky.png", "image/png", "image", 0)],
  },
};
for (const local of [false, true]) {
  for (const offered of [false, undefined]) {
    test(`actual ${local ? "local" : "hosted"} Library tiles when previews are ${offered === false ? "withheld" : "not declared"}`, async () => {
      const f = await mount(
        "/library?section=avatars",
        { library_previews: offered },
        1440,
        local,
      );
      const requested = [],
        fileErrors = [];
      f.page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/v1/content/files/"))
          requested.push(url.pathname + url.search);
      });
      // A refused preview logs a console error against its URL.
      f.page.on("console", (message) => {
        if (
          message.type() === "error" &&
          `${message.location().url} ${message.text()}`.includes(
            "/v1/content/files/",
          )
        )
          fileErrors.push(message.text());
      });
      await f.page.route(
        (url) =>
          url.pathname in previewItems ||
          url.pathname.startsWith("/v1/content/files/"),
        (route) => {
          const { pathname } = new URL(route.request().url());
          const item = previewItems[pathname];
          if (item)
            return route.fulfill({
              json: {
                items: [
                  {
                    ...item,
                    item_id: item.name,
                    logical_key: `local:${item.kind}:${item.name}`,
                    description: null,
                    source: "local",
                    editable: true,
                    dependencies: [],
                    revision_sha256: "r1",
                  },
                ],
                next_cursor: null,
                query: {},
              },
            });
          return pathname.endsWith("-manifest")
            ? route.fulfill({ json: {} })
            : route.fulfill({ contentType: "image/png", body: PNG });
        },
      );
      try {
        const previewsLoaded =
          offered === false
            ? null
            : Promise.all(
                [
                  "/v1/content/files/sparks-texture?variant=thumbnail",
                  "/v1/content/files/sky-image?variant=thumbnail",
                  "/v1/content/files/sparks-manifest",
                ].map((path) =>
                  f.page.waitForRequest((request) =>
                    request.url().endsWith(path),
                  ),
                ),
              );
        await f.visit("/library?section=fx");
        const tiles = {
          Sparks: "lucide-sparkles",
          Sky: "lucide-layers",
        };
        for (const name of Object.keys(tiles))
          await f.page.getByRole("article", { name, exact: true }).waitFor();
        if (previewsLoaded) await previewsLoaded;
        else {
          // No tile has an image, so nothing can start loading later either.
          for (const [name, icon] of Object.entries(tiles)) {
            const tile = f.page.getByRole("article", { name, exact: true });
            assert.equal(await tile.locator("img").count(), 0, name);
            assert.equal(await tile.locator(`svg.${icon}`).count(), 1, name);
          }
          await f.page.evaluate(
            () =>
              new Promise((done) =>
                requestAnimationFrame(() => requestAnimationFrame(done)),
              ),
          );
          assert.deepEqual(requested, []);
        }
        assert.deepEqual(fileErrors, []);
      } finally {
        await f.close();
      }
    });
  }
}
