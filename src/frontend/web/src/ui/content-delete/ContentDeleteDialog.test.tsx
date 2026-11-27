// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentDeleteError } from "@/lib/content/contentDeletion";
import { queryKeys } from "@/query/keys";
import { withRuntime } from "@/test/runtime-markup";
import {
  ContentDeleteDialog,
  type ContentToDelete,
} from "./ContentDeleteDialog";

const api = vi.hoisted(() => ({
  usage: vi.fn(),
  remove: vi.fn(),
  item: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/content/catalogApi", () => ({
  getCatalogItemUsage: api.usage,
  deleteCatalogItem: api.remove,
  getCatalogItem: api.item,
}));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeCacheKey: () => "owner",
}));
vi.mock("sonner", () => ({ toast: { success: api.toast } }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.usage.mockResolvedValue([]);
  api.remove.mockResolvedValue(undefined);
  client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const wave: ContentToDelete = {
  itemId: "wave-item",
  kind: "gesture",
  name: "Wave",
  revision: "shown",
};

/** The dialog opened for `item`, closed again by its own `onClose`. */
async function render(
  item: ContentToDelete,
  onDeleted: (item: ContentToDelete) => void = () => {},
) {
  function Harness() {
    const [open, setOpen] = useState<ContentToDelete | null>(item);
    return (
      <ContentDeleteDialog
        item={open}
        onClose={() => setOpen(null)}
        onDeleted={onDeleted}
      />
    );
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      withRuntime(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
  });
  await settle();
}

/** Let query results, which notify on a timer, reach the dialog. */
const settle = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (name: string) =>
  [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === name,
  )!;
const text = () => dialog()?.textContent ?? "";

describe("the Library delete confirmation", () => {
  it("names the item and its kind, its Local files and no undo", async () => {
    await render(wave);

    expect(text()).toContain("Delete “Wave”?");
    expect(text()).toContain(
      "This Gesture and its Local files will be removed. This can't be undone.",
    );
    expect(api.usage).toHaveBeenCalledWith(
      expect.anything(),
      "wave-item",
      expect.anything(),
    );
    expect(button("Delete").disabled).toBe(false);
  });

  it("says a Local Avatar's portrait goes too, reading the revision it lacks", async () => {
    api.item.mockResolvedValue({ revision_sha256: "avatar-revision" });
    await render({
      itemId: "avatar-item",
      kind: "avatar",
      name: "Mika",
      revision: null,
    });

    expect(text()).toContain("This Avatar and its Local files");
    expect(text()).toContain("Its generated portrait is removed too");

    await act(async () => button("Delete").click());
    expect(api.remove).toHaveBeenCalledWith(
      expect.anything(),
      "avatar-item",
      "avatar-revision",
    );
  });

  it("cannot delete an Avatar whose revision could not be read", async () => {
    api.item.mockRejectedValue(new Error("offline"));
    await render({
      itemId: "avatar-item",
      kind: "avatar",
      name: "Mika",
      revision: null,
    });

    expect(text()).toContain("This item couldn't be checked.");
    expect(button("Delete").disabled).toBe(true);
  });

  it("still offers Delete at a known revision when the usage check fails", async () => {
    // The server refuses an item in use, so an unknown use does not block.
    api.usage.mockRejectedValue(new TypeError("Failed to fetch"));
    await render(wave);

    expect(text()).not.toContain("couldn't be checked");
    expect(button("Delete").disabled).toBe(false);
  });

  it("names what uses an item and how to free it, and cannot be confirmed", async () => {
    api.usage.mockResolvedValue([
      { kind: "anima_reaction", id: "andrew", name: "Andrew" },
      { kind: "anima_gesture", id: "annie", name: "Annie" },
      { kind: "content", id: "sparkle", name: "Sparkle Wave" },
    ]);
    await render(wave);

    expect(text()).toContain("It's in use, so it can't be deleted:");
    expect(text()).toContain("In a Reaction cell of Andrew's Behavior.");
    expect(text()).toContain("Equipped as one of Annie's Gestures.");
    expect(text()).toContain("“Sparkle Wave” depends on it.");
    // One hint per way of freeing it, however many uses share it.
    expect(
      text().split("first remove it from each Anima's Behavior.").length,
    ).toBe(2);
    expect(text()).toContain("first delete the items that depend on it.");
    expect(button("Delete").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(false);
  });

  it("says where each Anima use is changed, or that the app cannot change it", async () => {
    api.usage.mockResolvedValue([
      { kind: "anima_avatar", id: "annie", name: "Annie" },
      { kind: "anima_appearance", id: "annie", name: "Annie" },
      { kind: "anima_voice", id: "andrew", name: "Andrew" },
      { kind: "anima_music", id: "andrew", name: "Andrew" },
    ]);
    await render(wave);

    expect(text()).toContain("Used as Annie's Avatar.");
    expect(text()).toContain("Used as Annie's profile or background image.");
    expect(text()).toContain("Used as Andrew's voice.");
    expect(text()).toContain("Used as Andrew's music.");
    expect(text()).toContain(
      "To delete it, first choose another Avatar with Change Avatar in each Anima's Settings tab.",
    );
    expect(text()).toContain(
      "choose another image in each Anima's Appearance, which opens from the Anima's picture on its page.",
    );
    expect(text()).toContain(
      "choose another voice under Voices in each Anima's Behavior tab.",
    );
    expect(text()).toContain(
      "Music can't be changed in the app, so it can't be deleted here.",
    );
    // The retired catch-all sent every Anima use to the Settings tab.
    expect(text()).not.toContain("choose something else");
  });

  it("announces the check and what it found in one live region", async () => {
    let answer: (uses: unknown[]) => void = () => {};
    api.usage.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await render(wave);

    const live = dialog()!.querySelector<HTMLElement>('[aria-live="polite"]')!;
    expect(live.textContent).toBe("Checking whether anything uses it…");

    await act(async () =>
      answer([{ kind: "anima_gesture", id: "annie", name: "Annie" }]),
    );
    await settle();

    // The same element, so a screen reader hears the change.
    expect(dialog()!.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live.textContent).toContain("Equipped as one of Annie's Gestures.");
  });

  it("deletes at the shown revision, refreshes its kind and says so", async () => {
    const onDeleted = vi.fn();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await render(wave, onDeleted);

    await act(async () => button("Delete").click());

    expect(api.remove).toHaveBeenCalledWith(
      expect.anything(),
      "wave-item",
      "shown",
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.gestures.all("owner"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.content.catalog("owner"),
    });
    expect(onDeleted).toHaveBeenCalledWith(wave);
    expect(api.toast).toHaveBeenCalledWith("“Wave” deleted.");
    expect(dialog()).toBeNull();
  });

  it("says a changed item changed, refreshes, and retries at its current revision", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    api.remove.mockRejectedValueOnce(
      new ContentDeleteError(409, {
        detail: { code: "catalog_item_changed", current_revision: "current" },
      }),
    );
    await render(wave);

    await act(async () => button("Delete").click());

    expect(text()).toContain("This item changed. Review it and try again.");
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.gestures.all("owner"),
    });

    await act(async () => button("Delete").click());
    expect(api.remove).toHaveBeenLastCalledWith(
      expect.anything(),
      "wave-item",
      "current",
    );
    expect(dialog()).toBeNull();
  });

  it("uses the same message for a stale revision", async () => {
    api.remove.mockRejectedValueOnce(
      new ContentDeleteError(409, {
        detail: {
          code: "catalog_revision_conflict",
          current_revision: "current",
        },
      }),
    );
    await render(wave);

    await act(async () => button("Delete").click());

    expect(text()).toContain("This item changed. Review it and try again.");
  });

  it("names what uses an item when the delete is refused as in use", async () => {
    api.remove.mockRejectedValueOnce(
      new ContentDeleteError(409, {
        detail: {
          code: "catalog_item_in_use",
          used_by: [{ kind: "anima_gesture", id: "annie", name: "Annie" }],
        },
      }),
    );
    await render(wave);

    await act(async () => button("Delete").click());

    expect(text()).toContain("Equipped as one of Annie's Gestures.");
    expect(button("Delete").disabled).toBe(true);
  });

  it("offers no Delete for an item that is no longer available, and drops it from its views", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    api.usage.mockRejectedValue(
      new ContentDeleteError(404, { detail: { code: "content_not_found" } }),
    );
    await render(wave);

    expect(text()).toContain("This item is no longer available to delete.");
    expect(button("Delete").disabled).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.gestures.all("owner"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.content.catalog("owner"),
    });
  });
});
