// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PyGenerationConversation } from "@animama/runtime-contracts/api-types";

import { generationConversation } from "../testing/generationFixtures";
import {
  mountGenerationHook,
  settle,
  type MountedHook,
} from "../testing/generationHarness";
import { useCreatorGenerationConversation } from "./useCreatorGenerationConversation";

type Props = Parameters<typeof useCreatorGenerationConversation>[0];
type Result = ReturnType<typeof useCreatorGenerationConversation>;

const server = {
  conversations: [] as PyGenerationConversation[],
  created: [] as unknown[],
  deleted: [] as string[],
};

const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const { pathname } = new URL(request.url);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (pathname === "/v1/generation/conversations" && request.method === "GET")
    return json({ conversations: server.conversations });
  if (pathname === "/v1/generation/conversations") {
    const { scope } = (await request.json()) as {
      scope: PyGenerationConversation["scope"];
    };
    server.created.push(scope);
    const conversation = generationConversation({
      id: `created-${server.created.length}`,
      scope,
    });
    server.conversations = [conversation, ...server.conversations];
    return json(conversation, 201);
  }
  if (request.method === "DELETE") {
    const id = pathname.split("/").at(-1)!;
    server.deleted.push(id);
    server.conversations = server.conversations.filter(
      (conversation) => conversation.id !== id,
    );
    return new Response(null, { status: 204 });
  }
  return json({ detail: { code: "not_found" } }, 404);
});

const creatorScope = (
  id: string,
  intent: "gesture" | "reaction",
  itemId: string | null,
) =>
  generationConversation({
    id,
    scope: { kind: "creator", intent, catalog_item_id: itemId },
  });

let mounted: MountedHook<Props, Result>;
async function mount(props: Props) {
  mounted = mountGenerationHook(useCreatorGenerationConversation, {
    props,
    fetch,
  });
  await settle();
  return mounted;
}

beforeEach(() => {
  window.sessionStorage.clear();
  server.conversations = [
    generationConversation({ id: "page-1" }),
    creatorScope("gesture-item-1", "gesture", "item-1"),
    creatorScope("reaction-item-1", "reaction", "item-1"),
    creatorScope("gesture-unsaved-old", "gesture", null),
  ];
  server.created = [];
  server.deleted = [];
  fetch.mockClear();
});
afterEach(() => mounted?.unmount());

describe("the assistant conversation of the item open in a creator", () => {
  it("finds a saved item's own conversation again, by kind and id", async () => {
    const { result, rerender } = await mount({
      intent: "gesture",
      itemId: "item-1",
      enabled: true,
    });
    expect(result().conversationId).toBe("gesture-item-1");
    rerender({ intent: "reaction", itemId: "item-1", enabled: true });
    await settle();
    expect(result().conversationId).toBe("reaction-item-1");
    expect(server.created).toEqual([]);
  });

  it("starts one for an item that has none, once the panel is used", async () => {
    const { result, rerender } = await mount({
      intent: "gesture",
      itemId: "item-2",
      enabled: false,
    });
    expect(result().conversationId).toBeNull();
    expect(server.created).toEqual([]);

    rerender({ intent: "gesture", itemId: "item-2", enabled: true });
    await settle();
    expect(server.created).toEqual([
      { kind: "creator", intent: "gesture", catalog_item_id: "item-2" },
    ]);
    expect(result().conversationId).toBe("created-1");
    // Nothing of another item, or of the Generate page, is touched.
    expect(server.deleted).toEqual([]);
  });

  it("gives an unsaved item a conversation of its own and leaves another tab's alone", async () => {
    const { result } = await mount({
      intent: "gesture",
      itemId: null,
      enabled: true,
    });
    // This tab did not start the earlier unsaved Gesture's conversation: it
    // may be another tab's, so it is left for the backend's seven-day rule.
    expect(server.deleted).toEqual([]);
    expect(server.created).toEqual([
      { kind: "creator", intent: "gesture", catalog_item_id: null },
    ]);
    expect(result().conversationId).toBe("created-1");
  });

  it("removes only what this tab's earlier unsaved items left behind", async () => {
    const first = await mount({
      intent: "gesture",
      itemId: null,
      enabled: true,
    });
    expect(first.result().conversationId).toBe("created-1");
    // The creator closes; a new unsaved Gesture opens in the same tab.
    first.unmount();

    const second = await mount({
      intent: "gesture",
      itemId: null,
      enabled: true,
    });
    expect(second.result().conversationId).toBe("created-2");
    expect(server.deleted).toEqual(["created-1"]);
    expect(server.conversations.map(({ id }) => id)).toContain(
      "gesture-unsaved-old",
    );
  });

  it("never lets two unsaved creators of one kind delete each other's conversation", async () => {
    const one = mountGenerationHook(useCreatorGenerationConversation, {
      props: { intent: "gesture", itemId: null, enabled: true },
      fetch,
    });
    await settle();
    const two = mountGenerationHook(useCreatorGenerationConversation, {
      props: { intent: "gesture", itemId: null, enabled: true },
      fetch,
    });
    await settle();
    mounted = two;

    expect(one.result().conversationId).toBe("created-1");
    expect(two.result().conversationId).toBe("created-2");
    // Each keeps its own; neither removed the other's, though this tab
    // started both.
    expect(server.deleted).toEqual([]);
    expect(server.created).toHaveLength(2);
    one.unmount();
  });
});
