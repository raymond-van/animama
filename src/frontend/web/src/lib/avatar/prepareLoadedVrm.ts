import type { VRM } from "@pixiv/three-vrm";

import {
  type ArkitFace,
  ownFaceNames,
  registerArkitFace,
} from "./arkitFaceExpressions";
import {
  applyEyelidClosureCorrection,
  type EyelidClosureCorrection,
} from "./eyelidClosure";
import { installFaceShapeStacking } from "./faceShapeStacking";
import { type FaceSignals, registerFaceSignals } from "./faceSignals";
import { registerIrisHideExpression } from "./irisHideExpression";
import { registerMmdFace } from "./mmdFaceExpressions";
import {
  installRestNormalization,
  type RestPoseCheck,
} from "./poses/anatomy/restNormalization";

/** What the load-time installs found on a model. */
export type PreparedVrm = {
  /** Where each blink and viseme preset comes from. */
  readonly faceSignals: FaceSignals;
  readonly arkitFace: ArkitFace;
  readonly eyelidClosure: EyelidClosureCorrection | null;
  /** How far the arms and hands rest from VRoid's, and what was normalized. */
  readonly restPose: RestPoseCheck;
};

/**
 * The load-time installs every place that loads an Avatar for display runs,
 * in order, so the app (`Avatar.load`), the Gesture review sheets
 * (`motion-authoring/reviewSheet.ts`) and Avatar test helpers play a model the
 * same way. Call it once after loading and expression canonicalization.
 *
 * Blink and viseme presets the file leaves empty are filled from other
 * shapes first (`faceSignals.ts`), then the face names content keys are
 * registered region by region (MMD morphs, then ARKit mixes, then
 * `Fcl_EYE_Iris_Hide`) before the eyelid closure correction, which measures
 * them, and the stacking limits on the expressions Animama built
 * (`faceShapeStacking.ts`). Face part detection (`Avatar.load`) runs after
 * this. Arms and hands whose rest differs from VRoid's are normalized
 * (`restNormalization.ts`).
 * Every step is idempotent.
 *
 * The motion checks load models without it, because they read the file's own
 * expressions; `vrm:inspect` reads those first and then runs it.
 */
export function prepareLoadedVrm(
  vrm: VRM,
  options: { vrmSha256: string | null | undefined },
): PreparedVrm {
  const faceSignals = registerFaceSignals(vrm);
  registerMmdFace(vrm, ownFaceNames(vrm));
  const arkitFace = registerArkitFace(vrm);
  registerIrisHideExpression(vrm, ownFaceNames(vrm));
  const eyelidClosure = applyEyelidClosureCorrection(vrm, options.vrmSha256);
  installFaceShapeStacking(vrm);
  const restPose = installRestNormalization(vrm);
  return { faceSignals, arkitFace, eyelidClosure, restPose };
}
