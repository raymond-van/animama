// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PyPose } from "@animama/runtime-contracts/api-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "@/query/keys";
import { usePoseContentActions } from "./usePoseContentActions";

const mocks = vi.hoisted(() => ({ remove: vi.fn() }));

vi.mock("@/lib/content/catalogApi", () => ({
  deleteCatalogItem: mocks.remove,
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

const localPose = {
  item_id: "pose-item",
  revision_sha256: "stale",
  editable: true,
  source: "local",
} as PyPose;

let root: Root | null = null;
let client: QueryClient;
const rendered: ReturnType<typeof usePoseContentActions>[] = [];
const actions = () => rendered.at(-1);

function Probe() {
  rendered.push(usePoseContentActions());
  return null;
}

beforeEach(async () => {
  mocks.remove.mockReset();
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

describe("Pose deletes", () => {
  it("refreshes Poses after a refused delete so a retry sends the current revision", async () => {
    // The file changed after the list loaded, so the server refuses the stale revision.
    mocks.remove.mockRejectedValue(
      Object.assign(new Error("Conflict"), { status: 409 }),
    );
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => {
      await expect(
        actions()?.deletePose.mutateAsync(localPose),
      ).rejects.toThrow("Conflict");
    });

    expect(mocks.remove).toHaveBeenCalledWith(
      { admitted: "composition client" },
      "pose-item",
      "stale",
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.poses.all("owner"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.content.catalog("owner"),
    });
  });

  it("refreshes Poses after a delete succeeds", async () => {
    mocks.remove.mockResolvedValue(undefined);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => {
      await actions()?.deletePose.mutateAsync(localPose);
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.poses.all("owner"),
    });
  });
});
