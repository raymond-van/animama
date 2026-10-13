"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useElementSize } from "@/hooks/useElementSize";
import type { VowelVisemeLipSyncSegment } from "@/lib/avatar/vowelVisemeSegment";
import {
  lipSyncPlanSources,
  mouthOpennessCurve,
  type LipSyncPlanSource,
} from "@/lib/speech/lipsync-plan-sources";
import { buildSpeechTimingEvidence } from "@/lib/speech/speech-timing-evidence";
import { useAvatarLipSyncBridgeStore } from "@/stores/avatar-lipsync-bridge-store";
import {
  useLipSyncDebugStore,
  type LipSyncDebugCapture,
} from "@/stores/lipsync-debug-store";
import { Button } from "@/ui/components/button";
import { startLipSyncReplay, type LipSyncReplay } from "./lipsync-debug-replay";
import {
  audioEnvelope,
  drawLipSyncTimeline,
  TIMELINE_HEIGHT,
  timelineWidth,
} from "./lipsync-debug-timeline";

const CURVE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6"];
const DEFAULT_FPS = 60;

type PlanState =
  | { status: "building" }
  | { status: "ready"; segment: VowelVisemeLipSyncSegment }
  | { status: "none" }
  | { status: "failed"; error: string };

type PlanEntry = { source: LipSyncPlanSource; color: string; plan: PlanState };

/**
 * Whether the captured run's playback has ended, so its plans can be built and
 * replayed without taking over its own live lip-sync.
 */
