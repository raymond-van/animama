import * as THREE from "three";
import * as quarks from "three.quarks";
import { describe, expect, it } from "vitest";

import compatibilityValid from "./fixtures/compatibility-valid.json";
import { createParticleVFXBatchedRenderer } from "./batchedRenderer";

type Batch = { material: { toneMapped: boolean }; systems: Set<unknown> };

/**
 * The fixture with one emitter per entry of `toneMapped`, every emitter's
 * material drawing the same texture so three.quarks would batch them
 * together. `undefined` leaves the material's field out.
 */
function manifest(toneMapped: Array<boolean | undefined>) {
  const json = structuredClone(compatibilityValid);
  const [emitter] = json.object.children;
  const [material] = json.materials;
  return {
    ...json,
    // One inline white pixel keeps the parse free of image fetches.
    images: [
      {
        uuid: "fixture-image",
        url: {
          data: [255, 255, 255, 255],
          width: 1,
          height: 1,
          type: "Uint8Array",
        },
      },
    ],
    textures: [{ uuid: "fixture-texture", image: "fixture-image" }],
    materials: toneMapped.map((value, index) => ({
      ...material,
      uuid: `fixture-material-${index}`,
      map: "fixture-texture",
      ...(value === undefined ? {} : { toneMapped: value }),
    })),
    object: {
      ...json.object,
      children: toneMapped.map((_, index) => ({
        ...structuredClone(emitter),
        uuid: `fixture-emitter-${index}`,
        ps: {
          ...structuredClone(emitter!.ps),
          material: `fixture-material-${index}`,
        },
      })),
    },
  };
}

function batches(toneMapped: Array<boolean | undefined>): Batch[] {
  const renderer = createParticleVFXBatchedRenderer(quarks);
  quarks.QuarksUtil.addToBatchRenderer(
    new quarks.QuarksLoader().parse(manifest(toneMapped)),
    renderer,
  );
  return renderer.batches as unknown as Batch[];
}

describe("createParticleVFXBatchedRenderer", () => {
  it("tone-maps emitters by default, batched together as three.quarks does", () => {
    const [batch, ...rest] = batches([undefined, true]);
    expect(rest).toEqual([]);
    expect(batch?.material.toneMapped).toBe(true);
    expect(batch?.systems.size).toBe(2);
  });

  it("draws an emitter whose material sets toneMapped: false without tone mapping", () => {
    const drawn = batches([true, false, undefined, false]);
    expect(
      drawn.map((batch) => [batch.material.toneMapped, batch.systems.size]),
    ).toEqual([
      [true, 2],
      [false, 2],
    ]);
  });
});

describe("particle placement under a rotated Avatar scene", () => {
  // VRM 0 scenes face the camera through a half turn about Y; the batch
  // renderer lives inside the Avatar scene, under the particle root.
  function render(options: { renderMode: number; worldSpace: boolean }) {
    const json = manifest([undefined]);
    const emitter = json.object.children[0]!;
    Object.assign(emitter.ps, options);
    // three.quarks only simulates emitters attached to a THREE.Scene.
    const world = new THREE.Scene();
    const avatarScene = new THREE.Group();
    world.add(avatarScene);
    avatarScene.position.set(0.5, 0, -2);
    avatarScene.rotation.y = Math.PI;
    const particleRoot = new THREE.Group();
    avatarScene.add(particleRoot);
    const renderer = createParticleVFXBatchedRenderer(quarks);
    particleRoot.add(renderer);
    const hand = new THREE.Object3D();
    hand.position.set(0.4, 1.1, 0.2);
    avatarScene.add(hand);
    const effect = new quarks.QuarksLoader().parse(json);
    hand.add(effect);
    quarks.QuarksUtil.addToBatchRenderer(effect, renderer);
    world.updateMatrixWorld(true);
    renderer.update(1 / 60);
    world.updateMatrixWorld(true);
    const [batch] = renderer.batches as unknown as Array<
      THREE.Mesh<THREE.InstancedBufferGeometry>
    >;
    const offset = batch!.geometry.getAttribute("offset");
    expect(batch!.geometry.instanceCount).toBe(1);
    return {
      rendered: new THREE.Vector3()
        .fromBufferAttribute(offset, 0)
        .applyMatrix4(batch!.matrixWorld),
      hand: hand.getWorldPosition(new THREE.Vector3()),
    };
  }

  it.each([
    ["billboard", 0],
    ["stretched billboard", 1],
    ["mesh", 2],
  ])("draws %s particles at their anchor bone", (_, renderMode) => {
    for (const worldSpace of [false, true]) {
      const { rendered, hand } = render({ renderMode, worldSpace });
      expect(rendered.distanceTo(hand)).toBeCloseTo(0, 5);
    }
  });
});
