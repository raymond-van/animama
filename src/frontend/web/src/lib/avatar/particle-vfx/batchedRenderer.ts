import type { BatchedRenderer, ParticleSystem } from "three.quarks";

type ThreeQuarksModule = typeof import("three.quarks");
type QuarksParticleSystem = Parameters<BatchedRenderer["addSystem"]>[0];
type QuarksBatch = BatchedRenderer["batches"][number];

/**
 * Create the three.quarks batch renderer Animama draws Particle Effects with.
 *
 * three.quarks draws each group of compatible emitters through one shader
 * material it builds itself, which tone-maps (ACES Filmic in chat) and so
 * cannot show white art at full brightness. A manifest material may opt out
 * with the three.js field `toneMapped: false`: this renderer keeps such
 * emitters in batches of their own, whose material has tone mapping off, and
 * leaves every other emitter batched and tone-mapped exactly as before.
 *
 * The particle shader has no sRGB output step either way, so with tone
 * mapping off a texture's stored values reach the canvas unchanged when its
 * `colorSpace` is empty (the art shows as authored, white at 255).
 *
 * three.quarks writes every particle's position in world space, so its
 * batches must draw with an identity world matrix. The renderer keeps an
 * identity world matrix wherever it is parented: under the Avatar scene the
 * Avatar's transform would otherwise apply twice, which mirrors VRM 0
 * Avatars' particles (their scenes turn half about Y) to the far side.
 */
export function createParticleVFXBatchedRenderer(
  quarks: ThreeQuarksModule,
): BatchedRenderer {
  class ParticleVFXBatchedRenderer extends quarks.BatchedRenderer {
    constructor() {
      super();
      this.matrixAutoUpdate = false;
      this.matrixWorldAutoUpdate = false;
    }

    override addSystem(system: QuarksParticleSystem): void {
      const toneMapped = isToneMapped(
        (system as ParticleSystem).getRendererSettings(),
      );
      const batches = this.batches;
      // While every emitter is tone-mapped, batching is three.quarks' own.
      if (
        toneMapped &&
        batches.every((batch) => isToneMapped(batch.settings))
      ) {
        super.addSystem(system);
        return;
      }
      // three.quarks matches batches without comparing tone mapping, so offer
      // it only batches drawn the same way: it joins one or builds a new one.
      const sameToneMapping = batches.filter(
        (batch) => isToneMapped(batch.settings) === toneMapped,
      );
      this.batches = sameToneMapping;
      try {
        super.addSystem(system);
      } finally {
        this.batches = batches;
      }
      const batch = sameToneMapping[this.systemToBatchIndex.get(system) ?? -1];
      if (!batch) {
        throw new Error("three.quarks did not batch the particle system.");
      }
      if (!batches.includes(batch)) {
        // A new batch: three.quarks builds its shader material once, here.
        for (const material of [batch.material].flat())
          material.toneMapped = toneMapped;
        batches.push(batch);
      }
      this.systemToBatchIndex.set(system, batches.indexOf(batch));
    }
  }
  return new ParticleVFXBatchedRenderer();
}

function isToneMapped(
  settings: Pick<QuarksBatch["settings"], "material">,
): boolean {
  return settings.material.toneMapped !== false;
}
