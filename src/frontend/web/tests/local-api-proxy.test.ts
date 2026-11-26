import { createHash } from "node:crypto";
import {
  createServer as createHTTPServer,
  request as httpRequest,
} from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

import {
  localAPIProxy,
  localDevelopmentOrigins,
  localDevelopmentRouteFence,
} from "../vite-plugins/local-api-proxy";

const publicOrigin = "http://animama-fixture.localhost:8200";
const authority = new URL(publicOrigin).host;

/**
 * Reserve an ephemeral loopback port. Vite treats `port: 0` as unset and falls
 * back to its default 5173, which another local Vite may already hold.
 */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Use actual Node sockets and Vite, without the Docker stack or product data. */
async function fixture() {
  const observed: {
    path: string;
    headers: IncomingHttpHeaders;
    body: string;
  }[] = [];
  const upgrades: IncomingHttpHeaders[] = [];
  const api = createHTTPServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      observed.push({ path: request.url!, headers: request.headers, body });
      // Stand in for FastAPI's independent admission, so header preservation
      // failures are visible as a rejected operation rather than a mocked call.
      const permitted =
        request.headers.host === authority &&
        (!request.headers.origin || request.headers.origin === publicOrigin) &&
        (request.method !== "POST" ||
          (request.headers["x-animama-csrf"] === "1" &&
            request.headers["sec-fetch-site"] === "same-origin"));
      response.writeHead(permitted ? 200 : 403, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ accepted: permitted }));
    });
  });
  api.on("upgrade", (request, socket) => {
    upgrades.push(request.headers);
    const accept = createHash("sha1")
      .update(
        `${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest("base64");
    socket.end(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    api.once("error", reject);
    api.listen(0, "127.0.0.1", () => {
      api.off("error", reject);
      resolve();
    });
  });
  const apiPort = (api.address() as AddressInfo).port;
  const root = await mkdtemp(join(tmpdir(), "animama-vite-proxy-"));
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><title>Local app</title>",
  );
  const vite = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [localDevelopmentRouteFence()],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: "127.0.0.1",
      port: await freePort(),
      strictPort: true,
      allowedHosts: ["animama-fixture.localhost"],
      proxy: localAPIProxy(`http://127.0.0.1:${apiPort}`),
    },
  });
  await vite.listen();
  const port = (vite.httpServer!.address() as AddressInfo).port;
  return {
    observed,
    upgrades,
    port,
    async close() {
      await vite.close();
      await closeServer(api);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function request(
  port: number,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body = "",
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { Host: authority, ...headers },
      },
      (response) => {
        let received = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          received += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode!, body: received }),
        );
        response.on("error", reject);
      },
    );
    request.setTimeout(2000, () =>
      request.destroy(new Error("Proxy test timeout")),
    );
    request.on("error", reject);
    request.end(body);
  });
}

