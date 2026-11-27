import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedComposition } from "./hosted-composition";
import { hostedCapabilitiesFixture as capabilities } from "../runtime/runtime-fixture";
import { RuntimeController } from "../runtime/runtime-controller";
import { queryKeys } from "@/query/keys";

const active = {
  schema_version: 1,
  state: "active",
  user_id: "owner",
  csrf_token: "fixture-csrf",
  recovery_session_id: "fixture-session-generation-one",
  capabilities,
  account_url: "https://accounts.example.test/",
};
function fixture(context = active) {
  const calls: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    calls.push(request);
    if (new URL(request.url).pathname === "/v1/hosted/runtime-context")
      return Response.json(context);
    if (new URL(request.url).pathname === "/api/cloud/auth/login")
      return Response.json({
        authorization_url: "https://identity.example.test/sign-in",
      });
    return Response.json({ ok: true });
  });
  const navigate = vi.fn();
  const composition = createHostedComposition({
    baseUrl: "https://app.example.test",
    fetch,
    navigate,
  });
  return { composition, calls, navigate, fetch };
}

function installReloadStorage() {
  const sessionRows = new Map<string, string>();
  const draftRows = new Map<string, string>();
  const storage = (rows: Map<string, string>) => ({
    get length() {
      return rows.size;
    },
    key: (index: number) => [...rows.keys()][index] ?? null,
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
  });
  vi.stubGlobal("window", {
    sessionStorage: storage(sessionRows),
    localStorage: storage(draftRows),
  });
  vi.stubGlobal("performance", {
    getEntriesByType: () => [{ type: "reload" }],
  });
  return { sessionRows, draftRows };
}

