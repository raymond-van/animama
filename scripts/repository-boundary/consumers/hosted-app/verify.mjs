/** Exercise emitted routes, bytes and real workers using an independent HTTP authority. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createApplicationServer } from "./server.mjs";
import { observeBrowser } from "./measurements.mjs";
import { STEP_TIMEOUT_MS, exerciseClipCompatibility } from "./clips.mjs";
import { exerciseLocales, exerciseLocaleAudioContinuity } from "./locales.mjs";

// Wall time of each journey phase in run order, from when this script starts.
const phases = [];
let phaseStarted = Date.now();
const endPhase = (name) => {
    const now = Date.now();
    phases.push({ name, seconds: (now - phaseStarted) / 1000 });
    console.log(
        JSON.stringify({ timing: name, seconds: phases.at(-1).seconds }),
    );
    phaseStarted = now;
};

// "candidate" is the set under validation; "previous" is the verified clean
// predecessor or controlled byte-change variant that it upgrades from.
const load = (directory, role) => ({
    role,
    directory: path.resolve(directory),
    manifest: JSON.parse(
        readFileSync(path.join(directory, "app-manifest.json")),
    ),
});
const candidate = load(process.argv[2], "candidate");
const previous = process.argv[3] ? load(process.argv[3], "previous") : null;
const selectionKind = process.argv[4] ?? "single-revision";
// Upgrade order: previous, then candidate, then rollback to previous.
const apps = previous ? [previous, candidate] : [candidate];
if (selectionKind === "verified-clean-package-set-pair")
    assert.notEqual(
        previous?.manifest.source_commit,
        candidate.manifest.source_commit,
    );
const seed = JSON.parse(
    readFileSync(
        path.join(
            candidate.directory,
            candidate.manifest.catalog_seed.manifest,
        ),
    ),
);
const avatar = seed.inventory.starters[0].entries.find((name) =>
    name.endsWith(".vrm"),
);
assert.ok(avatar, "The real starter retains its VRM");
const prefix = (app) =>
    "/" +
    app.manifest.files
        .find((file) =>
            file.path.endsWith("/resource-manifests/browser-runtime.json"),
        )
        .path.split("resource-manifests/")[0];
const label = (app) => ({
    role: app.role,
    source_commit: app.manifest.source_commit,
    resource_prefix: prefix(app),
});
// Identical emitted bytes share every immutable URL, so the selection change,
// old-tab worker and rollback below would exercise nothing. Source revisions
// that emit identical bytes use the controlled variant instead.
const distinctResourceRevisions =
    Boolean(previous) && prefix(previous) !== prefix(candidate);
if (previous)
    assert.ok(
        distinctResourceRevisions,
        `An upgrade/rollback pair needs distinct application resources; both use ${prefix(candidate)}`,
    );
const server = await createApplicationServer(apps, {
    vrmFile: path.join(candidate.directory, "catalog-seed/included", avatar),
    localeAuthority: true,
});
const browserArgs = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--autoplay-policy=no-user-gesture-required",
];
const browser = await chromium.launch({ headless: true, args: browserArgs });
const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-CA",
    timezoneId: "America/Toronto",
});
const observation = await observeBrowser(context, browser);
const page = await context.newPage();
context.setDefaultTimeout(STEP_TIMEOUT_MS);
const errors = [],
    consoleErrors = [],
    externalRequests = [],
    network = [],
    measurements = [],
    routes = [],
    checks = [];
context.on("request", (request) => {
    const url = new URL(request.url());
    if (
        !["blob:", "data:"].includes(url.protocol) &&
        url.origin !== server.origin
    )
        externalRequests.push(request.url());
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
        consoleErrors.push(message.text());
});
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
cdp.on("Network.loadingFinished", (event) =>
    network.push({ bytes: event.encodedDataLength }),
);
// Each measurement and check names the app whose bytes served it.
const check = (name, app) => checks.push({ name, app: app.role });
const checkpoint = async (name, app) => {
    const result = {
        name,
        app: app.role,
        ...(await observation.snapshot(page, cdp)),
        completedEncodedPageNetworkBytes: network.reduce(
            (sum, event) => sum + event.bytes,
            0,
        ),
        completedStaticBodyBytesIncludingWorkers: server.calls
            .filter((call) => call.path.startsWith("/_animama/"))
            .reduce((sum, call) => sum + (call.completed_body_bytes ?? 0), 0),
    };
    measurements.push(result);
    console.log(
        JSON.stringify({
            phase: name,
            app: app.role,
            heapUsedBytes: result.heapUsedBytes,
            browserRssKiB: result.browserRssKiB,
            staticBodyBytes: result.completedStaticBodyBytesIncludingWorkers,
        }),
    );
    return result;
};
const admit = async (owner, roster = false) => {
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
};
const firstPosedFrame = () =>
    page.waitForFunction(
        () =>
            performance
                .getEntriesByType("mark")
                .some((mark) => mark.name.endsWith(":first-posed-frame")),
        {},
        { timeout: 60000 },
    );
const voiceReady = async () => {
    await page.waitForFunction(
        () =>
            window.artifactResources.workers.some(
                (worker) =>
                    worker.messages.includes("ready") ||
                    worker.messages.includes("error"),
            ),
        {},
        { timeout: 120000 },
    );
    assert.ok(
        await page.evaluate(() =>
            window.artifactResources.workers.some((worker) =>
                worker.messages.includes("ready"),
            ),
        ),
        "Pinned models initialize without a substitute engine",
    );
};
const workerPath = (app) => prefix(app) + "tts/workers/inference-worker.js";
const voiceSettings = async (owner, configure) => {
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
    await configure(dialog);
    await dialog
        .getByRole("button", { name: "Close App Settings", exact: true })
        .click();
};
const voice = (owner) =>
    voiceSettings(owner, async (dialog) => {
        await dialog
            .getByRole("switch", { name: "Enable Text-to-Speech", exact: true })
            .check();
        await dialog
            .getByRole("combobox", {
                name: "Text-to-Speech provider",
                exact: true,
            })
            .click();
        await page
            .getByRole("option", { name: "PocketTTS", exact: true })
            .click();
    });
const chatPcm = async () => {
    const input = page.getByRole("textbox", {
        name: "What's on your mind?",
        exact: true,
    });
    await input.fill("Hello");
    await input.press("Enter");
    await page.waitForFunction(
        () =>
            window.artifactResources.worklets.some(
                (worklet) =>
                    worklet.nonzeroSamples > 0 &&
                    worklet.messages.includes("playback-started"),
            ),
        {},
        { timeout: 120000 },
    );
    assert.ok(
        await page.evaluate(() =>
            window.artifactResources.audio.some(
                (audio) => audio.state === "running",
            ),
        ),
        "Real AudioContext receives generated speech",
    );
};
const signOut = async (owner) => {
    await page
        .getByRole("button")
        .filter({ hasText: `${owner} account` })
        .click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await page
        .getByRole("heading", { name: "Sign in to Animama", exact: true })
        .waitFor();
    await page.waitForFunction(
        () =>
            window.artifactResources.workers.every(
                (worker) => worker.terminated,
            ) &&
            window.artifactResources.audio.every(
                (audio) => audio.state === "closed",
            ) &&
            window.artifactResources.created.every((url) =>
                window.artifactResources.revoked.includes(url),
            ),
    );
    assert.equal(
        (
            await context.request.get(
                server.origin + "/v1/content/runtime-fixture/avatar.vrm",
            )
        ).status(),
        401,
        "Ended session loses private bytes",
    );
};
try {
    endPhase("server-and-browser-start");
    // Route, static, shell, avatar and voice checks run on the candidate; only
    // the upgrade and rollback steps below select the previous app.
    server.select(candidate);
    await admit("artifact-owner");
    for (const temperature of ["cold", "warm"]) {
        const started = Date.now(),
            byteStart = network.reduce((sum, event) => sum + event.bytes, 0);
        await page.goto(server.origin);
        await page
            .getByRole("heading", { name: "Your Animas will appear here" })
            .waitFor();
        const measured = await checkpoint(
            `${temperature}-production-shell`,
            candidate,
        );
        measured.readyWallMs = Date.now() - started;
        measured.navigationEncodedPageNetworkBytes =
            measured.completedEncodedPageNetworkBytes - byteStart;
    }
    assert.equal(
        server.calls.filter((call) =>
            /\.(onnx|npy|safetensors)$/.test(call.path),
        ).length,
        0,
        "Models stay lazy before voice action",
    );
    assert.equal(
        server.calls.filter((call) => /installation|bootstrap/.test(call.path))
            .length,
        0,
        "Hosted has no installation startup",
    );
    assert.equal(
        (await fetch(server.origin + "/src/main.hosted.tsx")).status,
        404,
    );
    assert.equal(
        (await fetch(server.origin + "/catalog-seed/included/" + avatar))
            .status,
        404,
        "Seed is not static content",
    );
    assert.equal(
        (await fetch(server.origin + "/v1/not-an-api")).headers.get(
            "content-type",
        ),
        "application/json",
    );
    check("production-shell", candidate);
    endPhase("production-shell");
    const runtimePath = candidate.manifest.files.find((file) =>
        file.path.endsWith("/resource-manifests/browser-runtime.json"),
    ).path;
    const runtime = JSON.parse(
        readFileSync(path.join(candidate.directory, runtimePath)),
    );
    assert.equal(runtime.files.length, 21);
    assert.equal(
        runtime.files.reduce((sum, file) => sum + file.size, 0),
        280549335,
    );
    for (const expected of runtime.files) {
        const file = candidate.manifest.files.find(
            (file) =>
                "/" + file.path === prefix(candidate) + "onnx/" + expected.path,
        );
        assert.equal(file.sha256, expected.sha256);
        assert.equal(file.size, expected.size);
    }
    for (const file of candidate.manifest.files) {
        const response = await fetch(server.origin + "/" + file.path, {
            method: "HEAD",
        });
        assert.equal(response.status, 200, file.path);
        assert.equal(response.headers.get("content-type"), file.mime_type);
        assert.equal(Number(response.headers.get("content-length")), file.size);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(
            response.headers.get("cache-control").includes("immutable"),
            file.cache === "immutable",
        );
        assert.equal(
            response.headers
                .get("content-security-policy")
                .includes("'unsafe-eval'"),
            file.path.endsWith("/tts/workers/inference-worker.js"),
            "Eval stays confined to the exact pinned sentencepiece worker",
        );
    }
    const wasm = candidate.manifest.files.find((file) =>
        file.path.endsWith(".wasm"),
    );
    const response = await fetch(server.origin + "/" + wasm.path, {
        headers: { range: "bytes=0-63" },
    });
    assert.equal(response.status, 206);
    assert.equal(
        response.headers.get("content-range"),
        `bytes 0-63/${wasm.size}`,
    );
    assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        readFileSync(path.join(candidate.directory, wasm.path)).subarray(0, 64),
    );
    const mismatch = await fetch(server.origin + "/" + wasm.path, {
        method: "HEAD",
        headers: { range: "bytes=0-63", "if-range": '"wrong-version"' },
    });
    assert.equal(mismatch.status, 200);
    assert.equal(Number(mismatch.headers.get("content-length")), wasm.size);
    assert.equal(
        (
            await fetch(server.origin + "/" + wasm.path, {
                headers: { "if-none-match": `"sha256-${wasm.sha256}"` },
            })
        ).status,
        304,
    );
    check("static-inventory-head-range-cache", candidate);
    endPhase("static-inventory");
    for (const [route, ready] of [
        [
            "/library",
            () =>
                page
                    .getByRole("heading", { name: "Library", exact: true })
                    .waitFor(),
        ],
        [
            "/create",
            () =>
                page
                    .getByRole("heading", { name: "Create", exact: true })
                    .waitFor(),
        ],
        [
            "/particle-effects/new",
            () =>
                page
                    .getByRole("button", { name: "Save", exact: true })
                    .first()
                    .waitFor(),
        ],
        [
            "/avatar-effects/new",
            () =>
                page
                    .getByRole("button", { name: "Save", exact: true })
                    .first()
                    .waitFor(),
        ],
        [
            "/scene-effects/new",
            () =>
                page
                    .getByRole("button", { name: "Save", exact: true })
                    .first()
                    .waitFor(),
        ],
        [
            "/a/library",
            () =>
                page
                    .getByRole("heading", { name: "Library", exact: true })
                    .waitFor(),
        ],
    ]) {
        await page.goto(server.origin + route);
        await ready();
        routes.push({
            requested: route,
            final: new URL(page.url()).pathname,
            app: candidate.role,
        });
        if (route === "/particle-effects/new")
            await page.screenshot({
                path: "whole-app-creator.png",
                fullPage: true,
            });
    }
    await page.screenshot({ path: "whole-app-library.png", fullPage: true });
    await checkpoint("retained-deep-links", candidate);
    endPhase("deep-links");
    await admit("artifact-owner", true);
    for (const temperature of ["cold", "warm"]) {
        const started = Date.now(),
            byteStart = network.reduce((sum, event) => sum + event.bytes, 0);
        await page.goto(server.origin + "/fixture-anima");
        await firstPosedFrame();
        const measured = await checkpoint(
            `${temperature}-first-avatar`,
            candidate,
        );
        measured.readyWallMs = Date.now() - started;
        measured.navigationEncodedPageNetworkBytes =
            measured.completedEncodedPageNetworkBytes - byteStart;
    }
    await page.screenshot({ path: "whole-app-avatar.png", fullPage: true });
    assert.ok(
        !server.calls.some(
            (call) =>
                call.method === "GET" &&
                (call.path === workerPath(candidate) ||
                    call.path.includes("/onnx/models/pocket-tts/")),
        ),
        "An owner with Text-to-Speech off loads no Pocket TTS before turning voice on",
    );
    endPhase("first-avatar");
    const voiceStart = Date.now(),
        callStart = server.calls.length;
    await voice("artifact-owner");
    await voiceReady();
    (await checkpoint("cold-first-voice-ready", candidate)).readyWallMs =
        Date.now() - voiceStart;
    const pcmStart = Date.now();
    await chatPcm();
    (await checkpoint("cold-first-voice-playback", candidate)).firstPcmWallMs =
        Date.now() - pcmStart;
    // Owners start with Text-to-Speech off, so the voice action creates it.
    assert.ok(
        server.calls
            .slice(callStart)
            .some(
                (call) =>
                    call.method === "GET" &&
                    call.path === workerPath(candidate) &&
                    call.status === 200,
            ),
        "The candidate page creates the candidate's worker",
    );
    check("cold-voice-pcm", candidate);
    const localeAudioContinuity = await exerciseLocaleAudioContinuity(
        page,
        server,
        "artifact-owner",
    );
    check("locale-live-audio-continuity", candidate);
    endPhase("cold-voice");
    await signOut("artifact-owner");
    await checkpoint("sign-out-cleanup", candidate);
    const endedCookie = await context.cookies();
    await admit("artifact-owner");
    await page.goto(server.origin);
    await page
        .getByRole("heading", { name: "Your Animas will appear here" })
        .waitFor();
    assert.equal(await page.getByText("Hello", { exact: true }).count(), 0);
    const reauthenticatedCookie = await context.cookies();
    assert.notDeepEqual(
        reauthenticatedCookie.map((cookie) => cookie.value),
        endedCookie.map((cookie) => cookie.value),
        "Same owner receives a fresh admitted session",
    );
    check("session-cleanup", candidate);
    endPhase("session-cleanup");
    if (previous) {
        // Keep the previous app's actual page open while the candidate becomes
        // the entry selection. Its next runtime-created worker and model URLs
        // must still resolve the previous app's bytes.
        server.select(previous);
        await admit("upgrade-owner", true);
        // The previous page opens on the Library and reaches the Anima only
        // after the selection changes, without a reload, so every worker it
        // creates starts after the change.
        await page.goto(server.origin + "/library");
        await page
            .getByRole("heading", { name: "Library", exact: true })
            .waitFor();
        await checkpoint("previous-open-page", previous);
        server.select(candidate);
        const lateStart = server.calls.length;
        await page.evaluate(() => {
            window.history.pushState({}, "", "/fixture-anima");
            window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await firstPosedFrame();
        await voice("upgrade-owner");
        await voiceReady();
        await checkpoint("previous-late-voice-ready", previous);
        const late = server.calls
            .slice(lateStart)
            .filter(
                (call) =>
                    call.path.startsWith("/_animama/static/") &&
                    /\/(tts|onnx)\//.test(call.path),
            );
        assert.ok(
            late.some(
                (call) =>
                    call.method === "GET" &&
                    call.path === workerPath(previous) &&
                    call.status === 200,
            ),
            "The open previous page creates its own worker after the selection changes",
        );
        assert.ok(
            late.every((call) => call.path.startsWith(prefix(previous))),
            "Its late worker and model URLs resolve only the previous app's bytes",
        );
        check("old-tab-late-worker", previous);
        await signOut("upgrade-owner");
        await checkpoint("previous-sign-out-cleanup", previous);
        endPhase("old-tab-late-worker");
    }
    await admit("second-owner", true);
    await page.goto(server.origin + "/fixture-anima");
    await firstPosedFrame();
    assert.equal(
        await page.getByText("Hello", { exact: true }).count(),
        0,
        "The second owner cannot see the first owner's chat",
    );
    const warmVoiceStart = Date.now();
    await voice("second-owner");
    await voiceReady();
    (await checkpoint("warm-first-voice-ready", candidate)).readyWallMs =
        Date.now() - warmVoiceStart;
    const warmPcmStart = Date.now();
    await chatPcm();
    (await checkpoint("warm-first-voice-playback", candidate)).firstPcmWallMs =
        Date.now() - warmPcmStart;
    assert.ok(
        await page.evaluate(
            (expected) =>
                window.artifactResources.workers.some((worker) =>
                    worker.url.includes(expected),
                ),
            workerPath(candidate),
        ),
        "A fresh selected page uses the candidate's actual worker URL",
    );
    check("fresh-selection-warm-voice", candidate);
    await signOut("second-owner");
    await checkpoint("second-owner-cleanup", candidate);
    assert.equal(
        server.calls.filter(
            (call) =>
                call.path.startsWith("/_animama/") &&
                call.path.includes("/onnx/models/pocket-tts/animas/"),
        ).length,
        0,
        "Owner voice catalogs are private API bytes, not immutable application resources",
    );
    endPhase("warm-voice");
    if (previous) {
        server.select(previous);
        await admit("rollback-owner");
        await page.goto(server.origin);
        await page
            .getByRole("heading", { name: "Your Animas will appear here" })
            .waitFor();
        assert.ok(
            await page.evaluate(
                (expected) =>
                    [...document.scripts].some((script) =>
                        script.src.includes(expected),
                    ),
                prefix(previous),
            ),
            "Rollback selects the previous app's emitted entry and retained chunks",
        );
        check("rollback-entry", previous);
        endPhase("rollback-entry");
    }
    const localeCompatibility = await exerciseLocales(
        browser,
        server,
        candidate,
    );
    check("hosted-locale-contract", candidate);
    endPhase("hosted-locales");
    const clipCompatibility = await exerciseClipCompatibility(
        browser,
        server,
        apps,
        selectionKind,
        endPhase,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
        externalRequests,
        [],
        "The isolated browser has no external provider, source or model dependency",
    );
    const report = {
        status: "PASS",
        kind: "actual-emitted-whole-application",
        source_commit: candidate.manifest.source_commit,
        app_version: candidate.manifest.app_version,
        files: candidate.manifest.files.length,
        baseline_speech_files: 21,
        baseline_speech_bytes: 280549335,
        source_modules_available_to_browser: false,
        installation_calls: 0,
        provider_calls: 0,
        clip_compatibility: clipCompatibility,
        locale_compatibility: localeCompatibility,
        locale_audio_continuity: localeAudioContinuity,
        physical_capture_or_heard_audio: false,
        browser: {
            version: observation.browserVersion,
            headless: true,
            args: browserArgs,
            viewport: { width: 1440, height: 900 },
        },
        measurement_protocol:
            "No forced GC; Runtime.getHeapUsage; 100ms page heap samples; 1s summed browser-process RSS; page CDP encoded bytes plus server static body bytes including workers. Warm cases reuse the browser HTTP cache.",
        applications: {
            candidate: label(candidate),
            previous: previous ? label(previous) : null,
        },
        selection: {
            kind: selectionKind,
            distinct_resource_revisions: distinctResourceRevisions,
            initial_source: apps[0].manifest.source_commit,
            selected_source: candidate.manifest.source_commit,
            initial_prefix: prefix(apps[0]),
            selected_prefix: prefix(candidate),
            old_tab_late_worker: Boolean(previous),
            rollback_entry: Boolean(previous),
        },
        checks,
        routes,
        measurements,
        phase_seconds: phases,
        http_calls: server.calls,
        authority_calls: server.apiCalls,
        external_requests: externalRequests,
        errors,
    };
    writeFileSync(
        "whole-app-receipt.json",
        JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
        JSON.stringify({
            status: report.status,
            files: report.files,
            measurements: measurements.map((measurement) => ({
                name: measurement.name,
                heapUsedBytes: measurement.heapUsedBytes,
                browserRssKiB: measurement.browserRssKiB,
            })),
        }),
    );
} catch (error) {
    writeFileSync(
        "whole-app-failure.json",
        JSON.stringify(
            {
                error: error.message,
                errors,
                consoleErrors,
                http_calls: server.calls,
                measurements,
                phase_seconds: phases,
                body: await page.locator("body").innerText(),
            },
            null,
            2,
        ) + "\n",
    );
    throw error;
} finally {
    observation.close();
    await context.close();
    await browser.close();
    await server.close();
}
