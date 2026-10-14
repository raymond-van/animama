import { describe, expect, it } from "vitest";

import {
  applyParticleVFXEmitterPatch,
  createParticleVFXEditorDraftFromBlank,
  setParticleVFXSimpleControl,
  updateParticleVFXEditorCatalogDraft,
} from "@/lib/avatar/particle-vfx";
import { themedParticleDraft } from "@/test/particle-colour-theme";
import {
  equalParticleVFXDrafts,
  particleVFXDocumentFingerprint,
  rebaseParticleVFXSimpleControls,
} from "./particleVFXDocument";

describe("typed Particle Effect document", () => {
  it("fingerprints equivalent editable documents deterministically", () => {
    const draft = createParticleVFXEditorDraftFromBlank();
    const copy = structuredClone(draft);

    expect(particleVFXDocumentFingerprint(copy)).toBe(
      particleVFXDocumentFingerprint(draft),
    );
  });

  it("changes the recovery fingerprint when authored content changes", () => {
    const draft = createParticleVFXEditorDraftFromBlank();
    const renamed = {
      ...draft,
      catalog: { ...draft.catalog, label: "A different particle effect" },
    };

    expect(particleVFXDocumentFingerprint(renamed)).not.toBe(
      particleVFXDocumentFingerprint(draft),
    );
  });

  it("changes when a texture the effect uses gets new bytes, not when an unused one does", () => {
    const draft = createParticleVFXEditorDraftFromBlank();
    const reference = "textures/glyph-1.png";
    (draft.quarksJson.images as { url: string }[])[0]!.url = reference;
    const file = (sha256: string) => ({
      blob: new Blob([]),
      sha256,
      width: 1,
      height: 1,
    });
    const supplied = { ...draft, textureFiles: { [reference]: file("a") } };
    const replaced = { ...draft, textureFiles: { [reference]: file("b") } };
    const unused = {
      ...supplied,
      textureFiles: {
        ...supplied.textureFiles,
        "textures/other-1.png": file("c"),
      },
    };

    expect(particleVFXDocumentFingerprint(supplied)).not.toBe(
      particleVFXDocumentFingerprint(draft),
    );
    expect(particleVFXDocumentFingerprint(replaced)).not.toBe(
      particleVFXDocumentFingerprint(supplied),
    );
    expect(particleVFXDocumentFingerprint(unused)).toBe(
      particleVFXDocumentFingerprint(supplied),
    );
  });
});

describe("Simple controls in the Particle document", () => {
  const blank = createParticleVFXEditorDraftFromBlank();
  const emitterPath = blank.emitters[0]!.path;

  it("leaves Simple's reference and positions out of the Save fingerprint", () => {
    const sized = setParticleVFXSimpleControl(blank, "size", 200);
    const resized = setParticleVFXSimpleControl(sized, "size", 100);

    expect(sized.simple?.factors.size).toBe(200);
    expect(particleVFXDocumentFingerprint(sized)).not.toBe(
      particleVFXDocumentFingerprint(blank),
    );
    // Back at 100 % the effect is the one that was opened: not unsaved.
    expect(resized.simple).not.toBeNull();
    expect(particleVFXDocumentFingerprint(resized)).toBe(
      particleVFXDocumentFingerprint(blank),
    );
  });

  it("makes a Simple move an undo step even when the effect is unchanged", () => {
    // The blank effect's one layer bursts 12 particles, so Amount scales it;
    // a single-particle layer would leave the effect as it was.
    const single = applyParticleVFXEmitterPatch(blank, emitterPath, {
      burstCount: { min: 1, max: 1 },
    });
    const moved = setParticleVFXSimpleControl(single, "amount", 200);

    expect(particleVFXDocumentFingerprint(moved)).toBe(
      particleVFXDocumentFingerprint(single),
    );
    expect(equalParticleVFXDrafts(moved, single)).toBe(false);
    expect(
      equalParticleVFXDrafts(
        moved,
        setParticleVFXSimpleControl(single, "amount", 200),
      ),
    ).toBe(true);
  });

  it("rebases Simple when an edit from elsewhere changes the effect", () => {
    const scaled = setParticleVFXSimpleControl(blank, "speed", 150);
    const edited = rebaseParticleVFXSimpleControls(
      scaled,
      applyParticleVFXEmitterPatch(scaled, emitterPath, {
        startSize: { min: 0.3, max: 0.3 },
      }),
    );

    expect(edited.simple).toBeNull();
    // The scaled values stay in the effect; Simple now measures from them.
    expect(edited.catalog.defaultDurationSec).toBe(
      scaled.catalog.defaultDurationSec,
    );
    const renamed = rebaseParticleVFXSimpleControls(
      scaled,
      updateParticleVFXEditorCatalogDraft(scaled, { label: "Renamed" }),
    );
    expect(renamed.simple).toBeNull();
  });

  it("keeps Simple when an edit from elsewhere leaves the effect as it was", () => {
    const scaled = setParticleVFXSimpleControl(blank, "spread", 50);
    const unchanged = rebaseParticleVFXSimpleControls(
      scaled,
      updateParticleVFXEditorCatalogDraft(scaled, {
        label: scaled.catalog.label,
      }),
    );

    expect(unchanged.simple).toBe(scaled.simple);
    expect(rebaseParticleVFXSimpleControls(scaled, scaled)).toBe(scaled);
  });

  it("makes a colour theme an undo step and an Advanced colour edit a rebase to Original", async () => {
    const { draft, themed } = await themedParticleDraft("sky");
    expect(equalParticleVFXDrafts(themed, draft)).toBe(false);
    expect(
      equalParticleVFXDrafts(themed, (await themedParticleDraft("sky")).themed),
    ).toBe(true);
    // Another theme is another step.
    expect(
      equalParticleVFXDrafts(
        themed,
        (await themedParticleDraft("white")).themed,
      ),
    ).toBe(false);

    const copy = "textures/glyph-1-sky.png";
    const recoloured = rebaseParticleVFXSimpleControls(
      themed,
      applyParticleVFXEmitterPatch(themed, themed.emitters[0]!.path, {
        startColor: { r: 0.2, g: 0.4, b: 0.9 },
      }),
    );
    // Simple shows Original again; the edited effect keeps the theme's copy
    // as its own texture.
    expect(recoloured.simple).toBeNull();
    expect(recoloured.emitters[0]!.textureUrl).toBe(copy);
    expect(recoloured.textureFiles[copy]).toBe(themed.textureFiles[copy]);
  });
});
