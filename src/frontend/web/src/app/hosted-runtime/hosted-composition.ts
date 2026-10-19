import type {
  RuntimeAdmission,
  RuntimeUsage,
} from "@animama/runtime-contracts";
import { zRuntimeCapabilities } from "@animama/runtime-contracts/validators";
import { safeNavigationUrl } from "@animama/product-ui";
import { getI18n } from "react-i18next";
import type { AdmissionRefresh, AppComposition } from "../runtime/composition";
import type { SessionRequestScope } from "../runtime/session-requests";
import { traceProductRequest } from "../runtime/product-request-tracing";
import { createAccountSetup } from "./account-setup";
import {
  readIncompleteSignOut,
  recoveryGeneration,
  signInReturnPath,
  takeSignInFailure,
  writeIncompleteSignOut,
  type IncompleteSignOut,
} from "./account-navigation";
import {
  hostedRecoveryIdentity,
  forgetHostedRecoveryIdentity,
} from "./recovery-identity";
import { purgeHostedRecoverySessions } from "@/lib/content/recovery-session";
import { WordedError } from "@/lib/errors/apiError";
import type { HostedLocaleInput } from "@animama/runtime-contracts/locale";
import { hostedLocaleInput } from "./hosted-context";

type HostedContext = {
  schema_version: number;
  state: string;
  user_id: string | null;
  csrf_token: string | null;
  recovery_session_id?: string;
  capabilities: unknown;
  account_url?: string | null;
};
type Options = {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  navigate: (url: string) => void;
  sessionKey?: () => string;
  /** The original startup read, reused after i18n is ready. */
  initialContext?: Response;
};

/**
 * Context states that end the account's access, so they retire private work and
 * purge hosted recovery. `paused` (enrollment, capacity, rate and cooldown
 * limits) is transient: it withholds admission without revoking anything.
 */
const REVOKING_STATES = new Set([
  "session_required",
  "ineligible",
  "restricted",
  "deletion_pending",
]);
/** Server-owned account setup states; they withhold admission without revoking. */
const SETUP_STATES = new Set([
  "bootstrap_required",
  "bootstrapping",
  "recovery",
]);
/** Progress reads while setup finishes elsewhere, before recovery is offered (~2 min). */
const SETUP_POLL_DELAYS_MS = [1_500, 3_000, 5_000];
const MAX_SETUP_POLLS = 24;
/** An open view repeats failed setup on its own after this pause, doubling to a minute. */
const SETUP_PAUSE_MS = 2_000;
const MAX_SETUP_PAUSE_MS = 60_000;

/**
 * Admission messages use getters: render-time reads follow the current language
 * without rereading admission or consuming a one-shot sign-in failure again.
 */
/** A hosted runtime this application cannot use until it is updated. */
function updateRequired(): RuntimeAdmission {
  const t = getI18n().getFixedT(null, "app");
  return {
    status: "unavailable",
    get message() {
      return t("admission.messages.updateRequired");
    },
  };
}