describe("hosted admission and transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recovers the original draft namespace after reload without persisting credentials", async () => {
    const rows = new Map<string, string>();
    const sessionStorage = {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => rows.set(key, value),
      removeItem: (key: string) => rows.delete(key),
    };
    vi.stubGlobal("window", { sessionStorage });
    vi.stubGlobal("performance", {
      getEntriesByType: () => [{ type: "reload" }],
    });
    const first = await fixture().composition.readAdmission();
    const reloaded = await fixture().composition.readAdmission();
    expect(
      first.status === "ready" &&
        reloaded.status === "ready" &&
        first.session.key,
    ).toBe(reloaded.status === "ready" && reloaded.session.key);
    expect([...rows.values()].join(" ")).not.toContain(active.csrf_token);
  });

  it("isolates a new tab even when its opener cloned session storage", async () => {
    const rows = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => rows.get(key) ?? null,
        setItem: (key: string, value: string) => rows.set(key, value),
        removeItem: (key: string) => rows.delete(key),
      },
    });
    vi.stubGlobal("performance", {
      getEntriesByType: () => [{ type: "navigate" }],
    });
    const first = await fixture().composition.readAdmission();
    const otherTab = await fixture().composition.readAdmission();
    expect(
      first.status === "ready" &&
        otherTab.status === "ready" &&
        first.session.key !== otherTab.session.key,
    ).toBe(true);
  });

  it("notifies other hosted views before a delayed remote logout settles", async () => {
    const messages = vi.fn();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      localStorage: { length: 0, key: () => null },
    });
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        postMessage = messages;
        close = vi.fn();
        onmessage = null;
      },
    );
    const { composition, fetch } = fixture();
    await composition.readAdmission();
    const unsubscribe = composition.subscribe!(vi.fn());
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = composition.accountActions!.signOut();
    try {
      expect(messages).toHaveBeenCalledWith({ type: "signed-out" });
    } finally {
      finish(Response.json({ ok: true }));
      await pending;
      unsubscribe();
      vi.unstubAllGlobals();
    }
  });
  it("never lets the browser keep the composition's own session and admission requests", async () => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      localStorage: { length: 0, key: () => null },
    });
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        postMessage = vi.fn();
        close = vi.fn();
        onmessage = null;
      },
    );
    const { composition, calls, fetch } = fixture();
    // The age confirmation answers with the runtime context that follows it.
    const base = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input: RequestInfo | URL) => {
      if (
        new URL((input as Request).url).pathname !==
        "/v1/hosted/age-confirmation"
      )
        return base(input);
      calls.push(input as Request);
      return Response.json(active);
    });
    const controller = new RuntimeController(composition);
    const unsubscribe = composition.subscribe!(vi.fn());
    try {
      await controller.refresh();
      await vi.waitFor(() =>
        expect(
          calls.some(
            (call) => new URL(call.url).pathname === "/v1/hosted/events",
          ),
        ).toBe(true),
      );
      await composition.confirmAge!();
      await composition.accountActions!.signOut();
      const hosted = calls.filter((call) => {
        const path = new URL(call.url).pathname;
        return path.startsWith("/v1/hosted/") || path.startsWith("/api/cloud/");
      });
      expect(new Set(hosted.map((call) => new URL(call.url).pathname))).toEqual(
        new Set([
          "/v1/hosted/runtime-context",
          "/v1/hosted/events",
          "/v1/hosted/age-confirmation",
          "/api/cloud/auth/logout",
        ]),
      );
      expect(hosted.every((call) => call.cache === "no-store")).toBe(true);
    } finally {
      unsubscribe();
      controller.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("refreshes an explicitly reauthenticated lifetime even when owner and CSRF are unchanged", async () => {
    const { composition } = fixture();
    const first = await composition.readAdmission();
    composition.accountActions!.signIn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await composition.readAdmission();
    expect(
      first.status === "ready" &&
        second.status === "ready" &&
        first.session.key !== second.session.key,
    ).toBe(true);
  });

  it("ends private work when a CRLF-framed server event revokes admission", async () => {
    let state = "active";
    let events!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        events = controller;
      },
    });
    const fetch: typeof globalThis.fetch = async (input) =>
      new URL((input as Request).url).pathname === "/v1/hosted/events"
        ? new Response(stream)
        : Response.json({ ...active, state });
    const composition = createHostedComposition({
      baseUrl: "https://app.example.test",
      fetch,
      navigate: vi.fn(),
    });
    const controller = new RuntimeController(composition);
    const unsubscribe = composition.subscribe!((invalidate) => {
      void controller.refresh(false, invalidate);
    });
    try {
      await controller.refresh();
      const old = controller.getSnapshot().scope!;
      state = "restricted";
      events.enqueue(
        new TextEncoder().encode("event: revoked\r\ndata: {}\r\n\r\n"),
      );
      await vi.waitFor(() => expect(old.controller.signal.aborted).toBe(true));
      await vi.waitFor(() =>
        expect(controller.getSnapshot().admission.status).toBe("restricted"),
      );
    } finally {
      unsubscribe();
      controller.dispose();
    }
  });

  it.each([
    ["a revoked event", "event"],
    ["an events 403", "forbidden"],
  ] as const)(
    "keeps private work when %s is not confirmed by the runtime context",
    async (_label, signal) => {
      let streams = 0;
      let contextReads = 0;
      let events!: ReadableStreamDefaultController<Uint8Array>;
      const fetch: typeof globalThis.fetch = async (input) => {
        const path = new URL((input as Request).url).pathname;
        if (path === "/v1/hosted/runtime-context") {
          contextReads += 1;
          return Response.json(active);
        }
        if (path !== "/v1/hosted/events") return Response.json({ ok: true });
        streams += 1;
        if (signal === "forbidden" && streams === 1)
          return new Response(null, { status: 403 });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              events = controller;
            },
          }),
        );
      };
      const composition = createHostedComposition({
        baseUrl: "https://app.example.test",
        fetch,
        navigate: vi.fn(),
      });
      const controller = new RuntimeController(composition);
      const unsubscribe = composition.subscribe!((invalidate) => {
        void controller.refresh(false, invalidate);
      });
      try {
        await controller.refresh();
        const original = controller.getSnapshot();
        original.queryClient.setQueryData(["draft"], "retain");
        const readsBefore = contextReads;
        if (signal === "event") {
          await vi.waitFor(() => expect(events).toBeDefined());
          events.enqueue(new TextEncoder().encode("event: revoked\n\n"));
        }
        // The signal prompts a fresh context read, which keeps the session.
        await vi.waitFor(() =>
          expect(contextReads).toBeGreaterThan(readsBefore),
        );
        await vi.waitFor(() =>
          expect(controller.getSnapshot().reconnecting).toBe(false),
        );
        const current = controller.getSnapshot();
        const resumed = await current.scope!.fetch(
          new Request("https://app.example.test/v1/chats"),
        );
        expect(resumed.ok).toBe(true);
        expect(original.scope!.controller.signal.aborted).toBe(false);
        expect(current.scope).toBe(original.scope);
        expect(current.queryClient.getQueryData(["draft"])).toBe("retain");
      } finally {
        unsubscribe();
        controller.dispose();
      }
    },
  );

  it.each(["network", "server", "eof"])(
    "retains private work through an events %s fault and failed context refresh",
    async (failure) => {
      let online = true;
      const fetch: typeof globalThis.fetch = async (input) => {
        const path = new URL((input as Request).url).pathname;
        if (path === "/v1/hosted/events") {
          online = false;
          if (failure === "network") throw new TypeError("Offline");
          return new Response(failure === "eof" ? "" : null, {
            status: failure === "server" ? 503 : 200,
          });
        }
        if (!online) throw new TypeError("Offline");
        return Response.json(active);
      };
      const composition = createHostedComposition({
        baseUrl: "https://app.example.test",
        fetch,
        navigate: vi.fn(),
      });
      const controller = new RuntimeController(composition);
      await controller.refresh();
      const original = controller.getSnapshot().scope!;
      controller.getSnapshot().queryClient.setQueryData(["draft"], "retain");
      const unsubscribe = composition.subscribe!((invalidate) => {
        void controller.refresh(false, invalidate);
      });
      try {
        await vi.waitFor(() =>
          expect(controller.getSnapshot().reconnecting).toBe(true),
        );
        expect(controller.getSnapshot().scope).toBe(original);
        expect(original.controller.signal.aborted).toBe(false);
        expect(
          controller.getSnapshot().queryClient.getQueryData(["draft"]),
        ).toBe("retain");
        await expect(
          original.fetch("/v1/chats", { method: "POST" }),
        ).rejects.toThrow("reconnecting");
        online = true;
        await controller.refresh();
        expect(controller.getSnapshot().scope).toBe(original);
        expect(controller.getSnapshot().reconnecting).toBe(false);
      } finally {
        unsubscribe();
        controller.dispose();
      }
    },
  );

  it.each(["server", "eof"])(
    "does not let repeated events %s failures abort a slow healthy admission read",
    async (failure) => {
      vi.useFakeTimers();
      let reads = 0;
      let aborted = 0;
      const fetch: typeof globalThis.fetch = async (input) => {
        const request = input as Request;
        if (new URL(request.url).pathname === "/v1/hosted/events")
          return new Response(failure === "eof" ? "" : null, {
            status: failure === "server" ? 503 : 200,
          });
        if (++reads === 1) return Response.json(active);
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(Response.json(active)), 2_500);
          request.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            ++aborted;
            reject(new DOMException("Admission superseded", "AbortError"));
          });
        });
      };
      const composition = createHostedComposition({
        baseUrl: "https://app.example.test",
        fetch,
        navigate: vi.fn(),
      });
      const controller = new RuntimeController(composition);
      await controller.refresh();
      const original = controller.getSnapshot();
      original.queryClient.setQueryData(["draft"], "original-operation");
      const unsubscribe = composition.subscribe!((invalidate) => {
        void controller.refresh(false, invalidate);
      });
      try {
        await vi.advanceTimersByTimeAsync(2_500);
        expect(aborted).toBe(0);
        expect(reads).toBe(2);
        expect(controller.getSnapshot().scope).toBe(original.scope);
        expect(controller.getSnapshot().reconnecting).toBe(false);
        expect(original.queryClient.getQueryData(["draft"])).toBe(
          "original-operation",
        );
      } finally {
        unsubscribe();
        controller.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("retains admission backoff despite repeated uncertain events notifications", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const reads: number[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      if (new URL((input as Request).url).pathname === "/v1/hosted/events")
        return new Response(null, { status: 503 });
      reads.push(Date.now() - started);
      if (reads.length === 1) return Response.json(active);
      throw new TypeError("Context temporarily unavailable");
    };
    const composition = createHostedComposition({
      baseUrl: "https://app.example.test",
      fetch,
      navigate: vi.fn(),
    });
    const controller = new RuntimeController(composition);
    await controller.refresh();
    const original = controller.getSnapshot().scope;
    const unsubscribe = composition.subscribe!((invalidate) => {
      void controller.refresh(false, invalidate);
    });
    try {
      await vi.advanceTimersByTimeAsync(61_000);
      expect(reads).toEqual([
        0, 0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000,
      ]);
      expect(controller.getSnapshot().scope).toBe(original);
      expect(controller.getSnapshot().reconnecting).toBe(true);
    } finally {
      unsubscribe();
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["unknown", undefined, "recovery", "bootstrap_required", "paused"])(
    "preserves persisted ambiguous recovery through an initial %s context after reload",
    async (state) => {
      const { sessionRows, draftRows } = installReloadStorage();
      const first = await fixture().composition.readAdmission();
      expect(first.status).toBe("ready");
      if (first.status !== "ready")
        throw new Error("Initial admission missing");
      const key = `animama:action-editor:${encodeURIComponent(first.session.key)}:gesture`;
      const draft = JSON.stringify({ operationId: "original-ambiguous-save" });
      draftRows.set(key, draft);
      const context: Record<string, unknown> = { ...active };
      if (state === undefined) delete context.state;
      else context.state = state;
      const reloaded = fixture(context as typeof active);
      expect((await reloaded.composition.readAdmission()).status).not.toBe(
        "ready",
      );
      await expect(
        reloaded.composition.browserFetch("/v1/poses", { method: "POST" }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(draftRows.get(key)).toBe(draft);
      expect(sessionRows.get("animama.hosted-recovery.v1")).toContain(
        first.session.key,
      );
      reloaded.fetch.mockResolvedValueOnce(Response.json(active));
      const recovered = await reloaded.composition.readAdmission();
      expect(recovered.status === "ready" && recovered.session.key).toBe(
        first.session.key,
      );
      expect(draftRows.get(key)).toBe(draft);
    },
  );

  it.each([
    ["session_required", 200],
    ["ineligible", 200],
    ["restricted", 200],
    ["deletion_pending", 200],
    ["unauthorized", 401],
    ["forbidden", 403],
  ] as const)(
    "purges reload recovery on authoritative %s denial",
    async (state, status) => {
      const { sessionRows, draftRows } = installReloadStorage();
      const first = await fixture().composition.readAdmission();
      if (first.status !== "ready")
        throw new Error("Initial admission missing");
      const key = `animama:action-editor:${encodeURIComponent(first.session.key)}:gesture`;
      draftRows.set(
        key,
        JSON.stringify({ operationId: "original-ambiguous-save" }),
      );
      const reloaded = fixture({ ...active, state });
      if (status !== 200)
        reloaded.fetch.mockResolvedValueOnce(new Response(null, { status }));
      expect((await reloaded.composition.readAdmission()).status).not.toBe(
        "ready",
      );
      expect(draftRows.has(key)).toBe(false);
      expect(sessionRows.has("animama.hosted-recovery.v1")).toBe(false);
    },
  );

  it("keeps an open session and its drafts through a transient paused context", async () => {
    const context = { ...active };
    const { composition } = fixture(context);
    const controller = new RuntimeController(composition);
    await controller.refresh();
    const original = controller.getSnapshot();
    original.queryClient.setQueryData(["draft"], "retain");
    context.state = "paused";
    await controller.refresh();
    try {
      expect(controller.getSnapshot().scope).toBe(original.scope);
      expect(original.scope!.controller.signal.aborted).toBe(false);
      expect(controller.getSnapshot().reconnecting).toBe(true);
      context.state = "active";
      await controller.refresh();
      expect(controller.getSnapshot().scope).toBe(original.scope);
      expect(controller.getSnapshot().reconnecting).toBe(false);
      expect(original.queryClient.getQueryData(["draft"])).toBe("retain");
    } finally {
      controller.dispose();
    }
  });

  it.each([401, 403])(
    "retires ready admission on authoritative context HTTP %s",
    async (status) => {
      const { composition, fetch } = fixture();
      const controller = new RuntimeController(composition);
      await controller.refresh();
      const old = controller.getSnapshot().scope!;
      fetch.mockResolvedValueOnce(new Response(null, { status }));
      await controller.refresh();
      expect(old.controller.signal.aborted).toBe(true);
      expect(controller.getSnapshot().admission.status).toBe(
        "sign-in-required",
      );
    },
  );
  it("reads only hosted admission and retains a lifetime during an unchanged authority read", async () => {
    const { composition, calls } = fixture();
    const first = await composition.readAdmission();
    const second = await composition.readAdmission();
    expect(first.status).toBe("ready");
    expect(second).toEqual(first);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/hosted/runtime-context",
      "/v1/hosted/runtime-context",
    ]);
    expect(
      calls.every(
        (call) =>
          call.credentials === "same-origin" &&
          call.cache === "no-store" &&
          call.redirect === "error",
      ),
    ).toBe(true);
  });

  it("keeps a product request's own cache mode, so the server's policy decides what is kept", async () => {
    const { composition, calls } = fixture();
    await composition.readAdmission();
    const product = composition.transport.fetch;
    await product("/v1/content/catalog", { cache: "no-cache" });
    await product(
      new Request("https://app.example.test/v1/content/files/f1", {
        cache: "no-cache",
      }),
    );
    await product("/v1/animas/a1/runtime/revisions/r1/bundles/b1");
    const modes = Object.fromEntries(
      calls.map((call) => [new URL(call.url).pathname, call.cache]),
    );
    expect(modes).toEqual({
      "/v1/hosted/runtime-context": "no-store",
      "/v1/content/catalog": "no-cache",
      "/v1/content/files/f1": "no-cache",
      "/v1/animas/a1/runtime/revisions/r1/bundles/b1": "default",
    });
  });

  it("uses a fresh lifetime when the same owner reauthenticates", async () => {
    const context = { ...active };
    const { composition } = fixture(context);
    const first = await composition.readAdmission();
    context.csrf_token = "reauthenticated-fixture";
    context.recovery_session_id = "fixture-session-generation-two";
    const second = await composition.readAdmission();
    expect(
      first.status === "ready" &&
        second.status === "ready" &&
        first.session.key !== second.session.key,
    ).toBe(true);
  });

  it("retains draft identity across a CSRF refresh within the same authenticated session", async () => {
    const context = { ...active };
    const { composition } = fixture(context);
    const first = await composition.readAdmission();
    context.csrf_token = "refreshed-csrf";
    expect(await composition.readAdmission()).toEqual(first);
  });

  it.each([
    ["session_required", "sign-in-required"],
    ["ineligible", "ineligible"],
    ["paused", "restricted"],
    ["restricted", "restricted"],
    ["deletion_pending", "restricted"],
    ["recovery", "recovery"],
    ["bootstrapping", "loading"],
    ["identity_unavailable", "unavailable"],
    ["unknown", "unavailable"],
  ])("withholds private product dispatch in %s", async (state, expected) => {
    const { composition, calls } = fixture({ ...active, state });
    expect((await composition.readAdmission()).status).toBe(expected);
    await expect(composition.browserFetch("/v1/animas")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls).toHaveLength(1);
  });

  it("fails closed for old, absent and incompatible capability schemas", async () => {
    for (const bad of [
      { ...capabilities, schema_version: 1 },
      undefined,
      { ...capabilities, anima_creation: true },
      { ...capabilities, automatic_episode_processing: true },
      { ...capabilities, chatgpt_plan: true },
      { ...capabilities, content_generation: true },
    ]) {
      const { composition } = fixture({
        ...active,
        capabilities: bad,
      } as typeof active);
      expect((await composition.readAdmission()).status).toBe("unavailable");
    }
  });

  it("refuses Gemini voice, which needs the owner's own key", async () => {
    const { composition } = fixture({
      ...active,
      capabilities: {
        ...capabilities,
        gemini_tts: {
          models: ["gemini-3.8-flash-lite-tts"],
          default_model: "gemini-3.8-flash-lite-tts",
          voices: ["Kore"],
          default_voice: "Kore",
        },
      },
    } as typeof active);
    expect(await composition.readAdmission()).toMatchObject({
      status: "unavailable",
      message: "This hosted runtime has incompatible application capabilities.",
    });
  });

  it("admits operator-provisioned web search but never owner search settings", async () => {
    const operatorSearch = {
      configuration: false,
      configured: true,
      backend: "brave",
      credential_state: "configured",
    };
    const admitted = await fixture({
      ...active,
      capabilities: { ...capabilities, web_search: operatorSearch },
    } as typeof active).composition.readAdmission();
    expect(
      admitted.status === "ready" && admitted.capabilities.web_search,
    ).toEqual(operatorSearch);
    const administered = await fixture({
      ...active,
      capabilities: {
        ...capabilities,
        web_search: { ...operatorSearch, configuration: true },
      },
    } as typeof active).composition.readAdmission();
    expect(administered.status).toBe("unavailable");
  });

  it("uses cookie and current CSRF authority for explicit SDK, byte and streaming requests", async () => {
    const { composition, calls } = fixture();
    const controller = new RuntimeController(composition);
    await controller.refresh();
    await composition.browserFetch("/v1/chats", {
      method: "POST",
      headers: { Authorization: "Bearer ignored" },
      body: "{}",
    });
    const request = calls.at(-1)!;
    expect(request.headers.get("X-Animama-CSRF")).toBe("fixture-csrf");
    expect(request.headers.has("Authorization")).toBe(false);
    expect(request.credentials).toBe("same-origin");
    await expect(
      controller
        .getSnapshot()
        .scope!.fetch("https://other.example.test/v1/chats"),
    ).rejects.toThrow("application origin");
  });

  it("repairs only reported hosted bootstrap/recovery, never installation bootstrap", async () => {
    const { composition, calls } = fixture({ ...active, state: "recovery" });
    expect((await composition.readAdmission()).status).toBe("recovery");
    expect(calls).toHaveLength(1);
    await composition.repair();
    await vi.waitFor(() =>
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/v1/hosted/runtime-context",
        "/v1/hosted/runtime-context",
        "/v1/hosted/bootstrap:ensure",
      ]),
    );
    const body = (await calls[2].json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["idempotency_key"]);
    expect(calls[2].headers.get("X-Animama-CSRF")).toBe("fixture-csrf");
  });

  it("offers account navigation only for a validated admission URL", async () => {
    const { composition, navigate } = fixture();
    expect(composition.accountAffordances!().canOpenAccount).toBe(false);
    await composition.readAdmission();
    expect(composition.accountAffordances!().canOpenAccount).toBe(true);
    composition.accountActions!.openAccount();
    expect(navigate).toHaveBeenCalledWith("https://accounts.example.test/");
    for (const accountUrl of [
      undefined,
      null,
      "javascript:alert(1)",
      "http://accounts.example.test/",
      "https://user:secret@accounts.example.test/",
    ]) {
      const missing = fixture({
        ...active,
        account_url: accountUrl,
      } as unknown as typeof active);
      await missing.composition.readAdmission();
      expect(missing.composition.accountAffordances!().canOpenAccount).toBe(
        false,
      );
      expect(() => missing.composition.accountActions!.openAccount()).toThrow(
        "Account access is unavailable",
      );
    }
  });
});

