// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentDeleteError } from "@/lib/content/contentDeletion";
import { queryKeys } from "@/query/keys";
import { useContentDeletePreflight } from "./useContentDeletePreflight";

const api = vi.hoisted(() => ({ usage: vi.fn(), item: vi.fn() }));

vi.mock("@/lib/content/catalogApi", () => ({
  getCatalogItemUsage: api.usage,
  getCatalogItem: api.item,
  deleteCatalogItem: vi.fn(),
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

const wave = { itemId: "wave-item", kind: "gesture", revision: "r1" } as const;

let root: Root | null = null;
let client: QueryClient;
const results: ReturnType<typeof useContentDeletePreflight>[] = [];
const latest = () => results.at(-1)!;

function Probe({ open }: { open: boolean }) {
  results.push(useContentDeletePreflight(wave, open));
  return null;
}

/** Let query results, which notify on a timer, reach the probe. */
const settle = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function render(open: boolean) {
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Probe open={open} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

beforeEach(() => {
  api.usage.mockReset();
  api.item.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  results.length = 0;
  document.body.innerHTML = "";
});

describe("the delete dialog's usage check", () => {
  it("keeps its result while the dialog closes instead of checking again", async () => {
    api.usage.mockResolvedValue([]);
    await render(true);
    expect(latest().data).toEqual({
      available: true,
      usedBy: [],
      revision: "r1",
    });

    await render(false);

    expect(latest().isPending).toBe(false);
    expect(latest().isFetching).toBe(false);
    expect(latest().data).toMatchObject({ available: true });
    expect(api.usage).toHaveBeenCalledTimes(1);
  });

  it("reads afresh when the dialog opens again", async () => {
    api.usage.mockResolvedValue([]);
    await render(true);
    await render(false);
    api.usage.mockResolvedValue([
      { kind: "anima_gesture", id: "annie", name: "Annie" },
    ]);

    await render(true);

    expect(api.usage).toHaveBeenCalledTimes(2);
    expect(latest().data).toMatchObject({
      usedBy: [{ kind: "anima_gesture", id: "annie", name: "Annie" }],
    });
  });

  it("refreshes a gone item's views so they stop listing it", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    api.usage.mockRejectedValue(
      new ContentDeleteError(404, { detail: { code: "content_not_found" } }),
    );

    await render(true);

    expect(latest().data).toEqual({ available: false });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.gestures.all("owner"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.content.catalog("owner"),
    });
  });
});
