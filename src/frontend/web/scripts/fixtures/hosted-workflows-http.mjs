import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

export const hostedCapabilities = {
  schema_version: 2,
  runtime_kind: "hosted",
  chat: true,
  anima_creation: false,
  chat_file_uploads: false,
  provider_credentials: false,
  model_configuration: false,
  model_selection: true,
  model_role_selection: true,
  local_filesystem_administration: false,
  native_features: false,
  offline_speech_enabled: false,
  offline_speech_asset_version: null,
  offline_speech_gpu_asset_version: null,
  companion_safety: {
    enabled: true,
    ai_notice_enabled: true,
    crisis_detection_enabled: true,
    operator_reminder_hours: 1,
  },
  user_file_processing: {
    enabled: false,
    worker_state: "disabled",
    supported_extensions: [],
    last_heartbeat_at: null,
    pack_id: null,
  },
  web_search: { configuration: false, configured: false },
};
const families = {
  "avatar-content": "avatar",
  "appearance-content": "appearance",
  gestures: "gesture",
  poses: "pose",
  reactions: "reaction",
  "particle-effects": "particle_effect",
  "avatar-effects": "avatar_effect",
  "scene-effects": "scene_effect",
  "sound-effects": "sound_effect",
  "voice-content": "voice",
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const future = "2099-01-01T00:00:00Z";
const json = (response, data, status = 200) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
};
const error = (response, code, status) =>
  json(response, { detail: { code } }, status);
const locales = new Set(["en", "ja", "ko", "zh-Hans", "zh-Hant"]);
const visitorCookie = (locale) =>
  `fixture_locale=${locale ?? ""}; Path=/; SameSite=Lax; Max-Age=${locale === null ? 0 : 31536000}`;
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if ((request.headers["content-type"] ?? "").includes("multipart/form-data"))
    return new Request("http://fixture.invalid", {
      method: "POST",
      headers: request.headers,
      body: bytes,
    }).formData();
  return bytes.length ? JSON.parse(bytes.toString()) : {};
}
function ownerState(label) {
  return {
    label,
    profile: { display_name: `${label} account` },
    settings: { theme: "system", preferences: {}, last_active_anima_id: null },
    settingsReadFailure: false,
    animaSettings: { preferences: {} },
    anima: {
      id: "fixture-anima",
      name: `${label} Anima`,
      display_name: `${label} Anima`,
      aggregate_revision: 1,
      chat_profile: { default_model_provider_id: "fixture-model" },
      identity_status: "ready",
      presentation: {
        anima_id: "fixture-anima",
        display_name: `${label} Anima`,
        presentation_revision: "p1",
      },
    },
    items: new Map(),
    files: new Map(),
    saves: new Map(),
    operations: new Map(),
    stages: new Map(),
    entries: new Map(),
    versions: new Map(),
    revision: 1,
    plans: new Map(),
    commits: new Map(),
    chats: new Map(),
    messages: new Map(),
    managerRuns: new Map(),
    currentRun: null,
    quota: false,
    lostSave: false,
    lostCommit: false,
    nextPackageKind: "content",
  };
}

