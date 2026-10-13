import { VRMUtils } from "@pixiv/three-vrm";
import type { Material, Object3D, Texture } from "three";

/**
 * Release a loaded model that must never be drawn again.
 *
 * The model is detached first. A frame that still reaches a disposed geometry,
 * material or texture uploads it to the GPU again, and nothing releases that
 * copy until the canvas is destroyed. three.js leaves decoded ImageBitmaps to
 * garbage collection, which can hold more than 100 MB per model, so they are
 * closed once their textures are disposed. Textures are found the way
 * `VRMUtils.deepDispose` finds them.
 */
export function releaseModelScene(scene: Object3D): void {
  scene.removeFromParent();
  const bitmaps = collectImageBitmaps(scene);
  VRMUtils.deepDispose(scene);
  bitmaps.forEach((bitmap) => bitmap.close());
}

function collectImageBitmaps(scene: Object3D): Set<ImageBitmap> {
  const bitmaps = new Set<ImageBitmap>();
  if (typeof ImageBitmap === "undefined") return bitmaps;
  const addTexture = (value: unknown) => {
    const data = (value as Partial<Texture> | null)?.isTexture
      ? (value as Texture).source.data
      : null;
    if (data instanceof ImageBitmap) bitmaps.add(data);
  };
  scene.traverse((object) => {
    const material = (object as Object3D & { material?: Material | Material[] })
      .material;
    for (const entry of Array.isArray(material) ? material : [material]) {
      if (!entry) continue;
      Object.values(entry).forEach(addTexture);
      const shader = entry as Material & {
        isShaderMaterial?: boolean;
        uniforms?: Record<string, { value: unknown }>;
      };
      if (shader.isShaderMaterial && shader.uniforms) {
        Object.values(shader.uniforms).forEach((uniform) =>
          addTexture(uniform.value),
        );
      }
    }
  });
  return bitmaps;
}
