import assert from "node:assert/strict";
import test from "node:test";
import { createHostedWorkflowHttp } from "./hosted-workflows-http.mjs";

async function fixture(t, enabled = true) {
  const api = await createHostedWorkflowHttp({ localeAuthority: enabled });
  api.setOrigin(api.url);
  t.after(() => api.close());
  const admission = api.admit("locale-owner");
  const cookie = `fixture_session=${admission.cookie}; fixture_locale=ko`;
  const context = await (
    await fetch(api.url + "/v1/hosted/runtime-context", { headers: { cookie } })
  ).json();
  return {
    api,
    admission,
    context,
    request: (method, input, headers = {}) =>
      fetch(api.url + "/v1/users/me/settings", {
        method,
        headers: {
          cookie,
          origin: api.url,
          "content-type": "application/json",
          "x-animama-csrf": context.csrf_token,
          ...headers,
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      }),
  };
}

test("locale authority is opt-in and separates saved, visitor and materialized settings", async (t) => {
  const legacy = await fixture(t, false);
  assert.equal("locale" in legacy.context, false);
  const { api, context, request } = await fixture(t);
  assert.deepEqual(context.locale, { preference: null, visitor: "ko" });
  assert.equal((await (await request("GET")).json()).locale, null);
  api.setLocalePreference("locale-owner", "ja");
  assert.equal((await (await request("GET")).json()).locale, "ja");
  const unrelated = await request("PATCH", { theme: "dark" });
  assert.equal(unrelated.headers.get("set-cookie"), null);
  assert.equal((await unrelated.json()).locale, "ja");
  const cleared = await request("PATCH", { locale: null });
  assert.match(
    cleared.headers.get("set-cookie"),
    /fixture_locale=;.*Max-Age=0/,
  );
  assert.equal((await cleared.json()).locale, null);
  const explicit = await request("PATCH", { locale: "en" });
  assert.match(explicit.headers.get("set-cookie"), /fixture_locale=en;/);
  const reset = await request("DELETE");
  assert.equal((await reset.json()).locale, null);
  assert.match(reset.headers.get("set-cookie"), /Max-Age=0/);
});

test("authority rejects invalid writes and CSRF without changing account or visitor", async (t) => {
  const { api, request } = await fixture(t);
  api.setLocalePreference("locale-owner", "ja");
  for (const [input, headers, status] of [
    [{ locale: "ja-JP" }, {}, 422],
    [{ locale: "en" }, { origin: "https://foreign.invalid" }, 403],
    [{ locale: "en" }, { "x-animama-csrf": "wrong" }, 403],
  ]) {
    const response = await request("PATCH", input, headers);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal((await (await request("GET")).json()).locale, "ja");
});

test("partial and uncertain saves have distinct effects and never replay other fields", async (t) => {
  const { api, request } = await fixture(t);
  api.setNextLocaleOutcome("locale-owner", "locale_authority_unavailable");
  assert.equal((await request("PATCH", { locale: "ja" })).status, 503);
  assert.equal((await (await request("GET")).json()).locale, null);
  api.setNextLocaleOutcome("locale-owner", "locale_saved_settings_failed");
  const partial = await request("PATCH", { locale: "ja", theme: "dark" });
  assert.equal(partial.status, 409);
  assert.match(partial.headers.get("set-cookie"), /fixture_locale=ja;/);
  assert.equal(
    (await partial.json()).detail.code,
    "locale_saved_settings_failed",
  );
  assert.deepEqual(await (await request("GET")).json(), {
    theme: "system",
    preferences: {},
    last_active_anima_id: null,
    locale: "ja",
  });
  api.setNextLocaleOutcome("locale-owner", "locale_save_outcome_unknown");
  const unknown = await request("PATCH", { locale: "zh-Hant", theme: "dark" });
  assert.equal(unknown.status, 503);
  assert.equal(unknown.headers.get("set-cookie"), null);
  const readback = await (await request("GET")).json();
  assert.equal(readback.locale, "zh-Hant");
  assert.equal(readback.theme, "system");
});

test("held context and write replies retain their original owner snapshots", async (t) => {
  const { api, admission, request } = await fixture(t);
  api.setLocalePreference("locale-owner", "ja");
  const held = api.holdContextRead("locale-owner");
  const reading = fetch(api.url + "/v1/hosted/runtime-context", {
    headers: {
      cookie: `fixture_session=${admission.cookie}; fixture_locale=ko`,
    },
  });
  await held.started;
  api.setLocalePreference("locale-owner", "en");
  held.release();
  assert.deepEqual((await (await reading).json()).locale, {
    preference: "ja",
    visitor: "ko",
  });
  const write = api.holdLocaleWrite("locale-owner");
  const writing = request("PATCH", { locale: "zh-Hans" });
  await write.started;
  assert.equal((await (await request("GET")).json()).locale, "zh-Hans");
  api.setLocalePreference("locale-owner", "ko");
  write.release();
  assert.equal((await (await writing).json()).locale, "zh-Hans");
  assert.equal((await (await request("GET")).json()).locale, "ko");
});