function isComplete(
  capture: LipSyncDebugCapture | null,
): capture is LipSyncDebugCapture & { audioDurationSec: number } {
  return Boolean(
    capture &&
    capture.playbackEnded &&
    capture.audioDurationSec !== null &&
    capture.samples > 0,
  );
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function planStatusLabel(plan: PlanState): string {
  switch (plan.status) {
    case "building":
      return "building…";
    case "ready":
      return `${plan.segment.frameCount} frames`;
    case "none":
      return "no plan";
    case "failed":
      return plan.error;
  }
}

/**
 * The debug panel's Lip-sync view: the latest captured realtime run's audio,
 * its provider timing evidence and a mouth-openness curve per plan source, with
 * a replay of the run on the avatar using any of them.
 */
export function LipSyncDebugSection() {
  const capture = useLipSyncDebugStore((state) => state.capture);
  const complete = isComplete(capture) ? capture : null;
  // A replay would take over a playing reply's lip-sync, whatever its provider.
  const speechPlaying = useAvatarLipSyncBridgeStore(
    (state) => Object.keys(state.speechAudioStartsByRun).length > 0,
  );
  // Once the run's audio has ended, an unclosed bracket is punctuation.
  const timingComplete = Boolean(capture?.playbackEnded);
  const evidence = useMemo(
    () =>
      buildSpeechTimingEvidence(capture?.timing ?? [], {
        complete: timingComplete,
      }),
    [capture?.timing, timingComplete],
  );
  const [plans, setPlans] = useState<PlanEntry[]>([]);
  const [replay, setReplay] = useState<{
    sourceId: string;
    replay: LipSyncReplay;
  } | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [playheadSec, setPlayheadSec] = useState<number | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { width: containerWidth } = useElementSize(scrollElement);

  // Build every source's plan once the run's audio has ended.
  useEffect(() => {
    if (!complete) {
      setPlans([]);
      return;
    }
    let cancelled = false;
    const inputs = {
      runId: complete.runId,
      phonemizedText: complete.inputs?.phonemizedText ?? null,
      tokenizedText: complete.inputs?.tokenizedText ?? null,
      fps: complete.inputs?.fps ?? DEFAULT_FPS,
      audioDurationSec: complete.audioDurationSec,
      timing: complete.timing,
      evidence,
    };
    const sources = lipSyncPlanSources();
    setPlans(
      sources.map((source, index) => ({
        source,
        color: CURVE_COLORS[index % CURVE_COLORS.length],
        plan: { status: "building" },
      })),
    );
    sources.forEach((source, index) => {
      void source
        .build(inputs)
        .then(
          (segment): PlanState =>
            segment ? { status: "ready", segment } : { status: "none" },
        )
        .catch(
          (error: unknown): PlanState => ({
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .then((plan) => {
          if (cancelled) return;
          setPlans((current) =>
            current.map((entry, entryIndex) =>
              entryIndex === index ? { ...entry, plan } : entry,
            ),
          );
        });
    });
    return () => {
      cancelled = true;
    };
  }, [complete, evidence]);

  // Stop a replay when the view closes or a new run replaces the capture.
  useEffect(() => {
    if (!replay) return;
    return () => replay.replay.stop();
  }, [replay]);
  // A reply that starts speaking takes over the avatar, so the replay ends.
  useEffect(() => {
    if (speechPlaying) setReplay(null);
  }, [speechPlaying]);
  useEffect(() => {
    setReplay(null);
  }, [capture?.runId]);

  // Follow a replay's audio clock with the playhead.
  useEffect(() => {
    if (!replay) {
      setPlayheadSec(null);
      return;
    }
    let frame = 0;
    const tick = () => {
      const { audioContext, audioStartSec } = replay.replay;
      setPlayheadSec(Math.max(0, audioContext.currentTime - audioStartSec));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [replay]);

  // A capped capture is drawn on the audio it kept, beyond which nothing plays.
  const drawnDurationSec = complete
    ? Math.min(
        complete.audioDurationSec,
        complete.samples / complete.sampleRate,
      )
    : 0;
  const width = complete ? timelineWidth(drawnDurationSec, containerWidth) : 0;
  const envelope = useMemo(
    () =>
      complete
        ? audioEnvelope(complete.chunks, complete.samples, width)
        : new Float32Array(0),
    [complete, width],
  );

  const curves = useMemo(
    () =>
      plans.flatMap((entry) =>
        entry.plan.status === "ready"
          ? [
              {
                id: entry.source.id,
                color: entry.color,
                points: mouthOpennessCurve(entry.plan.segment),
              },
            ]
          : [],
      ),
    [plans],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !complete || width <= 0) return;
    const scale = window.devicePixelRatio || 1;
    // Resizing clears the bitmap, so only a changed size resets it.
    const pixelWidth = Math.round(width * scale);
    const pixelHeight = Math.round(TIMELINE_HEIGHT * scale);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    drawLipSyncTimeline(context, {
      width,
      height: TIMELINE_HEIGHT,
      durationSec: drawnDurationSec,
      envelope,
      evidence,
      curves,
      playheadSec,
      textColor: getComputedStyle(canvas).color,
    });
  }, [
    complete,
    curves,
    drawnDurationSec,
    envelope,
    evidence,
    playheadSec,
    width,
  ]);

  // Keep a replay's playhead in view when the timeline is wider than the panel.
  useEffect(() => {
    if (!scrollElement || drawnDurationSec <= 0 || playheadSec === null) return;
    const playheadX = (playheadSec / drawnDurationSec) * width;
    scrollElement.scrollLeft = Math.max(0, playheadX - containerWidth / 2);
  }, [containerWidth, drawnDurationSec, playheadSec, scrollElement, width]);

  if (!capture) {
    return (
      <p className="border-border/70 text-muted-foreground rounded-md border border-dashed p-2">
        Send a reply with ElevenLabs speech to capture its audio and timing.
      </p>
    );
  }

  const replayWith = async (entry: PlanEntry) => {
    if (!complete || entry.plan.status !== "ready") return;
    replay?.replay.stop();
    setReplay(null);
    setReplayError(null);
    try {
      const bridge = useAvatarLipSyncBridgeStore.getState();
      const started = await startLipSyncReplay({
        capture: complete,
        segment: entry.plan.segment,
        playSegment: bridge.playReplaySegment,
        stopSegment: bridge.stopReplaySegment,
        onEnded: () => setReplay(null),
      });
      setReplay({ sourceId: entry.source.id, replay: started });
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground">Run</dt>
        <dd className="text-2xs truncate text-right font-mono">
          {capture.runId}
        </dd>
        <dt className="text-muted-foreground">Audio</dt>
        <dd className="text-2xs text-right font-mono">
          {complete
            ? `${complete.audioDurationSec.toFixed(2)} s${complete.truncated ? " (first 90 s kept)" : ""}`
            : `capturing… ${(capture.samples / capture.sampleRate).toFixed(1)} s`}
        </dd>
        <dt className="text-muted-foreground">Evidence</dt>
        <dd className="text-2xs text-right font-mono">
          {[
            count(evidence.words.length, "word"),
            count(evidence.punctuation.length, "pause"),
            count(evidence.tags.length, "tag"),
          ].join(" · ")}
        </dd>
      </dl>

      {complete ? (
        <>
          <div
            ref={setScrollElement}
            className="border-border/60 overflow-x-auto rounded border"
          >
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={`Lip-sync timeline: audio, timing evidence and ${plans.length} plans over ${complete.audioDurationSec.toFixed(2)} s`}
              className="text-foreground block"
              style={{ width, height: TIMELINE_HEIGHT }}
            />
          </div>
          <ul className="space-y-1" aria-label="Lip-sync plans">
            {plans.map((entry) => (
              <li
                key={entry.source.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="truncate">{entry.source.label}</span>
                  <span className="text-muted-foreground text-2xs shrink-0">
                    {planStatusLabel(entry.plan)}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="text-2xs h-6 shrink-0 px-1.5"
                  disabled={entry.plan.status !== "ready" || speechPlaying}
                  onClick={() => void replayWith(entry)}
                  aria-label={`Replay with ${entry.source.label}`}
                >
                  {replay?.sourceId === entry.source.id
                    ? "Replaying"
                    : "Replay"}
                </Button>
              </li>
            ))}
          </ul>
          {replay ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-2xs h-6 px-1.5"
              onClick={() => setReplay(null)}
            >
              Stop replay
            </Button>
          ) : null}
          {speechPlaying && !replay ? (
            <p className="text-muted-foreground text-2xs">
              Replay waits for the reply that is speaking to finish.
            </p>
          ) : null}
          {replayError ? (
            <p className="text-destructive text-2xs">{replayError}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
