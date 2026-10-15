import * as THREE from "three";
import { describe, expect, it } from "vitest";

import type { Avatar } from "../Avatar";
import { resolveParticleVFXAvatarRenderableBoundsLocal } from "./autoFit";
import {
  alignParticleVFXRootToAvatar,
  normalizeParticleVFXTransform,
  resolveParticleVFXAnchorLocalPosition,
} from "./runtime";

/**
 * An Avatar standing at the same world place and facing the camera (+Z)
 * either way: three-vrm turns a VRM 0 scene half about Y to face +Z, so its
 * bones hold mirrored scene-local positions.
 */
function avatarFacingCamera(metaVersion: "0" | "1") {
  const turned = metaVersion === "0";
  const scene = new THREE.Group();
  scene.position.set(0.5, 0, -2);
  if (turned) scene.rotation.y = Math.PI;
  const flip = turned ? -1 : 1;
  const rightHand = new THREE.Object3D();
  rightHand.position.set(-0.4 * flip, 1.1, 0.2 * flip);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2));
  body.position.set(-0.3 * flip, 1, 0);
  scene.add(rightHand, body);
  scene.updateMatrixWorld(true);
  const avatar = {
    scene,
    vrm: {
      meta: { metaVersion },
      humanoid: {
        getNormalizedBoneNode: (name: string) =>
          name === "rightHand" ? rightHand : null,
      },
    },
  } as unknown as Avatar;
  return { avatar, scene, rightHand };
}

describe.each(["0", "1"] as const)(
  "Particle Effect placement on a VRM %s Avatar",
  (metaVersion) => {
    it("places an anchored effect at the bone, offset toward the Avatar's forward and left", () => {
      const { avatar, scene, rightHand } = avatarFacingCamera(metaVersion);
      const root = new THREE.Group();
      scene.add(root);
      alignParticleVFXRootToAvatar(root, avatar);
      const resolved = resolveParticleVFXAnchorLocalPosition({
        avatar,
        anchor: "rightHand",
        transform: normalizeParticleVFXTransform({
          offset: { x: 0.05, y: 0, z: 0.1 },
        }),
      });
      const effect = new THREE.Object3D();
      effect.position.set(
        resolved!.position.x,
        resolved!.position.y,
        resolved!.position.z,
      );
      root.add(effect);
      scene.updateMatrixWorld(true);

      const expected = rightHand
        .getWorldPosition(new THREE.Vector3())
        .add(new THREE.Vector3(0.05, 0, 0.1));
      const placed = effect.getWorldPosition(new THREE.Vector3());
      expect(placed.distanceTo(expected)).toBeCloseTo(0, 6);
      // The effect's own axes face the camera as authored.
      const facing = effect.getWorldDirection(new THREE.Vector3());
      expect(facing.z).toBeCloseTo(1, 6);
    });

    it("measures auto-fit bounds in the same Avatar frame", () => {
      const { avatar } = avatarFacingCamera(metaVersion);
      const bounds = resolveParticleVFXAvatarRenderableBoundsLocal(avatar);
      expect(bounds?.center.x).toBeCloseTo(-0.3, 6);
      expect(bounds?.center.y).toBeCloseTo(1, 6);
    });
  },
);