/** A signed-in account whose server-owned setup the test controls. */
function setupFlow(
  initial: string,
  ensure: (key: string, sent: number) => Response | Promise<Response>,
) {
  const state = { value: initial };
  const keys: string[] = [];
  let contextReads = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    if (path === "/v1/hosted/runtime-context") {
      contextReads += 1;
      return Response.json({ ...active, state: state.value });
    }
    if (path === "/v1/hosted/bootstrap:ensure") {
      const body = (await request.json()) as { idempotency_key: string };
      keys.push(body.idempotency_key);
      return ensure(body.idempotency_key, keys.length);
    }
    if (path === "/v1/hosted/events")
      return new Response(new ReadableStream<Uint8Array>());
    return Response.json({ ok: true });
  };
  const composition = createHostedComposition({
    baseUrl: "https://app.example.test",
    fetch,
    navigate: vi.fn(),
  });
  const controller = new RuntimeController(composition);
  const views: string[] = [];
  controller.subscribe(() => {
    const admission = controller.getSnapshot().admission;
    views.push(
      admission.status === "loading" && admission.message
        ? `loading: ${admission.message}`
        : admission.status,
    );
  });
  const unsubscribe = composition.subscribe!((invalidate) => {
    void controller.refresh(false, invalidate);
  });
  return {
    state,
    keys,
    views,
    controller,
    contextReads: () => contextReads,
    status: () => controller.getSnapshot().admission.status,
    close: () => {
      unsubscribe();
      controller.dispose();
    },
  };
}
const setupAnswer = () => Response.json({ state: "active", ready: true });

