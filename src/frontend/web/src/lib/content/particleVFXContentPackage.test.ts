import { describe, expect, it, vi } from "vitest";

import {
  addParticleVFXEditorEmitter,
  applyParticleVFXEmitterPatch,
  createParticleVFXEditorDraftFromBlank,
  setParticleVFXSimpleControl,
  updateParticleVFXEditorCatalogDraft,
} from "@/lib/avatar/particle-vfx";
import {
  buildParticleVFXContentPackage,
  ParticleVFXContentPackageError,
  type ParticleVFXContentPackageResource,
} from "./particleVFXContentPackage";

/** A PNG signature and a 1×1 IHDR: enough for the header checks. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
  0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0,
]);
/** A WebP VP8X header declaring 1×1. */
const WEBP = new Uint8Array([
  ...new TextEncoder().encode("RIFF0000WEBPVP8X"),
  10,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
]);

/** Packaging receives the name allocated by the save flow. */
function namedDraft() {
  return updateParticleVFXEditorCatalogDraft(
    createParticleVFXEditorDraftFromBlank(),
    {
      label: "New Particle FX",
    },
  );
}

function resource(
  logicalReference: string,
  bytes: Uint8Array,
  contentType: string,
): ParticleVFXContentPackageResource {
  const blob = new Blob([Uint8Array.from(bytes).buffer], {
    type: contentType,
  });
  return {
    logicalReference,
    previewUrl: "blob:preview-only",
    blob,
    contentType,
  };
}

