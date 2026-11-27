// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentDeleteError } from "@/lib/content/contentDeletion";
import { queryKeys } from "@/query/keys";
import { useDeleteContentItem } from "./useDeleteContentItem";

const api = vi.hoisted(() => ({ remove: vi.fn() }));

vi.mock("@animama/runtime-contracts/sdk", async (original) => ({
  ...(await original<typeof import("@animama/runtime-contracts/sdk")>()),
  deleteContentItemV1ContentItemsItemIdDelete: api.remove,
}));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeCacheKey: () => "owner",
}));
vi.mock("@animama/product-ui", () => ({
  useProductApiClient: () => ({ admitted: "composition client" }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let client: QueryClient;
const rendered: ReturnType<typeof useDeleteContentItem>[] = [];
const mutation = () => rendered.at(-1)!;

function Probe() {
  rendered.push(useDeleteContentItem());
  return null;
}

/** A generated-client result for an HTTP refusal. */
const refusal = (status: number, detail: Record<string, unknown>) => ({
  error: { detail },
  response: new Response(null, { status }),
});

beforeEach(async () => {
  api.remove.mockReset();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  rendered.length = 0;
  document.body.innerHTML = "";
});

/** The query keys a spied `invalidateQueries` was called with, in order. */
const invalidated = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(
    ([filters]) => (filters as { queryKey: unknown }).queryKey,
  );

describe("the shared content delete", () => {
  it("deletes at the shown revision and refreshes that kind's views", async () => {
    api.remove.mockResolvedValue({
      response: new Response(null, { status: 204 }),
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => {
      await mutation().mutateAsync({
        itemId: "pose-item",
        kind: "pose",
        revision: "shown",
      });
    });

    expect(api.remove).toHaveBeenCalledWith(
      expect.objectContaining({
        client: { admitted: "composition client" },
        path: { item_id: "pose-item" },
        query: { expected_revision: "shown" },
      }),
    );
    expect(invalidated(invalidate)).toEqual([
      queryKeys.content.catalog("owner"),
      queryKeys.poses.all("owner"),
    ]);
  });

  it("also refreshes portraits and pickers after an Avatar delete", async () => {
    api.remove.mockResolvedValue({
      response: new Response(null, { status: 204 }),
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => {
      await mutation().mutateAsync({
        itemId: "avatar-item",
        kind: "avatar",
        revision: "shown",
      });
    });

    // The server removes the Avatar's unused portrait Appearance with it.
    expect(invalidated(invalidate)).toEqual(
      expect.arrayContaining([
        queryKeys.content.catalog("owner"),
        queryKeys.avatarCatalog.all("owner"),
        queryKeys.appearanceImages.all("owner"),
        queryKeys.animaCreation.all("owner"),
      ]),
    );
  });

  it("refreshes after a refused delete so a retry sends the current revision", async () => {
    // The file changed after the list loaded (#948), so the server refuses.
    api.remove.mockResolvedValue(
      refusal(409, {
        code: "catalog_item_changed",
        current_revision: "current",
      }),
    );
    const invalidate = vi.spyOn(client, "invalidateQueries");

    let failure: unknown;
    await act(async () => {
      failure = await mutation()
        .mutateAsync({ itemId: "pose-item", kind: "pose", revision: "stale" })
        .catch((error: unknown) => error);
    });

    expect(failure).toBeInstanceOf(ContentDeleteError);
    expect(failure).toMatchObject({
      status: 409,
      code: "catalog_item_changed",
      currentRevision: "current",
    });
    expect(invalidated(invalidate)).toEqual([
      queryKeys.content.catalog("owner"),
      queryKeys.poses.all("owner"),
    ]);
  });

  it("keeps what uses an item from an in-use refusal", async () => {
    api.remove.mockResolvedValue(
      refusal(409, {
        code: "catalog_item_in_use",
        used_by: [
          { kind: "anima_voice", id: "anima-1", name: "Annie" },
          { kind: "unexpected", id: 7 },
        ],
      }),
    );

    let failure: unknown;
    await act(async () => {
      failure = await mutation()
        .mutateAsync({ itemId: "voice-item", kind: "voice", revision: "shown" })
        .catch((error: unknown) => error);
    });

    expect(failure).toMatchObject({
      code: "catalog_item_in_use",
      usedBy: [{ kind: "anima_voice", id: "anima-1", name: "Annie" }],
    });
  });

  it("treats an item that is already gone as deleted", async () => {
    api.remove.mockResolvedValue(refusal(404, { code: "content_not_found" }));

    await act(async () => {
      await expect(
        mutation().mutateAsync({
          itemId: "gone",
          kind: "gesture",
          revision: "shown",
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("reports a lost reply as a transport failure, not a refusal", async () => {
    api.remove.mockResolvedValue({ error: new TypeError("Failed to fetch") });

    let failure: unknown;
    await act(async () => {
      failure = await mutation()
        .mutateAsync({ itemId: "item", kind: "scene_effect", revision: "r" })
        .catch((error: unknown) => error);
    });

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(ContentDeleteError);
  });
});