describe("hosted account setup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets up a signed-in first-use account automatically, then admits it", async () => {
    const flow = setupFlow("bootstrap_required", () => {
      flow.state.value = "active";
      return setupAnswer();
    });
    try {
      await flow.controller.refresh();
      await vi.waitFor(() => expect(flow.status()).toBe("ready"));
      expect(flow.views).toContain("loading: Setting up your account…");
      expect(flow.views).not.toContain("recovery");
      expect(flow.keys).toHaveLength(1);
    } finally {
      flow.close();
    }
  });

  it("replays the same idempotency key after a lost reply", async () => {
    vi.useFakeTimers();
    const flow = setupFlow("bootstrap_required", (_key, sent) => {
      if (sent === 1) throw new TypeError("Failed to fetch");
      flow.state.value = "active";
      return setupAnswer();
    });
    try {
      await flow.controller.refresh();
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(flow.status()).toBe("ready"));
      expect(flow.keys).toHaveLength(2);
      expect(flow.keys[1]).toBe(flow.keys[0]);
    } finally {
      flow.close();
    }
  });

  it("offers recovery after an unanswered attempt and replays its key on retry", async () => {
    vi.useFakeTimers();
    let online = false;
    const flow = setupFlow("bootstrap_required", () => {
      if (!online) throw new TypeError("Failed to fetch");
      flow.state.value = "active";
      return setupAnswer();
    });
    try {
      await flow.controller.refresh();
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.waitFor(() => expect(flow.status()).toBe("recovery"));
      expect(flow.keys).toHaveLength(3);
      // Ordinary reads do not repeat an automatic attempt that already failed.
      await flow.controller.refresh();
      expect(flow.status()).toBe("recovery");
      expect(flow.keys).toHaveLength(3);
      online = true;
      await flow.controller.refresh(true);
      await vi.waitFor(() => expect(flow.status()).toBe("ready"));
      expect(flow.keys).toHaveLength(4);
      expect(flow.keys[3]).toBe(flow.keys[0]);
    } finally {
      flow.close();
    }
  });

  it("starts a person's retry with a new key once the server answered", async () => {
    const flow = setupFlow("bootstrap_required", (_key, sent) => {
      if (sent === 1)
        return Response.json(
          { state: "identity_unavailable" },
          { status: 503 },
        );
      flow.state.value = "active";
      return setupAnswer();
    });
    try {
      await flow.controller.refresh();
      await vi.waitFor(() => expect(flow.status()).toBe("recovery"));
      expect(flow.keys).toHaveLength(1);
      await flow.controller.refresh(true);
      await vi.waitFor(() => expect(flow.status()).toBe("ready"));
      expect(flow.keys).toHaveLength(2);
      expect(flow.keys[1]).not.toBe(flow.keys[0]);
    } finally {
      flow.close();
    }
  });

  it("runs one setup attempt at a time", async () => {
    let finish!: () => void;
    const flow = setupFlow(
      "bootstrap_required",
      () =>
        new Promise<Response>((resolve) => {
          finish = () => {
            flow.state.value = "active";
            resolve(setupAnswer());
          };
        }),
    );
    try {
      await flow.controller.refresh();
      await flow.controller.refresh();
      await flow.controller.refresh(true);
      await vi.waitFor(() => expect(flow.keys).toHaveLength(1));
      expect(flow.status()).toBe("loading");
      finish();
      await vi.waitFor(() => expect(flow.status()).toBe("ready"));
      expect(flow.keys).toHaveLength(1);
    } finally {
      flow.close();
    }
  });

  it("bounds setup progress polling, then offers recovery that polls again", async () => {
    vi.useFakeTimers();
    const flow = setupFlow("bootstrapping", () => setupAnswer());
    try {
      await flow.controller.refresh();
      expect(flow.views.at(-1)).toMatch(/^loading: /);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(flow.status()).toBe("recovery");
      const reads = flow.contextReads();
      expect(reads).toBeGreaterThan(10);
      expect(reads).toBeLessThan(40);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(flow.contextReads()).toBe(reads);
      await flow.controller.refresh(true);
      expect(flow.status()).toBe("loading");
      flow.state.value = "active";
      await vi.advanceTimersByTimeAsync(5_000);
      expect(flow.status()).toBe("ready");
      expect(flow.keys).toHaveLength(0);
    } finally {
      flow.close();
    }
  });

  it("repairs an open view's bootstrap requirement without ending its session", async () => {
    const flow = setupFlow("active", () => {
      flow.state.value = "active";
      return setupAnswer();
    });
    try {
      await flow.controller.refresh();
      const original = flow.controller.getSnapshot();
      original.queryClient.setQueryData(["draft"], "retain");
      // A newer release requires the idempotent bootstrap again.
      flow.state.value = "bootstrap_required";
      await flow.controller.refresh();
      await vi.waitFor(() => expect(flow.keys).toHaveLength(1));
      await vi.waitFor(() =>
        expect(flow.controller.getSnapshot().reconnecting).toBe(false),
      );
      expect(flow.controller.getSnapshot().scope).toBe(original.scope);
      expect(original.scope!.controller.signal.aborted).toBe(false);
      expect(original.queryClient.getQueryData(["draft"])).toBe("retain");
    } finally {
      flow.close();
    }
  });

  it("keeps repairing an open view at a bounded pace while setup fails", async () => {
    vi.useFakeTimers();
    let healthy = false;
    const flow = setupFlow("active", () => {
      if (!healthy)
        return Response.json(
          { state: "identity_unavailable" },
          { status: 503 },
        );
      flow.state.value = "active";
      return setupAnswer();
    });
    try {
      await flow.controller.refresh();
      const original = flow.controller.getSnapshot().scope;
      flow.state.value = "recovery";
      await flow.controller.refresh();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(flow.keys.length).toBeGreaterThan(1);
      expect(flow.keys.length).toBeLessThanOrEqual(6);
      expect(flow.controller.getSnapshot().reconnecting).toBe(true);
      expect(flow.controller.getSnapshot().scope).toBe(original);
      healthy = true;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(flow.controller.getSnapshot().reconnecting).toBe(false);
      expect(flow.controller.getSnapshot().scope).toBe(original);
    } finally {
      flow.close();
    }
  });
});

/** One browser profile: shared storage, focus and tab broadcasts. */
function installBrowserPage(href = "https://app.example.test/") {
  const rows = new Map<string, string>();
  const storage = {
    get length() {
      return rows.size;
    },
    key: (index: number) => [...rows.keys()][index] ?? null,
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => void rows.set(key, value),
    removeItem: (key: string) => void rows.delete(key),
  };
  const focusListeners = new Set<() => void>();
  const location = new URL(href);
  const history = {
    state: null,
    replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
      location.href = new URL(url, location).href;
    }),
  };
  const channels: { onmessage: ((event: MessageEvent) => void) | null }[] = [];
  vi.stubGlobal("window", {
    localStorage: storage,
    sessionStorage: storage,
    location,
    history,
    document: { pictureInPictureElement: null },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "focus") focusListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) =>
      focusListeners.delete(listener),
  });
  const visibilityListeners = new Set<() => void>();
  const documentStub = {
    hidden: false,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") visibilityListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) =>
      visibilityListeners.delete(listener),
  };
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage = vi.fn();
      close = vi.fn();
      constructor() {
        channels.push(this);
      }
    },
  );
  return {
    rows,
    location,
    history,
    focus: () => focusListeners.forEach((listener) => listener()),
    /** Hides or shows the page, as switching browser tabs does. */
    setHidden: (hidden: boolean) => {
      documentStub.hidden = hidden;
      visibilityListeners.forEach((listener) => listener());
    },
    /** Another tab's sign-out message. */
    signedOutElsewhere: () =>
      channels.forEach((channel) =>
        channel.onmessage?.({
          data: { type: "signed-out" },
        } as MessageEvent),
      ),
  };
}

/** The hosted service as the browser's tabs see it. */
function hostedService() {
  const service = {
    session: "fixture-session-generation-one" as string | null,
    logoutStatus: 200,
    loginStatus: 200,
    /** Overrides replies, for example to hold or lose them. */
    logoutReply: null as null | (() => Promise<Response>),
    loginReply: null as null | (() => Promise<Response>),
    /** Fails runtime-context reads, as during a brief outage. */
    contextFails: false,
    /** Answers an events connection; by default the stream stays open and silent. */
    events: null as
      | null
      | ((connection: number) => Response | Promise<Response>),
    eventsConnections: 0,
    contextReads: () =>
      service.paths().filter((path) => path === "/v1/hosted/runtime-context")
        .length,
    calls: [] as Request[],
    paths: () => service.calls.map((call) => new URL(call.url).pathname),
    fetch: (async (input) => {
      const request = input as Request;
      service.calls.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/v1/hosted/runtime-context" && service.contextFails)
        throw new TypeError("Failed to fetch");
      if (path === "/v1/hosted/runtime-context")
        return Response.json(
          service.session
            ? { ...active, recovery_session_id: service.session }
            : {
                ...active,
                state: "session_required",
                user_id: null,
                csrf_token: null,
              },
        );
      if (path === "/api/cloud/auth/logout") {
        if (service.logoutReply) return service.logoutReply();
        if (service.logoutStatus === 200) service.session = null;
        return Response.json({}, { status: service.logoutStatus });
      }
      if (path === "/api/cloud/auth/login") {
        if (service.loginReply) return service.loginReply();
        // Login first ends the browser's current session, or starts nothing.
        if (service.loginStatus !== 200)
          return Response.json(
            { error: "identity_unavailable" },
            { status: service.loginStatus },
          );
        service.session = null;
        return Response.json({
          authorization_url: "https://identity.example.test/sign-in",
        });
      }
      if (path === "/v1/hosted/events") {
        service.eventsConnections += 1;
        return service.events
          ? service.events(service.eventsConnections)
          : new Response(new ReadableStream<Uint8Array>());
      }
      return Response.json({ ok: true });
    }) as typeof globalThis.fetch,
  };
  return service;
}