describe("Particle VFX editable content package", () => {
  it("copies one curated texture and never mutates raw editor JSON", async () => {
    const draft = namedDraft();
    const before = JSON.stringify(draft.quarksJson);
    const fetcher = vi.fn(
      async () =>
        new Response(PNG, { headers: { "content-type": "image/png" } }),
    );

    const built = await buildParticleVFXContentPackage({
      draft,
      resources: [],
      fetcher,
    });
    const manifest = JSON.parse(await built.manifestFile.text()) as {
      images: { url: string }[];
    };

    expect(fetcher).toHaveBeenCalledWith(
      "/effects/vfx/particle-vfx/textures/soft-dot.png",
      { signal: undefined },
    );
    expect(built.textures).toHaveLength(1);
    expect(built.textures[0]).toMatchObject({
      packageReference: "textures/soft-dot.png",
      ordinal: 1,
    });
    expect(manifest.images[0]?.url).toBe("textures/soft-dot.png");
    expect(JSON.stringify(draft.quarksJson)).toBe(before);
  });

  it("packages the effect Simple scaled, without Simple's reference or positions", async () => {
    const draft = setParticleVFXSimpleControl(namedDraft(), "size", 200);
    const fetcher = vi.fn(
      async () =>
        new Response(PNG, { headers: { "content-type": "image/png" } }),
    );

    const built = await buildParticleVFXContentPackage({
      draft,
      resources: [],
      fetcher,
    });
    const manifestText = await built.manifestFile.text();
    const manifest = JSON.parse(manifestText) as {
      object: { children: { ps: { startSize: unknown } }[] };
    };

    expect(manifest.object.children[0]?.ps.startSize).toEqual(
      (draft.quarksJson.object as typeof manifest.object).children[0]?.ps
        .startSize,
    );
    expect(manifestText).not.toContain("reference");
    expect(JSON.stringify(built.authoringManifest)).not.toMatch(
      /simple|factors|reference/i,
    );
    // The saved draft is the effect as saved, with Simple back at 100 %.
    expect(built.normalizedDraft.simple).toBeNull();
  });

  it("normalizes canonical WebP names and keeps them stable on re-save", async () => {
    const draft = namedDraft();
    const first = await buildParticleVFXContentPackage({
      draft,
      resources: [resource("textures/soft-dot.png", WEBP, "image/webp")],
    });
    expect(first.textures[0]?.packageReference).toBe("textures/soft-dot.webp");

    const second = await buildParticleVFXContentPackage({
      draft: first.normalizedDraft,
      resources: [resource("textures/soft-dot.webp", WEBP, "image/webp")],
    });
    expect(second.textures[0]?.packageReference).toBe("textures/soft-dot.webp");
  });

  it("deduplicates repeated references and suffixes same-stem output collisions", async () => {
    const draft = namedDraft();
    const images = draft.quarksJson.images as { uuid: string; url: string }[];
    images[0]!.url = "textures/glow.png";
    images.push({ uuid: "second-image", url: "legacy/glow.jpg" });
    images.push({ uuid: "repeated-image", url: "textures/glow.png" });

    const built = await buildParticleVFXContentPackage({
      draft,
      resources: [
        resource("textures/glow.png", WEBP, "image/webp"),
        resource("legacy/glow.jpg", WEBP, "image/webp"),
      ],
    });

    expect(
      built.textures.map(({ packageReference }) => packageReference),
    ).toEqual(["textures/glow.webp", "textures/glow-2.webp"]);
    expect(
      (built.normalizedDraft.quarksJson.images as { url: string }[]).map(
        ({ url }) => url,
      ),
    ).toEqual([
      "textures/glow.webp",
      "textures/glow-2.webp",
      "textures/glow.webp",
    ]);
  });

  it("serializes complete runtime defaults and reports deterministic cap reductions", async () => {
    const draft = namedDraft();
    draft.catalog.defaultFollowAnchor = false;
    draft.catalog.performanceBudget.maxParticles = 900;
    draft.catalog.performanceBudget.maxDurationSec = 45;
    draft.catalog.shapeAutoFit = {
      kind: "avatarBoundsRectangle",
      padding: { width: 0.2, height: 0.3 },
      emitterNames: ["Emitter 1"],
    };
    const built = await buildParticleVFXContentPackage({
      draft,
      resources: [resource("textures/soft-dot.png", PNG, "image/png")],
    });
    const defaults = (
      built.authoringManifest.runtime_defaults as {
        slots: { particle_vfx: Record<string, unknown> };
      }
    ).slots.particle_vfx;

    expect(defaults).toMatchObject({
      follow_anchor: false,
      max_duration_seconds: 30,
      max_particles: 512,
      shape_auto_fit: {
        kind: "avatar_bounds_rectangle",
        padding: { width: 0.2, height: 0.3 },
        emitter_names: ["Emitter 1"],
      },
    });
    expect(built.notices).toHaveLength(2);
  });

  it("fits up to sixteen named emitters to the Avatar rectangle", async () => {
    let draft = namedDraft();
    while (draft.emitters.length < 16) {
      draft = addParticleVFXEditorEmitter(draft);
    }
    const emitterNames = draft.emitters.map((emitter) => emitter.name);
    draft.catalog.performanceBudget.maxParticles = 512;
    draft.catalog.shapeAutoFit = {
      kind: "avatarBoundsRectangle",
      padding: { width: 0.2, height: 0.3 },
      emitterNames,
    };
    const built = await buildParticleVFXContentPackage({
      draft,
      resources: [resource("textures/soft-dot.png", PNG, "image/png")],
    });
    const defaults = (
      built.authoringManifest.runtime_defaults as {
        slots: { particle_vfx: Record<string, unknown> };
      }
    ).slots.particle_vfx;

    expect(defaults.shape_auto_fit).toMatchObject({
      emitter_names: emitterNames,
    });

    draft.catalog.shapeAutoFit = {
      ...draft.catalog.shapeAutoFit,
      emitterNames: [...emitterNames, "emitter-17"],
    };
    await expect(
      buildParticleVFXContentPackage({
        draft,
        resources: [resource("textures/soft-dot.png", PNG, "image/png")],
      }),
    ).rejects.toThrow("match up to 16 emitters");
  });

  it("round-trips a multi-emitter authoring package with shared texture and runtime metadata", async () => {
    let draft = namedDraft();
    draft = addParticleVFXEditorEmitter(draft);
    draft = addParticleVFXEditorEmitter(draft);
    draft = applyParticleVFXEmitterPatch(draft, draft.emitters[0]!.path, {
      emitterTemplateId: "sparkle-burst",
      shape: { type: "rectangle", width: 1.4, height: 2.2 },
    });
    draft = updateParticleVFXEditorCatalogDraft(draft, {
      defaultAnchor: "chest",
      defaultFollowAnchor: false,
      defaultDurationSec: 2.75,
      preloadTier: "tierA",
      performanceBudget: {
        maxDurationSec: 6,
        maxParticles: 180,
        loopingAllowed: false,
        canCoexist: false,
      },
      shapeAutoFit: {
        kind: "avatarBoundsRectangle",
        padding: { width: 0.15, height: 0.25 },
        minSize: { width: 0.5, height: 1 },
        maxSize: { width: 3, height: 4 },
        emitterNames: [draft.emitters[0]!.name],
      },
    });

    const built = await buildParticleVFXContentPackage({
      draft,
      resources: [
        resource("textures/soft-dot.png", PNG, "image/png"),
        resource("textures/spark-pop-6x5.png", PNG, "image/png"),
      ],
    });
    const manifest = JSON.parse(await built.manifestFile.text()) as {
      images: { url: string }[];
      object: { children: unknown[] };
    };
    const defaults = (
      built.authoringManifest.runtime_defaults as {
        slots: { particle_vfx: Record<string, unknown> };
      }
    ).slots.particle_vfx;

    expect(manifest.object.children).toHaveLength(3);
    expect(new Set(manifest.images.map(({ url }) => url))).toEqual(
      new Set(["textures/soft-dot.png", "textures/spark-pop-6x5.png"]),
    );
    expect(
      manifest.images.filter(({ url }) => url === "textures/soft-dot.png"),
    ).toHaveLength(2);
    expect(built.textures).toHaveLength(2);
    expect(JSON.stringify(manifest)).toContain("Noise");
    expect(defaults).toMatchObject({
      anchor: "chest",
      follow_anchor: false,
      duration_seconds: 2.75,
      max_duration_seconds: 6,
      preload_tier: "tier_a",
      can_coexist: false,
      max_particles: 180,
      shape_auto_fit: {
        kind: "avatar_bounds_rectangle",
        padding: { width: 0.15, height: 0.25 },
      },
    });
  });

  it("keeps a texture's authored colour space through Save", async () => {
    const draft = namedDraft();
    const [texture] = draft.quarksJson.textures as { colorSpace: string }[];
    texture!.colorSpace = "srgb";

    const built = await buildParticleVFXContentPackage({
      draft,
      resources: [resource("textures/soft-dot.png", PNG, "image/png")],
    });
    const manifest = JSON.parse(await built.manifestFile.text()) as {
      textures: { colorSpace: string }[];
    };

    expect(manifest.textures.map(({ colorSpace }) => colorSpace)).toEqual([
      "srgb",
    ]);
    expect(
      (built.normalizedDraft.quarksJson.textures as { colorSpace: string }[])[0]
        ?.colorSpace,
    ).toBe("srgb");
  });

  it("keeps a material's tone-mapping opt-out through Save", async () => {
    const draft = namedDraft();
    const [material] = draft.quarksJson.materials as { toneMapped?: boolean }[];
    material!.toneMapped = false;

    const built = await buildParticleVFXContentPackage({
      draft,
      resources: [resource("textures/soft-dot.png", PNG, "image/png")],
    });
    const manifest = JSON.parse(await built.manifestFile.text()) as {
      materials: { toneMapped?: boolean }[];
    };

    expect(manifest.materials.map(({ toneMapped }) => toneMapped)).toEqual([
      false,
    ]);
    expect(
      (
        built.normalizedDraft.quarksJson.materials as {
          toneMapped?: boolean;
        }[]
      )[0]?.toneMapped,
    ).toBe(false);
  });

  it("rejects unsafe and content-type-mismatched resources before upload", async () => {
    const unsafe = namedDraft();
    (unsafe.quarksJson.images as { url: string }[])[0]!.url = "blob:secret";
    await expect(
      buildParticleVFXContentPackage({ draft: unsafe, resources: [] }),
    ).rejects.toBeInstanceOf(ParticleVFXContentPackageError);

    const mismatched = namedDraft();
    await expect(
      buildParticleVFXContentPackage({
        draft: mismatched,
        resources: [resource("textures/soft-dot.png", PNG, "image/webp")],
      }),
    ).rejects.toThrow("mismatched or unsupported image bytes");
  });
});