describe("local development proxy", () => {
  it("forwards original authority, browser metadata, CSRF and streamed bytes", async () => {
    const stack = await fixture();
    try {
      const headers = {
        Origin: publicOrigin,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "X-Animama-CSRF": "1",
        "Content-Type": "application/json",
      };
      expect(
        (
          await request(
            stack.port,
            "/v1/chats?operation=original",
            "POST",
            headers,
            '{"message":"hello"}',
          )
        ).status,
      ).toBe(200);
      expect(stack.observed).toHaveLength(1);
      const forwarded = stack.observed[0];
      expect(forwarded.path).toBe("/v1/chats?operation=original");
      expect(forwarded.body).toBe('{"message":"hello"}');
      expect(forwarded.headers.host).toBe(authority);
      for (const [name, value] of Object.entries(headers))
        expect(forwarded.headers[name.toLowerCase()]).toBe(value);
      expect(forwarded.headers["x-forwarded-host"]).toBeUndefined();
      expect(forwarded.headers["x-animama-internal-token"]).toBeUndefined();
      expect(forwarded.headers["x-animama-principal-id"]).toBeUndefined();
    } finally {
      await stack.close();
    }
  });

  it("does not manufacture valid Origin, Host or CSRF metadata for rejected requests", async () => {
    const stack = await fixture();
    try {
      expect(
        (
          await request(stack.port, "/v1/chats", "POST", {
            Origin: "https://hostile.invalid",
            "Sec-Fetch-Site": "cross-site",
          })
        ).status,
      ).toBe(403);
      expect(stack.observed[0].headers.origin).toBe("https://hostile.invalid");
      expect(stack.observed[0].headers["sec-fetch-site"]).toBe("cross-site");
      expect(stack.observed[0].headers["x-animama-csrf"]).toBeUndefined();
      expect(
        (
          await request(stack.port, "/v1/chats", "GET", {
            Host: "localhost:9999",
          })
        ).status,
      ).toBe(403);
      expect(stack.observed[1].headers.host).toBe("localhost:9999");
    } finally {
      await stack.close();
    }
  });

  it("never proxies private routes or hides them behind the SPA fallback", async () => {
    const stack = await fixture();
    try {
      for (const path of [
        "/_desktop/health",
        "/internal/config",
        "/docs",
        "/redoc",
        "/openapi.json",
        "/api/auth/sign-in",
        "/auth",
        "/auth/other",
        "/auth/callback/x",
        "/%61uth/callback",
        "/api/unknown",
        "/api/telemetry/unknown",
        "/%76%31/chats",
      ]) {
        expect(
          (await request(stack.port, path, "GET", { Accept: "text/html" }))
            .status,
          path,
        ).toBe(404);
      }
      expect(stack.observed).toHaveLength(0);
      expect((await request(stack.port, "/health")).status).toBe(200);
      // The ChatGPT sign-in return arrives at 127.0.0.1, which Vite's host check
      // accepts. It reaches FastAPI with its Host and query untouched; the
      // stand-in refuses that Host, while FastAPI admits it by its own rule.
      await request(stack.port, "/auth/callback?code=c&state=s", "GET", {
        Host: `127.0.0.1:${stack.port}`,
      });
      expect(stack.observed.at(-1)).toMatchObject({
        path: "/auth/callback?code=c&state=s",
        headers: { host: `127.0.0.1:${stack.port}` },
      });
      expect(
        (
          await request(
            stack.port,
            "/api/telemetry/logs",
            "POST",
            {
              Origin: publicOrigin,
              "Sec-Fetch-Site": "same-origin",
              "X-Animama-CSRF": "1",
            },
            "{}",
          )
        ).status,
      ).toBe(200);
      expect(stack.observed.map(({ path }) => path)).toEqual([
        "/health",
        "/auth/callback?code=c&state=s",
        "/api/telemetry/logs",
      ]);
    } finally {
      await stack.close();
    }
  });

  it("preserves log WebSocket Origin and Host without enabling arbitrary upgrades", async () => {
    const stack = await fixture();
    try {
      await new Promise<void>((resolve, reject) => {
        const upgrade = httpRequest({
          hostname: "127.0.0.1",
          port: stack.port,
          path: "/v1/logs",
          headers: {
            Host: authority,
            Origin: publicOrigin,
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version": "13",
          },
        });
        upgrade.on("upgrade", (_response, socket) => {
          socket.destroy();
          resolve();
        });
        upgrade.on("error", reject);
        upgrade.setTimeout(2000, () =>
          upgrade.destroy(new Error("Upgrade test timeout")),
        );
        upgrade.end();
      });
      expect(stack.upgrades).toHaveLength(1);
      expect(stack.upgrades[0].host).toBe(authority);
      expect(stack.upgrades[0].origin).toBe(publicOrigin);
      const rules = localAPIProxy("http://127.0.0.1:8000");
      expect(
        Object.entries(rules)
          .filter(([, options]) => options.ws)
          .map(([route]) => route),
      ).toEqual(["^/v1/logs(?:\\?|$)"]);
    } finally {
      await stack.close();
    }
  });

  it.each([
    "file:///private/data",
    "https://user:secret@collector",
    "http://localhost:8000/path",
    "http://localhost:8000?url=hostile",
  ])("rejects invalid operator target %s", (apiTarget) => {
    expect(() =>
      localDevelopmentOrigins({ ANIMAMA_API_PROXY_TARGET: apiTarget }),
    ).toThrow();
  });
});
