// @vitest-environment happy-dom
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PyGenerationConversation,
  PyGenerationConversationSnapshot,
} from "@animama/runtime-contracts/api-types";

import { queryKeys } from "@/query/keys";
import {
  generationConversation,
  generationDraft,
  generationSnapshot,
  generationUsage,
  jsonResponse,
} from "@/ui/generate/testing/generationFixtures";
import {
  mountGenerationHook,
  type MountedHook,
} from "@/ui/generate/testing/generationHarness";
import {
  useCreateGenerationConversation,
  useDeleteGenerationConversation,
  useDiscardGenerationDraft,
  useMarkGenerationDraftSaved,
  useRestoreGenerationDraft,
} from "./useGenerationMutations";

const SNAPSHOT = queryKeys.generation.conversation("session", "conversation-1");
const LIST = queryKeys.generation.conversations("session");

const server = {
  requests: [] as { method: string; path: string; body: unknown }[],
  answer: jsonResponse({}) as Response,
};

async function fetch(request: Request): Promise<Response> {
  server.requests.push({
    method: request.method,
    path: new URL(request.url).pathname,
    body:
      request.method === "POST" ? await request.json().catch(() => null) : null,
  });
  return server.answer;
}

function useMutations() {
  return {
    create: useCreateGenerationConversation(),
    remove: useDeleteGenerationConversation(),
    restore: useRestoreGenerationDraft(),
    discard: useDiscardGenerationDraft(),
    markSaved: useMarkGenerationDraftSaved(),
  };
}

let queryClient: QueryClient;
let mounted: MountedHook<null, ReturnType<typeof useMutations>>;
const snapshot = () =>
  queryClient.getQueryData<PyGenerationConversationSnapshot>(SNAPSHOT);
const list = () => queryClient.getQueryData<PyGenerationConversation[]>(LIST);

beforeEach(() => {
  server.requests = [];
  queryClient = new QueryClient();
  mounted = mountGenerationHook(useMutations, {
    props: null,
    fetch,
    queryClient,
  });
});

afterEach(() => mounted.unmount());

describe("assistant conversations", () => {
  it("starts an empty conversation on the Generate page", async () => {
    const older = generationConversation({ id: "conversation-0" });
    queryClient.setQueryData(LIST, [older]);
    const created = generationConversation();
    server.answer = jsonResponse(created, 201);

    await act(() => mounted.result().create.mutateAsync());

    expect(server.requests).toEqual([
      {
        method: "POST",
        path: "/v1/generation/conversations",
        body: { scope: { kind: "page" } },
      },
    ]);
    // Known without a read: a new conversation is empty and listed first.
    expect(snapshot()).toEqual({
      conversation: created,
      messages: [],
      drafts: [],
      // No run yet: the token use the backend reports for it.
      usage: generationUsage(),
    });
    expect(list()).toEqual([created, older]);
  });

  it("deletes a conversation and forgets it", async () => {
    queryClient.setQueryData(SNAPSHOT, generationSnapshot());
    const other = generationConversation({ id: "conversation-2" });
    queryClient.setQueryData(LIST, [generationConversation(), other]);
    server.answer = jsonResponse(null, 204);

    await act(() => mounted.result().remove.mutateAsync("conversation-1"));

    expect(server.requests[0]).toMatchObject({
      method: "DELETE",
      path: "/v1/generation/conversations/conversation-1",
    });
    expect(snapshot()).toBeUndefined();
    expect(list()).toEqual([other]);
  });

  it("reads the person's files again after a discard, which may have deleted images", async () => {
    // The discard deletes the reference images only that conversation used.
    const files = [...queryKeys.userFiles.all("session"), "list"];
    queryClient.setQueryData(files, [{ file_id: "file-1" }]);
    queryClient.setQueryData(SNAPSHOT, generationSnapshot());
    server.answer = jsonResponse(null, 204);

    await act(() => mounted.result().remove.mutateAsync("conversation-1"));

    expect(queryClient.getQueryState(files)?.isInvalidated).toBe(true);
  });

  it("leaves the cached files alone when the discard was refused", async () => {
    const files = [...queryKeys.userFiles.all("session"), "list"];
    queryClient.setQueryData(files, [{ file_id: "file-1" }]);
    server.answer = jsonResponse(
      { detail: { code: "generation_run_in_progress" } },
      409,
    );

    await act(() =>
      mounted
        .result()
        .remove.mutateAsync("conversation-1")
        .catch(() => undefined),
    );

    expect(queryClient.getQueryState(files)?.isInvalidated).toBe(false);
  });

  it("keeps a conversation the server refuses to delete, with the refusal's code", async () => {
    queryClient.setQueryData(SNAPSHOT, generationSnapshot());
    server.answer = jsonResponse(
      { detail: { code: "generation_run_in_progress" } },
      409,
    );

    const refusal = await act(() =>
      mounted
        .result()
        .remove.mutateAsync("conversation-1")
        .catch((error: unknown) => error),
    );

    expect(refusal).toEqual({ detail: { code: "generation_run_in_progress" } });
    expect(snapshot()).toEqual(generationSnapshot());
  });
});

describe("assistant drafts", () => {
  beforeEach(() => {
    queryClient.setQueryData(
      SNAPSHOT,
      generationSnapshot({
        drafts: [
          generationDraft({
            version: 2,
            status: "ready",
            checked_version: 2,
            has_previous_version: true,
          }),
        ],
      }),
    );
  });

  it("restores the previous version as a new one to check", async () => {
    const restored = generationDraft({ version: 3, checked_version: 2 });
    server.answer = jsonResponse(restored);

    await act(() => mounted.result().restore.mutateAsync("draft-1"));

    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/generation/drafts/draft-1:restore",
    });
    expect(snapshot()?.drafts).toEqual([restored]);
  });

  it("records the Library item a draft was saved as", async () => {
    const saved = generationDraft({
      version: 2,
      status: "ready",
      checked_version: 2,
      saved_item_id: "item-9",
      updated_at: "2026-11-26T10:05:00Z",
    });
    server.answer = jsonResponse(saved);

    await act(() =>
      mounted
        .result()
        .markSaved.mutateAsync({ draftId: "draft-1", itemId: "item-9" }),
    );

    expect(server.requests).toEqual([
      {
        method: "POST",
        path: "/v1/generation/drafts/draft-1:mark-saved",
        body: { item_id: "item-9" },
      },
    ]);
    expect(snapshot()?.drafts).toEqual([saved]);
  });

  it("discards a draft", async () => {
    server.answer = jsonResponse(null, 204);

    await act(() =>
      mounted.result().discard.mutateAsync({
        id: "draft-1",
        conversation_id: "conversation-1",
      }),
    );

    expect(server.requests[0]).toMatchObject({
      method: "DELETE",
      path: "/v1/generation/drafts/draft-1",
    });
    expect(snapshot()?.drafts).toEqual([]);
  });
});