it.each(["", "Existing description"])(
  "preserves optional description %j and emitter anchors in a saved package",
  async (description) => {
    let draft = updateParticleVFXEditorCatalogDraft(namedDraft(), {
      description,
    });
    draft = applyParticleVFXEmitterPatch(draft, draft.emitters[0]!.path, {
      anchor: "rightHand",
    });
    const built = await buildParticleVFXContentPackage({
      draft,
      resources: [resource("textures/soft-dot.png", PNG, "image/png")],
    });
    expect(built.normalizedDraft.catalog.description).toBe(description);
    expect(built.normalizedDraft.emitters[0]!.anchor).toBe("rightHand");
    expect(
      JSON.parse(await built.manifestFile.text()).object.children[0].userData
        .animamaParticleAnchor,
    ).toBe("rightHand");
  },
);

it("saves avatar rectangle fitting with no maximum size limit", async () => {
  const draft = updateParticleVFXEditorCatalogDraft(namedDraft(), {
    shapeAutoFit: {
      kind: "avatarBoundsRectangle",
      padding: { width: 0, height: 0 },
      minSize: { width: 0.1, height: 0.1 },
    },
  });
  const built = await buildParticleVFXContentPackage({
    draft,
    resources: [resource("textures/soft-dot.png", PNG, "image/png")],
  });
  expect(built.normalizedDraft.catalog.shapeAutoFit?.maxSize).toBeUndefined();
});

