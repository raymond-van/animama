// @vitest-environment happy-dom
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PyGenerationConversation } from "@animama/runtime-contracts/api-types";

import {
  generationConversation,
  jsonResponse,
} from "./testing/generationFixtures";
import {
  mountGenerationHook,
  settle,
  type MountedHook,
} from "./testing/generationHarness";
import {
  useGenerationConversationChoice,
  type GenerationConversationChoice,
} from "./useGenerationConversationChoice";

/** The assistant's conversations, as far as the page's choice touches them. */
const server = {
  conversations: [] as PyGenerationConversation[],
  created: 0,
  deleted: [] as string[],
  listDown: false,
  createDown: false,
  refuseDelete: false,
};

async function fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const refusal = (code: string, status: number) =>
    jsonResponse({ detail: { code } }, status);
  if (pathname.endsWith("/conversations")) {
    if (request.method === "GET")
      return server.listDown
        ? refusal("unavailable", 503)
        : jsonResponse({ conversations: server.conversations });
    if (server.createDown) return refusal("unavailable", 503);
    server.created += 1;
    const conversation = generationConversation({
      id: `created-${server.created}`,
    });
    server.conversations = [conversation, ...server.conversations];
    return jsonResponse(conversation, 201);
  }
  if (request.method === "DELETE") {
    if (server.refuseDelete) return refusal("generation_run_in_progress", 409);
    const id = pathname.split("/").at(-1)!;
    server.deleted.push(id);
    server.conversations = server.conversations.filter(
      (conversation) => conversation.id !== id,
    );
    return jsonResponse(null, 204);
  }
  throw new Error(`Unexpected request: ${request.method} ${pathname}`);
}

let mounted: MountedHook<null, GenerationConversationChoice>;
/** The choice over state the page holds; `opened` is what it held before. */
async function mount(strict = false, opened: string | null = null) {
  mounted = mountGenerationHook(
    () => useGenerationConversationChoice(useState<string | null>(opened)),
    { props: null, fetch, strict },
  );
  await settle();
  return mounted.result;
}

beforeEach(() => {
  server.conversations = [];
  server.created = 0;
  server.deleted = [];
  server.listDown = false;
  server.createDown = false;
  server.refuseDelete = false;
});
afterEach(() => mounted.unmount());

describe("useGenerationConversationChoice", () => {
  it("opens the conversation written to most recently", async () => {
    server.conversations = [
      generationConversation({ id: "latest", title: "a bow" }),
      generationConversation({ id: "older", title: "a wave" }),
    ];
    const result = await mount();
    expect(result().conversationId).toBe("latest");
    expect(result().conversations.map(({ id }) => id)).toEqual([
      "latest",
      "older",
    ]);
    expect(server.created).toBe(0);
  });

  it("keeps the conversation the page already had open, though another is the latest", async () => {
    server.conversations = [
      generationConversation({ id: "latest" }),
      generationConversation({ id: "older" }),
    ];
    // As after Model setup, which unmounts the workspace.
    const result = await mount(false, "older");
    expect(result().conversationId).toBe("older");
    expect(server.created).toBe(0);
  });

  it("starts the first conversation itself, once", async () => {
    // Development replays effects; still only one conversation is started.
    const result = await mount(true);
    expect(server.created).toBe(1);
    expect(result().conversationId).toBe("created-1");
    expect(result().conversations.map(({ id }) => id)).toEqual(["created-1"]);
  });

  it("leaves a creator's conversations to that creator", async () => {
    server.conversations = [
      generationConversation({
        id: "in-creator",
        scope: { kind: "creator", intent: "gesture", catalog_item_id: null },
      }),
      generationConversation({ id: "on-page" }),
    ];
    const result = await mount();
    expect(result().conversations.map(({ id }) => id)).toEqual(["on-page"]);
    expect(result().conversationId).toBe("on-page");
  });

  it("starts a new conversation and reopens an earlier one", async () => {
    server.conversations = [generationConversation({ id: "older" })];
    const result = await mount();
    await act(() => result().startNew());
    await settle();
    expect(result().conversationId).toBe("created-1");
    expect(result().conversations.map(({ id }) => id)).toEqual([
      "created-1",
      "older",
    ]);

    act(() => result().open("older"));
    expect(result().conversationId).toBe("older");
  });

  it("after discarding the open conversation opens the next, or starts one", async () => {
    server.conversations = [
      generationConversation({ id: "latest" }),
      generationConversation({ id: "older" }),
    ];
    const result = await mount();
    await act(() => result().discard("latest"));
    await settle();
    expect(server.deleted).toEqual(["latest"]);
    expect(result().conversationId).toBe("older");

    await act(() => result().discard("older"));
    await settle();
    expect(result().conversationId).toBe("created-1");
  });

  it("keeps the conversation open when the server refuses to delete it", async () => {
    server.conversations = [generationConversation({ id: "latest" })];
    server.refuseDelete = true;
    const result = await mount();
    let refused: unknown;
    await act(async () => {
      await result()
        .discard("latest")
        .catch((error: unknown) => {
          refused = error;
        });
    });
    expect(refused).toMatchObject({
      detail: { code: "generation_run_in_progress" },
    });
    expect(result().conversationId).toBe("latest");
  });

  it("says when conversations cannot be read or started, and tries again", async () => {
    server.listDown = true;
    const result = await mount();
    expect(result().isError).toBe(true);
    expect(result().conversationId).toBeNull();

    server.listDown = false;
    server.createDown = true;
    act(() => result().retry());
    await settle();
    // The list is read, but the first conversation cannot be started.
    expect(result().isError).toBe(true);
    expect(result().conversationId).toBeNull();

    server.createDown = false;
    act(() => result().retry());
    await settle();
    expect(result().isError).toBe(false);
    expect(result().conversationId).toBe("created-1");
  });
});
