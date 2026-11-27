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
  /** Holds each settings save until the test releases it. */
  holdSaves: null as Promise<void> | null,
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
      await server.holdSaves;
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
    row("plan-model", {
      model_provider: CHATGPT_PLAN_PROVIDER_TYPE,
      supported_reasoning_efforts: ["low", "medium", "high"],
    }),
    // The owner's own model, which chat cannot use without a context window.
    row("own-no-window", { source: "owner", context_window_tokens: null }),
    row("hidden-model", { hidden: true }),
  ];
  server.preferences = { speech: { tts_enabled: false } };
  server.patches = [];
  server.catalogDown = false;
  server.holdSaves = null;
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
    // The pickers also show the visible models that cannot be chosen, with why.
    expect(
      result().listed.map(({ item, unavailable }) => [item.id, unavailable]),
    ).toEqual([
      ["plan-model", null],
      ["key-model", null],
      ["no-tools", "tools_unsupported"],
      ["own-no-window", "context_window_missing"],
    ]);
  });

  it("offers the chosen model's effort levels and names none until one is chosen", async () => {
    server.preferences = { generation: { model_provider_id: "plan-model" } };
    const result = await mount();
    expect(result().efforts).toEqual(["low", "medium", "high"]);
    // No level chosen: the model's own default applies, and none is preselected.
    expect(result().effort).toBeNull();
    mounted.unmount();

    // A model that offers no levels has nothing to choose.
    server.preferences = { generation: { model_provider_id: "key-model" } };
    const none = await mount();
    expect(none().efforts).toEqual([]);
    expect(none().effort).toBeNull();
  });

  it("remembers a level for each model by itself, beside the model choice", async () => {
    server.preferences = {
      generation: {
        model_provider_id: "plan-model",
        reasoning_efforts: { "key-model": "max" },
      },
    };
    const result = await mount();
    await act(() => result().chooseEffort("high"));
    await settle();

    expect(server.patches).toEqual([
      {
        preferences: {
          generation: {
            model_provider_id: "plan-model",
            reasoning_efforts: { "key-model": "max", "plan-model": "high" },
          },
        },
      },
    ]);
    expect(result().effort).toBe("high");

    // Back to the model's default, for this model only.
    await act(() => result().chooseEffort(null));
    await settle();
    expect(result().effort).toBeNull();
    expect(server.preferences).toEqual({
      generation: {
        model_provider_id: "plan-model",
        reasoning_efforts: { "key-model": "max", "plan-model": null },
      },
    });
  });

  it("keeps the model control usable while an effort level is being saved", async () => {
    server.preferences = { generation: { model_provider_id: "plan-model" } };
    const result = await mount();
    let release!: () => void;
    server.holdSaves = new Promise<void>((resolve) => {
      release = resolve;
    });

    let saved!: Promise<void>;
    act(() => {
      saved = result().chooseEffort("low");
    });
    await settle();
    // The save is in flight, and the control is not held as for a model choice.
    expect(server.patches).toHaveLength(1);
    expect(result().isChoosing).toBe(false);

    release();
    await act(() => saved);
    await settle();
    expect(result().effort).toBe("low");

    // Choosing a model does hold it.
    server.holdSaves = new Promise<void>((resolve) => {
      release = resolve;
    });
    act(() => {
      saved = result().choose("key-model");
    });
    await settle();
    expect(result().isChoosing).toBe(true);
    release();
    await act(() => saved);
    await settle();
    expect(result().isChoosing).toBe(false);
  });

  it("names no level the chosen model does not list", async () => {
    server.preferences = {
      generation: {
        model_provider_id: "plan-model",
        // Saved when the model listed it, or for another model's scale.
        reasoning_efforts: { "plan-model": "xhigh", "key-model": "high" },
      },
    };
    const result = await mount();
    expect(result().effort).toBeNull();
    await act(() => result().choose("key-model"));
    await settle();
    // A model without levels sends none, whatever was saved for it.
    expect(result().effort).toBeNull();
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