/** One tab of the hosted app, mounted like the entrypoint mounts it. */
function hostedTab(service: ReturnType<typeof hostedService>) {
  const navigate = vi.fn();
  const composition = createHostedComposition({
    baseUrl: "https://app.example.test",
    fetch: service.fetch,
    navigate,
  });
  const controller = new RuntimeController(composition);
  const unsubscribe = composition.subscribe!((invalidate) => {
    void controller.refresh(false, invalidate);
  });
  return {
    composition,
    controller,
    navigate,
    status: () => controller.getSnapshot().admission.status,
    incomplete: () => controller.getSnapshot().account.signOutIncomplete,
    close: () => {
      unsubscribe();
      controller.dispose();
    },
  };
}

describe("hosted sign-in and sign-out", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a failed remote sign-out retryable across reads and reloads until it finishes", async () => {
    installBrowserPage();
    const service = hostedService();
    service.logoutStatus = 503;
    const tab = hostedTab(service);
    const reloaded = hostedTab(service);
    try {
      await tab.controller.refresh();
      expect(tab.status()).toBe("ready");
      await tab.controller.signOut();
      expect(tab.status()).toBe("sign-in-required");
      expect(tab.controller.getSnapshot().scope).toBeNull();
      expect(tab.incomplete()).toBe(true);
      // A focus or other read neither erases the failure nor readmits the
      // session it left live.
      await tab.controller.refresh();
      expect(tab.status()).toBe("sign-in-required");
      expect(tab.incomplete()).toBe(true);
      // Neither does a reload of the page.
      await reloaded.controller.refresh();
      expect(reloaded.status()).toBe("sign-in-required");
      expect(reloaded.incomplete()).toBe(true);
      service.logoutStatus = 200;
      await reloaded.controller.signOut();
      expect(reloaded.incomplete()).toBe(false);
      const logouts = service.calls.filter(
        (call) => new URL(call.url).pathname === "/api/cloud/auth/logout",
      );
      expect(logouts).toHaveLength(2);
      expect(logouts[1].headers.get("X-Animama-CSRF")).toBe("fixture-csrf");
      // The original page sees the finished sign-out on its next read.
      await tab.controller.refresh();
      expect(tab.incomplete()).toBe(false);
      expect(tab.status()).toBe("sign-in-required");
    } finally {
      tab.close();
      reloaded.close();
    }
  });

  it("replaces the session a failed sign-out left live once the login request has ended it", async () => {
    installBrowserPage();
    const service = hostedService();
    service.logoutStatus = 503;
    const tab = hostedTab(service);
    try {
      await tab.controller.refresh();
      await tab.controller.signOut();
      expect(tab.incomplete()).toBe(true);
      let reply!: () => void;
      service.loginReply = () =>
        new Promise<Response>((resolve) => {
          reply = () => {
            service.session = null;
            resolve(
              Response.json({
                authorization_url: "https://identity.example.test/sign-in",
              }),
            );
          };
        });
      tab.composition.accountActions!.signIn();
      await vi.waitFor(() =>
        expect(service.paths()).toContain("/api/cloud/auth/login"),
      );
      // Until the login request has ended the old session, the guard stays.
      expect(tab.composition.accountAffordances!().signOutIncomplete).toBe(
        true,
      );
      reply();
      await vi.waitFor(() =>
        expect(tab.navigate).toHaveBeenCalledWith(
          "https://identity.example.test/sign-in",
        ),
      );
      expect(tab.composition.accountAffordances!().signOutIncomplete).toBe(
        false,
      );
    } finally {
      tab.close();
    }
  });

  it("keeps the retry view when a sign-in from it cannot end the live session", async () => {
    installBrowserPage();
    const service = hostedService();
    service.logoutStatus = 503;
    service.loginStatus = 503;
    const tab = hostedTab(service);
    const reloaded = hostedTab(service);
    try {
      await tab.controller.refresh();
      await tab.controller.signOut();
      tab.composition.accountActions!.signIn();
      await vi.waitFor(() =>
        expect(tab.controller.getSnapshot().admission).toEqual({
          status: "sign-in-required",
          message: "Sign-in could not be started. Please try again.",
        }),
      );
      expect(tab.incomplete()).toBe(true);
      expect(tab.navigate).not.toHaveBeenCalled();
      // A focus or Try again read never readmits the session left live,
      await tab.controller.refresh();
      expect(tab.status()).toBe("sign-in-required");
      expect(tab.controller.getSnapshot().scope).toBeNull();
      expect(tab.incomplete()).toBe(true);
      // and neither does a reload.
      await reloaded.controller.refresh();
      expect(reloaded.status()).toBe("sign-in-required");
      expect(reloaded.incomplete()).toBe(true);
    } finally {
      tab.close();
      reloaded.close();
    }
  });

  it("returns from a failed identity sign-in to the sign-in alert, not the old session", async () => {
    const page = installBrowserPage();
    const service = hostedService();
    service.logoutStatus = 503;
    const tab = hostedTab(service);
    try {
      await tab.controller.refresh();
      await tab.controller.signOut();
      tab.composition.accountActions!.signIn();
      await vi.waitFor(() => expect(tab.navigate).toHaveBeenCalled());
    } finally {
      tab.close();
    }
    // The identity provider refuses and returns to the app.
    page.location.href = "https://app.example.test/library?sign_in=failed";
    const returned = hostedTab(service);
    try {
      await returned.controller.refresh();
      expect(returned.controller.getSnapshot().admission).toEqual({
        status: "sign-in-required",
        message: "Sign-in did not finish. Please try again.",
      });
      expect(returned.controller.getSnapshot().scope).toBeNull();
      expect(returned.incomplete()).toBe(false);
    } finally {
      returned.close();
    }
  });

  it("does not readmit the old session when the person comes back before the login reply", async () => {
    const page = installBrowserPage();
    const service = hostedService();
    service.logoutStatus = 503;
    const tab = hostedTab(service);
    const reloaded = hostedTab(service);
    try {
      await tab.controller.refresh();
      await tab.controller.signOut();
      // Back from the identity page leaves the login request unanswered.
      service.loginReply = () => new Promise<Response>(() => {});
      tab.composition.accountActions!.signIn();
      await vi.waitFor(() =>
        expect(service.paths()).toContain("/api/cloud/auth/login"),
      );
      page.focus();
      await tab.controller.refresh();
      expect(tab.status()).toBe("sign-in-required");
      expect(tab.controller.getSnapshot().scope).toBeNull();
      expect(tab.incomplete()).toBe(true);
      await reloaded.controller.refresh();
      expect(reloaded.status()).toBe("sign-in-required");
      expect(reloaded.incomplete()).toBe(true);
    } finally {
      tab.close();
      reloaded.close();
    }
  });

  it("lets a tab whose sign-out failed defer to a newer sign-in made in another tab", async () => {
    installBrowserPage();
    const service = hostedService();
    service.logoutStatus = 503;
    const stale = hostedTab(service);
    const other = hostedTab(service);
    try {
      await stale.controller.refresh();
      await stale.controller.signOut();
      expect(stale.incomplete()).toBe(true);
      // Another tab signs in from its retry view; the callback creates S2.
      await other.controller.refresh();
      other.composition.accountActions!.signIn();
      await vi.waitFor(() => expect(other.navigate).toHaveBeenCalled());
      service.session = "fixture-session-generation-two";
      service.logoutStatus = 200;
      // The stale tab no longer offers to retry against S2.
      await stale.controller.refresh();
      expect(stale.incomplete()).toBe(false);
      expect(stale.status()).toBe("sign-in-required");
      // A Try again racing that read does not sign S2 out,
      await stale.controller.signOut();
      expect(service.session).toBe("fixture-session-generation-two");
      // and its Sign in adopts S2 instead of replacing it.
      stale.composition.accountActions!.signIn();
      await vi.waitFor(() => expect(stale.status()).toBe("ready"));
      expect(stale.navigate).not.toHaveBeenCalled();
      // Signing out of S2 there ends S2.
      await stale.controller.signOut();
      expect(service.session).toBeNull();
      expect(stale.incomplete()).toBe(false);
    } finally {
      stale.close();
      other.close();
    }
  });

  it("lets a later sign-out end a newer session after a sign-in from a stale tab could not start", async () => {
    installBrowserPage();
    const service = hostedService();
    service.logoutStatus = 503;
    const stale = hostedTab(service);
    const other = hostedTab(service);
    try {
      await stale.controller.refresh();
      await stale.controller.signOut();
      expect(stale.incomplete()).toBe(true);
      // Another tab signs in from its retry view; the callback creates S2.
      await other.controller.refresh();
      other.composition.accountActions!.signIn();
      await vi.waitFor(() => expect(other.navigate).toHaveBeenCalled());
      service.session = "fixture-session-generation-two";
      service.logoutStatus = 200;
      // A brief outage fails both the stale tab's read and its login start.
      service.contextFails = true;
      service.loginStatus = 503;
      stale.composition.accountActions!.signIn();
      await vi.waitFor(() =>
        expect(stale.controller.getSnapshot().admission).toEqual({
          status: "unavailable",
          message: "Sign-in could not be started. Please try again.",
        }),
      );
      service.contextFails = false;
      // A deliberate sign-out from that view ends the live session S2.
      await stale.controller.signOut();
      expect(service.session).toBeNull();
    } finally {
      stale.close();
      other.close();
    }
  });

  it("does not hold a newer session to a logout that fails after that session began", async () => {
    installBrowserPage();
    const service = hostedService();
    const tab = hostedTab(service);
    const other = hostedTab(service);
    try {
      await tab.controller.refresh();
      let fail!: () => void;
      service.logoutReply = () =>
        new Promise<Response>((resolve) => {
          fail = () => resolve(Response.json({}, { status: 503 }));
        });
      const signingOut = tab.controller.signOut();
      await vi.waitFor(() =>
        expect(service.paths()).toContain("/api/cloud/auth/logout"),
      );
      // Another tab's sign-in completes before the failed reply arrives.
      service.session = "fixture-session-generation-two";
      fail();
      await signingOut;
      await other.controller.refresh();
      expect(other.status()).toBe("ready");
      expect(other.incomplete()).toBe(false);
      await tab.controller.refresh();
      expect(tab.incomplete()).toBe(false);
      expect(tab.status()).toBe("sign-in-required");
    } finally {
      tab.close();
      other.close();
    }
  });

  it("does not record a failed logout that this tab's sign-in already overtook", async () => {
    installBrowserPage();
    const service = hostedService();
    // Without a recovery generation the record cannot name its session.
    service.session = "unbound";
    const tab = hostedTab(service);
    try {
      await tab.controller.refresh();
      expect(tab.status()).toBe("ready");
      let fail!: () => void;
      service.logoutReply = () =>
        new Promise<Response>((resolve) => {
          fail = () => resolve(Response.json({}, { status: 503 }));
        });
      const signingOut = tab.controller.signOut();
      await vi.waitFor(() =>
        expect(service.paths()).toContain("/api/cloud/auth/logout"),
      );
      // Sign in while the logout is unanswered; login ends the session.
      tab.composition.accountActions!.signIn();
      await vi.waitFor(() => expect(tab.navigate).toHaveBeenCalled());
      fail();
      await signingOut;
      expect(tab.composition.accountAffordances!().signOutIncomplete).toBe(
        false,
      );
    } finally {
      tab.close();
    }
    // The callback's new session opens normally.
    service.session = "unbound-two";
    const returned = hostedTab(service);
    try {
      await returned.controller.refresh();
      expect(returned.status()).toBe("ready");
    } finally {
      returned.close();
    }
  });

  it("lets a tab signed out by another tab adopt a newer session when it is focused", async () => {
    const page = installBrowserPage();
    const service = hostedService();
    const tab = hostedTab(service);
    try {
      await tab.controller.refresh();
      const first = tab.controller.getSnapshot().scope!;
      page.signedOutElsewhere();
      await vi.waitFor(() => expect(tab.status()).toBe("sign-in-required"));
      expect(first.controller.signal.aborted).toBe(true);
      // The other tab signs in again.
      service.session = "fixture-session-generation-two";
      page.focus();
      await vi.waitFor(() => expect(tab.status()).toBe("ready"));
      expect(tab.controller.getSnapshot().scope!.key).not.toBe(first.key);
      expect(tab.navigate).not.toHaveBeenCalled();
    } finally {
      tab.close();
    }
  });

  it("adopts another tab's active session instead of starting a new sign-in", async () => {
    const page = installBrowserPage();
    const service = hostedService();
    const tab = hostedTab(service);
    try {
      await tab.controller.refresh();
      page.signedOutElsewhere();
      await vi.waitFor(() => expect(tab.status()).toBe("sign-in-required"));
      service.session = "fixture-session-generation-two";
      tab.composition.accountActions!.signIn();
      await vi.waitFor(() => expect(tab.status()).toBe("ready"));
      expect(service.paths()).not.toContain("/api/cloud/auth/login");
      expect(tab.navigate).not.toHaveBeenCalled();
    } finally {
      tab.close();
    }
  });

  it("keeps the tab that signed out signed out when it is focused again", async () => {
    const page = installBrowserPage();
    const service = hostedService();
    const tab = hostedTab(service);
    try {
      await tab.controller.refresh();
      await tab.controller.signOut();
      expect(tab.incomplete()).toBe(false);
      service.session = "fixture-session-generation-two";
      page.focus();
      await tab.controller.refresh();
      expect(tab.status()).toBe("sign-in-required");
    } finally {
      tab.close();
    }
  });

  it("returns to the current page after sign-in", async () => {
    installBrowserPage("https://app.example.test/library?tab=effects#top");
    const service = hostedService();
    service.session = null;
    const tab = hostedTab(service);
    try {
      await tab.controller.refresh();
      tab.composition.accountActions!.signIn();
      await vi.waitFor(() => expect(tab.navigate).toHaveBeenCalled());
      const login = service.calls.find(
        (call) => new URL(call.url).pathname === "/api/cloud/auth/login",
      )!;
      expect(await login.json()).toEqual({
        return_path: "/library?tab=effects",
      });
    } finally {
      tab.close();
    }
  });

  it("reports a failed sign-in callback on the sign-in view and removes its marker", async () => {
    const page = installBrowserPage(
      "https://app.example.test/library?sign_in=failed&tab=1",
    );
    const service = hostedService();
    service.session = null;
    const tab = hostedTab(service);
    try {
      expect(page.location.href).toBe("https://app.example.test/library?tab=1");
      await tab.controller.refresh();
      expect(tab.controller.getSnapshot().admission).toEqual({
        status: "sign-in-required",
        message: "Sign-in did not finish. Please try again.",
      });
      tab.composition.accountActions!.signIn();
      await vi.waitFor(() => expect(tab.navigate).toHaveBeenCalled());
      const login = service.calls.find(
        (call) => new URL(call.url).pathname === "/api/cloud/auth/login",
      )!;
      expect(await login.json()).toEqual({ return_path: "/library?tab=1" });
      expect(await tab.composition.readAdmission()).toEqual({
        status: "sign-in-required",
      });
    } finally {
      tab.close();
    }
  });
});

