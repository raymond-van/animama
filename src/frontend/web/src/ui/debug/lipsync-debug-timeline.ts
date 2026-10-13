/**
 * Canvas drawing for the debug panel's Lip-sync view. Three lanes share one
 * time axis: the audio envelope, the timing evidence, and one mouth-openness
 * curve per plan source.
 */

import type {
  AudioTagClass,
  SpeechTimingEvidence,
} from "@/lib/speech/speech-timing-evidence";

/** Horizontal scale; the view scrolls when a reply is longer than the panel. */
export const TIMELINE_PX_PER_SEC = 120;
export const TIMELINE_HEIGHT = 168;

const ENVELOPE_LANE = { top: 0, height: 36 };
const EVIDENCE_LANE = { top: 40, height: 48 };
const CURVE_LANE = { top: 92, height: 72 };

const TAG_COLORS: Record<AudioTagClass, string> = {
  nonverbal: "rgba(245, 158, 11, 0.45)",
  sound_effect: "rgba(168, 85, 247, 0.45)",
  pacing: "rgba(148, 163, 184, 0.45)",
  delivery: "#ef4444",
};
const WORD_FILLS = ["rgba(59, 130, 246, 0.18)", "rgba(59, 130, 246, 0.32)"];
const PUNCTUATION_COLOR = "rgba(148, 163, 184, 0.9)";
const PLAYHEAD_COLOR = "#ef4444";

export type TimelineCurve = {
  id: string;
  color: string;
  points: ReadonlyArray<{ timeSec: number; openness: number }>;
};

/** The canvas width for `durationSec` of audio in a container `minWidth` wide. */
export function timelineWidth(durationSec: number, minWidth: number): number {
  return Math.max(
    Math.round(minWidth),
    Math.ceil(durationSec * TIMELINE_PX_PER_SEC),
  );
}

/** Peak level (0–1) of the captured PCM in each of `columns` equal slices. */
export function audioEnvelope(
  chunks: readonly Int16Array[],
  samples: number,
  columns: number,
): Float32Array {
  const envelope = new Float32Array(Math.max(0, columns));
  if (columns <= 0 || samples <= 0) return envelope;
  const samplesPerColumn = samples / columns;
  let index = 0;
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length; offset += 1, index += 1) {
      const column = Math.min(
        columns - 1,
        Math.floor(index / samplesPerColumn),
      );
      const level = Math.abs(chunk[offset]) / 32768;
      if (level > envelope[column]) envelope[column] = level;
    }
  }
  return envelope;
}

/** Draw the timeline; `playheadSec` marks a replay's position. */
export function drawLipSyncTimeline(
  context: CanvasRenderingContext2D,
  args: {
    width: number;
    height: number;
    durationSec: number;
    envelope: Float32Array;
    evidence: SpeechTimingEvidence;
    curves: readonly TimelineCurve[];
    playheadSec: number | null;
    textColor: string;
  },
): void {
  const { width, height, durationSec, evidence } = args;
  const x = (timeSec: number) =>
    durationSec > 0 ? (timeSec / durationSec) * width : 0;
  context.clearRect(0, 0, width, height);

  // Audio envelope, mirrored around the lane's middle.
  context.fillStyle = PUNCTUATION_COLOR;
  const middle = ENVELOPE_LANE.top + ENVELOPE_LANE.height / 2;
  args.envelope.forEach((level, column) => {
    const half = (level * ENVELOPE_LANE.height) / 2;
    context.fillRect(
      (column / args.envelope.length) * width,
      middle - half,
      1,
      Math.max(1, half * 2),
    );
  });

  // Evidence: tag intervals behind words, then words, punctuation and markers.
  for (const tag of evidence.tags) {
    if (tag.tagClass === "delivery") continue;
    context.fillStyle = TAG_COLORS[tag.tagClass];
    context.fillRect(
      x(tag.startSec),
      EVIDENCE_LANE.top,
      Math.max(1, x(tag.endSec) - x(tag.startSec)),
      EVIDENCE_LANE.height,
    );
  }
  context.font = "10px ui-monospace, monospace";
  context.textBaseline = "top";
  evidence.words.forEach((word, index) => {
    const left = x(word.startSec);
    const boxWidth = Math.max(1, x(word.endSec) - left);
    context.fillStyle = WORD_FILLS[index % 2];
    context.fillRect(left, EVIDENCE_LANE.top + 14, boxWidth, 18);
    context.fillStyle = args.textColor;
    context.fillText(word.text, left + 1, EVIDENCE_LANE.top + 17, boxWidth);
  });
  context.fillStyle = PUNCTUATION_COLOR;
  for (const mark of evidence.punctuation) {
    context.fillRect(
      x(mark.startSec),
      EVIDENCE_LANE.top + 34,
      Math.max(1, x(mark.endSec) - x(mark.startSec)),
      4,
    );
    context.fillText(mark.text, x(mark.startSec), EVIDENCE_LANE.top + 38);
  }
  context.strokeStyle = TAG_COLORS.delivery;
  context.fillStyle = TAG_COLORS.delivery;
  for (const tag of evidence.tags) {
    const label = tag.directions.map((direction) => direction.text).join(", ");
    if (tag.tagClass !== "delivery") {
      context.fillText(label, x(tag.startSec) + 1, EVIDENCE_LANE.top + 1);
      continue;
    }
    // A delivery direction is a marker at its start for the words after it.
    context.beginPath();
    context.moveTo(x(tag.startSec), EVIDENCE_LANE.top);
    context.lineTo(x(tag.startSec), EVIDENCE_LANE.top + EVIDENCE_LANE.height);
    context.stroke();
    context.fillText(label, x(tag.startSec) + 2, EVIDENCE_LANE.top + 1);
  }

  // One mouth-openness curve per plan source.
  const curveBottom = CURVE_LANE.top + CURVE_LANE.height;
  context.lineWidth = 1.5;
  for (const curve of args.curves) {
    context.strokeStyle = curve.color;
    context.beginPath();
    curve.points.forEach((point, index) => {
      const pointX = x(point.timeSec);
      const pointY = curveBottom - point.openness * CURVE_LANE.height;
      if (index === 0) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    });
    context.stroke();
  }
  context.lineWidth = 1;

  if (args.playheadSec !== null) {
    context.strokeStyle = PLAYHEAD_COLOR;
    context.beginPath();
    context.moveTo(x(args.playheadSec), 0);
    context.lineTo(x(args.playheadSec), height);
    context.stroke();
  }
}
