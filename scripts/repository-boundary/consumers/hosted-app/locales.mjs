/** Locale journeys use only emitted application bytes and ordinary HTTP authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createApplicationServer } from "./server.mjs";
import { STEP_TIMEOUT_MS } from "./clips.mjs";

// Independent observable copy expectations, not imports from product source or catalogs.
export const localeText = {
    en: {
        title: "Sign in to Animama",
        denied: "Account access is not available",
        settings: "App Settings",
        close: "Close App Settings",
        language: "Language",
        signOut: "Sign out",
    },
    ja: {
        title: "Animama にサインイン",
        denied: "アカウントにアクセスできません",
        settings: "アプリ設定",
        close: "アプリ設定を閉じる",
        language: "言語",
        signOut: "サインアウト",
    },
    ko: {
        title: "Animama에 로그인",
        denied: "계정에 접근할 수 없습니다",
        settings: "앱 설정",
        close: "앱 설정 닫기",
        language: "언어",
        signOut: "로그아웃",
    },
    "zh-Hans": {
        title: "登录 Animama",
        denied: "无法访问账户",
        settings: "应用设置",
        close: "关闭应用设置",
        language: "语言",
        signOut: "退出登录",
    },
    "zh-Hant": {
        title: "登入 Animama",
        denied: "無法存取帳號",
        settings: "應用程式設定",
        close: "關閉應用程式設定",
        language: "語言",
        signOut: "登出",
    },
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileDigest = (file) => sha(readFileSync(file));
const sourceIdentity = (app) => ({
    source_commit: app.manifest.source_commit,
    app_version: app.manifest.app_version,
    app_manifest_sha256: fileDigest(
        path.join(app.directory, "app-manifest.json"),
    ),
});
const waitLocale = (page, locale) =>
    page.waitForFunction(
        (expected) =>
            document.documentElement.lang === expected &&
            document.documentElement.dir === "ltr",
        locale,
    );
const delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Real browser focus/visibility transitions exercise the composition refresh subscription. */
export async function focusLocalePage(page) {
    const other = await page.context().newPage();
    await other.bringToFront();
    await page.bringToFront();
    await other.close();
}

async function visitor(context, origin, value) {
    if (value === null) await context.clearCookies({ name: "fixture_locale" });
    else
        await context.addCookies([
            { name: "fixture_locale", value, url: origin, sameSite: "Lax" },
        ]);
}
const readVisitor = async (context) =>
    (await context.cookies()).find((cookie) => cookie.name === "fixture_locale")
        ?.value ?? null;
async function admit(context, server, owner, roster = true) {
    const admission = await server.admit(owner, roster);
    await context.addCookies([
        {
            name: "fixture_session",
            value: admission.cookie,
            url: server.origin,
            httpOnly: true,
            sameSite: "Lax",
        },
    ]);
    return admission;
}
async function settings(page, owner, locale) {
    await page
        .getByRole("button")
        .filter({ hasText: `${owner} account` })
        .click();
    await page
        .getByRole("menuitem", {
            name: localeText[locale].settings,
            exact: true,
        })
        .click();
    return page.getByRole("dialog", {
        name: localeText[locale].settings,
        exact: true,
    });
}
async function choose(page, locale, next, keyboard = false) {
    const dialog = page.getByRole("dialog", {
        name: localeText[locale].settings,
        exact: true,
    });
    await dialog
        .getByRole("combobox", {
            name: localeText[locale].language,
            exact: true,
        })
        .click();
    const option =
        next === null
            ? page.getByRole("option").first()
            : page.locator(`[role="option"][lang="${next}"]`);
    if (keyboard) {
        await option.focus();
        await option.press("Enter");
    } else await option.click();
}
const closeSettings = (page, locale) =>
    page
        .getByRole("dialog")
        .getByRole("button", { name: localeText[locale].close, exact: true })
        .click();
const localeWrites = (server, owner) =>
    server.apiCalls.filter(
        (call) =>
            call.owner === owner &&
            call.path === "/v1/users/me/settings" &&
            call.method === "PATCH" &&
            Object.hasOwn(call.body ?? {}, "locale"),
    );