/**
 * An events stream that says `ready`, then optionally `revoked`, and is cut after
 * `cutAfterMs`, as a proxy closing or resetting a long-lived response would.
 */
function readyStream({
  cutAfterMs,
  cut = "ends",
  revoked = false,
}: {
  cutAfterMs?: number;
  cut?: "ends" | "fails";
  revoked?: boolean;
} = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
        if (revoked)
          controller.enqueue(encoder.encode("event: revoked\ndata: {}\n\n"));
        if (cutAfterMs === undefined) return;
        setTimeout(() => {
          try {
            if (cut === "ends") controller.close();
            else controller.error(new TypeError("network error"));
          } catch {
            /* The composition already closed this connection. */
          }
        }, cutAfterMs);
      },
    }),
  );
}

describe("hosted admission reads", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads the runtime context once for a page load", async () => {
    vi.useFakeTimers();
    installBrowserPage();
    const service = hostedService();
    service.events = () => readyStream();
    const tab = hostedTab(service);
    try {
      await tab.controller.refresh();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(tab.status()).toBe("ready");
      expect(service.eventsConnections).toBe(1);
      expect(service.contextReads()).toBe(1);
    } finally {
      tab.close();
    }
  });

  it.each([
    ["visible", "ends"],
    ["visible", "fails"],
    ["hidden", "ends"],
    ["hidden", "fails"],
  ] as const)(
    "does not poll admission from a %s idle tab whose events stream %s every few seconds",
    async (visibility, cut) => {
      vi.useFakeTimers();
      const page = installBrowserPage();
      const service = hostedService();
      service.events = () => readyStream({ cutAfterMs: 3_000, cut });
      const tab = hostedTab(service);
      try {
        await tab.controller.refresh();
        const original = tab.controller.getSnapshot().scope;
        if (visibility === "hidden") page.setHidden(true);
        let suspended = false;
        const unwatch = tab.controller.subscribe(() => {
          if (tab.controller.getSnapshot().reconnecting) suspended = true;
        });
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        unwatch();
        // Each cut reconnects after about a second, and each restored stream
        // says `ready`, so admission stands without a read or a pause.
        expect(service.eventsConnections).toBeGreaterThan(20);
        expect(service.contextReads()).toBe(1);
        expect(suspended).toBe(false);
        expect(tab.controller.getSnapshot().scope).toBe(original);
      } finally {
        tab.close();
      }
    },
  );

  it.each([
    ["is revoked", () => readyStream({ revoked: true })],
    ["answers 401", () => new Response(null, { status: 401 })],
    ["answers 403", () => new Response(null, { status: 403 })],
    ["answers 503", () => new Response(null, { status: 503 })],
    ["cannot connect", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["ends before ready", () => new Response("")],
  ] as const)(
    "re-reads admission when the reconnected events stream %s",
    async (_label, reconnect) => {
      vi.useFakeTimers();
      installBrowserPage();
      const service = hostedService();
      service.events = (connection) =>
        connection === 1 ? readyStream({ cutAfterMs: 1_000 }) : reconnect();
      const tab = hostedTab(service);
      try {
        await tab.controller.refresh();
        // The cut at 1 s reconnects after at most 1.2 s more.
        await vi.advanceTimersByTimeAsync(2_300);
        expect(service.eventsConnections).toBe(2);
        expect(service.contextReads()).toBe(2);
      } finally {
        tab.close();
      }
    },
  );

  it("does not re-read admission on focus while the events stream is open and admission is recent", async () => {
    vi.useFakeTimers();
    const page = installBrowserPage();
    const service = hostedService();
    service.events = () => readyStream();
    const tab = hostedTab(service);
    try {
      await tab.controller.refresh();
      await vi.advanceTimersByTimeAsync(10_000);
      // Switching away and back focuses the window and shows the page.
      page.setHidden(true);
      page.setHidden(false);
      page.focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.contextReads()).toBe(1);
      // A minute after the last read, returning reads again, once for both events.
      await vi.advanceTimersByTimeAsync(60_000);
      page.setHidden(true);
      expect(service.contextReads()).toBe(1);
      page.setHidden(false);
      page.focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.contextReads()).toBe(2);
      expect(tab.status()).toBe("ready");
    } finally {
      tab.close();
    }
  });

  it("does not re-read admission on focus while a cut events stream reconnects", async () => {
    vi.useFakeTimers();
    const page = installBrowserPage();
    const service = hostedService();
    // The stream is cut at 1 s and reconnects 0.8-1.2 s later.
    service.events = () => readyStream({ cutAfterMs: 1_000 });
    const tab = hostedTab(service);
    try {
      await tab.controller.refresh();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(service.eventsConnections).toBe(1);
      page.focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.contextReads()).toBe(1);
      // The focus fell between the cut and the reconnect.
      await vi.advanceTimersByTimeAsync(700);
      expect(service.eventsConnections).toBe(2);
      expect(service.contextReads()).toBe(1);
    } finally {
      tab.close();
    }
  });

  it.each([
    ["has not said ready", () => new Response(new ReadableStream())],
    [
      "could not be restored",
      (connection: number) =>
        connection === 1
          ? readyStream({ cutAfterMs: 1_000 })
          : new Response(null, { status: 503 }),
    ],
  ] as const)(
    "re-reads admission on focus while the events stream %s",
    async (_label, events) => {
      vi.useFakeTimers();
      const page = installBrowserPage();
      const service = hostedService();
      service.events = events;
      const tab = hostedTab(service);
      try {
        await tab.controller.refresh();
        await vi.advanceTimersByTimeAsync(2_300);
        const reads = service.contextReads();
        page.focus();
        await vi.advanceTimersByTimeAsync(0);
        expect(service.contextReads()).toBe(reads + 1);
      } finally {
        tab.close();
      }
    },
  );
});