/** Cookie authority and CSRF are installed before React; browser headers cannot choose an owner. */
export function createHostedComposition(
  options: Options,
): AppComposition & { browserFetch: typeof globalThis.fetch } {
  const origin = new URL(options.baseUrl).origin;
  let initialContext = options.initialContext;
  let locale: HostedLocaleInput | null = null;
  // A save acknowledgement or sign-out fences a context read already in flight.
  let localeRevision = 0;
  const clearLocalePreference = () => {
    ++localeRevision;
    if (locale) locale = { ...locale, preference: null };
  };
  let csrf: string | null = null;
  let scope: SessionRequestScope | null = null;
  let session: {
    owner: string;
    generation: string;
    key: string;
    /** The noncredential recovery generation, when the context gave one. */
    recovery: string | null;
  } | null = null;
  let accountUrl: string | null = null;
  /** This tab signed out, so it stays signed out until a sign-in here. */
  let signedOut = false;
  /** Another tab signed out; this tab checks again when it is next focused. */
  let signedOutElsewhere = false;
  /**
   * A failed sign-out this page could not record because storage is
   * unavailable; otherwise the browser-wide record alone decides.
   */
  let unrecordedSignOut: IncompleteSignOut | null = null;
  /**
   * The session this page's last failed sign-out targeted. It only stops a
   * retry from ending a newer session after another tab cleared the record.
   */
  let failedSignOutTarget: string | null = null;
  /** Successful login starts; each one ended the browser's previous session. */
  let loginsStarted = 0;
  let signOutAttempt: Promise<void> | null = null;
  /** A failed sign-in callback is reported on the sign-in view until the next attempt. */
  let signInFailed = takeSignInFailure();
  let signInError = false;
  let loginRequest: AbortController | null = null;
  let events: AbortController | null = null;
  let bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let eventsDelay = 1_000;
  let eventsDoubted = false;
  const listeners = new Set<(invalidate?: AdmissionRefresh) => void>();
  let channel: BroadcastChannel | null = null;
  const notify = (invalidate: AdmissionRefresh = false) =>
    listeners.forEach((listener) => listener(invalidate));
  const stopEvents = () => {
    events?.abort();
    events = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    eventsDelay = 1_000;
    eventsDoubted = false;
  };

  const key = options.sessionKey ?? (() => crypto.randomUUID());

  const authorizedFetch: typeof globalThis.fetch = async (input, init) => {
    const target = typeof input === "string" ? new URL(input, origin) : input;
    const request = new Request(target, init);
    const url = new URL(request.url);
    if (url.origin !== origin)
      throw new TypeError(
        "Hosted requests must stay on the application origin",
      );
    const headers = new Headers(request.headers);
    headers.delete("Authorization");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
      if (!csrf) throw new Error("A current hosted CSRF token is required");
      headers.set("X-Animama-CSRF", csrf);
    }
    return options.fetch(
      traceProductRequest(
        new Request(request, {
          headers,
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
        }),
      ),
    );
  };

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await authorizedFetch(path, init);
    if (!response.ok)
      throw new Error(`Hosted request failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  const signInRequired = (): RuntimeAdmission => {
    const t = getI18n().getFixedT(null, "app");
    return signInFailed
      ? {
          status: "sign-in-required",
          get message() {
            return t("admission.messages.signInNotFinished");
          },
        }
      : { status: "sign-in-required" };
  };
  /** Sign-in could not start; reported once, on whichever view comes next. */
  const takeSignInError = () => {
    const failed = signInError;
    signInError = false;
    return failed;
  };
  const signInErrorMessage = () => {
    const t = getI18n().getFixedT(null, "app");
    return t("admission.messages.signInNotStarted");
  };

  /** The failed sign-out still in force for this browser, if any. */
  const incompleteSignOut = (): IncompleteSignOut | null =>
    readIncompleteSignOut() ?? unrecordedSignOut;

  function recordIncompleteSignOut(generation: string | null): void {
    const record = { generation };
    unrecordedSignOut = writeIncompleteSignOut(record) ? null : record;
  }

  function forgetIncompleteSignOut(): void {
    unrecordedSignOut = null;
    writeIncompleteSignOut(null);
  }

  /**
   * Reads the browser's live Cloud session without admitting it. The read also
   * settles a recorded failed sign-out: the record ends once its session has
   * ended or a newer sign-in has replaced it.
   */
  async function liveSession(
    signal?: AbortSignal,
  ): Promise<{ csrf: string; generation: string | null } | null> {
    const response = await authorizedFetch("/v1/hosted/runtime-context", {
      signal,
    });
    let live: { csrf: string; generation: string | null } | null = null;
    if (response.status !== 401 && response.status !== 403) {
      if (!response.ok)
        throw new Error("Hosted context is temporarily unavailable");
      const context = (await response.json()) as HostedContext;
      if (context.state !== "session_required") {
        if (typeof context.csrf_token !== "string" || !context.csrf_token)
          throw new Error("Hosted context has no current CSRF token");
        live = {
          csrf: context.csrf_token,
          generation: recoveryGeneration(context.recovery_session_id),
        };
      }
    }
    const record = incompleteSignOut();
    if (
      record &&
      (!live ||
        (record.generation &&
          live.generation &&
          record.generation !== live.generation))
    )
      forgetIncompleteSignOut();
    return live;
  }

  /**
   * Ends the Cloud session a sign-out targets. An admitted view uses its own
   * token; otherwise the live session is read first and left alone when a
   * newer sign-in has replaced the target.
   */
  async function logout(
    admittedCsrf: string | null,
    target: string | null,
  ): Promise<void> {
    let token = admittedCsrf;
    if (!token) {
      const live = await liveSession();
      if (!live) return;
      if (target && live.generation && live.generation !== target) return;
      token = live.csrf;
    }
    csrf = token;
    await json("/api/cloud/auth/logout", { method: "POST" });
  }

  async function signOutOnce(): Promise<void> {
    clearLocalePreference();
    loginRequest?.abort();
    const admitted = session;
    // The session to end: the admitted one, or the one a failed sign-out
    // targeted (recorded for the browser, or remembered by this page).
    const target = admitted
      ? admitted.recovery
      : (incompleteSignOut()?.generation ?? failedSignOutTarget);
    const admittedCsrf = admitted ? csrf : null;
    const loginsBefore = loginsStarted;
    session = null;
    signedOut = true;
    signedOutElsewhere = false;
    // Private browser state is removed at once, whatever the server says.
    const recoveryCleanup = purgeHostedRecoverySessions();
    forgetHostedRecoveryIdentity();
    channel?.postMessage({ type: "signed-out" });
    const [remote, local] = await Promise.allSettled([
      logout(admittedCsrf, target),
      recoveryCleanup,
    ]);
    accountUrl = null;
    // A login started here meanwhile already ended the targeted session, so a
    // late logout failure must not hold the session that sign-in creates.
    const overtaken = loginsStarted !== loginsBefore;
    if (remote.status === "rejected" && !overtaken) {
      failedSignOutTarget = target;
      recordIncompleteSignOut(target);
    } else if (!overtaken) {
      failedSignOutTarget = null;
      forgetIncompleteSignOut();
      csrf = null;
    }
    const errors = (overtaken ? [local] : [remote, local]).flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        "Hosted sign-out could not fully complete",
      );
  }

  // Attempts are not tied to an admission read: a superseded read must not
  // abandon a setup request whose reply would otherwise be lost.
  const setup = createAccountSetup((idempotencyKey) =>
    authorizedFetch("/v1/hosted/bootstrap:ensure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: idempotencyKey }),
    }),
  );
  /** A signed-in first use starts setup without a click, once per page. */
  let automaticSetup = true;
  /** A person's retry permits one attempt, including in `recovery`. */
  let setupRequested = false;
  let setupPolls = 0;
  let setupPause = SETUP_PAUSE_MS;
  let setupPausedUntil = 0;

  /**
   * Account setup withholds admission without revoking anything. A first use
   * sets up on its own behind a setup view, and `recovery` (or a failed
   * attempt) waits for a person's retry. An open view keeps its session and
   * drafts suspended while it repairs at a bounded pace.
   */
  function setupAdmission(state: string): RuntimeAdmission {
    const open = session !== null;
    if (state === "bootstrapping") {
      if (open) throw new Error("Hosted account setup has not finished");
      setupPolls += 1;
      if (setupPolls > MAX_SETUP_POLLS) return { status: "recovery" };
      if (listeners.size && !bootstrapTimer)
        bootstrapTimer = setTimeout(
          () => {
            bootstrapTimer = null;
            notify();
          },
          SETUP_POLL_DELAYS_MS[
            Math.min(setupPolls, SETUP_POLL_DELAYS_MS.length) - 1
          ],
        );
      const t = getI18n().getFixedT(null, "app");
      return {
        status: "loading",
        get message() {
          return t("admission.messages.accountSetupFinishing");
        },
      };
    }
    const permitted = open
      ? Date.now() >= setupPausedUntil
      : setupRequested || (state === "bootstrap_required" && automaticSetup);
    if (permitted && csrf && !setup.running) {
      if (open) {
        setupPausedUntil = Date.now() + setupPause;
        setupPause = Math.min(setupPause * 2, MAX_SETUP_PAUSE_MS);
      } else {
        automaticSetup = false;
        setupRequested = false;
      }
      // The context read afterwards, not the reply, decides what comes next.
      void setup.run().then(() => notify());
    }
    if (open) throw new Error("Hosted account setup has not finished");
    const t = getI18n().getFixedT(null, "app");
    return setup.running
      ? {
          status: "loading",
          get message() {
            return t("admission.messages.accountSetupRunning");
          },
        }
      : { status: "recovery" };
  }

  async function contextAdmission(
    context: HostedContext,
    signal?: AbortSignal,
  ): Promise<RuntimeAdmission> {
    if (context.schema_version !== 1) {
      if (session) throw new Error("Hosted context has an incompatible format");
      return updateRequired();
    }
    if (context.state !== "bootstrapping" && bootstrapTimer) {
      clearTimeout(bootstrapTimer);
      bootstrapTimer = null;
    }
    csrf =
      typeof context.csrf_token === "string" && context.csrf_token
        ? context.csrf_token
        : null;
    // A missing or unsafe optional account URL withholds navigation.
    accountUrl = safeNavigationUrl(context.account_url, origin);
    const states: Record<
      string,
      Exclude<RuntimeAdmission["status"], "ready">
    > = {
      session_required: "sign-in-required",
      identity_unavailable: "unavailable",
      ineligible: "ineligible",
      paused: "restricted",
      restricted: "restricted",
      deletion_pending: "restricted",
    };
    if (context.state !== "bootstrapping") setupPolls = 0;
    if (context.state !== "active") {
      if (SETUP_STATES.has(context.state)) return setupAdmission(context.state);
      const authoritativeDenial = REVOKING_STATES.has(context.state);
      if (session && !authoritativeDenial)
        throw new Error("Hosted admission could not currently be confirmed");
      session = null;
      // Initial reloads have no in-memory session yet. Unknown/transient states
      // withhold admission but cannot revoke that tab's persisted operation.
      if (authoritativeDenial) {
        void scope?.end();
        await purgeHostedRecoverySessions();
        forgetHostedRecoveryIdentity();
        signal?.throwIfAborted();
      }
      if (context.state === "session_required") return signInRequired();
      return { status: states[context.state] ?? "unavailable" };
    }
    setupRequested = false;
    setupPause = SETUP_PAUSE_MS;
    signInFailed = false;
    // A later sign-out here targets this active session, not an older one.
    failedSignOutTarget = null;
    const result = zRuntimeCapabilities.safeParse(context.capabilities);
    // Older schema defaults must not accidentally admit a hosted surface.
    const raw = context.capabilities as { schema_version?: unknown } | null;
    if (
      !result.success ||
      raw?.schema_version !== 2 ||
      typeof context.user_id !== "string" ||
      !context.user_id ||
      !csrf ||
      csrf.length > 512 ||
      /[\r\n]/.test(csrf) ||
      result.data.runtime_kind !== "hosted"
    ) {
      if (session)
        throw new Error("Hosted context has incompatible capabilities");
      return updateRequired();
    }
    const capabilities = result.data;
    if (
      capabilities.anima_creation ||
      capabilities.chat_file_uploads ||
      capabilities.user_file_processing.enabled ||
      capabilities.provider_credentials ||
      capabilities.gemini_tts ||
      capabilities.model_configuration ||
      capabilities.local_filesystem_administration ||
      capabilities.native_features ||
      capabilities.web_search?.configuration
    ) {
      if (session)
        throw new Error("Hosted context has incompatible capabilities");
      const t = getI18n().getFixedT(null, "app");
      return {
        status: "unavailable",
        get message() {
          return t("admission.messages.incompatibleCapabilities");
        },
      };
    }
    const recovery = recoveryGeneration(context.recovery_session_id);
    const generation = recovery ?? csrf;
    if (
      session?.owner !== context.user_id ||
      session.generation !== generation
    ) {
      if (session) await scope?.end();
      const recoveryKey = options.sessionKey
        ? key()
        : await hostedRecoveryIdentity(context.user_id, recovery, signal);
      signal?.throwIfAborted();
      session = {
        owner: context.user_id,
        generation,
        key: recoveryKey,
        recovery,
      };
    }
    return {
      status: "ready",
      session: { key: session.key, owner: { id: context.user_id } },
      capabilities,
      onboardingRequired: false,
    };
  }

  async function readAdmission(
    signal?: AbortSignal,
  ): Promise<RuntimeAdmission> {
    if (signOutAttempt) return { status: "sign-in-required" };
    if (incompleteSignOut()) {
      // Never readmit the session a failed sign-out left live: its retry view
      // stays until that session ends or a newer sign-in replaces it.
      const retryView = (): RuntimeAdmission =>
        takeSignInError()
          ? {
              status: "sign-in-required",
              get message() {
                return signInErrorMessage();
              },
            }
          : { status: "sign-in-required" };
      try {
        await liveSession(signal);
        if (incompleteSignOut()) return retryView();
      } catch {
        signal?.throwIfAborted();
        return retryView();
      }
    }
    if (signedOut || signedOutElsewhere) {
      // Sign-out keeps admission latched, but another site can still change or
      // clear the browser's display choice. Never adopt its account preference
      // or pass this display-only response through account admission.
      const revision = localeRevision;
      try {
        const response = await authorizedFetch("/v1/hosted/runtime-context", {
          signal,
        });
        if (response.ok) {
          const context = (await response.json()) as HostedContext;
          signal?.throwIfAborted();
          if (revision === localeRevision && context.schema_version === 1) {
            const input = hostedLocaleInput(context);
            locale = input
              ? { preference: null, visitor: input.visitor }
              : null;
          }
        }
      } catch {
        // A failed display refresh preserves the last visitor choice and can
        // never undo a local sign-out. An aborted read must remain superseded.
        signal?.throwIfAborted();
      }
      signal?.throwIfAborted();
      return { status: "sign-in-required" };
    }
    if (takeSignInError())
      return {
        status: "unavailable",
        get message() {
          return signInErrorMessage();
        },
      };
    const revision = localeRevision;
    const response =
      initialContext ??
      (await authorizedFetch("/v1/hosted/runtime-context", { signal }));
    initialContext = undefined;
    signal?.throwIfAborted();
    if (response.status === 401 || response.status === 403) {
      clearLocalePreference();
      session = null;
      csrf = null;
      void scope?.end();
      await purgeHostedRecoverySessions();
      forgetHostedRecoveryIdentity();
      signal?.throwIfAborted();
      return signInRequired();
    }
    if (!response.ok)
      throw new Error("Hosted context is temporarily unavailable");
    const context = (await response.json()) as HostedContext;
    signal?.throwIfAborted();
    if (context.state === "identity_unavailable" && session)
      throw new Error("Hosted identity is temporarily unavailable");
    const admission = await contextAdmission(context, signal);
    signal?.throwIfAborted();
    if (revision === localeRevision) {
      locale = hostedLocaleInput(context) ?? null;
      if (locale && context.state === "session_required")
        locale = { ...locale, preference: null };
    }
    return admission;
  }

  /** A person's retry permits one new setup attempt and restarts progress reads. */
  async function repair(signal?: AbortSignal): Promise<RuntimeAdmission> {
    setupRequested = true;
    setupPolls = 0;
    return readAdmission(signal);
  }

  const browserFetch: typeof globalThis.fetch = (input, init) => {
    const target = typeof input === "string" ? new URL(input, origin) : input;
    const request = new Request(target, init);
    const url = new URL(request.url);
    if (url.origin === origin && url.pathname.startsWith("/v1/")) {
      if (!scope)
        return Promise.reject(
          new DOMException(
            "Hosted product admission is required",
            "AbortError",
          ),
        );
      return scope.fetch(request);
    }
    return options.fetch(request);
  };

  function startEvents() {
    if (!scope || !listeners.size || events) return;
    const controller = new AbortController();
    events = controller;
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const response = await authorizedFetch("/v1/hosted/events", {
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          if (controller.signal.aborted) return;
          eventsDoubted = true;
          // The runtime context, not the events stream, decides whether admission ended.
          notify(
            response.status === 401 || response.status === 403
              ? "recheck"
              : "uncertain",
          );
          return;
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          if (buffer.length > 64 * 1024)
            throw new Error("Hosted events exceeded the buffer limit");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (/^event:\s*revoked\s*$/m.test(event)) {
              eventsDoubted = true;
              notify("recheck");
              return;
            }
            if (/^event:\s*ready\s*$/m.test(event)) {
              eventsDelay = 1_000;
              // A restored stream lets paused requests resume without waiting for
              // backoff; a plain refresh resumes the same session without pausing again.
              if (eventsDoubted) notify();
              eventsDoubted = false;
            }
          }
        }
        if (!controller.signal.aborted) {
          eventsDoubted = true;
          notify("uncertain");
        }
      } catch {
        if (!controller.signal.aborted) {
          eventsDoubted = true;
          notify("uncertain");
        }
      } finally {
        void reader?.cancel().catch(() => {});
        if (events === controller) events = null;
        if (!controller.signal.aborted && scope && listeners.size) {
          // Bounded exponential backoff with jitter keeps an outage from
          // turning every open tab into a once-per-second poller.
          const delay = Math.min(
            eventsDelay * (0.8 + Math.random() * 0.4),
            30_000,
          );
          eventsDelay = Math.min(eventsDelay * 2, 30_000);
          retryTimer = setTimeout(() => {
            retryTimer = null;
            startEvents();
          }, delay);
        }
      }
    })();
  }

  return {
    kind: "hosted",
    transport: { baseUrl: origin, fetch: authorizedFetch },
    browserFetch,
    readAdmission,
    repair,
    localeInput: () => locale,
    clearLocalePreference,
    confirmLocale: (preference) => {
      ++localeRevision;
      // Older compositions keep the existing settings-driven behavior.
      if (locale) locale = { preference, visitor: preference };
    },
    bindSession: (next) => {
      stopEvents();
      scope = next;
      if (next) startEvents();
    },
    accountAffordances: () => ({
      // Without a validated URL the Account controls are hidden, not broken.
      canOpenAccount: accountUrl !== null,
      signOutIncomplete: incompleteSignOut() !== null,
    }),
    accountActions: {
      signIn: () => {
        // A sign-out still running here targets the live session.
        const signingOut = signOutAttempt !== null;
        signedOut = false;
        signedOutElsewhere = false;
        // A later sign-out from this tab targets whatever session is live then;
        // a remaining shared record still names the failed sign-out's target.
        failedSignOutTarget = null;
        automaticSetup = true;
        session = null;
        forgetHostedRecoveryIdentity();
        loginRequest?.abort();
        const controller = new AbortController();
        loginRequest = controller;
        void (async () => {
          // Another tab may have signed in since this view signed out: adopt
          // that session instead of replacing it (and retiring its drafts).
          // The read also ends a failed sign-out's record that a newer
          // session replaced; the session such a sign-out left live is never
          // adopted.
          const live = await liveSession(controller.signal).catch(() => {
            controller.signal.throwIfAborted();
            return null;
          });
          if (live && !signingOut && !incompleteSignOut()) {
            failedSignOutTarget = null;
            return notify(true);
          }
          // Login is deliberately separate from product CSRF admission.
          const response = await options.fetch(
            new Request(new URL("/api/cloud/auth/login", origin), {
              method: "POST",
              signal: controller.signal,
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ return_path: signInReturnPath() }),
            }),
          );
          // A refused login (503) could not end the live session and started
          // nothing, so a failed sign-out keeps its retry view.
          if (!response.ok) throw new Error("Sign-in is unavailable");
          // Login has ended this browser's previous session, so a failed
          // sign-out's guard ends here, not when the person asks to sign in.
          loginsStarted += 1;
          forgetIncompleteSignOut();
          failedSignOutTarget = null;
          const result = (await response.json()) as {
            authorization_url?: string;
          };
          controller.signal.throwIfAborted();
          const url = safeNavigationUrl(result.authorization_url);
          if (!url)
            throw new Error("Sign-in requires a secure identity endpoint");
          signInFailed = false;
          options.navigate(url);
        })().catch(() => {
          if (!controller.signal.aborted) {
            signInError = true;
            notify(true);
          }
        });
      },
      /** Joins a running sign-out; a failed remote logout keeps its CSRF for the retry. */
      signOut: () =>
        (signOutAttempt ??= signOutOnce().finally(() => {
          signOutAttempt = null;
        })),
      openAccount: () => {
        if (!accountUrl) {
          const t = getI18n().getFixedT(null, "app");
          throw new WordedError(
            t("admission.accountUnavailableContactOperator"),
          );
        }
        options.navigate(accountUrl);
      },
      loadUsage: async (signal): Promise<RuntimeUsage> => {
        if (!scope) throw new Error("Account usage requires current admission");
        const response = await scope.fetch("/v1/hosted/quotas", { signal });
        if (!response.ok) throw new Error("Account usage is unavailable");
        const value = (await response.json()) as {
          turns: { used: number; limit: number };
          chats: { used: number; limit: number };
          storage_bytes: { used: number; limit: number };
          resets_at: string;
        };
        for (const unit of [value.turns, value.chats, value.storage_bytes]) {
          if (
            !unit ||
            !Number.isSafeInteger(unit.used) ||
            unit.used < 0 ||
            !Number.isSafeInteger(unit.limit) ||
            unit.limit < 0
          )
            throw new Error("Account usage has an incompatible format");
        }
        if (!Number.isFinite(Date.parse(value.resets_at)))
          throw new Error("Account usage has an incompatible reset time");
        const t = getI18n().getFixedT(null, "app");
        return {
          units: [
            {
              id: "turns",
              label: t("accountUsage.units.turns"),
              ...value.turns,
              resetsAt: value.resets_at,
            },
            {
              id: "chats",
              label: t("accountUsage.units.chats"),
              ...value.chats,
            },
            {
              id: "storage_bytes",
              label: t("accountUsage.units.storageBytes"),
              ...value.storage_bytes,
            },
          ],
        };
      },
    },
    subscribe: (refresh) => {
      listeners.add(refresh);
      // Returning to a tab checks the server again, including a tab another
      // tab signed out: someone may have signed in again since.
      const onFocus = () => {
        if (typeof document !== "undefined" && document.hidden) return;
        signedOutElsewhere = false;
        refresh();
      };
      if (typeof window !== "undefined") {
        window.addEventListener("focus", onFocus);
        if (typeof document !== "undefined")
          document.addEventListener("visibilitychange", onFocus);
        if (typeof BroadcastChannel !== "undefined" && !channel) {
          channel = new BroadcastChannel("animama-hosted-admission");
          channel.onmessage = (event: MessageEvent<unknown>) => {
            if (
              event.data &&
              typeof event.data === "object" &&
              "type" in event.data &&
              event.data.type === "signed-out"
            ) {
              // Only the tab that signed out stays latched; this one ends its
              // private work now and reads the server when it is next focused.
              signedOutElsewhere = true;
              session = null;
              clearLocalePreference();
              notify(true);
            }
          };
        }
      }
      startEvents();
      return () => {
        listeners.delete(refresh);
        if (typeof window !== "undefined")
          window.removeEventListener("focus", onFocus);
        if (typeof document !== "undefined")
          document.removeEventListener("visibilitychange", onFocus);
        if (!listeners.size) {
          stopEvents();
          if (bootstrapTimer) clearTimeout(bootstrapTimer);
          bootstrapTimer = null;
          channel?.close();
          channel = null;
        }
      };
    },
  };
}