async function ready(page, locale) {
    await waitLocale(page, locale);
    await page.locator("textarea").first().waitFor();
}

/** All locale checks are isolated from the existing English and real-audio journeys. */
export async function exerciseLocales(
    browser,
    server,
    candidate,
    { evidenceDir = "locale-evidence" } = {},
) {
    mkdirSync(evidenceDir, { recursive: true });
    server.select(candidate);
    const checks = [],
        screenshots = [],
        errors = [],
        externalRequests = [];
    const identity = sourceIdentity(candidate);
    const capture = async (page, name) => {
        const file = path.join(evidenceDir, `${name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        screenshots.push({
            name,
            file: path.basename(file),
            sha256: fileDigest(file),
            viewport: page.viewportSize(),
        });
    };
    const contextFor = async ({
        browserLocale = "en-CA",
        staleCache = "zh-Hant",
        preferred,
    } = {}) => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            locale: browserLocale,
            storageState: {
                cookies: [],
                origins: [
                    {
                        origin: server.origin,
                        localStorage: [
                            {
                                name: "animama.ui-locale.applied",
                                value: staleCache,
                            },
                        ],
                    },
                ],
            },
        });
        context.setDefaultTimeout(STEP_TIMEOUT_MS);
        context.on("request", (request) => {
            const url = new URL(request.url());
            if (
                ["http:", "https:"].includes(url.protocol) &&
                url.origin !== server.origin
            )
                externalRequests.push(request.url());
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        if (preferred) {
            const cdp = await context.newCDPSession(page);
            const userAgent = await page.evaluate(() => navigator.userAgent);
            await cdp.send("Network.setUserAgentOverride", {
                userAgent,
                acceptLanguage: preferred.join(","),
            });
        }
        return { context, page };
    };
    const record = (name, extra = {}) => checks.push({ name, ...extra });
    try {
        for (const locale of Object.keys(localeText)) {
            const { context, page } = await contextFor();
            try {
                await visitor(context, server.origin, locale);
                const start = server.apiCalls.length;
                await page.goto(server.origin);
                await page
                    .getByRole("heading", {
                        name: localeText[locale].title,
                        exact: true,
                    })
                    .waitFor();
                await waitLocale(page, locale);
                assert.ok(
                    server.apiCalls
                        .slice(start)
                        .every(
                            (call) =>
                                call.path === "/v1/hosted/runtime-context",
                        ),
                    "Display locale does not authorize private product reads",
                );
                await capture(page, `admission-${locale}-desktop`);
                await page.setViewportSize({ width: 390, height: 844 });
                await capture(page, `admission-${locale}-narrow`);
                assert.equal(
                    await page.evaluate(
                        () =>
                            document.documentElement.scrollWidth <=
                            innerWidth + 1,
                    ),
                    true,
                );
                assert.equal(
                    await readVisitor(context),
                    locale,
                    "A context read cannot rewrite the visitor",
                );
                record("signed-out-render", {
                    locale,
                    stale_applied_cache_ignored: true,
                });
            } finally {
                await context.close();
            }
        }
        for (const [browserLocale, expected, preferred] of [
            ["zh-TW", "zh-Hant"],
            ["zh-HK", "zh-Hant"],
            ["zh-CN", "zh-Hans"],
            ["zh-Hant-CN", "zh-Hant"],
            ["fr-FR", "en"],
            ["en-CA", "ko", ["fr-FR", "ko-KR", "ja-JP"]],
        ]) {
            const { context, page } = await contextFor({
                browserLocale,
                preferred,
                staleCache: "ja",
            });
            try {
                await visitor(context, server.origin, "not-canonical");
                await page.goto(server.origin);
                await page
                    .getByRole("heading", {
                        name: localeText[expected].title,
                        exact: true,
                    })
                    .waitFor();
                await waitLocale(page, expected);
                if (preferred)
                    assert.deepEqual(
                        await page.evaluate(() => [...navigator.languages]),
                        preferred,
                    );
                record("browser-language-matching", {
                    browserLocale,
                    preferred,
                    expected,
                });
            } finally {
                await context.close();
            }
        }
        {
            const { context, page } = await contextFor({
                browserLocale: "ko-KR",
                staleCache: "ja",
            });
            try {
                server.setContextFailure(null, true);
                await page.goto(server.origin);
                await waitLocale(page, "ko");
                await page
                    .getByRole("heading", {
                        name: "런타임을 사용할 수 없습니다",
                        exact: true,
                    })
                    .waitFor();
                await capture(page, "unavailable-initial-browser-fallback");
                record("unavailable-initial-read-browser-fallback");
            } finally {
                server.setContextFailure(null, false);
                await context.close();
            }
        }
        {
            const { context, page } = await contextFor();
            const owner = "locale-denied";
            try {
                await admit(context, server, owner);
                server.setAdmissionState(owner, "ineligible");
                server.setLocalePreference(owner, "en");
                await visitor(context, server.origin, "ja");
                await page.goto(server.origin);
                await page
                    .getByRole("heading", {
                        name: localeText.en.denied,
                        exact: true,
                    })
                    .waitFor();
                await waitLocale(page, "en");
                server.setLocalePreference(owner, "en-US");
                await focusLocalePage(page);
                await page
                    .getByRole("heading", {
                        name: localeText.ja.denied,
                        exact: true,
                    })
                    .waitFor();
                await waitLocale(page, "ja");
                record("saved-English-precedence-and-invalid-saved-hint");
            } finally {
                await context.close();
            }
        }
        {
            const { context, page } = await contextFor();
            const owner = "locale-picker";
            try {
                const admission = await admit(context, server, owner);
                await visitor(context, server.origin, "ja");
                await page.goto(server.origin + "/fixture-anima");
                await ready(page, "ja");
                const draft = page.locator("textarea").first();
                await draft.fill("Unsent locale continuity draft");
                const input = await draft.elementHandle();
                const route = page.url();
                await settings(page, owner, "ja");
                const picker = page.getByRole("combobox", {
                    name: localeText.ja.language,
                    exact: true,
                });
                assert.match(await picker.innerText(), /システムのデフォルト/);
                await choose(page, "ja", null);
                await waitLocale(page, "en");
                assert.equal(await readVisitor(context), null);
                assert.equal(admission.state.localePreference, null);
                assert.equal(
                    localeWrites(server, owner).at(-1).body.locale,
                    null,
                );
                // The same explicit clear also works through actual keyboard activation.
                await visitor(context, server.origin, "ko");
                await focusLocalePage(page);
                await waitLocale(page, "ko");
                await choose(page, "ko", null, true);
                await waitLocale(page, "en");
                assert.equal(await readVisitor(context), null);
                await choose(page, "en", "zh-Hant");
                await waitLocale(page, "zh-Hant");
                assert.equal(await readVisitor(context), "zh-Hant");
                await closeSettings(page, "zh-Hant");
                assert.equal(
                    await draft.inputValue(),
                    "Unsent locale continuity draft",
                );
                assert.equal(
                    await input.evaluate((element) => element.isConnected),
                    true,
                    "Locale change preserves the mounted composer",
                );
                assert.equal(page.url(), route);
                await draft.press("Enter");
                await page
                    .getByText(
                        "Fixture reply to Unsent locale continuity draft",
                        { exact: true },
                    )
                    .waitFor();
                assert.equal(
                    admission.state.lastTurn.client_context.ui_locale,
                    "zh-Hant",
                );
                record(
                    "nullable-picker-reselection-mouse-keyboard-and-chat-continuity",
                );
                // A context reply captured before the confirmed mutation cannot replace it.
                const held = server.holdContextRead(owner);
                await focusLocalePage(page);
                await held.started;
                await settings(page, owner, "zh-Hant");
                await choose(page, "zh-Hant", "ja");
                await waitLocale(page, "ja");
                held.release();
                await held.completed;
                await delay(100);
                assert.equal(
                    await page.locator("html").getAttribute("lang"),
                    "ja",
                );
                await closeSettings(page, "ja");
                record("stale-focus-read-cannot-replace-confirmed-save");
                await page
                    .getByRole("button")
                    .filter({ hasText: `${owner} account` })
                    .click();
                await page
                    .getByRole("menuitem", {
                        name: localeText.ja.signOut,
                        exact: true,
                    })
                    .click();
                await page
                    .getByRole("heading", {
                        name: localeText.ja.title,
                        exact: true,
                    })
                    .waitFor();
                await visitor(context, server.origin, "ko");
                await focusLocalePage(page);
                await page
                    .getByRole("heading", {
                        name: localeText.ko.title,
                        exact: true,
                    })
                    .waitFor();
                await visitor(context, server.origin, null);
                await focusLocalePage(page);
                await page
                    .getByRole("heading", {
                        name: localeText.en.title,
                        exact: true,
                    })
                    .waitFor();
                record("signed-out-visitor-refresh-and-clear");
            } finally {
                await context.close();
            }
        }
        {
            const { context, page } = await contextFor();
            const owner = "locale-creator";
            try {
                await admit(context, server, owner);
                server.setLocalePreference(owner, "en");
                await page.goto(server.origin + "/particle-effects/new");
                const name = page.getByRole("textbox", {
                    name: "Particle FX name",
                    exact: true,
                });
                await name.fill("Uncommitted locale editor draft");
                const element = await name.elementHandle();
                const route = page.url();
                server.setLocalePreference(owner, "ja");
                await focusLocalePage(page);
                await waitLocale(page, "ja");
                assert.equal(
                    await element.evaluate(
                        (input) => input.isConnected && input.value,
                    ),
                    "Uncommitted locale editor draft",
                );
                assert.equal(page.url(), route);
                await capture(page, "creator-edit-survives-locale-refresh");
                record("creator-draft-and-navigation-continuity");
            } finally {
                await context.close();
            }
        }
        {
            const { context, page } = await contextFor();
            const owner = "locale-old-owner";
            try {
                await admit(context, server, owner);
                server.setLocalePreference(owner, "en");
                await page.goto(server.origin + "/fixture-anima");
                await ready(page, "en");
                const held = server.holdLocaleWrite(owner);
                await settings(page, owner, "en");
                await choose(page, "en", "ja");
                await held.started;
                const replacement = await admit(
                    context,
                    server,
                    "locale-new-owner",
                );
                server.setLocalePreference(replacement.owner, "ko");
                await focusLocalePage(page);
                await waitLocale(page, "ko");
                await page
                    .getByRole("button")
                    .filter({ hasText: `${replacement.owner} account` })
                    .waitFor();
                held.release();
                await held.completed;
                await delay(100);
                assert.equal(
                    await page.locator("html").getAttribute("lang"),
                    "ko",
                );
                assert.equal(replacement.state.localePreference, "ko");
                record("late-save-cannot-replace-new-owner");
            } finally {
                await context.close();
            }
        }
        for (const [outcome, message, resolved] of [
            [
                "locale_conflict",
                /Your language preference changed elsewhere\./,
                "en",
            ],
            [
                "locale_authority_unavailable",
                /Language preferences are temporarily unavailable\./,
                "en",
            ],
            [
                "locale_save_outcome_unknown",
                /We could not confirm whether your language was saved\.|言語が保存されたか確認できません/,
                "ja",
            ],
            [
                "lost_response",
                /We could not confirm whether your language was saved\.|言語が保存されたか確認できません/,
                "ja",
            ],
            [
                "locale_saved_settings_failed",
                /Your language was saved, but other settings could not be saved\.|言語は保存されましたが/,
                "ja",
            ],
        ]) {
            const { context, page } = await contextFor();
            const owner = `locale-error-${outcome}`;
            try {
                await admit(context, server, owner);
                server.setLocalePreference(owner, "en");
                await visitor(context, server.origin, "en");
                await page.goto(server.origin + "/fixture-anima");
                await ready(page, "en");
                server.setNextLocaleOutcome(owner, outcome);
                await settings(page, owner, "en");
                await choose(page, "en", "ja");
                // The acknowledgement may precede or follow the new catalog load.
                await page.getByText(message).waitFor();
                await waitLocale(page, resolved);
                await capture(page, `error-${outcome}`);
                assert.equal(
                    localeWrites(server, owner).length,
                    1,
                    "No automatic replay or compensation",
                );
                assert.equal(
                    await readVisitor(context),
                    outcome === "locale_saved_settings_failed" ? "ja" : "en",
                );
                record("explicit-save-outcome", {
                    outcome,
                    resolved,
                    writes: 1,
                });
            } finally {
                await context.close();
            }
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(
            externalRequests,
            [],
            "Locale journeys use no external service or source checkout",
        );
        const report = {
            status: "PASS",
            kind: "emitted-application-locales",
            ...identity,
            checks,
            screenshots,
            errors,
            external_requests: externalRequests,
            real_audio_continuity: false,
            physical_capture_or_heard_audio: false,
        };
        const file = path.join(evidenceDir, "locale-receipt.json");
        writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
        return { ...report, receipt: { path: file, sha256: fileDigest(file) } };
    } catch (error) {
        writeFileSync(
            path.join(evidenceDir, "locale-failure.json"),
            JSON.stringify(
                {
                    ...identity,
                    error: error.message,
                    checks,
                    screenshots,
                    errors,
                    authority_calls: server.apiCalls,
                },
                null,
                2,
            ) + "\n",
        );
        throw error;
    }
}

/** Called only after the full verifier has proved real Pocket PCM and a live worklet. */
export async function exerciseLocaleAudioContinuity(page, server, owner) {
    const snapshot = () =>
        page.evaluate(() => ({
            workers: window.artifactResources.workers.map((worker) => ({
                url: worker.url,
                terminated: worker.terminated,
            })),
            audio: window.artifactResources.audio.map((audio) => audio.state),
            worklets: window.artifactResources.worklets.map(
                (worklet) => worklet.name,
            ),
        }));
    const before = await snapshot();
    assert.ok(before.workers.some((worker) => !worker.terminated));
    assert.ok(before.audio.includes("running"));
    assert.ok(before.worklets.length > 0);
    const route = page.url();
    server.setLocalePreference(owner, "ja");
    await focusLocalePage(page);
    await waitLocale(page, "ja");
    assert.deepEqual(
        await snapshot(),
        before,
        "Locale refresh retains the same live worker, AudioContext and worklet resources",
    );
    assert.equal(page.url(), route);
    server.setLocalePreference(owner, "en");
    await focusLocalePage(page);
    await waitLocale(page, "en");
    assert.deepEqual(await snapshot(), before);
    return {
        status: "PASS",
        real_pocket_pcm_precondition: true,
        same_live_resources: true,
        workers: before.workers.length,
        audio_contexts: before.audio.length,
        worklets: before.worklets.length,
    };
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    assert.ok(
        process.argv[2],
        "Usage: node locales.mjs <verified-unpacked-application> [evidence-directory]",
    );
    const directory = path.resolve(process.argv[2]);
    const candidate = {
        role: "candidate",
        directory,
        manifest: JSON.parse(
            readFileSync(path.join(directory, "app-manifest.json")),
        ),
    };
    const { chromium } = await import("playwright");
    const server = await createApplicationServer([candidate], {
        localeAuthority: true,
    });
    const browser = await chromium.launch({
        headless: true,
        args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
        ],
    });
    try {
        const report = await exerciseLocales(browser, server, candidate, {
            evidenceDir: process.argv[3] ?? "locale-evidence",
        });
        console.log(
            JSON.stringify({
                status: report.status,
                source_commit: report.source_commit,
                checks: report.checks.length,
                receipt: report.receipt,
                real_audio_continuity: false,
            }),
        );
    } finally {
        await browser.close();
        await server.close();
    }
}