/** A hosted flow whose context, 18+ relay and product replies the test controls. */
function confirmationFlow(context: Record<string, unknown>) {
  const state: { context: Record<string, unknown> } = {
    context: { ...active, ...context },
  };
  const relays: Request[] = [];
  let relay: () => Response | Promise<Response> = () =>
    Response.json({ ...state.context, state: "active" });
  let product: (request: Request) => Response = () => Response.json([]);
  let contextReply: (() => Promise<Response>) | null = null;
  let contextReads = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    if (path === "/v1/hosted/runtime-context") {
      contextReads += 1;
      const reply = contextReply;
      contextReply = null;
      return reply ? reply() : Response.json(state.context);
    }
    if (path === "/v1/hosted/age-confirmation") {
      relays.push(request.clone());
      return relay();
    }
    if (path === "/v1/hosted/bootstrap:ensure")
      throw new Error("Confirmation never runs account setup");
    if (path === "/v1/hosted/events")
      return new Response(new ReadableStream<Uint8Array>());
    return product(request);
  };
  const composition = createHostedComposition({
    baseUrl: "https://app.example.test",
    fetch,
    navigate: vi.fn(),
  });
  const controller = new RuntimeController(composition);
  const unsubscribe = composition.subscribe!((invalidate) => {
    void controller.refresh(false, invalidate);
  });
  return {
    state,
    relays,
    composition,
    controller,
    contextReads: () => contextReads,
    setRelay: (next: typeof relay) => {
      relay = next;
    },
    setProduct: (next: typeof product) => {
      product = next;
    },
    /** The next context read answers with this reply instead of the current state. */
    setContextReply: (next: () => Promise<Response>) => {
      contextReply = next;
    },
    admission: () => controller.getSnapshot().admission,
    close: () => {
      unsubscribe();
      controller.dispose();
    },
  };
}

