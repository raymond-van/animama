// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHATGPT_PLAN_PROVIDER_TYPE } from "@/lib/chat/model-catalog";
import { jsonResponse } from "./testing/generationFixtures";
import {
  mountGenerationHook,
  settle,
  type MountedHook,
} from "./testing/generationHarness";
import {
  useGenerationModel,
  type GenerationModelChoice,
} from "./useGenerationModel";

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  model: id,
  model_provider: "OpenAIResponsesHTTPAgent",
  api_standard: "responses",
  model_kind: "chat",
  source: "builtin",
  hidden: false,
  supports_tools: true,
  supports_streaming: true,
  ...overrides,
});

const server = {
  catalog: [] as ReturnType<typeof row>[],
  preferences: {} as Record<string, unknown>,
  patches: [] as unknown[],
  /** Answers the catalog read with a failure. */
  catalogDown: false,
};

async function fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/v1/model-providers")
    return server.catalogDown
      ? jsonResponse({ detail: { code: "unavailable" } }, 503)
      : jsonResponse(server.catalog);
  if (pathname === "/v1/users/me/settings") {
    if (request.method === "PATCH") {
      const body = (await request.json()) as {
        preferences: Record<string, unknown>;
      };
      server.patches.push(body);
      server.preferences = body.preferences;
    }
    return jsonResponse({ preferences: server.preferences });
  }
  throw new Error(`Unexpected request: ${request.method} ${pathname}`);
}

let mounted: MountedHook<null, GenerationModelChoice>;
const mount = async () => {
  mounted = mountGenerationHook(useGenerationModel, { props: null, fetch });
  await settle();
  return mounted.result;
};

beforeEach(() => {
  server.catalog = [
    row("key-model"),
    row("no-tools", { supports_tools: false }),
    row("plan-model", { model_provider: CHATGPT_PLAN_PROVIDER_TYPE }),
    // The owner's own model, which chat cannot use without a context window.
    row("own-no-window", { source: "owner", context_window_tokens: null }),
  ];
  server.preferences = { speech: { tts_enabled: false } };
  server.patches = [];
  server.catalogDown = false;
});

afterEach(() => {
  mounted.unmount();
  vi.restoreAllMocks();
});

describe("useGenerationModel", () => {
  it("offers the eligible models and no model before the owner chose one", async () => {
    const result = await mount();
    expect(result().isPending).toBe(false);
    expect(result().models.map(({ id }) => id)).toEqual([
      "plan-model",
      "key-model",
    ]);
    // No choice means setup; the assistant never picks one itself.
    expect(result().model).toBeNull();
  });

  it("saves the choice in the owner's preferences, keeping the others", async () => {
    const result = await mount();
    await act(() => result().choose("key-model"));
    await settle();

    expect(server.patches).toEqual([
      {
        preferences: {
          speech: { tts_enabled: false },
          generation: { model_provider_id: "key-model" },
        },
      },
    ]);
    expect(result().model?.id).toBe("key-model");
  });

  it("says when the models could not be read, and reads them again on retry", async () => {
    server.catalogDown = true;
    server.preferences = { generation: { model_provider_id: "key-model" } };
    const result = await mount();
    expect(result().isError).toBe(true);

    server.catalogDown = false;
    act(() => result().retry());
    await settle();
    expect(result().isError).toBe(false);
    expect(result().model?.id).toBe("key-model");
  });

  it("reads the saved choice, and none when that model can no longer be used", async () => {
    server.preferences = { generation: { model_provider_id: "plan-model" } };
    const result = await mount();
    expect(result().model?.id).toBe("plan-model");
    mounted.unmount();

    // Signed out of the plan: its models left the catalog.
    server.catalog = [row("key-model")];
    const after = await mount();
    expect(after().model).toBeNull();
    expect(after().models.map(({ id }) => id)).toEqual(["key-model"]);
  });
});
