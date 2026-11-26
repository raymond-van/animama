import { describe, expect, it } from "vitest";

import {
  loadTestAvatarWithGltf,
  type TestAvatarId,
} from "../motion-authoring/testing/includedAvatars";
import {
  DEFAULT_SPRING_BONE_PHYSICS_PARAMS,
  SpringBonePhysicsController,
  springsTunedWithoutAmbientForces,
} from "./SpringBonePhysicsController";

/** An Included Avatar with its spring settings recorded before any controller runs. */
async function avatar(id: TestAvatarId) {
  const { vrm, gltf } = await loadTestAvatarWithGltf(id);
  vrm.scene.updateMatrixWorld(true);
  const joints = [...vrm.springBoneManager!.joints];
  const before = joints.map((joint) => ({
    gravityPower: joint.settings.gravityPower,
    gravityDir: joint.settings.gravityDir.clone(),
    dragForce: joint.settings.dragForce,
  }));
  return { vrm, gltf, joints, before };
}

describe("SpringBonePhysicsController ambient forces", () => {
  it("adds the updraft to VRM-authored springs by default", async () => {
    const { vrm, gltf, joints } = await avatar("Andrew");
    const controller = new SpringBonePhysicsController(vrm, {
      sourceGltf: gltf,
    });
    controller.update(1 / 60);
    // Andrew's hair has no authored gravity, so any upward pull is the updraft.
    expect(
      joints.some(
        (joint) =>
          joint.settings.gravityPower * joint.settings.gravityDir.y > 0,
      ),
    ).toBe(true);
    expect(controller.getSnapshot().ambientForces).toBe(true);
    controller.dispose();
  });

  it("keeps the authored gravity when ambient forces are off", async () => {
    // Annie authors gravity on some joints (up to 0.25) and none on others.
    const { vrm, gltf, joints, before } = await avatar("Annie");
    expect(before.some(({ gravityPower }) => gravityPower > 0)).toBe(true);
    const controller = new SpringBonePhysicsController(vrm, {
      sourceGltf: gltf,
      ambientForces: false,
    });
    controller.update(1 / 60);
    joints.forEach((joint, index) => {
      const authored = before[index]!;
      expect(joint.settings.gravityPower).toBeCloseTo(authored.gravityPower, 6);
      if (authored.gravityPower > 0) {
        expect(
          joint.settings.gravityDir.angleTo(authored.gravityDir),
        ).toBeCloseTo(0, 5);
      }
      // Drag tuning still applies (hair at full intensity, others at half).
      expect(joint.settings.dragForce).toBeGreaterThanOrEqual(
        authored.dragForce,
      );
    });
    expect(controller.getSnapshot().ambientForces).toBe(false);
    controller.dispose();
  });

  it("never raises drag above 1", async () => {
    const { vrm, gltf, joints } = await avatar("Andrew");
    // A converted PhysBone can author drag 0.86; ×2 would exceed 1.
    for (const joint of joints) joint.settings.dragForce = 0.86;
    const controller = new SpringBonePhysicsController(vrm, {
      sourceGltf: gltf,
      ambientForces: false,
    });
    controller.setParams({
      dragMultiplier: DEFAULT_SPRING_BONE_PHYSICS_PARAMS.dragMultiplier,
    });
    controller.update(1 / 60);
    for (const joint of joints) {
      expect(joint.settings.dragForce).toBeLessThanOrEqual(1);
    }
    controller.dispose();
  });

  it("recognises Mochiya conversions by the converter's extension", () => {
    expect(
      springsTunedWithoutAmbientForces({
        extensionsUsed: ["VRMC_vrm", "MOCHIYA_avatar_composition"],
      }),
    ).toBe(true);
    expect(
      springsTunedWithoutAmbientForces({
        extensionsUsed: ["VRMC_vrm", "ANIMAMA_avatar_conversion"],
      }),
    ).toBe(true);
    expect(
      springsTunedWithoutAmbientForces({
        extensionsUsed: ["VRMC_vrm", "VRMC_springBone"],
      }),
    ).toBe(false);
    expect(springsTunedWithoutAmbientForces(null)).toBe(false);
  });
});