describe("hosted 18+ confirmation", () => {
  afterEach(() => vi.useRealTimers());

  it("admits an unconfirmed account behind the confirmation, never as account setup", async () => {
    const flow = confirmationFlow({ state: "age_confirmation_required" });
    try {
      await flow.controller.refresh();
      const admission = flow.admission();
      expect(admission.status).toBe("ready");
      expect(admission.status === "ready" && admission.onboardingRequired).toBe(
        true,
      );
    } finally {
      flow.close();
    }
  });

  it("relays only the explicit answer and opens the same session in place", async () => {
    const flow = confirmationFlow({ state: "age_confirmation_required" });
    try {
      await flow.controller.refresh();
      const original = flow.controller.getSnapshot();
      original.queryClient.setQueryData(["scene"], "kept");
      await flow.controller.confirmAge();
      const [request] = flow.relays;
      expect(request.method).toBe("POST");
      expect(request.headers.get("X-Animama-CSRF")).toBe(active.csrf_token);
      expect(await request.json()).toEqual({ adult_confirmed: true });
      const after = flow.controller.getSnapshot();
      expect(
        after.admission.status === "ready" &&
          after.admission.onboardingRequired,
      ).toBe(false);
      expect(after.scope).toBe(original.scope);
      expect(after.queryClient.getQueryData(["scene"])).toBe("kept");
    } finally {
      flow.close();
    }
  });

  it("keeps the confirmation open when the relay fails", async () => {
    const flow = confirmationFlow({ state: "age_confirmation_required" });
    flow.setRelay(() => new Response(null, { status: 503 }));
    try {
      await flow.controller.refresh();
      await expect(flow.controller.confirmAge()).rejects.toThrow();
      const admission = flow.admission();
      expect(admission.status === "ready" && admission.onboardingRequired).toBe(
        true,
      );
    } finally {
      flow.close();
    }
  });

  it("reopens the confirmation when any request is refused for it", async () => {
    const flow = confirmationFlow({ state: "active" });
    try {
      await flow.controller.refresh();
      expect(
        flow.admission().status === "ready" &&
          (flow.admission() as { onboardingRequired: boolean })
            .onboardingRequired,
      ).toBe(false);
      flow.state.context = {
        ...flow.state.context,
        state: "age_confirmation_required",
      };
      flow.setProduct(() =>
        Response.json({ state: "age_confirmation_required" }, { status: 403 }),
      );
      // The refused request is cancelled, not reported as a failure.
      await expect(flow.composition.browserFetch("/v1/chats")).rejects.toThrow(
        expect.objectContaining({ name: "AbortError" }),
      );
      await vi.waitFor(() => {
        const admission = flow.admission();
        expect(
          admission.status === "ready" && admission.onboardingRequired,
        ).toBe(true);
      });
    } finally {
      flow.close();
    }
  });

  it("does not let a context read begun before the confirmation reopen the dialog", async () => {
    const flow = confirmationFlow({ state: "age_confirmation_required" });
    try {
      await flow.controller.refresh();
      // A poll starts before the relay and answers only after it, with the stale state.
      let answer!: (response: Response) => void;
      flow.setContextReply(
        () => new Promise<Response>((resolve) => (answer = resolve)),
      );
      const polled = flow.controller.refresh();
      await flow.controller.confirmAge();
      answer(Response.json({ ...active, state: "age_confirmation_required" }));
      await polled;
      const admission = flow.admission();
      expect(admission.status === "ready" && admission.onboardingRequired).toBe(
        false,
      );
    } finally {
      flow.close();
    }
  });

  it("reads the context once for refusals while the dialog is already open", async () => {
    const flow = confirmationFlow({ state: "age_confirmation_required" });
    try {
      await flow.controller.refresh();
      const reads = flow.contextReads();
      flow.setProduct(() =>
        Response.json({ state: "age_confirmation_required" }, { status: 403 }),
      );
      for (let index = 0; index < 3; index += 1)
        await expect(
          flow.composition.browserFetch("/v1/chats"),
        ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(flow.contextReads()).toBe(reads);
      expect(flow.controller.getSnapshot().reconnecting).toBe(false);
    } finally {
      flow.close();
    }
  });

  it("reads the context when a confirmation finds the session ended", async () => {
    const flow = confirmationFlow({ state: "age_confirmation_required" });
    flow.setRelay(() =>
      Response.json({ state: "session_required" }, { status: 401 }),
    );
    try {
      await flow.controller.refresh();
      const reads = flow.contextReads();
      flow.state.context = { ...flow.state.context, state: "session_required" };
      await expect(flow.controller.confirmAge()).rejects.toThrow();
      await vi.waitFor(() =>
        expect(flow.admission().status).toBe("sign-in-required"),
      );
      expect(flow.contextReads()).toBeGreaterThan(reads);
    } finally {
      flow.close();
    }
  });

  it("ignores other refusals", async () => {
    const flow = confirmationFlow({ state: "active" });
    try {
      await flow.controller.refresh();
      const reads = flow.contextReads();
      flow.setProduct(() =>
        Response.json({ code: "chat_quota_exhausted" }, { status: 403 }),
      );
      await flow.composition.browserFetch("/v1/chats");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(flow.contextReads()).toBe(reads);
    } finally {
      flow.close();
    }
  });
});

describe("hosted setup pending", () => {
  afterEach(() => vi.useRealTimers());

  it("re-reads a pending setup on a bounded schedule and refreshes the Animas when it clears", async () => {
    vi.useFakeTimers();
    const flow = confirmationFlow({ state: "active", setup_pending: true });
    try {
      await flow.controller.refresh();
      const snapshot = flow.controller.getSnapshot();
      expect(snapshot.setupPending).toBe(true);
      const invalidate = vi.spyOn(snapshot.queryClient, "invalidateQueries");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(flow.contextReads()).toBeGreaterThan(1);
      flow.state.context = { ...flow.state.context, setup_pending: false };
      await vi.advanceTimersByTimeAsync(5_000);
      const after = flow.controller.getSnapshot();
      expect(after.setupPending).toBe(false);
      expect(after.scope).toBe(snapshot.scope);
      if (after.admission.status !== "ready")
        throw new Error("Admission missing");
      const { session } = after.admission;
      // Product queries are keyed by the session's cache key, never the owner.
      expect(session.key).not.toBe(session.owner.id);
      for (const queryKey of [
        queryKeys.animas.all(session.key),
        queryKeys.settings.all(session.key),
      ])
        expect(invalidate).toHaveBeenCalledWith({ queryKey });
      const reads = flow.contextReads();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(flow.contextReads()).toBe(reads);
    } finally {
      flow.close();
    }
  });

  it("bounds the burst of re-reads for a setup that stays pending", async () => {
    vi.useFakeTimers();
    const flow = confirmationFlow({
      state: "age_confirmation_required",
      setup_pending: true,
    });
    try {
      await flow.controller.refresh();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // About 40 burst reads in the first ~3 minutes, then one every 30 s.
      const reads = flow.contextReads();
      expect(reads).toBeGreaterThan(40);
      expect(reads).toBeLessThan(70);
    } finally {
      flow.close();
    }
  });

  it("stops re-reading a pending setup once the person signs out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      localStorage: { length: 0, key: () => null },
    });
    const flow = confirmationFlow({
      state: "age_confirmation_required",
      setup_pending: true,
    });
    try {
      await flow.controller.refresh();
      await flow.controller.signOut();
      const reads = flow.contextReads();
      const views: string[] = [];
      flow.controller.subscribe(() =>
        views.push(flow.controller.getSnapshot().admission.status),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(flow.contextReads()).toBe(reads);
      expect(views).toEqual([]);
    } finally {
      flow.close();
      vi.unstubAllGlobals();
    }
  });

  it("keeps re-reading slowly after its burst so the starters still appear", async () => {
    vi.useFakeTimers();
    const flow = confirmationFlow({ state: "active", setup_pending: true });
    try {
      await flow.controller.refresh();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const reads = flow.contextReads();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(flow.contextReads() - reads).toBe(2);
      flow.state.context = { ...flow.state.context, setup_pending: false };
      await vi.advanceTimersByTimeAsync(30_000);
      expect(flow.controller.getSnapshot().setupPending).toBe(false);
    } finally {
      flow.close();
    }
  });

  it("reports no pending setup for a context without the field", async () => {
    const flow = confirmationFlow({ state: "active" });
    try {
      await flow.controller.refresh();
      expect(flow.controller.getSnapshot().setupPending).toBe(false);
    } finally {
      flow.close();
    }
  });
});

describe("hosted setup pending before a view subscribes", () => {
  afterEach(() => vi.useRealTimers());

  it("starts re-reading once the first view subscribes", async () => {
    vi.useFakeTimers();
    const context = { ...active, setup_pending: true };
    let reads = 0;
    const composition = createHostedComposition({
      baseUrl: "https://app.example.test",
      navigate: vi.fn(),
      fetch: async (input) => {
        const path = new URL((input as Request).url).pathname;
        if (path === "/v1/hosted/events")
          return new Response(new ReadableStream<Uint8Array>());
        reads += 1;
        return Response.json(context);
      },
    });
    await composition.readAdmission();
    expect(composition.setupPending!()).toBe(true);
    const refresh = vi.fn();
    const unsubscribe = composition.subscribe!(refresh);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(refresh).toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
    expect(reads).toBe(1);
  });
});

describe("hosted 18+ confirmation follow-ups", () => {
  it("reads the context again when the confirmation cancelled a read in flight", async () => {
    const flow = confirmationFlow({ state: "age_confirmation_required" });
    // The relay commits the confirmation, so a read begun after it answers active.
    flow.setRelay(() => {
      flow.state.context = { ...flow.state.context, state: "active" };
      return Response.json(flow.state.context);
    });
    let published = 0;
    const stop = flow.controller.subscribe(() => (published += 1));
    try {
      await flow.controller.refresh();
      let answer!: (response: Response) => void;
      flow.setContextReply(
        () => new Promise<Response>((resolve) => (answer = resolve)),
      );
      const polled = flow.controller.refresh();
      const reads = flow.contextReads();
      const before = published;
      await flow.controller.confirmAge();
      answer(Response.json({ ...active, state: "age_confirmation_required" }));
      await polled;
      // The relay's reply and then the fresh read are published; the cancelled read is not.
      await vi.waitFor(() => expect(published).toBe(before + 2));
      expect(flow.contextReads()).toBe(reads + 1);
      const admission = flow.admission();
      expect(admission.status === "ready" && admission.onboardingRequired).toBe(
        false,
      );
    } finally {
      stop();
      flow.close();
    }
  });

  it("reads the context again when the confirmation replaced a scheduled retry", async () => {
    const flow = confirmationFlow({ state: "age_confirmation_required" });
    flow.setRelay(() => {
      flow.state.context = { ...flow.state.context, state: "active" };
      return Response.json(flow.state.context);
    });
    try {
      await flow.controller.refresh();
      vi.useFakeTimers();
      // A recheck's read fails, so the scope pauses and a retry waits a second.
      flow.setContextReply(() => Promise.reject(new TypeError("offline")));
      await flow.controller.refresh(false, "recheck");
      const reads = flow.contextReads();
      await flow.controller.confirmAge();
      await vi.advanceTimersByTimeAsync(0);
      expect(flow.contextReads()).toBe(reads + 1);
    } finally {
      vi.useRealTimers();
      flow.close();
    }
  });

  it("refetches queries refused before the confirmation", async () => {
    const flow = confirmationFlow({ state: "age_confirmation_required" });
    try {
      await flow.controller.refresh();
      const { queryClient } = flow.controller.getSnapshot();
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      await flow.controller.confirmAge();
      expect(invalidate).toHaveBeenCalledWith();
    } finally {
      flow.close();
    }
  });
});
