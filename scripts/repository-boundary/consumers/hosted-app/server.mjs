/** Ordinary HTTP fixture: static selection is closed; private traffic has cookie/CSRF authority. */
import { createServer, request as httpRequest } from "node:http";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createClipApi } from "./clip-api.mjs";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const CSP =
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob:; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
const json = (res, value, status = 200) => {
    res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
    });
    res.end(JSON.stringify(value));
};

/** Routes in the shared file router, including its bounded legacy /a redirect. */
export function applicationRoute(raw) {
    const route = raw.replace(/^\/a(?=\/|$)/, "").replace(/^\/+/, "/") || "/";
    const id = "[A-Za-z0-9_-]+";
    return (
        [
            /^\/$/,
            /^\/(?:create|library|memories|safety|setup)\/?$/,
            new RegExp(`^/animas(?:/${id}(?:/identity)?)?/?$`),
            /^\/(?:avatar|scene)-effects\/?$/,
            new RegExp(
                `^/(?:gestures|reactions|particle-effects|avatar-effects|scene-effects|sound-effects)/new/?$`,
            ),
            new RegExp(
                `^/(?:gestures|poses|reactions|particle-effects|avatar-effects|scene-effects|sound-effects)/${id}/edit/?$`,
            ),
            new RegExp(`^/desktop/(?:pip|quick-chat)/${id}/?$`),
            new RegExp(`^/${id}(?:/c/${id})?/?$`),
        ].some((pattern) => pattern.test(route)) &&
        !["src", "v1", "api", "_animama", "avatar-portrait-debug"].includes(
            route.split("/")[1],
        )
    );
}

