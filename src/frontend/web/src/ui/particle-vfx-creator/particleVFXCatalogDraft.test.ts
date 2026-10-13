import { readFileSync } from "node:fs";

import type { Client } from "@animama/runtime-contracts/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { missingParticleVFXTextureReferences } from "@/lib/avatar/particle-vfx";
import type { PyContentPreview } from "@/lib/content/catalogTypes";
import { PARTICLE_EFFECT_TEMPLATES } from "@/lib/effects/effectTemplates";

import {
  loadParticleEffectTemplate,
  loadParticleVFXCatalogDraft,
} from "./particleVFXCatalogDraft";

/** An Included Particle Effect folder, served as the catalog would. */
type IncludedFolder = {
  descriptor: {
    content_id: string;
    name: string;
    description: string;
    runtime_defaults: Record<string, unknown>;
    files: Array<{ path: string; role: string }>;
  };
  bytes: Map<string, Uint8Array<ArrayBuffer>>;
};

function includedFolder(stem: string): IncludedFolder {
  const root = new URL(
    `../../../../../../content/included/vfx/particle/quark/${stem}/`,
    import.meta.url,
  );
  const descriptor = JSON.parse(
    readFileSync(new URL(`${stem}.json`, root), "utf8"),
  ) as IncludedFolder["descriptor"];
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
  previewed: [] as string[],
}));

vi.mock("@/lib/content/catalogApi", () => ({
  listCatalogItems: async () => catalog.items,
  previewCatalogItem: async (_client: unknown, itemId: string) => {
    catalog.previewed.push(itemId);
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
  catalog.previews.set(itemId, {
    preview_id: `preview-${stem}`,
    revision: "r1",
    revision_sha256: "r1",
    expires_at: "2099-01-01T00:00:00Z",
    metadata: { runtime_defaults: folder.descriptor.runtime_defaults },
    files: folder.descriptor.files.map(({ path, role }, ordinal) => {
      const fileRef = `${stem}/${path}`;
      catalog.bytes.set(fileRef, folder.bytes.get(path)!);
      return {
        file_ref: fileRef,
        role,
        ordinal,
        filename: path.split("/").at(-1)!,
        logical_path: path,
        media_type: role === "manifest" ? "application/json" : "image/png",
        size_bytes: folder.bytes.get(path)!.byteLength,
        sha256: "",
        url: `/preview/${fileRef}`,
      };
    }),
  });
  return folder;
}

const apiClient = {} as Client;
const signal = () => new AbortController().signal;

describe("Particle Effect catalog drafts", () => {
  beforeEach(() => {
    catalog.items = [];
    catalog.previews.clear();
    catalog.bytes.clear();
    catalog.previewed = [];
  });

  it("opens Heart Burst as a new draft with its settings, layers and every texture", async () => {
    const folder = serveIncluded("heart-burst");
    catalog.items.push({
      item_id: "local-copy",
      source: "local",
      logical_key: "local:heart-burst",
      name: "Heart Burst",
    });

    const draft = await loadParticleEffectTemplate(
      apiClient,
      "heart-burst",
      signal(),
    );

    expect(catalog.previewed).toEqual(["included-heart-burst"]);
    // "Heart Burst" is taken, so the draft is a separate, unused name.
    expect(draft.catalog).toMatchObject({
      label: "Heart Burst 1",
      description: folder.descriptor.description,
      defaultAnchor: "chest",
      defaultDurationSec: 2.5,
    });
    expect(draft.emitters).toHaveLength(6);
    const textures = folder.descriptor.files
      .filter((file) => file.role === "texture")
      .map((file) => file.path);
    expect(Object.keys(draft.textureFiles).sort()).toEqual(textures.sort());
    for (const path of textures) {
      const file = draft.textureFiles[path]!;
      expect(new Uint8Array(await file.blob.arrayBuffer()), path).toEqual(
        folder.bytes.get(path),
      );
    }
    expect(missingParticleVFXTextureReferences(draft)).toEqual([]);
  });

  it("opens every Particle template with all of its textures", async () => {
    for (const template of PARTICLE_EFFECT_TEMPLATES)
      serveIncluded(template.id);

    for (const template of PARTICLE_EFFECT_TEMPLATES) {
      const draft = await loadParticleEffectTemplate(
        apiClient,
        template.id,
        signal(),
      );
      const { descriptor } = includedFolder(template.id);
      expect(draft.catalog.label, template.id).toBe(`${template.name} 1`);
      expect(Object.keys(draft.textureFiles).sort(), template.id).toEqual(
        descriptor.files
          .filter((file) => file.role === "texture")
          .map((file) => file.path)
          .sort(),
      );
      expect(missingParticleVFXTextureReferences(draft), template.id).toEqual(
        [],
      );
    }
  });

  it("reopens a saved item under its own name", async () => {
    serveIncluded("hearts-v1");

    const draft = await loadParticleVFXCatalogDraft(apiClient, {
      itemId: "included-hearts-v1",
      name: "My hearts",
      description: "Mine",
      signal: signal(),
    });

    expect(draft.catalog).toMatchObject({
      label: "My hearts",
      description: "Mine",
    });
    expect(Object.keys(draft.textureFiles)).toEqual(["textures/heart.png"]);
  });

  it("fails clearly when the manifest or a texture cannot be read", async () => {
    serveIncluded("heart-burst");
    catalog.bytes.delete("heart-burst/textures/heart-ring.png");

    await expect(
      loadParticleEffectTemplate(apiClient, "heart-burst", signal()),
    ).rejects.toThrow("A Particle Effect texture could not be loaded.");

    await expect(
      loadParticleEffectTemplate(apiClient, "not-a-template", signal()),
    ).rejects.toThrow("This Particle Effect template is unavailable.");
  });
});
