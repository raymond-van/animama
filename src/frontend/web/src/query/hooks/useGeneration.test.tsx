// @vitest-environment happy-dom
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PyGenerationConversationSnapshot } from "@animama/runtime-contracts/api-types";

import { queryKeys } from "@/query/keys";
import {
  generationConversation,
  generationDraft,
  generationSnapshot,
  jsonResponse,
} from "@/ui/generate/testing/generationFixtures";
import {
  mountGenerationHook,
  settle,
} from "@/ui/generate/testing/generationHarness";
import {
  refreshGenerationConversation,
  removeGenerationDraft,
  useGenerationConversation,
  useGenerationConversations,
  writeGenerationDraft,
} from "./useGeneration";

const KEY = queryKeys.generation.conversation("session", "conversation-1");
const capabilities = vi.hoisted(() => ({ withhold: false }));

vi.mock("@/query/hooks/useRuntimeCapabilities", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/query/hooks/useRuntimeCapabilities")
    >();
  return {
    useRuntimeCapabilities: () => {
      const query = actual.useRuntimeCapabilities();
      return capabilities.withhold
        ? { ...query, data: { ...query.data, content_generation: false } }
        : query;
    },
  };
});

function cacheWith(snapshot: PyGenerationConversationSnapshot) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(KEY, snapshot);
  return {
    queryClient,
    drafts: () =>
      queryClient.getQueryData<PyGenerationConversationSnapshot>(KEY)!.drafts,
  };
}

afterEach(() => {
  capabilities.withhold = false;
});

describe("writeGenerationDraft", () => {
  it("adds a new draft in position order", () => {
    const first = generationDraft({ id: "draft-1", position: 0 });
    const third = generationDraft({ id: "draft-3", position: 2 });
    const { queryClient, drafts } = cacheWith(
      generationSnapshot({ drafts: [first, third] }),
    );
    const second = generationDraft({ id: "draft-2", position: 1 });
    writeGenerationDraft(queryClient, "session", second);
    expect(drafts()).toEqual([first, second, third]);
  });

  it("replaces a draft with a newer version or a later state of one version", () => {
    const stored = generationDraft({ updated_at: "2026-11-26T10:00:00Z" });
    const { queryClient, drafts } = cacheWith(
      generationSnapshot({ drafts: [stored] }),
    );
    const repairing = generationDraft({
      status: "repairing",
      checked_version: 1,
      updated_at: "2026-11-26T10:00:05Z",
    });
    writeGenerationDraft(queryClient, "session", repairing);
    expect(drafts()).toEqual([repairing]);

    const next = generationDraft({
      version: 2,
      updated_at: "2026-11-26T10:00:09Z",
    });
    writeGenerationDraft(queryClient, "session", next);
    expect(drafts()).toEqual([next]);
  });

  it("keeps the later state when answers arrive out of order", () => {
    const repairing = generationDraft({
      version: 2,
      status: "repairing",
      updated_at: "2026-11-26T10:00:05Z",
    });
    const { queryClient, drafts } = cacheWith(
      generationSnapshot({ drafts: [repairing] }),
    );
    // A check report's answer for the version before, landing late.
    writeGenerationDraft(
      queryClient,
      "session",
      generationDraft({ version: 1, updated_at: "2026-11-26T10:00:07Z" }),
    );
    // The same version as it stood a moment earlier.
    writeGenerationDraft(
      queryClient,
      "session",
      generationDraft({ version: 2, updated_at: "2026-11-26T10:00:04Z" }),
    );
    expect(drafts()).toEqual([repairing]);
  });

  it("writes nothing while the conversation is not cached", () => {
    const queryClient = new QueryClient();
    writeGenerationDraft(queryClient, "session", generationDraft());
    expect(queryClient.getQueryData(KEY)).toBeUndefined();
  });
});

describe("removeGenerationDraft", () => {
  it("takes a discarded draft out of its conversation", () => {
    const kept = generationDraft({ id: "draft-2", position: 1 });
    const { queryClient, drafts } = cacheWith(
      generationSnapshot({ drafts: [generationDraft(), kept] }),
    );
    removeGenerationDraft(queryClient, "session", "conversation-1", "draft-1");
    expect(drafts()).toEqual([kept]);
  });
});

describe("the assistant's queries", () => {
  const server = {
    reads: [] as string[],
    snapshot: generationSnapshot({ drafts: [generationDraft()] }),
  };
  const fetch = async (request: Request) => {
    const { pathname } = new URL(request.url);
    server.reads.push(pathname);
    return pathname.endsWith("/conversations")
      ? jsonResponse({ conversations: [server.snapshot.conversation] })
      : jsonResponse(server.snapshot);
  };
  const useBoth = (conversationId: string | null) => ({
    list: useGenerationConversations(),
    snapshot: useGenerationConversation(conversationId),
  });

  afterEach(() => {
    server.reads = [];
  });

  it("read the conversations and one conversation's snapshot", async () => {
    const mounted = mountGenerationHook(useBoth, {
      props: "conversation-1",
      fetch,
    });
    await settle();
    expect(mounted.result().list.data).toEqual([generationConversation()]);
    expect(mounted.result().snapshot.data).toEqual(server.snapshot);
    expect(server.reads.sort()).toEqual([
      "/v1/generation/conversations",
      "/v1/generation/conversations/conversation-1",
    ]);
    mounted.unmount();
  });

  it("read nothing without a conversation or where the runtime withholds the assistant", async () => {
    const none = mountGenerationHook(useBoth, { props: null, fetch });
    await settle();
    expect(server.reads).toEqual(["/v1/generation/conversations"]);
    none.unmount();

    server.reads = [];
    capabilities.withhold = true;
    const withheld = mountGenerationHook(useBoth, {
      props: "conversation-1",
      fetch,
    });
    await settle();
    expect(server.reads).toEqual([]);
    expect(withheld.result().snapshot.data).toBeUndefined();
    withheld.unmount();
  });

  it("read a cached conversation again on mount, then only when asked", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(KEY, generationSnapshot());
    const mounted = mountGenerationHook(
      (id: string) => useGenerationConversation(id),
      { props: "conversation-1", fetch, queryClient },
    );
    await settle();
    // The mount's read replaced the cached copy.
    expect(mounted.result().data).toEqual(server.snapshot);
    expect(server.reads).toHaveLength(1);

    // A run's draft is not overwritten by a background read.
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(server.reads).toHaveLength(1);

    await refreshGenerationConversation(
      queryClient,
      "session",
      "conversation-1",
    );
    expect(server.reads).toHaveLength(2);
    mounted.unmount();
  });
});
