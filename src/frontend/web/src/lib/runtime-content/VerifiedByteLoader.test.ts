import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  VerifiedByteLoader,
  verifyRuntimeBytes,
  type VerifiedByteMember,
} from "./VerifiedByteLoader";

function member(payload: Uint8Array): VerifiedByteMember {
  return {
    file_ref: "member-1",
    url: "/v1/animas/a/runtime/revisions/r/files/member-1",
    media_type: "application/octet-stream",
    size_bytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
}

describe("VerifiedByteLoader", () => {
  it("keeps exactly a view's verified bytes when its buffer is larger", async () => {
    const buffer = new TextEncoder().encode("xxruntimeyy").buffer;
    const view = new Uint8Array(buffer, 2, 7);

    const verified = await verifyRuntimeBytes(member(view), view);
    new Uint8Array(buffer).fill(0);

    expect(await verified.blob.text()).toBe("runtime");
  });

  it("deduplicates concurrent requests and verifies exact bytes", async () => {
    const payload = new TextEncoder().encode("runtime");
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response(payload);
      },
    );
    const loader = new VerifiedByteLoader({
      apiBaseUrl: "http://localhost:8000",
      fetcher,
    });

    const [first, second] = await Promise.all([
      loader.load(member(payload)),
      loader.load(member(payload)),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.blob.size).toBe(payload.byteLength);
    expect(fetcher.mock.calls[0]?.[1]?.cache).toBe("no-cache");
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("Authorization"),
    ).toBe(false);
  });

  it("rejects a changed digest", async () => {
    const expected = new TextEncoder().encode("expected");
    const changed = new TextEncoder().encode("changed!");
    const loader = new VerifiedByteLoader({
      fetcher: vi.fn(async () => new Response(changed)),
    });

    await expect(loader.load(member(expected))).rejects.toMatchObject({
      code: "digest_mismatch",
    });
  });
});
