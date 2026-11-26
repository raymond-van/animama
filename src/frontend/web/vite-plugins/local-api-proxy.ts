import type { Plugin, ProxyOptions } from "vite";

const API_ROUTE = /^\/v1(?:\/|$)/;
const TELEMETRY_ROUTE = /^\/api\/telemetry\/(?:traces|metrics|logs)$/;
const SIGN_IN_RETURN_ROUTE = "/auth/callback";

/** Read server-owned origins once; a request can never choose a proxy target. */
export function localDevelopmentOrigins(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const publicOrigin = new URL(
    environment.ANIMAMA_PUBLIC_ORIGIN ?? "http://localhost:8000",
  );
  const apiTarget = new URL(
    environment.ANIMAMA_API_PROXY_TARGET ?? "http://127.0.0.1:8001",
  );
  for (const origin of [publicOrigin, apiTarget]) {
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new Error(
        "Local development requires fixed HTTP(S) origins without paths or credentials",
      );
    }
  }
  return { publicOrigin: publicOrigin.origin, apiTarget: apiTarget.origin };
}

/** Only application APIs and the one supported log WebSocket reach FastAPI. */
export function localAPIProxy(apiTarget: string): Record<string, ProxyOptions> {
  const http: ProxyOptions = {
    target: apiTarget,
    changeOrigin: false,
    xfwd: false,
    followRedirects: false,
    rewriteWsOrigin: false,
  };
  return {
    "^/v1/logs(?:\\?|$)": { ...http, ws: true },
    "^/v1(?:/|\\?|$)": { ...http, ws: false },
    "^/health(?:\\?|$)": { ...http, ws: false },
    "^/api/telemetry/(?:traces|metrics|logs)(?:\\?|$)": { ...http, ws: false },
    // The browser's return from OpenAI's ChatGPT sign-in; FastAPI admits it by its own rule.
    "^/auth/callback(?:\\?|$)": { ...http, ws: false },
  };
}

/** Prevent private paths from falling through Vite's development SPA fallback.
 * FastAPI remains responsible for admission; browser Host, Origin, Fetch
 * Metadata and CSRF headers cross the development proxy unchanged.
 */
export function localDevelopmentRouteFence(): Plugin {
  return {
    name: "animama-local-development-route-fence",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const rawPath = (request.url ?? "/").split("?", 1)[0];
        let path: string;
        try {
          path = decodeURIComponent(rawPath);
        } catch {
          response.writeHead(400, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const privatePath =
          /^\/(?:_desktop|internal|docs|redoc|openapi\.json)(?:\/|$)/.test(
            path,
          );
        const unknownAuth =
          /^\/auth(?:\/|$)/.test(path) && rawPath !== SIGN_IN_RETURN_ROUTE;
        const unknownAPI =
          /^\/api(?:\/|$)/.test(path) && !TELEMETRY_ROUTE.test(rawPath);
        const encodedAPI = API_ROUTE.test(path) && !API_ROUTE.test(rawPath);
        if (privatePath || unknownAuth || unknownAPI || encodedAPI) {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        next();
      });
    },
  };
}