export async function createApplicationServer(
    applications,
    { vrmFile, localeAuthority = false } = {},
) {
    let selected = applications[0];
    const inventory = new Map();
    for (const app of applications)
        for (const file of app.manifest.files) {
            if (file.path === "index.html") continue;
            const existing = inventory.get("/" + file.path);
            if (existing && existing.file.sha256 !== file.sha256)
                throw new Error("Immutable URL reused for different bytes");
            inventory.set("/" + file.path, { directory: app.directory, file });
        }
    const { createHostedWorkflowHttp } =
        await import("./hosted-workflows-http.mjs");
    const api = await createHostedWorkflowHttp({ localeAuthority });
    const clips = createClipApi(json, applications[0].directory);
    const sessions = new Map(),
        calls = [];
    const vrm = vrmFile ? readFileSync(vrmFile) : null;
    const avatarFile = vrm && {
        file_ref: "fixture-avatar",
        item_id: "fixture-avatar",
        filename: "avatar.vrm",
        role: "model",
        ordinal: 0,
        media_type: "application/octet-stream",
        size_bytes: vrm.length,
        sha256: sha(vrm),
        url: "/v1/content/runtime-fixture/avatar.vrm",
    };
    const runtime = {
        effective_revision: "fixture-revision",
        loadout_revision: 1,
        catalog_version: 1,
        can_chat: true,
        lease_expires_at: "2099-01-01T00:00:00Z",
        avatar: avatarFile
            ? {
                  avatar_id: "fixture-avatar",
                  revision: "r1",
                  runtime_root_id: "avatar",
                  source: {
                      type: "catalog_item",
                      source: "local",
                      item_id: "fixture-avatar",
                      revision: "r1",
                  },
                  files: [avatarFile],
              }
            : null,
        gestures: [],
        poses: [],
        reactions: [],
        reaction_cells: {},
        appearances: [],
        particle_effects: [],
        avatar_effects: [],
        scene_effects: [],
        sound_effects: [],
        idle: { default_pool: [], cells: {}, gestures: [] },
        voice: null,
        warnings: [],
        content_descriptor: {
            schema_version: 1,
            revision: "fixture-revision",
            total_bytes: vrm?.length ?? 0,
            members: avatarFile ? [avatarFile] : [],
            entries: [],
            roots: avatarFile
                ? [
                      {
                          root_id: "avatar",
                          slot_key: "avatar",
                          item_id: "fixture-avatar",
                          kind: "avatar",
                          revision_sha256: sha(vrm),
                          entry_ids: [],
                          member_refs: [avatarFile.file_ref],
                      },
                  ]
                : [],
            diagnostics: [],
        },
    };
    const server = createServer(async (req, res) => {
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("content-security-policy", CSP);
        res.setHeader("cross-origin-opener-policy", "same-origin");
        res.setHeader("cross-origin-embedder-policy", "require-corp");
        res.setHeader("cross-origin-resource-policy", "same-origin");
        const raw = req.url.split("?")[0];
        calls.push({
            path: raw,
            method: req.method,
            selected: selected.manifest.source_commit,
            status: null,
        });
        const call = calls.at(-1);
        res.on("finish", () => {
            call.status = res.statusCode;
            call.completed_body_bytes =
                req.method === "HEAD" || res.statusCode === 304
                    ? 0
                    : Number(res.getHeader("content-length") ?? 0);
        });
        if (
            (raw.includes("%") && !raw.startsWith("/v1/")) ||
            raw.includes("\\") ||
            raw.split("/").some((part) => part === ".." || part === ".")
        )
            return json(res, { error: "invalid_path" }, 400);
        const cookie = /(?:^|; )fixture_session=([^;]+)/.exec(
            req.headers.cookie ?? "",
        )?.[1];
        const session = sessions.get(cookie);
        if (raw.startsWith("/v1/") || raw.startsWith("/api/cloud/auth/")) {
            if (raw !== "/v1/hosted/runtime-context" && !session)
                return json(res, { error: "session_required" }, 401);
            if (
                session &&
                !["GET", "HEAD"].includes(req.method) &&
                (req.headers.origin !== origin ||
                    req.headers["x-animama-csrf"] !== session.csrf)
            )
                return json(res, { error: "csrf_required" }, 403);
            if (session) {
                try {
                    if (await clips.handle(req, res, raw, session)) return;
                } catch (error) {
                    return json(
                        res,
                        {
                            error: "invalid_clip_fixture_request",
                            detail: error.message,
                        },
                        400,
                    );
                }
            }
            if (
                session &&
                req.method === "GET" &&
                raw === "/v1/animas" &&
                session.roster
            )
                return json(res, [session.state.anima]);
            if (
                session &&
                req.method === "GET" &&
                raw === "/v1/animas/fixture-anima/runtime"
            )
                return json(res, runtime);
            if (
                session &&
                req.method === "POST" &&
                raw.startsWith("/v1/animas/fixture-anima/runtime/revisions/")
            )
                return json(res, { ok: true });
            if (
                session &&
                req.method === "GET" &&
                raw === "/v1/animas/fixture-anima/loadout"
            )
                return json(res, {
                    anima_id: "fixture-anima",
                    revision: 1,
                    bindings: [],
                });
            if (session && raw === "/v1/model-assets" && req.method === "GET")
                return json(res, { assets: [], free_bytes: 1024 ** 3 });
            if (
                session &&
                ["GET", "HEAD"].includes(req.method) &&
                raw === "/v1/content/runtime-fixture/avatar.vrm" &&
                vrm
            ) {
                res.writeHead(200, {
                    "content-type": "application/octet-stream",
                    "content-length": vrm.length,
                    "cache-control": "private, no-store",
                });
                return res.end(req.method === "HEAD" ? undefined : vrm);
            }
            const upstream = httpRequest(
                new URL(req.url, api.url),
                { method: req.method, headers: req.headers },
                (incoming) => {
                    if (
                        raw === "/api/cloud/auth/logout" &&
                        req.method === "POST" &&
                        incoming.statusCode < 300
                    )
                        sessions.delete(cookie);
                    res.writeHead(incoming.statusCode, incoming.headers);
                    incoming.pipe(res);
                },
            );
            upstream.on("error", () =>
                json(res, { error: "fixture_unavailable" }, 502),
            );
            req.pipe(upstream);
            return;
        }
        if (!["GET", "HEAD"].includes(req.method))
            return json(res, { error: "method_not_allowed" }, 405);
        let entry =
            raw === "/index.html"
                ? {
                      directory: selected.directory,
                      file: selected.manifest.files.find(
                          (file) => file.path === "index.html",
                      ),
                  }
                : inventory.get(raw);
        // These are the shared router's retained routes. Files and API misses never get HTML.
        if (!entry && applicationRoute(raw)) {
            entry = {
                directory: selected.directory,
                file: selected.manifest.files.find(
                    (file) => file.path === "index.html",
                ),
            };
        }
        if (!entry) return json(res, { error: "resource_unavailable" }, 404);
        const { file, directory } = entry;
        // The pinned sentencepiece Emscripten binding constructs JS call wrappers.
        // This applies to its exact trusted module worker, never the entry document.
        if (file.path.endsWith("/tts/workers/inference-worker.js"))
            res.setHeader(
                "content-security-policy",
                CSP.replace(
                    "'wasm-unsafe-eval'",
                    "'wasm-unsafe-eval' 'unsafe-eval'",
                ),
            );
        const etag = `"sha256-${file.sha256}"`;
        res.setHeader("content-type", file.mime_type);
        res.setHeader("etag", etag);
        res.setHeader(
            "cache-control",
            file.cache === "immutable"
                ? "public, max-age=31536000, immutable"
                : "no-cache",
        );
        if (file.range) res.setHeader("accept-ranges", "bytes");
        if (req.headers["if-none-match"] === etag && !req.headers.range) {
            res.writeHead(304);
            return res.end();
        }
        let start = 0,
            end = file.size - 1,
            status = 200;
        if (
            req.headers.range &&
            file.range &&
            (!req.headers["if-range"] || req.headers["if-range"] === etag)
        ) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (!match || (!match[1] && !match[2])) {
                res.writeHead(416, { "content-range": `bytes */${file.size}` });
                return res.end();
            }
            if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
            else {
                start = Number(match[1]);
                end = match[2] ? Math.min(Number(match[2]), end) : end;
            }
            if (
                !Number.isSafeInteger(start) ||
                !Number.isSafeInteger(end) ||
                start > end ||
                start >= file.size
            ) {
                res.writeHead(416, { "content-range": `bytes */${file.size}` });
                return res.end();
            }
            status = 206;
            res.setHeader(
                "content-range",
                `bytes ${start}-${end}/${file.size}`,
            );
        }
        res.setHeader("content-length", Math.max(0, end - start + 1));
        res.writeHead(status);
        if (req.method === "HEAD" || file.size === 0) return res.end();
        createReadStream(path.join(directory, file.path), { start, end }).pipe(
            res,
        );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    api.setOrigin(origin);
    return {
        origin,
        calls,
        apiCalls: api.calls,
        setLocalePreference: api.setLocalePreference,
        setAdmissionState: api.setAdmissionState,
        setNextLocaleOutcome: api.setNextLocaleOutcome,
        setContextFailure: api.setContextFailure,
        holdContextRead: api.holdContextRead,
        holdLocaleWrite: api.holdLocaleWrite,
        clipRecords: clips.records,
        initializeClipFixtures: clips.initialize,
        select: (app) => {
            selected = app;
        },
        admit: async (owner, roster = false) => {
            const admission = api.admit(owner);
            const response = await fetch(
                api.url + "/v1/hosted/runtime-context",
                {
                    headers: { cookie: `fixture_session=${admission.cookie}` },
                },
            );
            const context = await response.json();
            // New owners start with Text-to-Speech off, so only the journeys
            // that turn on voice warm Pocket TTS; its warm-up on every Anima
            // page otherwise saturates a two-core CI runner. A returning owner
            // keeps the settings it saved.
            admission.state.settings.preferences.speech ??= {
                tts_enabled: false,
            };
            sessions.set(admission.cookie, {
                ...admission,
                roster,
                csrf: context.csrf_token,
            });
            return admission;
        },
        close: async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
            await api.close();
        },
    };
}