describe("Particle VFX textures the effect carries", () => {
  function pngOf(width: number, height: number, size = 64): Blob {
    const bytes = new Uint8Array(Math.max(size, PNG.length));
    bytes.set(PNG);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return new Blob([bytes], { type: "image/png" });
  }

  function carried(blob: Blob) {
    return { blob, sha256: "a".repeat(64), width: 1, height: 1 };
  }

  it("packages a carried texture and reopens with its bytes under the package path", async () => {
    const draft = namedDraft();
    (draft.quarksJson.images as { url: string }[])[0]!.url =
      "textures/glyph-1.png";
    const blob = pngOf(64, 32);
    const withFile = {
      ...draft,
      textureFiles: { "textures/glyph-1.png": carried(blob) },
    };
    const built = await buildParticleVFXContentPackage({
      draft: withFile,
      resources: [],
    });
    expect(built.textures.map((texture) => texture.packageReference)).toEqual([
      "textures/glyph-1.png",
    ]);
    expect(await built.textures[0]!.file.arrayBuffer()).toEqual(
      await blob.arrayBuffer(),
    );
    const reopened = built.normalizedDraft.textureFiles["textures/glyph-1.png"];
    expect(reopened).toMatchObject({ width: 64, height: 32 });
    expect(reopened!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a texture over the size limits or a total over 32 MiB, naming the limit", async () => {
    const draft = namedDraft();
    (draft.quarksJson.images as { url: string }[])[0]!.url =
      "textures/big-1.png";
    await expect(
      buildParticleVFXContentPackage({
        draft: {
          ...draft,
          textureFiles: {
            "textures/big-1.png": carried(pngOf(8, 8, 4 * 1024 * 1024 + 1)),
          },
        },
        resources: [],
      }),
    ).rejects.toThrow("4 MiB");
    await expect(
      buildParticleVFXContentPackage({
        draft: {
          ...draft,
          textureFiles: { "textures/big-1.png": carried(pngOf(4096, 8)) },
        },
        resources: [],
      }),
    ).rejects.toThrow("2048 px");

    let many = namedDraft();
    const files: Record<string, ReturnType<typeof carried>> = {};
    for (let index = 0; index < 9; index += 1) {
      if (index) many = addParticleVFXEditorEmitter(many);
      const reference = `textures/part-${index}.png`;
      (many.quarksJson.images as { url: string }[])[index]!.url = reference;
      files[reference] = carried(pngOf(8, 8, 4 * 1024 * 1024 - 64));
    }
    await expect(
      buildParticleVFXContentPackage({
        draft: { ...many, textureFiles: files },
        resources: [],
      }),
    ).rejects.toThrow("32 MiB");
  });
});
