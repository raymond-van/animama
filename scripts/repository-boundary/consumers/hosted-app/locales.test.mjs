import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { localeText } from "./locales.mjs";

// The installed consumer has its copied fixture beside this test. Repository
// unit runs use the same fixture source; no application source is imported.
const installed = new URL("./hosted-workflows-http.mjs", import.meta.url);
const { createHostedWorkflowHttp } = await import(
    existsSync(installed)
        ? installed.href
        : new URL(
              "../../../../src/frontend/web/scripts/fixtures/hosted-workflows-http.mjs",
              import.meta.url,
          ).href
);

test("every rendered language has independent admission and picker expectations", () => {
    assert.deepEqual(Object.keys(localeText), [
        "en",
        "ja",
        "ko",
        "zh-Hans",
        "zh-Hant",
    ]);
    assert.equal(
        new Set(Object.values(localeText).map((text) => text.title)).size,
        5,
    );
});

test("signed-out display hints cannot authorize private API calls; denied account hints remain independently testable", async (t) => {
    const api = await createHostedWorkflowHttp({ localeAuthority: true });
    api.setOrigin(api.url);
    t.after(() => api.close());
    for (const locale of [...Object.keys(localeText), "ja-JP", "bad-value"]) {
        const headers = { cookie: `fixture_locale=${locale}` };
        const context = await (
            await fetch(api.url + "/v1/hosted/runtime-context", { headers })
        ).json();
        assert.equal(context.state, "session_required");
        assert.deepEqual(context.locale, { preference: null, visitor: locale });
        assert.equal(
            (await fetch(api.url + "/v1/users/me/settings", { headers }))
                .status,
            401,
        );
    }
    const owner = api.admit("denied-locale-owner");
    api.setLocalePreference(owner.owner, "en-US");
    api.setAdmissionState(owner.owner, "ineligible");
    const context = await (
        await fetch(api.url + "/v1/hosted/runtime-context", {
            headers: {
                cookie: `fixture_session=${owner.cookie}; fixture_locale=ko`,
            },
        })
    ).json();
    assert.equal(context.state, "ineligible");
    assert.deepEqual(context.locale, { preference: "en-US", visitor: "ko" });
});
