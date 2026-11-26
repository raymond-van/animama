// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LibraryAvatarModelRow } from "./LibraryAvatarModelRow";

const REVISION = "a".repeat(64);
const NEWER = "b".repeat(64);
const SAVED = "c".repeat(64);

const mocks = vi.hoisted(() => ({
  apiClient: {},
  animas: [] as Array<Record<string, unknown>>,
  faceParts: null as Record<string, unknown> | null,
  storedRevision: "",
  getAvatarFaceParts: vi.fn(),
  getContentItem: vi.fn(),
  saveAvatarContent: vi.fn(),
}));

vi.mock("@animama/runtime-contracts/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAvatarFaceParts: mocks.getAvatarFaceParts,
  getContentItemV1ContentItemsItemIdGet: mocks.getContentItem,
  saveAvatarContent: mocks.saveAvatarContent,
}));
vi.mock("@animama/product-ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProductApiClient: () => mocks.apiClient,
}));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeCacheKey: () => "owner-1",
}));
vi.mock("@/query/hooks/useAnimas", () => ({
  useAnimas: () => ({ data: mocks.animas, refetch: vi.fn() }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A GLB holding only `json`, enough for Create Anima's browser checks. */
function vrmFile(json: unknown, name = "Mika v2.vrm"): File {
  const text = JSON.stringify(json);
  const chunk = new TextEncoder().encode(
    text.padEnd(Math.ceil(text.length / 4) * 4, " "),
  );
  const bytes = new Uint8Array(20 + chunk.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, chunk.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(chunk, 20);
  return new File([bytes], name, { type: "model/vrm" });
}

const VALID_VRM = {
  asset: { version: "2.0" },
  extensions: { VRMC_vrm: { specVersion: "1.0" } },
};

let root: Root | null = null;
let replaced: unknown[] = [];

function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <QueryClientProvider client={client}>
        <LibraryAvatarModelRow
          itemId="item-7"
          onReplaced={(saved) => replaced.push(saved)}
        />
      </QueryClientProvider>,
    );
  });
}

async function settle(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );

async function choose(file: File) {
  const input =
    document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  replaced = [];
  mocks.animas = [
    { id: "a1", display_name: "Ari", avatar_catalog_item_id: "item-7" },
    { id: "a2", display_name: "Bo", avatar_catalog_item_id: "item-7" },
    { id: "a3", display_name: "Cy", avatar_catalog_item_id: "item-9" },
  ];
  mocks.faceParts = null;
  mocks.storedRevision = REVISION;
  mocks.getAvatarFaceParts.mockReset();
  mocks.getAvatarFaceParts.mockImplementation(async () => ({
    data: {
      item_id: "item-7",
      revision: REVISION,
      source: mocks.faceParts ? "local_metadata" : "none",
      face_parts: mocks.faceParts,
    },
  }));
  mocks.getContentItem.mockReset();
  mocks.getContentItem.mockImplementation(async () => ({
    data: {
      item_id: "item-7",
      revision_sha256: mocks.storedRevision,
      relative_locator: "avatars/mika.vrm",
    },
  }));
  mocks.saveAvatarContent.mockReset();
  mocks.saveAvatarContent.mockImplementation(async () => ({
    data: { item_id: "item-7", revision_sha256: SAVED },
    response: { status: 200 },
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("Library Replace VRM", () => {
  it("rejects a file that is not a VRM before anything is sent", async () => {
    render();
    await choose(new File(["not a model"], "notes.vrm"));
    await settle(() => document.body.querySelector('[role="alert"]') !== null);

    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("Replace")).toBeUndefined();
    expect(mocks.saveAvatarContent).not.toHaveBeenCalled();
  });

  it("names the Animas that switch and saves nothing on Cancel", async () => {
    render();
    await choose(vrmFile(VALID_VRM));
    await settle(() => button("Replace") !== undefined);

    expect(text()).toContain("Replace the model with Mika v2.vrm");
    expect(text()).toContain(
      "Ari and Bo use this Avatar and will switch to the new model the next time their chats load.",
    );
    expect(text()).not.toContain("Cy");
    // No correction is saved, so nothing about face parts is said.
    expect(text()).not.toContain("face part");

    act(() => button("Cancel")!.click());
    expect(button("Replace")).toBeUndefined();
    expect(mocks.saveAvatarContent).not.toHaveBeenCalled();
  });

  it("warns that a saved face part correction stops applying", async () => {
    mocks.faceParts = { schema: "animama/avatar-face-parts/1" };
    mocks.animas = [];
    render();
    await settle(() => mocks.getAvatarFaceParts.mock.calls.length > 0);
    await choose(vrmFile(VALID_VRM));
    await settle(() => text().includes("face part fixes"));

    expect(text()).toContain("No Anima uses this Avatar yet.");
    expect(text()).toContain(
      "The face part fixes saved for the current file stop applying",
    );
  });

  it("replaces the same item's file, fenced by the reviewed revision", async () => {
    render();
    await settle(() => mocks.getAvatarFaceParts.mock.calls.length > 0);
    const file = vrmFile(VALID_VRM);
    await choose(file);
    await settle(() => button("Replace")?.disabled === false);
    await act(async () => button("Replace")!.click());
    await settle(() => replaced.length > 0);

    expect(mocks.saveAvatarContent).toHaveBeenCalledTimes(1);
    const [options] = mocks.saveAvatarContent.mock.calls[0];
    // The stored file's own name, not the display name.
    expect(options.path).toEqual({ entry_name: "mika" });
    expect(options.body).toEqual({
      operation_id: expect.any(String),
      files: [file],
      catalog_item_id: "item-7",
      expected_revision: REVISION,
    });
    // Not a creation save: an Avatar in use may be replaced.
    expect(options.body).not.toHaveProperty("creation_context");
    expect(replaced).toEqual([{ item_id: "item-7", revision_sha256: SAVED }]);
  });

  it("refuses to write when the Avatar changed after the review", async () => {
    mocks.storedRevision = NEWER;
    render();
    await settle(() => mocks.getAvatarFaceParts.mock.calls.length > 0);
    await choose(vrmFile(VALID_VRM));
    await settle(() => button("Replace")?.disabled === false);
    await act(async () => button("Replace")!.click());
    await settle(() => text().includes("changed since you chose the file"));

    expect(mocks.saveAvatarContent).not.toHaveBeenCalled();
    expect(replaced).toEqual([]);
    // The details are read again before the owner confirms a second time.
    await settle(() => mocks.getAvatarFaceParts.mock.calls.length > 1);
    expect(mocks.getAvatarFaceParts.mock.calls.length).toBeGreaterThan(1);
  });
});
