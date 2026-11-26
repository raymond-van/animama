/// <reference lib="webworker" />
import {
  checkMotion,
  type MotionCheckAvatar,
  type MotionCheckReport,
} from "@/lib/avatar/motion-authoring/checks";
import { loadHeadlessVrm } from "@/lib/avatar/motion-authoring/headlessVrm";

/**
 * The motion checks in a Web Worker, for the feasibility trial
 * (`trial.ts`). `load` parses the Avatar files once; each `check` then runs
 * `checkMotion` on them and reports how long it took inside the worker.
 */

export type ChecksWorkerRequest =
  | { kind: "load"; avatars: { id: string; bytes: ArrayBuffer }[] }
  | { kind: "check"; clip: unknown };

export type ChecksWorkerReply =
  | { kind: "loaded"; loadMs: number }
  | { kind: "checked"; checkMs: number; report: MotionCheckReport }
  | { kind: "failed"; message: string };

let avatars: MotionCheckAvatar[] = [];

const reply = (message: ChecksWorkerReply) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<ChecksWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.kind === "load") {
      const started = performance.now();
      avatars = await Promise.all(
        request.avatars.map(async ({ id, bytes }) => ({
          id,
          vrm: await loadHeadlessVrm(bytes),
        })),
      );
      reply({ kind: "loaded", loadMs: performance.now() - started });
      return;
    }
    const started = performance.now();
    const report = checkMotion(request.clip, avatars);
    reply({ kind: "checked", checkMs: performance.now() - started, report });
  } catch (error) {
    reply({
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
