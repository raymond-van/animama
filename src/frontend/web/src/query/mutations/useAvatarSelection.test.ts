import { describe, expect, it, vi } from "vitest";

import { selectAvatar } from "./useAvatarSelection";

const sdk = vi.hoisted(() => ({
  planAvatar: vi.fn(async () => ({ data: { plan_digest: "d".repeat(64) } })),
  commitAvatar: vi.fn(async () => ({ data: { revision: 5 } })),
}));
vi.mock("@animama/runtime-contracts/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  planAvatar: sdk.planAvatar,
  commitAvatar: sdk.commitAvatar,
}));

describe("selectAvatar", () => {
  it("commits exactly the plan for the Avatar slot at the shown revision", async () => {
    const client = {} as never;
    const result = await selectAvatar(client, "anima-1", {
      avatar: { item_id: "mika", logical_key: null, source: "local" },
      expectedRevision: 4,
    });

    const intent = {
      operation: "set",
      source: {
        type: "catalog",
        catalog_item_id: "mika",
        logical_key: null,
        source: "local",
      },
      config: {},
    };
    expect(sdk.planAvatar).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { anima_id: "anima-1" },
        body: { expected_revision: 4, intent },
      }),
    );
    expect(sdk.commitAvatar).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { anima_id: "anima-1" },
        body: {
          expected_revision: 4,
          intent,
          plan_digest: "d".repeat(64),
          idempotency_key: expect.any(String),
        },
      }),
    );
    expect(result).toEqual({ revision: 5 });
  });
});
