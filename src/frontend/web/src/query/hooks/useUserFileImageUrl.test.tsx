// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@animama/product-ui/query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeOwnerProvider } from "@/app/runtime/RuntimeOwnerContext";
import {
  UserFileImageError,
  useUserFileImageUrl,
  userFileContentPath,
} from "@/query/hooks/useUserFileImageUrl";
import { useDeleteUserFile } from "@/query/mutations/useDeleteUserFile";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = "session-1";
type ImageState = ReturnType<typeof useUserFileImageUrl>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient;
let imageFetch: ReturnType<typeof vi.fn>;
let view: {
  image: ImageState | null;
  deleteFile: ReturnType<typeof useDeleteUserFile> | null;
} = { image: null, deleteFile: null };

/** The image state as of the latest render. */
const latest = () => view.image;

function mount(fileId = "file-1") {
  const mounted: typeof view = { image: null, deleteFile: null };
  function Probe() {
    mounted.image = useUserFileImageUrl(fileId, "preview");
    mounted.deleteFile = useDeleteUserFile();
    return null;
  }
  view = mounted;
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      <QueryClientProvider client={client}>
        <RuntimeOwnerProvider
          ownerId="owner"
          sessionKey={SESSION}
          transport={{
            baseUrl: "http://runtime.fixture.test",
            // Only the delete goes through the API client.
            fetch: async () => new Response(null, { status: 204 }),
          }}
        >
          <Probe />
        </RuntimeOwnerProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  imageFetch = vi.fn();
  vi.stubGlobal("fetch", imageFetch);
  view = { image: null, deleteFile: null };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat image requests", () => {
  it("ask the owner-only byte route for the original, preview or thumbnail", () => {
    expect(userFileContentPath("file-1", "original")).toBe(
      "/v1/files/file-1/content",
    );
    expect(userFileContentPath("file-1", "preview")).toBe(
      "/v1/files/file-1/content?variant=preview",
    );
    expect(userFileContentPath("file/1", "thumbnail")).toBe(
      "/v1/files/file%2F1/content?variant=thumbnail",
    );
  });

  it("treat a deleted, replaced or unshrinkable image as final", () => {
    expect(new UserFileImageError(404).gone).toBe(true);
    expect(new UserFileImageError(409).gone).toBe(true);
    expect(new UserFileImageError(422).gone).toBe(false);
    expect(new UserFileImageError(422).permanent).toBe(true);
    expect(new UserFileImageError(503).permanent).toBe(false);
  });
});

describe("a chat image in the page", () => {
  it("shows as a Blob URL, cached under the session, and is released on unmount", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    imageFetch.mockResolvedValue(
      new Response(new Blob(["png"], { type: "image/png" })),
    );
    mount();

    await vi.waitFor(() => expect(latest()?.url).toMatch(/^blob:/));
    const url = latest()!.url;
    expect(String(imageFetch.mock.calls[0]![0])).toMatch(
      /\/v1\/files\/file-1\/content\?variant=preview$/,
    );
    expect(
      client.getQueryData(
        queryKeys.userFileImages.variant(SESSION, "file-1", "preview"),
      ),
    ).toBeInstanceOf(Blob);

    act(() => root?.unmount());
    root = null;
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it.each([404, 409])(
    "is gone after one request when the server answers %i",
    async (status) => {
      imageFetch.mockResolvedValue(new Response(null, { status }));
      mount();

      await vi.waitFor(() => expect(latest()?.isGone).toBe(true));
      expect(latest()).toMatchObject({ url: null, isError: false });
      expect(imageFetch).toHaveBeenCalledTimes(1);
    },
  );

  it("is not retried when the server cannot shrink it", async () => {
    imageFetch.mockResolvedValue(new Response(null, { status: 422 }));
    mount();

    await vi.waitFor(() => expect(latest()?.isError).toBe(true));
    expect(latest()?.isGone).toBe(false);
    expect(imageFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a passing failure before reporting it", async () => {
    imageFetch.mockImplementation(
      async () => new Response(null, { status: 503 }),
    );
    mount();

    await vi.waitFor(() => expect(latest()?.isError).toBe(true));
    expect(imageFetch).toHaveBeenCalledTimes(3);
  });

  it("is fetched again after its file is deleted", async () => {
    imageFetch.mockResolvedValueOnce(
      new Response(new Blob(["png"], { type: "image/png" })),
    );
    mount();
    await vi.waitFor(() => expect(latest()?.url).toMatch(/^blob:/));

    imageFetch.mockResolvedValue(new Response(null, { status: 404 }));
    await act(async () => {
      await view.deleteFile!.mutateAsync({ fileId: "file-1" });
    });

    await vi.waitFor(() => expect(latest()?.isGone).toBe(true));
    expect(latest()?.url).toBeNull();
  });
});
