import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer, loadConfigFromFile } from "vite";
import { observeInitialNavigation } from "./fixtures/initial-navigation-diagnostics.mjs";
import { createHostedWorkflowHttp } from "./fixtures/hosted-workflows-http.mjs";
import { BROWSER_STEP_TIMEOUT_MS } from "./fixtures/browser-timeouts.mjs";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const fixture = "tests/fixtures/hosted-composition";
let api, server, browser, origin;
before(async () => {
  api = await createHostedWorkflowHttp({
    workletSource: await readFile(
      path.join(webRoot, "public/tts/audio/pcm-processor.worklet.js"),
    ),
  });
  const shared = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    path.join(webRoot, "vite.config.ts"),
  );
  server = await createServer({
    configFile: false,
    root: webRoot,
    publicDir: false,
    logLevel: "error",
    cacheDir: path.join(webRoot, "node_modules/.vite/hosted-workflows-tests"),
    define: {
      __ANIMAMA_DEV_BUILD__: "false",
      __ANIMAMA_APP_VERSION__: '"fixture"',
      __CLIENT_PARAKEET_MODELS__: JSON.stringify({
        source: "asset-store",
        baseUrl: "/onnx/models/parakeet",
        webgpuBaseUrl: "/onnx/models/parakeet-webgpu",
      }),
    },
    optimizeDeps: { entries: [path.join(webRoot, fixture, "main.tsx")] },
    resolve: shared.config.resolve,
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: {
        "/v1": { target: api.url, ws: true },
        "/tts/audio": { target: api.url },
        "/api/cloud/auth": { target: api.url },
      },
      fs: {
        allow: [path.resolve(webRoot, "../../.."), path.resolve(webRoot, "..")],
      },
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

const fixtureUrl = (route = "/") =>
  `${origin}/${fixture}/index.html?workflows=1&route=${encodeURIComponent(route)}`;
async function mount(route = "/", owner, { waitForSettings = true } = {}) {
  const admission = api.admit(owner),
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (cause) => errors.push(cause.message));
  page.setDefaultTimeout(BROWSER_STEP_TIMEOUT_MS);
  await page.context().addCookies([
    {
      name: "fixture_session",
      value: admission.cookie,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await observeInitialNavigation({
    page,
    ownedContext: page.context(),
    navigate: () => page.goto(fixtureUrl(route)),
    ready: () =>
      page.waitForFunction(
        (waitForSettings) =>
          window.workflowFixture &&
          (!waitForSettings || !window.workflowFixture.settings.isLoading),
        waitForSettings,
        { timeout: BROWSER_STEP_TIMEOUT_MS },
      ),
  });
  return { page, errors, ...admission };
}
async function invoke(page, name, options = {}) {
  return page.evaluate(
    async ({ name, options }) => {
      const { sdk, client } = window.workflowFixture;
      const result = await sdk[name]({
        client,
        requestValidator: undefined,
        responseValidator: undefined,
        throwOnError: false,
        ...options,
      });
      return {
        data: result.data,
        error: result.error,
        status: result.response?.status,
      };
    },
    { name, options },
  );
}
function assertAuthority(owner) {
  const calls = api.calls.filter((call) => call.owner === owner);
  assert.equal(
    calls.some((call) =>
      /bootstrap|installation|\/v1\/runtime-context$/.test(call.path),
    ),
    false,
  );
  assert.equal(
    calls
      .filter((call) => !["GET", "HEAD"].includes(call.method))
      .every(
        (call) =>
          (call.path === "/api/cloud/auth/login" || call.csrf) &&
          call.origin === origin,
      ),
    true,
  );
}

const savedPreferences = {
  chat: { default_model_provider_id: "saved-chat-model" },
  models: {
    utility_model_provider_id: "saved-utility-model",
    memory_manager_model_provider_id: "saved-memory-model",
    embedding_model_provider_id: "saved-embedding-model",
  },
  speech: { tts_enabled: false, mic_sensitivity: "normal" },
  presentation: { render_markdown: false },
  futurePreference: { retained: "owner choice" },
};
function settingsWrites(owner) {
  return api.calls.filter(
    (call) =>
      call.owner === owner &&
      call.path === "/v1/users/me/settings" &&
      call.method === "PATCH",
  );
}
async function startPreferenceSave(page, patch) {
  await page.evaluate((patch) => {
    window.preferenceSaveResult = null;
    window.preferenceSave = window.workflowFixture.settings
      .updateUserPreferences(patch)
      .then(
        (settings) => ({ status: "saved", preferences: settings?.preferences }),
        (cause) => ({ status: "failed", code: cause?.detail?.code }),
      )
      .then((result) => (window.preferenceSaveResult = result));
  }, patch);
}
async function assertPreferenceSavePending(page) {
  await page.waitForFunction(() => window.workflowFixture?.settings.isUpdating);
  assert.equal(
    await page.getByLabel("App preference save status").textContent(),
    "Saving",
  );
  assert.equal(await page.evaluate(() => window.preferenceSaveResult), null);
}

test("hosted settings hooks persist retained groups, explicit false and Anima inheritance across a fresh entry", async () => {
  const { page, owner, errors } = await mount();
  await page.getByText("Your Animas will appear here").waitFor();
  const preferences = {
    chat: { default_model_provider_id: "fixture-model" },
    appearance: { dark: { accent: "#ff6600" } },
    presentation: {
      render_markdown: false,
      disable_animation: true,
      disable_vfx: false,
    },
    speech: {
      tts_enabled: false,
      tts_provider: "browser",
      stt_provider: "browser_external",
      mic_sensitivity: "normal",
    },
    emotion: { disable_influence: true, disable_updates: false },
    memory: { disable_influence: false, disable_updates: true },
    safety: { crisis_resource_region: "CA", reminder_hours: 0.5 },
    models: {
      utility_model_provider_id: "fixture-model",
      memory_manager_model_provider_id: "fixture-model",
      embedding_model_provider_id: "fixture-model",
    },
  };
  await page.evaluate(
    (preferences) =>
      window.workflowFixture.settings.updateUserSettings({
        theme: "dark",
        preferences,
      }),
    preferences,
  );
  await page.evaluate(() =>
    window.workflowFixture.settings.updateAnimaPreferences({
      memory: { disable_updates: false },
      emotion: { disable_influence: false },
    }),
  );
  await page.goto(fixtureUrl());
  await page.waitForFunction(
    () => window.workflowFixture?.settings.userSettings?.theme === "dark",
  );
  const saved = await page.evaluate(() => ({
    user: window.workflowFixture.settings.userPreferences,
    anima: window.workflowFixture.settings.animaPreferences,
    effective: window.workflowFixture.settings.effectivePreferences,
  }));
  assert.deepEqual(saved.user, preferences);
  assert.equal(saved.effective.memory.disable_updates, false);
  assert.equal(saved.effective.emotion.disable_influence, false);
  assert.equal(saved.anima.speech, undefined);
  const profile = await invoke(page, "updateUserProfileV1UsersMeProfilePatch", {
    body: { display_name: "Kept account name" },
  });
  assert.equal(profile.status, 200);
  await invoke(page, "deleteUserSettingsV1UsersMeSettingsDelete");
  await page.goto(fixtureUrl());
  await page.waitForFunction(
    () => window.workflowFixture && !window.workflowFixture.settings.isLoading,
  );
  assert.deepEqual(
    await page.evaluate(() => window.workflowFixture.settings.userPreferences),
    {},
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.workflowFixture.settings.animaPreferences.memory.disable_updates,
    ),
    false,
  );
  await page.getByText("Kept account name", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assertAuthority(owner);
  await page.close();
});

test("preference saves surface failed initial and fresh reads without writes, then preserve saved choices on retry", async (t) => {
  for (const initialFailure of [true, false]) {
    await t.test(
      initialFailure ? "initial read failed" : "fresh read failed",
      async () => {
        const admitted = api.admit();
        admitted.state.settings.preferences = structuredClone(savedPreferences);
        admitted.state.settingsReadFailure = initialFailure;
        const { page, state, owner, errors } = await mount("/", admitted.owner);
        try {
          if (initialFailure) {
            assert.equal(
              await page.evaluate(
                () => window.workflowFixture.settings.userPreferences,
              ),
              null,
            );
          }
          state.settingsReadFailure = true;
          await startPreferenceSave(page, {
            speech: { mic_sensitivity: "high" },
          });
          const outcome = await page.evaluate(() => window.preferenceSave);
          assert.deepEqual(outcome, {
            status: "failed",
            code: "fixture_settings_read_failed",
          });
          assert.equal(settingsWrites(owner).length, 0);
          assert.deepEqual(state.settings.preferences, savedPreferences);
          await page.waitForFunction(
            () => !window.workflowFixture.settings.isUpdating,
          );
          assert.equal(
            await page.getByLabel("App preference save status").textContent(),
            "Idle",
          );
          state.settingsReadFailure = false;
          await startPreferenceSave(page, {
            speech: { mic_sensitivity: "high" },
          });
          const expected = {
            ...savedPreferences,
            speech: { ...savedPreferences.speech, mic_sensitivity: "high" },
          };
          assert.deepEqual(await page.evaluate(() => window.preferenceSave), {
            status: "saved",
            preferences: expected,
          });
          assert.deepEqual(state.settings.preferences, expected);
          await page.goto(fixtureUrl());
          await page.waitForFunction(
            () =>
              window.workflowFixture &&
              !window.workflowFixture.settings.isLoading,
          );
          assert.deepEqual(
            await page.evaluate(
              () => window.workflowFixture.settings.userPreferences,
            ),
            expected,
          );
          assert.deepEqual(errors, []);
          assertAuthority(owner);
        } finally {
          await page.close();
        }
      },
    );
  }
});

test("preference saves wait for the unfinished initial read and expose pending state without losing stored choices", async () => {
  const admitted = api.admit();
  admitted.state.settings.preferences = structuredClone(savedPreferences);
  const held = api.holdSettingsRead(admitted.owner);
  const { page, state, owner, errors } = await mount("/", admitted.owner, {
    waitForSettings: false,
  });
  try {
    await held.started;
    assert.equal(
      await page.evaluate(() => window.workflowFixture.settings.isLoading),
      true,
    );
    await startPreferenceSave(page, { speech: { mic_sensitivity: "high" } });
    await assertPreferenceSavePending(page);
    assert.equal(settingsWrites(owner).length, 0);
    held.release();
    const expected = {
      ...savedPreferences,
      speech: { ...savedPreferences.speech, mic_sensitivity: "high" },
    };
    assert.deepEqual(await page.evaluate(() => window.preferenceSave), {
      status: "saved",
      preferences: expected,
    });
    assert.deepEqual(state.settings.preferences, expected);
    await page.waitForFunction(
      () => !window.workflowFixture.settings.isUpdating,
    );
    assert.equal(
      await page.getByLabel("App preference save status").textContent(),
      "Idle",
    );
    assert.deepEqual(errors, []);
    assertAuthority(owner);
  } finally {
    held.release();
    await page.close();
  }
});

test("preference saves read current durable choices rather than a stale cached object and stay pending through that read", async () => {
  const admitted = api.admit();
  admitted.state.settings.preferences = structuredClone(savedPreferences);
  const { page, state, owner, errors } = await mount("/", admitted.owner);
  const latest = {
    ...savedPreferences,
    chat: { default_model_provider_id: "latest-chat-model" },
    models: {
      ...savedPreferences.models,
      utility_model_provider_id: "latest-utility-model",
    },
    futurePreference: { retained: "updated in another view" },
  };
  state.settings.preferences = structuredClone(latest);
  const held = api.holdSettingsRead(owner);
  try {
    await startPreferenceSave(page, { speech: { mic_sensitivity: "high" } });
    await held.started;
    await assertPreferenceSavePending(page);
    assert.equal(settingsWrites(owner).length, 0);
    held.release();
    const expected = {
      ...latest,
      speech: { ...latest.speech, mic_sensitivity: "high" },
    };
    assert.deepEqual(await page.evaluate(() => window.preferenceSave), {
      status: "saved",
      preferences: expected,
    });
    assert.deepEqual(state.settings.preferences, expected);
    await page.goto(fixtureUrl());
    await page.waitForFunction(
      () =>
        window.workflowFixture && !window.workflowFixture.settings.isLoading,
    );
    assert.deepEqual(
      await page.evaluate(
        () => window.workflowFixture.settings.userPreferences,
      ),
      expected,
    );
    assert.deepEqual(errors, []);
    assertAuthority(owner);
  } finally {
    held.release();
    await page.close();
  }
});

test("preference fresh reads cannot write or publish late choices after session replacement", async (t) => {
  for (const sameOwner of [true, false]) {
    await t.test(
      sameOwner ? "same-owner reauthentication" : "another owner",
      async () => {
        const admitted = api.admit();
        admitted.state.settings.preferences = structuredClone(savedPreferences);
        const { page, state, owner, errors } = await mount("/", admitted.owner);
        const key = await page.evaluate(() => window.workflowFixture.key);
        const held = api.holdSettingsRead(owner);
        try {
          await startPreferenceSave(page, {
            speech: { mic_sensitivity: "high" },
          });
          await held.started;
          await assertPreferenceSavePending(page);
          await page.evaluate(() => window.hostedFixture.signOut());
          await page.waitForFunction(() => !window.workflowFixture);
          assert.equal(
            (await page.evaluate(() => window.preferenceSave)).status,
            "failed",
          );
          const next = api.admit(sameOwner ? owner : undefined);
          const nextPreferences = {
            ...savedPreferences,
            chat: { default_model_provider_id: "replacement-session-model" },
            futurePreference: { retained: "replacement choices" },
          };
          next.state.settings.preferences = structuredClone(nextPreferences);
          await page.context().addCookies([
            {
              name: "fixture_session",
              value: next.cookie,
              url: origin,
              httpOnly: true,
              sameSite: "Lax",
            },
          ]);
          await page.evaluate(() => window.hostedFixture.reauthenticate());
          await page.waitForFunction(
            (oldKey) =>
              window.workflowFixture &&
              window.workflowFixture.key !== oldKey &&
              !window.workflowFixture.settings.isLoading,
            key,
          );
          held.release();
          await held.completed;
          assert.equal(settingsWrites(owner).length, 0);
          assert.equal(settingsWrites(next.owner).length, 0);
          assert.deepEqual(next.state.settings.preferences, nextPreferences);
          assert.deepEqual(
            state.settings.preferences,
            sameOwner ? nextPreferences : savedPreferences,
          );
          assert.deepEqual(
            await page.evaluate(
              () => window.workflowFixture.settings.userPreferences,
            ),
            nextPreferences,
          );
          await startPreferenceSave(page, {
            presentation: { render_markdown: true },
          });
          const expected = {
            ...nextPreferences,
            presentation: { render_markdown: true },
          };
          assert.deepEqual(await page.evaluate(() => window.preferenceSave), {
            status: "saved",
            preferences: expected,
          });
          assert.deepEqual(next.state.settings.preferences, expected);
          await page.goto(fixtureUrl());
          await page.waitForFunction(
            () =>
              window.workflowFixture &&
              !window.workflowFixture.settings.isLoading,
          );
          assert.deepEqual(
            await page.evaluate(
              () => window.workflowFixture.settings.userPreferences,
            ),
            expected,
          );
          assert.deepEqual(errors, []);
          assertAuthority(owner);
          assertAuthority(next.owner);
        } finally {
          held.release();
          await page.close();
        }
      },
    );
  }
});

test("existing Anima identity, emotion and relationship repair use the admitted client and survive reentry", async () => {
  const { page, state, owner, errors } = await mount();
  const updated = await page.evaluate(() =>
    window.workflowFixture.identity.update({
      animaId: "fixture-anima",
      body: {
        expected_aggregate_revision: 1,
        anima: {
          display_name: "Kept Anima",
          metadata: { profile: "Retained profile" },
        },
      },
    }),
  );
  assert.equal(updated.display_name, "Kept Anima");
  assert.equal(updated.aggregate_revision, 2);
  await page.evaluate(() =>
    window.workflowFixture.identity.emotion({
      animaId: "fixture-anima",
      body: { joy: 5 },
    }),
  );
  assert.equal(
    await page.evaluate(
      () => window.workflowFixture.identity.snapshot().emotional_state.joy,
    ),
    5,
  );
  const repair = () =>
    page.evaluate(() =>
      window.workflowFixture.identity.repair({ animaId: "fixture-anima" }),
    );
  const first = await repair(),
    repeated = await repair();
  assert.equal(first.id, repeated.id);
  assert.equal(state.entries.size, 1);
  const stale = await invoke(page, "patchAnimaV1AnimasAnimaIdPatch", {
    path: { anima_id: "fixture-anima" },
    body: {
      expected_aggregate_revision: 1,
      anima: { display_name: "Stale overwrite" },
    },
  });
  assert.equal(stale.status, 409);
  await page.goto(fixtureUrl());
  await page.waitForFunction(
    () => window.workflowFixture && !window.workflowFixture.settings.isLoading,
  );
  const reloaded = await invoke(page, "getAnimaV1AnimasAnimaIdGet", {
    path: { anima_id: "fixture-anima" },
  });
  assert.equal(reloaded.data.display_name, "Kept Anima");
  assert.equal(reloaded.data.metadata.profile, "Retained profile");
  const foreign = await mount();
  const theirAnima = await invoke(foreign.page, "getAnimaV1AnimasAnimaIdGet", {
    path: { anima_id: "fixture-anima" },
  });
  assert.notEqual(theirAnima.data.display_name, "Kept Anima");
  const relationship = await invoke(
    foreign.page,
    "getMemoryEntryV1MemoryEntriesEntryIdGet",
    { path: { entry_id: first.id } },
  );
  assert.equal(relationship.status, 404);
  assertAuthority(owner);
  assert.deepEqual(errors, []);
  await foreign.page.close();
  await page.close();
});

test("saved voice clone hooks preserve original bytes at quota, rename through admitted files and reject stale changes", async () => {
  const { page, state, owner, errors } = await mount();
  await page.evaluate(() => {
    window.cloneDraft = {
      entryName: "kept-voice",
      operationId: crypto.randomUUID(),
      descriptor: {
        schema_version: 1,
        content_type: "voice",
        content_id: "local:voice:fixture",
        codec: "pocket-tts-catalog-v1",
        name: "Kept voice",
        voices: ["neutral"],
        provenance: { encoder: "pocket-tts", format_version: 1 },
        files: [
          { path: "original.wav", role: "source_sample" },
          { path: "voice.bin", role: "pocket_voice_catalog" },
        ],
      },
      files: [
        new File(["original recording"], "original.wav", { type: "audio/wav" }),
        new File(["encoded voice"], "voice.bin"),
      ],
    };
  });
  state.quota = true;
  const denied = await page.evaluate(async () => {
    try {
      await window.workflowFixture.clones.save(window.cloneDraft);
    } catch (cause) {
      return {
        status: cause.status,
        code: cause.code,
        original: await window.cloneDraft.files[0].text(),
      };
    }
  });
  assert.deepEqual(denied, {
    status: 429,
    code: "quota_exceeded",
    original: "original recording",
  });
  state.quota = false;
  const saved = await page.evaluate(() =>
    window.workflowFixture.clones.save(window.cloneDraft),
  );
  assert.equal(saved.codec, "pocket-tts-catalog-v1");
  const replay = await page.evaluate(() =>
    window.workflowFixture.clones.save(window.cloneDraft),
  );
  assert.equal(replay.item_id, saved.item_id);
  assert.equal(state.items.size, 1);
  const renamed = await page.evaluate(
    (clone) =>
      window.workflowFixture.clones.rename({ clone, name: "Renamed voice" }),
    saved,
  );
  assert.equal(renamed.item_id, saved.item_id);
  assert.equal(renamed.name, "Renamed voice");
  assert.deepEqual(
    [...state.files.values()].map((file) => file.bytes.toString()),
    ["original recording", "encoded voice"],
  );
  const stale = await page.evaluate(async (clone) => {
    try {
      await window.workflowFixture.clones.rename({
        clone,
        name: "Stale rename",
      });
    } catch (cause) {
      return { status: cause.status, code: cause.code };
    }
  }, saved);
  assert.deepEqual(stale, { status: 409, code: "catalog_revision_conflict" });
  const foreign = await mount();
  const privateFile = await invoke(
    foreign.page,
    "streamContentFileV1ContentFilesFileRefGet",
    { path: { file_ref: renamed.files[0].file_ref }, parseAs: "blob" },
  );
  assert.equal(privateFile.status, 404);
  await page.evaluate(
    (clone) => window.workflowFixture.clones.remove(clone),
    renamed,
  );
  assert.equal(state.items.size, 0);
  assert.equal(state.files.size, 0);
  assert.equal(state.anima.primary_voice, undefined);
  assert.deepEqual(errors, []);
  assertAuthority(owner);
  await foreign.page.close();
  await page.close();
});

test("a lost creator save reply survives an actual reload and reconciles the same operation", async () => {
  const { page, state } = await mount();
  try {
    state.lostSave = true;
    const original = await page.evaluate(async () => {
      const operationId = crypto.randomUUID();
      const form = {
        kind: "pose",
        entryName: "Reload recovered pose",
        fileName: "pose.json",
        text: "original draft bytes",
      };
      window.hostedFixture.persistDraft(operationId, form);
      try {
        const f = window.workflowFixture;
        await f.saveCatalogItem(f.client, {
          kind: form.kind,
          entryName: form.entryName,
          operationId,
          files: [new File([form.text], form.fileName)],
        });
      } catch (cause) {
        return {
          operationId,
          status: cause.status,
          key: window.hostedFixture.current().key,
        };
      }
      throw new Error("The fixture must lose the first committed reply");
    });
    assert.equal(original.status, 502);
    assert.equal(state.saves.size, 1);
    const committed = state.saves.get(original.operationId);
    await page.route(`${origin}/`, async (route) => {
      if (!route.request().isNavigationRequest()) return route.fallback();
      const response = await route.fetch({ url: fixtureUrl() });
      const html = (await response.text())
        .replace('src="./main.tsx"', `src="/${fixture}/main.tsx"`)
        .replace(
          "<head>",
          '<head><script>history.replaceState(null, "", "/?workflows=1")</script>',
        );
      await route.fulfill({ response, body: html });
    });
    await page.reload();
    await page.waitForFunction(
      () =>
        window.workflowFixture && !window.workflowFixture.settings.isLoading,
    );
    const recovered = await page.evaluate(async () => {
      const draft = window.hostedFixture.draft();
      const f = window.workflowFixture;
      const result = await f.saveCatalogItem(f.client, {
        kind: draft.form.kind,
        entryName: draft.form.entryName,
        operationId: draft.operationId,
        files: [new File([draft.form.text], draft.form.fileName)],
      });
      return {
        key: window.hostedFixture.current().key,
        operationId: draft.operationId,
        result,
      };
    });
    assert.equal(recovered.key, original.key);
    assert.equal(recovered.operationId, original.operationId);
    assert.equal(recovered.result.item_id, committed.item_id);
    assert.equal(state.saves.size, 1);
    assert.equal(state.items.size, 1);
  } finally {
    await page.close();
  }
});

test("all typed content families save through admitted HTTP, preserve drafts at quota, replay a lost reply and verify private preview bytes", async () => {
  const { page, state, owner, errors } = await mount();
  const kinds = [
    "avatar",
    "appearance",
    "gesture",
    "pose",
    "reaction",
    "idle_style",
    "particle_effect",
    "avatar_effect",
    "scene_effect",
    "sound_effect",
    "voice",
  ];
  for (const kind of kinds) {
    const saved = await page.evaluate(async (kind) => {
      const f = window.workflowFixture;
      return f.saveCatalogItem(f.client, {
        kind,
        entryName: `Fixture ${kind}`,
        files: [new File(["fixture"], "content.json")],
        operationId: crypto.randomUUID(),
      });
    }, kind);
    assert.equal(saved.kind, kind);
    assert.equal(saved.editable, true);
  }
  assert.equal(state.items.size, 11);
  state.quota = true;
  const quota = await page.evaluate(async () => {
    const f = window.workflowFixture;
    window.creatorDraft = {
      kind: "pose",
      entryName: "Kept draft",
      files: [new File(["private draft"], "pose.json")],
      operationId: crypto.randomUUID(),
    };
    try {
      await f.saveCatalogItem(f.client, window.creatorDraft);
    } catch (cause) {
      return {
        status: cause.status,
        code: cause.code,
        draft: await window.creatorDraft.files[0].text(),
      };
    }
  });
  assert.deepEqual(quota, {
    status: 429,
    code: "quota_exceeded",
    draft: "private draft",
  });
  state.quota = false;
  state.lostSave = true;
  const uncertain = await page.evaluate(async () => {
    const f = window.workflowFixture;
    try {
      await f.saveCatalogItem(f.client, window.creatorDraft);
    } catch (cause) {
      return { name: cause.name, status: cause.status, message: cause.message };
    }
  });
  assert.equal(uncertain.name, "ContentSaveApiError");
  // The real reverse proxy converts its upstream disconnect to a 502. Either
  // that response or a browser fetch rejection leaves the receipt uncertain.
  assert.equal(uncertain.status, 502);
  assert.match(uncertain.message, /draft is preserved/);
  const count = state.items.size;
  const replay = await page.evaluate(() =>
    window.workflowFixture.saveCatalogItem(
      window.workflowFixture.client,
      window.creatorDraft,
    ),
  );
  assert.equal(state.items.size, count);
  assert.equal(replay.name, "Kept draft");
  const preview = await page.evaluate(async (id) => {
    const f = window.workflowFixture,
      result = await f.previewTypedCatalogItem(f.client, "pose", id);
    const loader = new f.VerifiedByteLoader(),
      file = result.files[0];
    const verified = await loader.load(file);
    try {
      await loader.load({
        ...file,
        file_ref: `${id}-bad-hash`,
        url: `/v1/content/files/${id}-bad-hash`,
      });
    } catch (cause) {
      return { text: await verified.blob.text(), code: cause.code };
    }
  }, replay.item_id);
  assert.equal(preview.text, `${owner} private preview`);
  assert.equal(preview.code, "digest_mismatch");
  await page.goto(fixtureUrl("/library"));
  await page.getByRole("heading", { name: "Library", exact: true }).waitFor();
  await page.getByText("Kept draft", { exact: true }).first().waitFor();
  // Remove only items created in this disposable owner's fixture inventory.
  for (const item of [...state.items.values()])
    await page.evaluate(
      ({ id, revision }) =>
        window.workflowFixture.deleteCatalogItem(
          window.workflowFixture.client,
          id,
          revision,
        ),
      { id: item.item_id, revision: item.revision_sha256 },
    );
  assert.equal(state.items.size, 0);
  assert.deepEqual(errors, []);
  assertAuthority(owner);
  await page.close();
});

test("a Library import resolves its lost commit receipt after a real same-tab reload without repeating installation", async () => {
  const { page, state, owner, errors } = await mount("/library");
  state.lostCommit = true;
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Choose .zip file").setInputFiles({
    name: "fixture.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("fixture zip!"),
  });
  await page
    .getByRole("heading", { name: "Review import", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Import 1 item", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Import status", exact: true })
    .waitFor();
  const before = api.calls.filter(
    (call) => call.owner === owner && call.path.endsWith("/commit"),
  ).length;
  const originalKey = await page.evaluate(
    () => window.hostedFixture.current().key,
  );
  // A reload restores this tab's receipt; ordinary navigation starts a fresh namespace.
  await page.route(`${origin}/library`, async (route) => {
    if (!route.request().isNavigationRequest()) return route.fallback();
    const response = await route.fetch({ url: fixtureUrl("/library") });
    const html = (await response.text())
      .replace('src="./main.tsx"', `src="/${fixture}/main.tsx"`)
      .replace(
        "<head>",
        '<head><script>history.replaceState(null, "", "/library?workflows=1&route=%2Flibrary")</script>',
      );
    await route.fulfill({ response, body: html });
  });
  await page.reload();
  await page.waitForFunction(
    () => window.workflowFixture && !window.workflowFixture.settings.isLoading,
  );
  assert.equal(
    await page.evaluate(() => window.hostedFixture.current().key),
    originalKey,
  );
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page
    .getByRole("heading", { name: "Import complete", exact: true })
    .waitFor({ timeout: BROWSER_STEP_TIMEOUT_MS });
  assert.equal(
    api.calls.filter(
      (call) => call.owner === owner && call.path.endsWith("/commit"),
    ).length,
    before,
  );
  assert.equal(before, 1);
  assert.equal(state.operations.size, 1);
  await page
    .getByRole("link", { name: "View in Library", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(state.stages.size, 0);
  assert.deepEqual(errors, []);
  assertAuthority(owner);
  await page.close();
});

test("logical memory edits, conflicts, history and revert remain admitted and isolated from another owner", async () => {
  const a = await mount(),
    b = await mount();
  const create = await invoke(a.page, "createMemoryEntryV1MemoryEntriesPost", {
    body: { type: "file", name: "notes.md", content: "first private note" },
  });
  assert.equal(create.status, 200);
  const id = create.data.id;
  const edit = await invoke(
    a.page,
    "patchMemoryEntryV1MemoryEntriesEntryIdPatch",
    {
      path: { entry_id: id },
      body: {
        expected_version: 1,
        content: "second private note",
        name: "renamed.md",
      },
    },
  );
  assert.equal(edit.data.version, 2);
  const stale = await invoke(
    a.page,
    "patchMemoryEntryV1MemoryEntriesEntryIdPatch",
    { path: { entry_id: id }, body: { expected_version: 1, content: "stale" } },
  );
  assert.equal(stale.status, 409);
  assert.equal(a.state.entries.get(id).content, "second private note");
  const foreign = await invoke(
    b.page,
    "getMemoryEntryV1MemoryEntriesEntryIdGet",
    { path: { entry_id: id } },
  );
  assert.equal(foreign.status, 404);
  const versions = await invoke(
    a.page,
    "listMemoryEntryVersionsV1MemoryEntriesEntryIdVersionsGet",
    { path: { entry_id: id } },
  );
  assert.equal(versions.data.versions.length, 2);
  const revert = await invoke(
    a.page,
    "revertMemoryEntryV1MemoryEntriesEntryIdRevertPost",
    {
      path: { entry_id: id },
      body: { expected_version: 2, target_version: 1 },
    },
  );
  assert.equal(revert.data.content, "first private note");
  await invoke(a.page, "deleteMemoryEntryV1MemoryEntriesEntryIdDelete", {
    path: { entry_id: id },
  });
  assert.equal(a.state.entries.size, 0);
  assert.equal(b.state.entries.size, 0);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  assertAuthority(a.owner);
  assertAuthority(b.owner);
  await a.page.close();
  await b.page.close();
});

test("same-owner reauthentication fences the old admitted client and cross-owner entry cannot read private catalog bytes", async () => {
  const a = await mount();
  const privateItem = await a.page.evaluate(async () => {
    const f = window.workflowFixture;
    return f.saveCatalogItem(f.client, {
      kind: "pose",
      entryName: "Owner private pose",
      files: [new File(["private"], "pose.json")],
      operationId: crypto.randomUUID(),
    });
  });
  const oldKey = await a.page.evaluate(() => {
    window.oldWorkflowClient = window.workflowFixture.client;
    return window.workflowFixture.key;
  });
  await a.page.evaluate(() => {
    window.pendingPrivateRead = window.oldWorkflowClient
      .get({ url: "/v1/content/items/fixture-pending", throwOnError: true })
      .then(
        () => "late",
        (cause) => cause.name,
      );
  });
  await a.page.evaluate(() => window.hostedFixture.signOut());
  await a.page.waitForFunction(() => !window.workflowFixture);
  assert.equal(
    await a.page.evaluate(() => window.pendingPrivateRead),
    "AbortError",
  );
  const read = await a.page.evaluate(async () => {
    try {
      await window.oldWorkflowClient.get({
        url: "/v1/content/items/fixture-pending",
        throwOnError: true,
      });
      return "late";
    } catch (cause) {
      return cause.name;
    }
  });
  assert.equal(read, "AbortError");
  const next = api.admit(a.owner);
  await a.page.context().addCookies([
    {
      name: "fixture_session",
      value: next.cookie,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await a.page.goto(fixtureUrl());
  await a.page.waitForFunction(() => window.workflowFixture);
  assert.notEqual(
    await a.page.evaluate(() => window.workflowFixture.key),
    oldKey,
  );
  const b = await mount();
  assert.notEqual(
    await b.page.evaluate(() => window.workflowFixture.key),
    oldKey,
  );
  const foreign = await b.page.evaluate(async (id) => {
    try {
      await window.workflowFixture.previewTypedCatalogItem(
        window.workflowFixture.client,
        "pose",
        id,
      );
    } catch (cause) {
      return cause.detail?.code;
    }
  }, privateItem.item_id);
  assert.equal(foreign, "content_not_found");
  const foreignBytes = await b.page.evaluate(async (id) => {
    const result = await window.workflowFixture.client.get({
      url: `/v1/content/files/${id}-good`,
      throwOnError: false,
    });
    return {
      status: result.response?.status,
      code: result.error?.detail?.code,
    };
  }, privateItem.item_id);
  assert.deepEqual(foreignBytes, {
    status: 404,
    code: "content_file_not_found",
  });
  await a.page.evaluate(
    ({ id, revision }) =>
      window.workflowFixture.deleteCatalogItem(
        window.workflowFixture.client,
        id,
        revision,
      ),
    { id: privateItem.item_id, revision: privateItem.revision_sha256 },
  );
  assert.equal(a.state.items.size, 0);
  assert.equal(b.state.items.size, 0);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  assertAuthority(a.owner);
  assertAuthority(b.owner);
  await a.page.close();
  await b.page.close();
});

test("each loadout family reviews the current revision, rejects stale commits and replays one authoritative commit", async () => {
  const { page, state, owner, errors } = await mount();
  const contracts = [
    [
      "avatar",
      "planAvatar",
      "commitAvatar",
      { operation: "remove", config: {} },
    ],
    ["voice", "planVoice", "commitVoice", { operation: "remove", config: {} }],
    [
      "gestures",
      "planGestureV1AnimasAnimaIdGesturesPlanPost",
      "commitGestureV1AnimasAnimaIdGesturesCommitPost",
      { operation: "remove", binding_id: "fixture-binding" },
    ],
    [
      "reactions",
      "planReactionV1AnimasAnimaIdReactionsPlanPost",
      "commitReactionV1AnimasAnimaIdReactionsCommitPost",
      { operation: "remove", binding_id: "fixture-binding" },
    ],
    [
      "idle-style",
      "planIdleStyleV1AnimasAnimaIdIdleStylePlanPost",
      "commitIdleStyleV1AnimasAnimaIdIdleStyleCommitPost",
      { operation: "remove" },
    ],
    [
      "appearance",
      "planAppearanceV1AnimasAnimaIdAppearancePlanPost",
      "commitAppearanceV1AnimasAnimaIdAppearanceCommitPost",
      { operation: "remove", use: "background" },
    ],
  ];
  for (const [family, planName, commitName, intent] of contracts) {
    const body = { expected_revision: state.revision, intent },
      path = { anima_id: "fixture-anima" };
    const reviewed = await invoke(page, planName, { path, body });
    assert.equal(reviewed.status, 200);
    state.revision++;
    const stale = await invoke(page, commitName, {
      path,
      body: {
        ...body,
        plan_digest: reviewed.data.plan_digest,
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(stale.status, 409);
    const revision = state.revision;
    const fresh = await invoke(page, planName, {
      path,
      body: { ...body, expected_revision: revision },
    });
    const commitBody = {
      expected_revision: revision,
      intent,
      plan_digest: fresh.data.plan_digest,
      idempotency_key: crypto.randomUUID(),
    };
    const committed = await invoke(page, commitName, {
      path,
      body: commitBody,
    });
    assert.equal(committed.data.action, family);
    assert.equal(committed.data.aggregate_revision, revision + 1);
    const replay = await invoke(page, commitName, { path, body: commitBody });
    assert.deepEqual(replay.data, committed.data);
    assert.equal(state.revision, revision + 1);
  }
  // Exercise the existing React mutation binding, with its request validators and invalidations.
  const selected = await page.evaluate(
    (revision) =>
      window.workflowFixture.voice({ clone: null, expectedRevision: revision }),
    state.revision,
  );
  assert.equal(selected.aggregate_revision, state.revision);
  const appearance = await page.evaluate(async (revision) => {
    const mutations = window.workflowFixture.loadout,
      intent = { operation: "remove", use: "background" };
    const plan = await mutations.planAppearance.mutateAsync({
      expected_revision: revision,
      intent,
    });
    return mutations.commitAppearance.mutateAsync({
      expected_revision: revision,
      intent,
      plan_digest: plan.plan_digest,
      idempotency_key: crypto.randomUUID(),
    });
  }, state.revision);
  assert.equal(appearance.aggregate_revision, state.revision);
  assert.deepEqual(errors, []);
  assertAuthority(owner);
  await page.close();
});

test("the shared chat session retains quota-failed text, retries once and reloads owner-scoped history", async () => {
  const { page, state, owner, errors } = await mount();
  await page.waitForFunction(() => window.workflowFixture.chat.canChat);
  state.chatQuota = true;
  await page.evaluate(async () => {
    const chat = window.workflowFixture.chat;
    chat.setInput("Preserved quota draft");
    await chat.handleSubmitText({
      text: "Preserved quota draft",
      clearInput: true,
    });
  });
  await page.waitForFunction(() => !window.workflowFixture.chat.isStreaming);
  const failed = await page.evaluate(
    () => window.workflowFixture.chat.displayMessages,
  );
  assert.equal(
    failed.some((message) => message.text === "Preserved quota draft"),
    true,
  );
  assert.equal([...state.messages.values()].flat().length, 0);
  state.chatQuota = false;
  await page.evaluate(() =>
    window.workflowFixture.chat.restoreFailedMessage("Preserved quota draft"),
  );
  await page.waitForFunction(
    () => window.workflowFixture.chat.input === "Preserved quota draft",
  );
  await page.evaluate(() => window.workflowFixture.chat.handleSubmit());
  await page.waitForFunction(() =>
    window.workflowFixture.chat.displayMessages.some(
      (message) => message.text === "Fixture reply to Preserved quota draft",
    ),
  );
  await page.evaluate(() =>
    window.workflowFixture.chat.handleStreamingAnimationComplete(),
  );
  const chatId = [...state.chats.keys()][0];
  assert.equal(state.messages.get(chatId).length, 2);
  assert.equal(
    state.lastTurn.client_context.locale,
    await page.evaluate(() => navigator.language),
  );
  await page.goto(fixtureUrl());
  await page.waitForFunction(() => window.workflowFixture);
  const history = await invoke(
    page,
    "listChatMessagesV1ChatsChatIdMessagesGet",
    { path: { chat_id: chatId } },
  );
  assert.equal(
    history.data.messages[1].message,
    "Fixture reply to Preserved quota draft",
  );
  const rename = await invoke(page, "updateChatV1ChatsChatIdPatch", {
    path: { chat_id: chatId },
    body: { title: "Retained history" },
  });
  assert.equal(rename.data.title, "Retained history");
  const search = await invoke(page, "searchChatMessagesV1ChatsSearchPost", {
    body: { query: "quota draft" },
  });
  assert.equal(search.data.results.length, 2);
  const other = await mount();
  assert.equal(
    (
      await invoke(other.page, "getChatV1ChatsChatIdGet", {
        path: { chat_id: chatId },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await invoke(page, "deleteChatV1ChatsChatIdDelete", {
        path: { chat_id: chatId },
      })
    ).status,
    204,
  );
  assert.equal(state.chats.size, 0);
  assert.deepEqual(errors, []);
  assertAuthority(owner);
  await other.page.close();
  await page.close();
});

test("general, Reflection and episode review hooks preserve approval, resume, continuation and undo contracts", async () => {
  const a = await mount(),
    b = await mount();
  for (const kind of ["general", "reflect", "episodes"]) {
    const started = await a.page.evaluate(
      (kind) =>
        window.workflowFixture.manager[kind]({
          body:
            kind === "general"
              ? { message: "Review private logical memory" }
              : kind === "reflect"
                ? { anima_id: "fixture-anima" }
                : {},
        }),
      kind,
    );
    const id = started.run.id,
      approvalId = started.approvals[0].id;
    const snapshot = await a.page.evaluate(
      (id) => window.workflowFixture.managerSnapshot(id),
      id,
    );
    assert.equal(snapshot.run.id, id);
    assert.equal(snapshot.approvals[0].status, "pending");
    const blocked = await a.page.evaluate(async (runId) => {
      try {
        await window.workflowFixture.manager.complete({ runId });
      } catch (cause) {
        return cause.status;
      }
    }, id);
    assert.equal(blocked, 409);
    const current = await invoke(
      a.page,
      "getCurrentMemoryManagerRunV1MemoryManagerRunsCurrentGet",
    );
    assert.equal(current.data.run.id, id);
    const foreign = await invoke(
      b.page,
      "getMemoryManagerRunV1MemoryManagerRunsRunIdGet",
      { path: { run_id: id } },
    );
    assert.equal(foreign.status, 404);
    const continued = await a.page.evaluate(
      (runId) =>
        window.workflowFixture.manager.append({
          runId,
          body: { content: "Keep the existing approval" },
        }),
      id,
    );
    assert.equal(
      continued.messages.at(-1).content,
      "Keep the existing approval",
    );
    const approved = await a.page.evaluate(
      (approvalId) =>
        window.workflowFixture.manager.decide({
          approvalId,
          body: { decision: "approve" },
        }),
      approvalId,
    );
    assert.equal(approved.can_undo, true);
    const undone = await a.page.evaluate(
      (approval) => window.workflowFixture.manager.undo({ approval }),
      approved,
    );
    assert.equal(undone.undo_version, 3);
    const done = await a.page.evaluate(
      (runId) => window.workflowFixture.manager.complete({ runId }),
      id,
    );
    assert.equal(done.run.status, "completed");
    assert.equal(
      await a.page.evaluate(() => window.workflowFixture.currentManager()),
      null,
    );
  }
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  assertAuthority(a.owner);
  assertAuthority(b.owner);
  await a.page.close();
  await b.page.close();
});

test("content and existing Anima export use admitted bytes and release temporary reviews", async () => {
  const { page, state, owner, errors } = await mount();
  for (const selection of [
    { item_ids: ["fixture-item"] },
    { anima_id: "fixture-anima" },
  ]) {
    const exported = await page.evaluate(async (selection) => {
      const f = window.workflowFixture,
        api = f.createPackageExportApi(f.client);
      const summary = await api.summary(
        selection,
        new AbortController().signal,
      );
      const review = await api.prepare(selection, summary.digest);
      const response = await f.client.get({
        url: review.url,
        parseAs: "blob",
        throwOnError: true,
      });
      const content = await response.data.text();
      await api.discard(review.export_id);
      return { content, review };
    }, selection);
    assert.equal(exported.content, "zip!");
    assert.equal(exported.review.size_bytes, 4);
  }
  assert.equal(state.chats.size, 0);
  assert.equal(state.entries.size, 0);
  assert.deepEqual(errors, []);
  assertAuthority(owner);
  await page.close();
});

test("hosted Anima package review explains the narrow exclusion and never sends an install", async () => {
  const { page, state, owner } = await mount("/library");
  state.nextPackageKind = "anima";
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Choose .zip file").setInputFiles({
    name: "anima.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("fixture zip!"),
  });
  await page
    .getByRole("heading", { name: "Review import", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Import 1 item", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByText(
      "Importing an Anima package is unavailable here. Import content or export an existing Anima instead.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    api.calls.filter(
      (call) => call.owner === owner && call.path.endsWith("/commit"),
    ).length,
    0,
  );
  assert.equal(state.items.size, 0);
  assert.equal(state.operations.size, 0);
  await page.close();
});

test("hosted Library failure retries a read while host scan remains guarded", async () => {
  const { page, state, owner, errors } = await mount();
  state.catalogUnavailable = true;
  await page.goto(fixtureUrl("/library"));
  await page
    .getByRole("button", { name: "Content library unavailable", exact: true })
    .click();
  await page
    .getByText("Host file scanning is managed by the operator.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Retry scan", exact: true }).count(),
    0,
  );
  state.catalogUnavailable = false;
  await page
    .getByRole("button", { name: "Retry Library", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Content library unavailable", exact: true })
    .waitFor({ state: "detached" });
  const refusal = await page.evaluate(async () => {
    try {
      await window.workflowFixture.rescan();
    } catch (cause) {
      return cause.message;
    }
  });
  assert.equal(refusal, "Host file scanning is managed by the operator.");
  assert.equal(
    api.calls.filter(
      (call) => call.owner === owner && call.path === "/v1/content:rescan",
    ).length,
    0,
  );
  assert.deepEqual(errors, []);
  await page.close();
});

test("unavailable speech worklet closes its actual Web Audio context and retains text fallback", async () => {
  const { page, errors } = await mount();
  await page.evaluate(() => {
    window.fixtureAudioContexts = [];
    const Original = window.AudioContext;
    window.AudioContext = new Proxy(Original, {
      construct: (ctor, args) => {
        const context = Reflect.construct(ctor, args);
        window.fixtureAudioContexts.push(context);
        return context;
      },
    });
  });
  await page.evaluate(async () => {
    const f = window.workflowFixture;
    const pending = f.speech.startRun("unavailable-speech", {
      animaId: "fixture-anima",
    });
    f.speech.acceptSession("unavailable-speech", {
      transport: "server",
      websocket_url: "/v1/voice/streams/fixture",
      voice_id: "voice",
      model_id: "eleven_v4_turbo",
      output_format: "pcm_24000",
      sync_alignment: true,
    });
    await pending;
  });
  assert.equal(
    await page.evaluate(() => window.fixtureAudioContexts.length),
    1,
  );
  assert.equal(
    await page.evaluate(() => window.fixtureAudioContexts[0].state),
    "closed",
  );
  assert.deepEqual(await page.evaluate(() => window.workflowFixture.warnings), [
    "elevenlabs_start_failed",
  ]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("the retained microphone settings handle actual permission refusal and keep device preferences through sign-out", async () => {
  const { page, state, owner, errors } = await mount();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Browser.setPermission", {
    permission: { name: "microphone" },
    setting: "denied",
    origin,
  });
  await page
    .getByRole("button")
    .filter({ hasText: `${owner} account` })
    .click();
  await page
    .getByRole("menuitem", { name: "App Settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "App Settings",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Voice", exact: true }).click();
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await page
    .getByText("Could not open the microphone.", { exact: true })
    .waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "Test", exact: true }).isEnabled(),
    true,
  );
  await dialog
    .getByRole("combobox", { name: "Microphone sensitivity", exact: true })
    .click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.workflowFixture.settings.userPreferences?.speech
        ?.mic_sensitivity === "high",
  );
  assert.equal(state.settings.preferences.speech.mic_sensitivity, "high");
  await page.evaluate(async () => {
    const prefs = await import("/src/lib/voice/microphone-preferences.ts");
    prefs.writeSelectedMicrophoneId("remembered-fixture-mic");
  });
  await dialog
    .getByRole("button", { name: "Close App Settings", exact: true })
    .click();
  await page.evaluate(() => window.hostedFixture.signOut());
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem("animama.microphone.deviceId"),
    ),
    "remembered-fixture-mic",
  );
  assert.deepEqual(errors, []);
  assertAuthority(owner);
  await page.close();
});

test("server speech opens a cookie-bound same-origin socket with the actual worklet and closes on sign-out", async () => {
  api.setWorkletAvailable(true);
  const { page, owner, errors } = await mount();
  try {
    await page.evaluate(() => {
      window.fixtureSpeechSockets = [];
      window.fixtureSpeechContexts = [];
      window.fixtureSpeechFrames = [];
      const OriginalSocket = window.WebSocket,
        OriginalAudio = window.AudioContext;
      window.WebSocket = new Proxy(OriginalSocket, {
        construct: (ctor, args) => {
          const socket = Reflect.construct(ctor, args),
            send = socket.send.bind(socket);
          socket.send = (frame) => {
            window.fixtureSpeechFrames.push(JSON.parse(frame));
            send(frame);
          };
          window.fixtureSpeechSockets.push(socket);
          return socket;
        },
      });
      window.AudioContext = new Proxy(OriginalAudio, {
        construct: (ctor, args) => {
          const context = Reflect.construct(ctor, args);
          window.fixtureSpeechContexts.push(context);
          return context;
        },
      });
    });
    await page.evaluate(async () => {
      const speech = window.workflowFixture.speech,
        context = { animaId: "fixture-anima" };
      const pending = speech.startRun("server-speech", context);
      speech.acceptSession("server-speech", {
        transport: "server",
        websocket_url: "/v1/voice/streams/fixture",
        voice_id: "voice",
        model_id: "eleven_v4_turbo",
        output_format: "pcm_24000",
        sync_alignment: false,
      });
      speech.appendText("server-speech", "fixture speech", context);
      await pending;
    });
    await page.waitForFunction(() =>
      window.fixtureSpeechFrames.some(
        (frame) => frame.text === "fixture speech",
      ),
    );
    assert.deepEqual(
      api.voiceConnections
        .filter((connection) => connection.owner === owner)
        .map(({ owner: _, ...connection }) => connection),
      [{ origin, path: "/v1/voice/streams/fixture", query: "", closed: false }],
    );
    assert.equal(
      await page.evaluate(() =>
        window.fixtureSpeechFrames.some(
          (frame) => "token" in frame || "xi_api_key" in frame,
        ),
      ),
      false,
    );
    await page.evaluate(() => window.hostedFixture.signOut());
    await page.waitForFunction(
      () =>
        window.fixtureSpeechSockets[0].readyState === WebSocket.CLOSED &&
        window.fixtureSpeechContexts[0].state === "closed",
    );
    assert.deepEqual(errors, []);
    assertAuthority(owner);
  } finally {
    api.setWorkletAvailable(false);
    await page.close();
  }
});
