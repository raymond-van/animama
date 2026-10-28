// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PyRuntimeImageReference } from "@animama/runtime-contracts/api-types";
import { ProductRuntimeProvider } from "@animama/product-ui";
import { describe, expect, it, vi } from "vitest";

import { useAnimaPresentationImage } from "./useAnimaPresentationImage";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DIGEST = "c".repeat(64);
const reference: PyRuntimeImageReference = {
  source_type: "catalog",
  url: `/v1/content/files/portrait/sha256/${DIGEST}`,
  content_type: "image/webp",
  width: 256,
  height: 256,
  content_revision: DIGEST,
  presentation: { fit: "cover", focal_x: 0.5, focal_y: 0.5, zoom: 1 },
};

function Thumbnail() {
  useAnimaPresentationImage(reference);
  return null;
}

describe("Anima presentation images", () => {
  it("lets the browser reuse a kept reply, so a digest URL costs no request on a later visit", async () => {
    const fetch = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => new Response(new Blob(["image"], { type: "image/webp" })));
    const client = new QueryClient();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProductRuntimeProvider
            owner={{ id: "owner" }}
            sessionKey="session-1"
            capabilities={{ chat: true }}
            transport={{ baseUrl: "http://runtime.fixture.test", fetch }}
          >
            <Thumbnail />
          </ProductRuntimeProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`http://runtime.fixture.test${reference.url}`);
    // The server's reply policy decides: an Included digest URL is kept, an
    // owner's file is still revalidated (ADR 0033).
    expect(init?.cache).toBe("default");
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  });
});
