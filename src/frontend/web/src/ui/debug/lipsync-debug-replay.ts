/**
 * Replays a captured run in the debug panel's Lip-sync view: its audio plays
 * through a separate `AudioContext`, and the chosen plan drives the avatar's
 * mouth on that clock through the bridge's segment path.
 */

import type { VowelVisemeLipSyncSegment } from "@/lib/avatar/vowelVisemeSegment";
import type { LipSyncDebugCapture } from "@/stores/lipsync-debug-store";

// Lead time so the source and the plan start on the same scheduled instant.
const REPLAY_LEAD_SEC = 0.1;

let replayCount = 0;

export type LipSyncReplay = {
  /** The synthetic run the plan plays under. */
  runId: string;
  audioContext: AudioContext;
  /** When the audio starts on `audioContext`'s clock. */
  audioStartSec: number;
  stop: () => void;
};

type PlaySegment = (args: {
  segment: VowelVisemeLipSyncSegment;
  audioContext: AudioContext;
  audioStartSec: number;
}) => boolean;

/** The plan under the replay's own run and segment ids, so each replay starts fresh. */
function withReplayIds(
  segment: VowelVisemeLipSyncSegment,
  runId: string,
): VowelVisemeLipSyncSegment {
  const segmentId = `${runId}-segment`;
  return {
    ...segment,
    segmentId,
    meta: { ...segment.meta, run_id: runId, segment_id: segmentId },
    frames: segment.frames.map((frame) => ({
      ...frame,
      run_id: runId,
      segment_id: segmentId,
    })),
  };
}

export async function startLipSyncReplay(args: {
  capture: LipSyncDebugCapture;
  segment: VowelVisemeLipSyncSegment;
  /** Apply the plan to the avatar; `false` when no avatar is ready. */
  playSegment: PlaySegment;
  /** Clear the replay's plan from the avatar. */
  stopSegment: () => void;
  onEnded?: () => void;
  createAudioContext?: (options: { sampleRate: number }) => AudioContext;
}): Promise<LipSyncReplay> {
  const { capture } = args;
  const audioContext = (
    args.createAudioContext ?? ((options) => new AudioContext(options))
  )({ sampleRate: capture.sampleRate });
  const buffer = audioContext.createBuffer(
    1,
    Math.max(1, capture.samples),
    capture.sampleRate,
  );
  const channel = buffer.getChannelData(0);
  let offset = 0;
  for (const chunk of capture.chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      channel[offset + index] = chunk[index] / 32768;
    }
    offset += chunk.length;
  }

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  const audioStartSec = audioContext.currentTime + REPLAY_LEAD_SEC;
  replayCount += 1;
  const runId = `lipsync-replay-${replayCount}`;

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // The source may have ended already.
    }
    args.stopSegment();
    void audioContext.close().catch(() => {});
  };

  if (
    !args.playSegment({
      segment: withReplayIds(args.segment, runId),
      audioContext,
      audioStartSec,
    })
  ) {
    stopped = true;
    await audioContext.close().catch(() => {});
    throw new Error("No avatar is ready to replay lip-sync.");
  }
  source.onended = () => {
    stop();
    args.onEnded?.();
  };
  source.start(audioStartSec);
  return { runId, audioContext, audioStartSec, stop };
}
