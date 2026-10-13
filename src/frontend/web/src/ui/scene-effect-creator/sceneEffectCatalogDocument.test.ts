import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Client } from "@animama/runtime-contracts/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PyContentPreview } from "@/lib/content/catalogTypes";
import { SCENE_EFFECT_TEMPLATES } from "@/lib/effects/effectTemplates";
import {
  sceneEffectImageMetadata,
  validateSceneEffectDocument,
} from "@/lib/scene-vfx/editor";

import { loadSceneEffectTemplate } from "./sceneEffectCatalogDocument";

/** An Included Scene Effect folder, served as the catalog would. */
type IncludedFolder = {
  descriptor: {
    content_id: string;
    name: string;
    description: string;
    definition: Record<string, unknown>;
    files: Array<{ path: string; role: string }>;
  };
  bytes: Map<string, Uint8Array<ArrayBuffer>>;
};

function includedFolder(stem: string): IncludedFolder {
  const root = new URL(
    `../../../../../../content/included/vfx/scene/${stem}/`,
    import.meta.url,
  );
  const raw = JSON.parse(
    readFileSync(new URL(`${stem}.json`, root), "utf8"),
  ) as Partial<IncludedFolder["descriptor"]>;
  // A focus-line preset registers no images.
  const descriptor = {
    ...raw,
    files: raw.files ?? [],
  } as IncludedFolder["descriptor"];
  return {
    descriptor,
    bytes: new Map(
      descriptor.files.map(({ path }) => [
        path,
        new Uint8Array(readFileSync(new URL(path, root))),
      ]),
    ),
  };
}

const catalog = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  previews: new Map<string, PyContentPreview>(),
  bytes: new Map<string, Uint8Array<ArrayBuffer>>(),
}));

vi.mock("@/lib/content/catalogApi", () => ({
  listCatalogItems: async () => catalog.items,
  previewCatalogItem: async (_client: unknown, itemId: string) => {
    const preview = catalog.previews.get(itemId);
    if (!preview) throw new Error(`No preview for ${itemId}`);
    return preview;
  },
}));
vi.mock("@/lib/content/contentPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/contentPreview")>()),
  fetchContentPreviewFile: async (
    _preview: unknown,
    file: { file_ref: string },
  ) => {
    const bytes = catalog.bytes.get(file.file_ref);
    return bytes
      ? new Response(new Blob([bytes]))
      : new Response(null, { status: 404 });
  },
}));

/** Serve `stem` as an Included catalog item with a typed preview. */
function serveIncluded(stem: string): IncludedFolder {
  const folder = includedFolder(stem);
  const itemId = `included-${stem}`;
  catalog.items.push({
    item_id: itemId,
    source: "included",
    logical_key: folder.descriptor.content_id,
    name: folder.descriptor.name,
    description: folder.descriptor.description,
  });
  const files = folder.descriptor.files.map(({ path, role }, ordinal) => {
    const fileRef = `${stem}/${path}`;
    const bytes = folder.bytes.get(path)!;
    catalog.bytes.set(fileRef, bytes);
    return {
      file_ref: fileRef,
      role,
      ordinal,
      filename: path,
      logical_path: path,
      media_type: "image/png",
      size_bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      url: `/preview/${fileRef}`,
    };
  });
  catalog.previews.set(itemId, {
    preview_id: `preview-${stem}`,
    revision: "r1",
    revision_sha256: "r1",
    expires_at: "2099-01-01T00:00:00Z",
    files,
    metadata: {
      definition: folder.descriptor.definition,
      dependencies: [],
      logical_resource_files: Object.fromEntries(
        files.map(({ logical_path, file_ref, role, ordinal }) => [
          logical_path,
          { file_ref, role, ordinal },
        ]),
      ),
    },
  });
  return folder;
}

const apiClient = {} as Client;
const signal = () => new AbortController().signal;

describe("Scene Effect templates", () => {
  beforeEach(() => {
    catalog.items = [];
    catalog.previews.clear();
    catalog.bytes.clear();
  });

  it("opens Emotion Love as a new draft with its scatter layers and every image", async () => {
    const folder = serveIncluded("scene-vfx-emotion-love");
    catalog.items.push({
      item_id: "local-love",
      source: "local",
      logical_key: "local:love",
      name: "Emotion Love",
    });

    const { document, imageResources } = await loadSceneEffectTemplate(
      apiClient,
      "scene-vfx-emotion-love",
      signal(),
    );

    expect(document).toMatchObject({
      name: "Emotion Love 1",
      description: folder.descriptor.description,
      kind: "background_layers",
      durationMs: null,
    });
    expect(
      document.background.scatters.map((layer) =>
        layer.items.map((item) =>
          item.kind === "image" ? item.image.logicalName : item.kind,
        ),
      ),
    ).toEqual([["rose-heart-petal.png"], ["sparkle-white.png"]]);
    expect(document.background.tile.image?.logicalName).toBe("bokeh-tile.png");
    expect(
      imageResources.map((resource) => resource.logicalName).sort(),
    ).toEqual(folder.descriptor.files.map((file) => file.path).sort());
    for (const resource of imageResources) {
      expect(
        new Uint8Array(await resource.file.arrayBuffer()),
        resource.logicalName,
      ).toEqual(folder.bytes.get(resource.logicalName));
    }
    expect(validateSceneEffectDocument(document, imageResources)).toEqual([]);
  });

  it("opens every Scene template, the focus presets included, with all of its images", async () => {
    for (const template of SCENE_EFFECT_TEMPLATES) serveIncluded(template.id);

    for (const template of SCENE_EFFECT_TEMPLATES) {
      const { document, imageResources } = await loadSceneEffectTemplate(
        apiClient,
        template.id,
        signal(),
      );
      expect(document.name, template.id).toBe(`${template.name} 1`);
      expect(document.kind, template.id).toBe(
        template.group === "focus-lines" ? "focus_lines" : "background_layers",
      );
      expect(
        sceneEffectImageMetadata(document)
          .map((image) => image.logicalName)
          .sort(),
        template.id,
      ).toEqual(imageResources.map((resource) => resource.logicalName).sort());
      expect(
        validateSceneEffectDocument(document, imageResources).filter(
          (issue) => issue.severity === "error",
        ),
        template.id,
      ).toEqual([]);
    }
  });

  it("fails clearly when an image cannot be downloaded or the template is unknown", async () => {
    serveIncluded("scene-vfx-emotion-love");
    catalog.bytes.delete("scene-vfx-emotion-love/sparkle-white.png");

    await expect(
      loadSceneEffectTemplate(apiClient, "scene-vfx-emotion-love", signal()),
    ).rejects.toThrow(
      "The content image sparkle-white.png could not be downloaded.",
    );
    await expect(
      loadSceneEffectTemplate(apiClient, "shoujo-bloom", signal()),
    ).rejects.toThrow("This Scene Effect template is unavailable.");
  });
});
