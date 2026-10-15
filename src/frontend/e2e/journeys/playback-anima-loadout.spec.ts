import { test } from "../fixtures/animama";
import { attachPlaybackCheckpoint } from "../helpers/checkpoints";
import {
  proveReactionPlayback,
  proveVrmaPlayback,
} from "../helpers/playback-assertions";
import type {
  ExpectedPlaybackTarget,
  PlaybackObservation,
} from "../helpers/playback-observation";
import {
  PreviewNetworkRecorder,
  ReadOnlyJourneyGuard,
} from "../helpers/preview-network";
import { openAnnieLoadoutPreview } from "../helpers/preview-surfaces";

type AnimaLoadoutJourney = {
  channel: "reaction" | "vrma";
  contentName: string;
  key: string;
  requiredFiles: readonly string[];
  target: ExpectedPlaybackTarget;
};

const JOURNEYS: readonly AnimaLoadoutJourney[] = [
  {
    key: "anima-loadout-gesture-being-cocky",
    channel: "vrma",
    contentName: "Being Cocky",
    target: { kind: "animation", runtimeId: "being_cocky" },
    requiredFiles: ["being_cocky.vrma"],
  },
  {
    key: "anima-loadout-reaction-admiration-4",
    channel: "reaction",
    contentName: "Admiration Reaction 4",
    target: { kind: "anima_pose_clip", runtimeId: "admiration-4" },
    requiredFiles: [
      "shimmer-glint.png",
      "star3-sheet.png",
      "twinkle-star-gold.png",
      "bokeh-tile.png",
    ],
  },
] as const;

for (const journey of JOURNEYS) {
  test(`${journey.key} @surface-anima-loadout @channel-${journey.channel} @playback-representative @read-only`, async ({
    page,
    animamaEvidence,
  }) => {
    const network = new PreviewNetworkRecorder(page);
    const readOnly = new ReadOnlyJourneyGuard(page);
    try {
      const { animaId, surface } =
        await test.step(`Open Annie Loadout and preview ${journey.contentName}`, async () => {
          return openAnnieLoadoutPreview({
            contentName: journey.contentName,
            page,
            section: journey.channel === "reaction" ? "reaction" : "gesture",
          });
        });
      let samples: PlaybackObservation[];
      if (journey.channel === "vrma") {
        samples =
          await test.step(`Assert VRMA ${journey.target.runtimeId} is active, weighted, and advancing`, async () => {
            return proveVrmaPlayback({
              evidence: animamaEvidence,
              evidenceName: journey.key,
              expectedTarget: journey.target,
              surface,
            });
          });
      } else {
        samples =
          await test.step("Assert reaction timing, expressions, fired events, and all VFX channels", async () => {
            return proveReactionPlayback({
              evidence: animamaEvidence,
              evidenceName: journey.key,
              expectedAvatarEffects: ["star3"],
              expectedEventIds: [
                "scene-emotion-background",
                "avatar-star3",
                "particle-twinkle-shimmer",
              ],
              expectedParticleEffects: ["twinkle-shimmer"],
              expectedSceneEffects: ["scene-vfx-emotion-admiration"],
              expectedTarget: journey.target,
              // admiration-4 peaks at happy 0.75 and relaxed 0.33; sampled
              // frames can land just short of the peak.
              expressionThresholds: { happy: 0.7, relaxed: 0.3 },
              surface,
            });
          });
      }

      await test.step(`Assert preview API selected ${journey.target.runtimeId} and loaded required resources`, async () => {
        await network.waitForPreview(journey.target.runtimeId);
        await network.requireResources(journey.requiredFiles);
        await network.attach(animamaEvidence, `${journey.key}-preview-network`);
      });
      await test.step("Capture the playback checkpoint and observation", async () => {
        await attachPlaybackCheckpoint({
          evidence: animamaEvidence,
          locator: surface,
          name: journey.key,
          samples,
        });
      });
      await test.step("Assert Annie's persisted loadout is unchanged", async () => {
        await readOnly.verifyLoadoutUnchanged(animaId, animamaEvidence);
      });
      await test.step("Assert no catalog or loadout mutations occurred", async () => {
        await readOnly.assertNoMutations(animamaEvidence);
      });
    } finally {
      await network.dispose();
      await readOnly.dispose();
    }
  });
}