/** Independent HTTP authority fixture. Unknown routes fail; owner identity comes only from its cookie. */
export async function createHostedWorkflowHttp({
  workletSource,
  localeAuthority = false,
} = {}) {
  const sessions = new Map(),
    owners = new Map(),
    calls = [],
    settingsReads = new Map(),
    heldSettingsReads = new Set(),
    contextReads = new Map(),
    localeWrites = new Map(),
    contextFailures = new Map(),
    heldResponses = new Set();
  /** Capture the reply before waiting, so tests can release genuinely stale authority. */
  const hold = (queue, owner) => {
    let start, release, complete;
    const started = new Promise((resolve) => {
      start = resolve;
    });
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    const completed = new Promise((resolve) => {
      complete = resolve;
    });
    const held = {
      start,
      wait,
      complete,
      release: () => {
        heldResponses.delete(held);
        release();
      },
    };
    heldResponses.add(held);
    if (!queue.has(owner)) queue.set(owner, []);
    queue.get(owner).push(held);
    return { started, completed, release: held.release };
  };
  const ownerFor = (owner) => {
    const state = owners.get(owner);
    if (!state) throw new Error("Unknown fixture owner");
    return state;
  };
  const settingsFor = (state) =>
    localeAuthority
      ? { ...state.settings, locale: state.localePreference ?? null }
      : state.settings;
  let origin,
    workletAvailable = false;
  const voiceConnections = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    const cookie = /(?:^|; )fixture_session=([^;]+)/.exec(
      request.headers.cookie ?? "",
    )?.[1];
    const session = sessions.get(cookie);
    const state = session && owners.get(session.owner);
    const write = !["GET", "HEAD"].includes(request.method);
    const validCsrf = Boolean(
      session && request.headers["x-animama-csrf"] === session.csrf,
    );
    calls.push({
      started_at: new Date().toISOString(),
      path: url.pathname,
      method: request.method,
      owner: session?.owner ?? null,
      csrf: validCsrf,
      origin: request.headers.origin ?? null,
      status: null,
    });
    const call = calls.at(-1);
    response.on("finish", () => {
      call.status = response.statusCode;
      call.completed_at = new Date().toISOString();
    });
    if (url.pathname === "/tts/audio/pcm-processor.worklet.js") {
      if (!workletAvailable)
        return error(response, "fixture_worklet_unavailable", 404);
      response.writeHead(200, { "content-type": "text/javascript" });
      return response.end(workletSource);
    }
    if (url.pathname === "/v1/hosted/runtime-context") {
      const snapshot = {
        schema_version: 1,
        state: session
          ? (state.admissionState ?? "active")
          : localeAuthority
            ? "session_required"
            : "unauthenticated",
        user_id: session?.owner ?? null,
        csrf_token: session?.csrf ?? null,
        recovery_session_id: session?.recovery ?? null,
        capabilities: hostedCapabilities,
        account_url: `${origin}/central-account`,
        ...(localeAuthority
          ? {
              locale: {
                preference: state?.localePreference ?? null,
                // Deliberately retain malformed fixture hints: the emitted app must
                // reject noncanonical inputs independently of this authority.
                visitor:
                  /(?:^|; )fixture_locale=([^;]*)/.exec(
                    request.headers.cookie ?? "",
                  )?.[1] || null,
              },
            }
          : {}),
      };
      const failure = contextFailures.get(session?.owner ?? null);
      call.context_state = snapshot.state;
      if (localeAuthority) call.locale = structuredClone(snapshot.locale);
      const held = contextReads.get(session?.owner ?? null)?.shift();
      held?.start();
      if (held) await held.wait;
      try {
        return failure
          ? error(response, "locale_authority_unavailable", 503)
          : json(response, snapshot);
      } finally {
        held?.complete();
      }
    }
    if (url.pathname === "/api/cloud/auth/login") {
      if (request.method !== "POST" || request.headers.origin !== origin)
        return error(response, "origin_required", 403);
      return json(response, {
        authorization_url: "https://identity.example.test/sign-in",
      });
    }
    if (!session) return error(response, "session_required", 401);
    if (write && (!validCsrf || request.headers.origin !== origin))
      return error(response, "csrf_required", 403);
    try {
      const path = url.pathname,
        method = request.method;
      if (path === "/api/cloud/auth/logout") {
        sessions.delete(cookie);
        return json(response, { ok: true });
      }
      if (path === "/v1/runtime-capabilities")
        return json(response, hostedCapabilities);
      if (path === "/v1/hosted/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: ready\ndata: {}\n\n");
        return; // Match the product's live event connection; EOF is a transport fault.
      }
      if (path === "/v1/hosted/quotas")
        return json(response, { turns: { used: 1, limit: 10 } });
      if (path === "/v1/users/me/profile") {
        if (method === "PATCH")
          Object.assign(state.profile, await body(request));
        return json(response, state.profile);
      }
      if (
        path === "/v1/users/me/settings" ||
        path === "/v1/animas/fixture-anima/settings"
      ) {
        const key = path.includes("users") ? "settings" : "animaSettings";
        if (key === "settings" && method === "GET") {
          const snapshot = structuredClone(settingsFor(state));
          const failed = state.settingsReadFailure;
          const held = settingsReads.get(session.owner)?.shift();
          held?.start();
          if (held) await held.wait;
          try {
            return failed
              ? error(response, "fixture_settings_read_failed", 503)
              : json(response, snapshot);
          } finally {
            held?.complete();
          }
        }
        if (
          key === "settings" &&
          localeAuthority &&
          ["PATCH", "POST", "DELETE"].includes(method)
        ) {
          const input = method === "DELETE" ? {} : await body(request);
          call.body = structuredClone(input);
          const explicitLocale =
            method === "DELETE" || Object.hasOwn(input, "locale");
          const locale = method === "DELETE" ? null : input.locale;
          if (explicitLocale && locale !== null && !locales.has(locale))
            return error(response, "invalid_locale", 422);
          const outcome = explicitLocale ? state.nextLocaleOutcome : null;
          if (explicitLocale) state.nextLocaleOutcome = null;
          if (
            ["locale_conflict", "locale_authority_unavailable"].includes(
              outcome,
            )
          )
            return error(
              response,
              outcome,
              outcome === "locale_conflict" ? 409 : 503,
            );
          if (explicitLocale) state.localePreference = locale;
          if (!outcome) {
            if (method === "DELETE") state.settings = { preferences: {} };
            else Object.assign(state.settings, input);
          }
          const snapshot = structuredClone(settingsFor(state));
          const held = explicitLocale
            ? localeWrites.get(session.owner)?.shift()
            : null;
          held?.start();
          if (held) await held.wait;
          try {
            if (outcome === "lost_response") return response.destroy();
            if (outcome === "locale_save_outcome_unknown")
              return error(response, outcome, 503);
            if (explicitLocale)
              response.setHeader("set-cookie", visitorCookie(locale));
            if (outcome === "locale_saved_settings_failed")
              return error(response, outcome, 409);
            return json(response, snapshot);
          } finally {
            held?.complete();
          }
        }
        if (method === "DELETE") state[key] = { preferences: {} };
        if (method === "PATCH") Object.assign(state[key], await body(request));
        return json(response, state[key]);
      }
      if (path === "/v1/animas") return json(response, []);
      if (path === "/v1/animas/fixture-anima") {
        if (method === "PATCH") {
          const input = await body(request);
          if (
            input.expected_aggregate_revision !== state.anima.aggregate_revision
          )
            return error(response, "anima_revision_conflict", 409);
          Object.assign(state.anima, input.anima);
          state.anima.aggregate_revision++;
        }
        return json(response, state.anima);
      }
      if (
        path === "/v1/animas/fixture-anima/emotional-state" &&
        method === "PUT"
      ) {
        state.anima.emotional_state = await body(request);
        return json(response, state.anima);
      }
      if (
        path === "/v1/memory/anima-memories/fixture-anima:repair" &&
        method === "POST"
      ) {
        const entry = state.entries.get("fixture-memories") ?? {
          id: "fixture-memories",
          entry_id: "fixture-memories",
          version: 1,
          anima_id: "fixture-anima",
          path: "MEMORIES.md",
          content: "Relationship template",
        };
        state.entries.set(entry.id, entry);
        state.versions.set(entry.id, [structuredClone(entry)]);
        return json(response, entry);
      }
      if (path === "/v1/model-providers")
        return json(response, [
          {
            id: "fixture-model",
            model: "fixture-model",
            model_client: "OpenAIResponsesHTTPAgent",
            api_standard: "openai-responses",
            settings: {},
          },
        ]);
      if (path === "/v1/avatar-catalog")
        return json(response, { items: [], next_cursor: null, query: {} });
      if (path === "/v1/chats") {
        if (method === "POST") {
          const input = await body(request),
            chat = {
              ...input,
              id: randomUUID(),
              model_provider_id: "fixture-model",
              api_standard: "openai-responses",
            };
          state.chats.set(chat.id, chat);
          state.messages.set(chat.id, []);
          return json(response, chat);
        }
        return json(response, [...state.chats.values()]);
      }
      if (path === "/v1/chats/search" && method === "POST") {
        const input = await body(request);
        return json(response, {
          results: [...state.messages.values()]
            .flat()
            .filter((item) => item.message.includes(input.query)),
        });
      }
      const chatRoute = /^\/v1\/chats\/([^/]+)(?:\/(messages))?$/.exec(path);
      if (chatRoute) {
        const chat = state.chats.get(chatRoute[1]);
        if (!chat) return error(response, "chat_not_found", 404);
        if (chatRoute[2])
          return json(response, { messages: state.messages.get(chat.id) });
        if (method === "DELETE") {
          state.chats.delete(chat.id);
          state.messages.delete(chat.id);
          response.writeHead(204);
          return response.end();
        }
        if (method === "PATCH") Object.assign(chat, await body(request));
        return json(response, chat);
      }
      if (path === "/v1/animas/fixture-anima/chat:sse" && method === "POST") {
        const input = await body(request),
          chat = state.chats.get(input.chat_id);
        state.lastTurn = input;
        if (!chat) return error(response, "chat_not_found", 404);
        if (state.chatQuota) return error(response, "quota_exceeded", 429);
        const reply = `Fixture reply to ${input.message}`;
        state.messages.get(chat.id).push(
          {
            id: randomUUID(),
            role: "user",
            message: input.message,
            chat_id: chat.id,
          },
          {
            id: randomUUID(),
            role: "assistant",
            message: reply,
            chat_id: chat.id,
          },
        );
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        response.write(
          `event: user_response\ndata: ${JSON.stringify({ run_id: input.run_id, text: reply, is_delta: true, part_final: true })}\n\n`,
        );
        return response.end(
          `event: run_completed\ndata: ${JSON.stringify({ run_id: input.run_id, chat_id: chat.id })}\n\n`,
        );
      }
      if (path === "/v1/content/catalog") {
        if (state.catalogUnavailable)
          return error(response, "temporarily_unavailable", 503);
        return json(response, {
          items: [...state.items.values()],
          scan_required: false,
        });
      }
      if (path === "/v1/content/items/fixture-pending") {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return json(response, { private: state.label });
      }
      const fileMatch = /^\/v1\/content\/files\/([^/]+)$/.exec(path);
      if (fileMatch) {
        const savedFile = state.files.get(fileMatch[1]);
        if (savedFile) {
          response.writeHead(200, {
            "content-type": savedFile.media_type,
            "content-length": savedFile.bytes.length,
          });
          return response.end(savedFile.bytes);
        }
        const itemId = fileMatch[1].replace(/-(good|bad-hash)$/, "");
        if (!state.items.has(itemId))
          return error(response, "content_file_not_found", 404);
        const bytes = Buffer.from(`${state.label} private preview`);
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-length": bytes.length,
        });
        return response.end(
          fileMatch[1].endsWith("-bad-hash")
            ? Buffer.alloc(bytes.length, 42)
            : bytes,
        );
      }
      const itemMatch = /^\/v1\/content\/items\/([^/]+)$/.exec(path);
      if (itemMatch) {
        const item = state.items.get(itemMatch[1]);
        if (!item) return error(response, "content_not_found", 404);
        if (method === "DELETE") {
          if (
            url.searchParams.get("expected_revision") !== item.revision_sha256
          )
            return error(response, "catalog_revision_conflict", 409);
          state.items.delete(itemMatch[1]);
          for (const file of item.files) state.files.delete(file.file_ref);
          return json(response, { deleted: true });
        }
        return json(response, item);
      }
      const typed = /^\/v1\/([^/]+)(?:\/([^/]+))?$/.exec(path);
      const kind = typed && families[typed[1]];
      if (kind) {
        if (method === "GET")
          return json(response, {
            items: [...state.items.values()].filter(
              (item) => item.kind === kind,
            ),
            next_cursor: null,
            query: {},
          });
        if (method === "PUT") {
          const form = await body(request),
            operation = form.get("operation_id");
          if (state.saves.has(operation))
            return json(response, state.saves.get(operation));
          if (state.quota) return error(response, "quota_exceeded", 429);
          const old = state.items.get(form.get("catalog_item_id"));
          if (old && form.get("expected_revision") !== old.revision_sha256)
            return error(response, "catalog_revision_conflict", 409);
          const item = {
            kind,
            item_id: old?.item_id ?? randomUUID(),
            source: "local",
            editable: true,
            logical_key: `local:${kind}:${decodeURIComponent(typed[2])}`,
            name: decodeURIComponent(typed[2]),
            description: null,
            dependencies: [],
            files: [],
            revision_sha256: digest(operation),
            status: "valid",
            diagnostics: [],
            display_name: decodeURIComponent(typed[2]),
            semantic_key: "fixture",
            implementation: { kind: "anima_clip" },
            config: {},
            pose_id: "fixture",
          };
          if (kind === "voice" && form.get("descriptor_json")) {
            const descriptor = JSON.parse(form.get("descriptor_json"));
            item.codec = descriptor.codec;
            item.name = descriptor.name;
            item.metadata = descriptor;
            item.relative_locator = `voices/${decodeURIComponent(typed[2])}`;
            for (const file of old?.files ?? [])
              state.files.delete(file.file_ref);
            item.files = await Promise.all(
              form.getAll("files").map(async (file, ordinal) => {
                const bytes = Buffer.from(await file.arrayBuffer()),
                  file_ref = randomUUID();
                const registered = {
                  file_ref,
                  filename: file.name,
                  logical_path: file.name,
                  role: descriptor.files.find(
                    (entry) => entry.path === file.name,
                  )?.role,
                  media_type: file.type || "application/octet-stream",
                  size_bytes: bytes.length,
                  sha256: digest(bytes),
                  ordinal,
                };
                state.files.set(file_ref, { ...registered, bytes });
                return registered;
              }),
            );
          }
          state.items.set(item.item_id, item);
          state.saves.set(operation, item);
          if (state.lostSave) {
            state.lostSave = false;
            return response.destroy();
          }
          return json(response, item);
        }
      }
      const preview = /^\/v1\/([^/]+)\/([^/]+):preview$/.exec(path);
      if (preview && families[preview[1]]) {
        const item = state.items.get(preview[2]);
        if (!item) return error(response, "content_not_found", 404);
        const bytes = Buffer.from(`${state.label} private preview`);
        return json(response, {
          preview_id: "fixture-preview",
          revision_sha256: item.revision_sha256,
          expires_at: future,
          item,
          files: [
            {
              file_ref: `${item.item_id}-good`,
              filename: "preview.txt",
              role: "primary",
              ordinal: 0,
              media_type: "text/plain",
              size_bytes: bytes.length,
              sha256: digest(bytes),
              url: `/v1/content/files/${item.item_id}-good`,
            },
          ],
        });
      }
      const plan =
        /^\/v1\/animas\/fixture-anima\/(avatar|voice|gestures|reactions|idle|appearance):(plan|commit)$/.exec(
          path,
        );
      if (plan) {
        const input = await body(request);
        if (plan[2] === "plan") {
          if (input.expected_revision !== state.revision)
            return error(response, "loadout_revision_conflict", 409);
          const planDigest = digest(
            JSON.stringify({
              family: plan[1],
              revision: state.revision,
              intent: input.intent,
            }),
          );
          state.plans.set(planDigest, {
            revision: state.revision,
            intent: input.intent,
            family: plan[1],
          });
          return json(response, {
            expected_revision: state.revision,
            plan_digest: planDigest,
            diagnostics: [],
            can_commit: true,
            ...input,
          });
        }
        if (state.commits.has(input.idempotency_key))
          return json(response, state.commits.get(input.idempotency_key));
        const reviewed = state.plans.get(input.plan_digest);
        if (
          !reviewed ||
          reviewed.revision !== state.revision ||
          input.expected_revision !== state.revision ||
          reviewed.family !== plan[1] ||
          JSON.stringify(reviewed.intent) !== JSON.stringify(input.intent)
        )
          return error(response, "loadout_revision_conflict", 409);
        state.revision++;
        const result = {
          anima_id: "fixture-anima",
          action: plan[1],
          revision: state.revision,
          aggregate_revision: state.revision,
        };
        state.commits.set(input.idempotency_key, result);
        return json(response, result);
      }
      if (path === "/v1/animas/fixture-anima/loadout")
        return json(response, {
          anima_id: "fixture-anima",
          revision: state.revision,
          aggregate_revision: state.revision,
          gestures: [],
          reactions: [],
          disabled_starter_gestures: [],
          starter_version: 1,
          idle: { default_pool: [], cells: [] },
        });
      if (path === "/v1/memory/anima-identities")
        return json(response, { items: [] });
      if (path === "/v1/memory/entries") {
        if (method === "GET")
          return json(response, {
            entries: [...state.entries.values()],
            next_cursor: null,
          });
        const input = await body(request),
          entry = {
            ...input,
            id: randomUUID(),
            entry_id: randomUUID(),
            version: 1,
          };
        entry.entry_id = entry.id;
        state.entries.set(entry.id, entry);
        state.versions.set(entry.id, [structuredClone(entry)]);
        return json(response, entry);
      }
      const memory =
        /^\/v1\/memory\/entries\/([^/:]+)(?:\/(versions)(?:\/(\d+))?|(:revert))?$/.exec(
          path,
        );
      if (memory) {
        const entry = state.entries.get(memory[1]);
        if (!entry) return error(response, "memory_entry_not_found", 404);
        if (method === "DELETE") {
          state.entries.delete(entry.id);
          return json(response, { deleted: true });
        }
        if (memory[2])
          return json(
            response,
            memory[3]
              ? state.versions.get(entry.id)[Number(memory[3]) - 1]
              : { versions: state.versions.get(entry.id) },
          );
        if (method === "PATCH" || memory[4]) {
          const input = await body(request);
          if (input.expected_version !== entry.version)
            return error(response, "memory_entry_version_conflict", 409);
          Object.assign(
            entry,
            memory[4]
              ? state.versions.get(entry.id)[input.target_version - 1]
              : input,
            { version: entry.version + 1 },
          );
          state.versions.get(entry.id).push(structuredClone(entry));
        }
        return json(response, entry);
      }
      if (path === "/v1/memory/manager/runs/current")
        return json(
          response,
          state.currentRun ? state.managerRuns.get(state.currentRun) : null,
        );
      const startManager =
        /^\/v1\/memory\/manager\/runs(?::(reflect|process-episodes))?$/.exec(
          path,
        );
      if (startManager && method === "POST") {
        if (state.currentRun)
          return error(response, "memory_manager_run_active", 409);
        const input = await body(request),
          runId = randomUUID(),
          kind =
            startManager[1] === "reflect"
              ? "reflection"
              : startManager[1] === "process-episodes"
                ? "episode_processing"
                : "general";
        const snapshot = {
          run: { id: runId, kind, status: "waiting_approval" },
          messages: [
            {
              id: randomUUID(),
              run_id: runId,
              role: "user",
              content: input.message ?? kind,
            },
          ],
          approvals: [
            {
              id: randomUUID(),
              run_id: runId,
              status: "pending",
              can_undo: false,
              target_entry_id: "fixture-memory",
              preview: {
                path: "/animas/fixture-anima/MEMORIES.md",
                operation: "update",
                unified_diff: "fixture diff",
              },
            },
          ],
        };
        state.managerRuns.set(runId, snapshot);
        state.currentRun = runId;
        return json(response, snapshot, 201);
      }
      const manager =
        /^\/v1\/memory\/manager\/runs\/([^/:]+)(?:\/(messages)|:(complete))?$/.exec(
          path,
        );
      if (manager) {
        const snapshot = state.managerRuns.get(manager[1]);
        if (!snapshot)
          return error(response, "memory_manager_run_not_found", 404);
        if (manager[2] === "messages") {
          const input = await body(request);
          snapshot.messages.push({
            id: randomUUID(),
            role: "user",
            content: input.content,
            run_id: snapshot.run.id,
          });
        }
        if (manager[3] === "complete") {
          if (
            snapshot.approvals.some((approval) => approval.status === "pending")
          )
            return error(response, "memory_manager_approval_pending", 409);
          snapshot.run.status = "completed";
          state.currentRun = null;
        }
        return json(response, snapshot);
      }
      const decision =
        /^\/v1\/memory\/manager\/approvals\/([^/:]+):(decide|undo)$/.exec(path);
      if (decision) {
        const snapshot = [...state.managerRuns.values()].find((run) =>
          run.approvals.some((approval) => approval.id === decision[1]),
        );
        const approval = snapshot?.approvals.find(
          (item) => item.id === decision[1],
        );
        if (!approval)
          return error(response, "memory_manager_approval_not_found", 404);
        if (decision[2] === "undo") {
          approval.can_undo = false;
          return json(response, {
            approval,
            target_entry_id: approval.target_entry_id,
            undo_version: 3,
            deleted: false,
          });
        }
        const input = await body(request);
        approval.status =
          input.decision === "approve" ? "approved" : "rejected";
        approval.can_undo = input.decision === "approve";
        approval.applied_version = approval.can_undo ? 2 : null;
        snapshot.run.status = "active";
        return json(response, approval);
      }
      if (path === "/v1/content/package-imports" && method === "POST") {
        const input = await body(request),
          stage = {
            ...input,
            stage_id: randomUUID(),
            state: "uploading",
            active: false,
            received_bytes: 0,
            next_part_index: 0,
            part_size_bytes: 4,
            expires_at: future,
            review: null,
          };
        state.stages.set(stage.stage_id, stage);
        return json(response, stage);
      }
      const packageStage =
        /^\/v1\/content\/package-imports\/([^/]+)(?:\/(parts)\/(\d+)|\/(review|commit))?$/.exec(
          path,
        );
      if (packageStage) {
        const stage = state.stages.get(packageStage[1]);
        if (!stage) return error(response, "package_stage_unavailable", 409);
        if (method === "DELETE") {
          state.stages.delete(stage.stage_id);
          response.writeHead(204);
          return response.end();
        }
        if (packageStage[2]) {
          const bytes = await bodyBytes(request),
            index = Number(packageStage[3]);
          stage.received_bytes += bytes.length;
          stage.next_part_index = index + 1;
          return json(response, {
            stage_id: stage.stage_id,
            index,
            sha256: digest(bytes),
            size_bytes: bytes.length,
            received_bytes: stage.received_bytes,
            next_part_index: index + 1,
            complete: stage.received_bytes === stage.expected_size_bytes,
          });
        }
        if (packageStage[4] === "review") {
          stage.review = {
            ...stage,
            kind: state.nextPackageKind,
            package_sha256: digest(stage.operation_id),
            size_bytes: stage.expected_size_bytes,
            review_digest: digest(stage.stage_id),
            items: [],
            anima: null,
            selected_count: 1,
            required_count: 0,
          };
          return json(response, stage.review);
        }
        if (packageStage[4] === "commit") {
          const input = await body(request);
          if (state.nextPackageKind === "anima")
            return error(response, "anima_creation_unavailable", 403);
          const result = {
            schema_version: 1,
            ...input,
            package_sha256: stage.review.package_sha256,
            items: [],
            anima_id: null,
          };
          state.operations.set(input.operation_id, {
            operation_id: input.operation_id,
            state: "completed",
            result,
          });
          if (state.lostCommit) {
            state.lostCommit = false;
            return response.destroy();
          }
          return json(response, result);
        }
        return json(response, stage);
      }
      const operation = /^\/v1\/content\/package-operations\/([^/]+)$/.exec(
        path,
      );
      if (operation)
        return json(
          response,
          state.operations.get(operation[1]) ?? {
            operation_id: operation[1],
            state: "not_found",
          },
        );
      if (path === "/v1/content/package-exports:summary")
        return json(response, {
          schema_version: 1,
          digest: digest(state.label),
          summary: { kind: "content", selected_count: 1, required_count: 0 },
          total_bytes: 4,
        });
      if (path === "/v1/content/package-exports" && method === "POST")
        return json(response, {
          export_id: "fixture-export",
          filename: "content.zip",
          size_bytes: 4,
          sha256: digest("zip!"),
          expires_at: future,
          url: "/v1/content/package-exports/fixture-export/file",
        });
      if (path === "/v1/content/package-exports/fixture-export/file") {
        response.writeHead(200, { "content-type": "application/zip" });
        return response.end("zip!");
      }
      if (
        path === "/v1/content/package-exports/fixture-export" &&
        method === "DELETE"
      ) {
        response.writeHead(204);
        return response.end();
      }
      return error(response, "unimplemented_fixture_route", 404);
    } catch (cause) {
      error(response, `fixture_failure:${cause.message}`, 500);
    }
  });
  // Real browser socket/handshake, with no provider or synthetic audio output.
  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url, "http://fixture.invalid");
    const cookie = /(?:^|; )fixture_session=([^;]+)/.exec(
      request.headers.cookie ?? "",
    )?.[1];
    const session = sessions.get(cookie);
    if (
      !session ||
      request.headers.origin !== origin ||
      url.pathname !== "/v1/voice/streams/fixture" ||
      url.search
    )
      return socket.destroy();
    const accept = createHash("sha1")
      .update(
        `${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest("base64");
    const record = {
      owner: session.owner,
      origin: request.headers.origin,
      path: url.pathname,
      query: url.search,
      closed: false,
    };
    voiceConnections.push(record);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (data) => {
      if ((data[0] & 15) === 8) socket.end(Buffer.from([0x88, 0]));
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      record.closed = true;
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    voiceConnections,
    setLocalePreference: (owner, locale) => {
      ownerFor(owner).localePreference = locale;
    },
    setAdmissionState: (owner, value) => {
      ownerFor(owner).admissionState = value;
    },
    setNextLocaleOutcome: (owner, value) => {
      if (
        ![
          "locale_conflict",
          "locale_authority_unavailable",
          "locale_save_outcome_unknown",
          "locale_saved_settings_failed",
          "lost_response",
        ].includes(value)
      )
        throw new Error("Unknown locale outcome");
      ownerFor(owner).nextLocaleOutcome = value;
    },
    setContextFailure: (owner, failed) => {
      contextFailures.set(owner, failed);
    },
    holdContextRead: (owner = null) => hold(contextReads, owner),
    holdLocaleWrite: (owner) => {
      ownerFor(owner);
      return hold(localeWrites, owner);
    },
    setWorkletAvailable: (value) => {
      workletAvailable = value;
    },
    setOrigin: (value) => {
      origin = value;
    },
    admit: (owner = randomUUID()) => {
      if (!owners.has(owner)) owners.set(owner, ownerState(owner));
      const cookie = randomUUID();
      sessions.set(cookie, {
        owner,
        csrf: randomUUID(),
        recovery: randomUUID(),
      });
      return { cookie, state: owners.get(owner), owner };
    },
    /** Hold one actual HTTP read, including its original snapshot, until released. */
    holdSettingsRead: (owner) => {
      if (!owners.has(owner)) throw new Error("Unknown fixture owner");
      let start, release, complete;
      const started = new Promise((resolve) => {
        start = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      const completed = new Promise((resolve) => {
        complete = resolve;
      });
      const held = {
        start,
        wait,
        complete,
        release: () => {
          heldSettingsReads.delete(held);
          release();
        },
      };
      heldSettingsReads.add(held);
      if (!settingsReads.has(owner)) settingsReads.set(owner, []);
      settingsReads.get(owner).push(held);
      return { started, completed, release: held.release };
    },
    close: () => {
      for (const held of heldSettingsReads) held.release();
      for (const held of heldResponses) held.release();
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      });
    },
  };
}
async function bodyBytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}
