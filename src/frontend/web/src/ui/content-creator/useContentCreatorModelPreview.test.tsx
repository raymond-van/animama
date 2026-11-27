// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mountGenerationHook,
  settle,
  type MountedHook,
} from "@/ui/generate/testing/generationHarness";
import type { ContentCreatorModelSource } from "./contentCreatorModelPreview";
import {
  useContentCreatorModelPreview,
  type ContentCreatorModelPreview,
} from "./useContentCreatorModelPreview";

type CatalogQuery = {
  items: { catalog_item_id: string | null; name: string }[];
  isError?: boolean;
  isPending?: boolean;
};

const fixture = vi.hoisted(() => ({
  catalogs: {} as Record<string, unknown>,
  catalogRequests: [] as { origin?: string; enabled?: boolean }[],
  previews: [] as string[],
  previewDown: false,
  /** The target the hook last asked the preview pipeline to prepare. */
  target: null as { key: string } | null,
}));

vi.mock("@/query/hooks/useAnimas", () => ({
  // No Anima: the picker has only the Avatars it lists.
  useAnimas: () => ({ data: [], isSuccess: true, isPending: false }),
}));
vi.mock("@/query/hooks/useAnimaRuntimeCatalog", () => ({
  useAnimaRuntimeCatalog: () => ({
    data: undefined,
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/ui/settings/SettingsProvider", () => ({
  useSettings: () => ({ userSettings: null, isLoading: false }),
}));
vi.mock("@/query/hooks/useAvatarCatalog", () => ({
  useAvatarCatalog: (input: { origin?: string; enabled?: boolean }) => {
    fixture.catalogRequests.push(input);
    const query = fixture.catalogs[input.origin ?? "all"] as
      | CatalogQuery
      | undefined;
    const listed = input.enabled !== false && query && !query.isPending;
    return {
      data:
        listed && !query.isError
          ? { pages: [{ items: query.items }] }
          : undefined,
      isSuccess: Boolean(listed && !query.isError),
      isError: Boolean(input.enabled !== false && query?.isError),
      isPending: !listed && !query?.isError,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@/lib/content/catalogApi", () => ({
  previewCatalogItem: async (_client: unknown, itemId: string) => {
    fixture.previews.push(itemId);
    if (fixture.previewDown) throw new Error("gone");
    return {
      preview_id: `preview-${itemId}`,
      revision: "revision-3",
      // A file grant lasts minutes; the hook refreshes it shortly before.
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  },
}));
vi.mock("@/lib/content/avatarPreviewTarget", () => ({
  avatarPreviewTarget: (preview: { preview_id: string }, name: string) => ({
    key: `typed-avatar:${preview.preview_id}`,
    displayName: name,
  }),
}));
vi.mock("@/ui/content-preview/usePreparedContentPreview", () => ({
  usePreparedContentPreview: (target: { key: string } | null) => {
    fixture.target = target;
    return { prepared: null, error: null, retry: async () => {} };
  },
}));

type Props = {
  selectedModel: ContentCreatorModelSource | null;
  includedAvatars?: boolean;
  ownAvatars?: boolean;
};

const onSelectModel = vi.fn();
let mounted: MountedHook<Props, ContentCreatorModelPreview>;
async function mount(props: Props) {
  mounted = mountGenerationHook(
    (input: Props) =>
      useContentCreatorModelPreview({
        ownerKey: "pose-creator",
        onSelectModel,
        ...input,
      }),
    { props, fetch: () => Promise.reject(new Error("No request expected.")) },
  );
  await settle();
  return mounted.result;
}

beforeEach(() => {
  fixture.catalogs = {
    included: {
      items: [
        { catalog_item_id: "included-andrew", name: "Andrew" },
        { catalog_item_id: "included-annie", name: "Annie" },
      ],
    },
    local: {
      items: [
        { catalog_item_id: "own-fox", name: "Fox" },
        // An Avatar without a catalog item cannot be previewed.
        { catalog_item_id: null, name: "Unlisted" },
      ],
    },
  };
  fixture.catalogRequests = [];
  fixture.previews = [];
  fixture.previewDown = false;
  fixture.target = null;
  onSelectModel.mockClear();
});
afterEach(() => mounted.unmount());

describe("useContentCreatorModelPreview", () => {
  it("lists nothing but the Anima's model unless asked for more", async () => {
    const result = await mount({ selectedModel: null });
    expect(result().modelOptions).toEqual([]);
    expect(fixture.catalogRequests).toEqual(
      expect.arrayContaining([
        { origin: "included", enabled: false },
        { origin: "local", enabled: false },
      ]),
    );
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it("offers the person's own Avatars, then the Included ones", async () => {
    const result = await mount({
      selectedModel: null,
      includedAvatars: true,
      ownAvatars: true,
    });
    expect(
      result().modelOptions.map(({ key, displayName, sourceType }) => ({
        key,
        displayName,
        sourceType,
      })),
    ).toEqual([
      { key: "own:own-fox", displayName: "Fox", sourceType: "own_avatar" },
      {
        key: "included:included-andrew",
        displayName: "Andrew",
        sourceType: "included_avatar",
      },
      {
        key: "included:included-annie",
        displayName: "Annie",
        sourceType: "included_avatar",
      },
    ]);
    // Without an Anima the first Included Avatar is the default.
    expect(onSelectModel).toHaveBeenCalledWith(
      expect.objectContaining({ key: "included:included-andrew" }),
    );
  });

  it("previews a chosen own Avatar through its catalog item", async () => {
    const first = await mount({
      selectedModel: null,
      includedAvatars: true,
      ownAvatars: true,
    });
    const own = first().modelOptions[0]!;
    mounted.rerender({
      selectedModel: own,
      includedAvatars: true,
      ownAvatars: true,
    });
    await settle();
    expect(fixture.previews).toEqual(["own-fox"]);
    // Identity is the Avatar item and revision, not the file grant.
    expect(fixture.target).toMatchObject({
      key: "own-avatar:own-fox:revision-3",
      displayName: "Fox",
    });
    expect(mounted.result().modelError).toBeNull();
  });

  it("says when an own Avatar or the list of them cannot be loaded", async () => {
    fixture.previewDown = true;
    const first = await mount({ selectedModel: null, ownAvatars: true });
    mounted.rerender({
      selectedModel: first().modelOptions[0]!,
      ownAvatars: true,
    });
    // The preview read is retried before it gives up.
    await vi.waitFor(
      () =>
        expect(mounted.result().modelError).toBe(
          "The selected Avatar could not be prepared.",
        ),
      { timeout: 10_000 },
    );
    mounted.unmount();

    fixture.catalogs.local = { items: [], isError: true };
    const failed = await mount({ selectedModel: null, ownAvatars: true });
    expect(failed().modelCatalogError).toBe("Could not load your Avatars.");
  });
});
