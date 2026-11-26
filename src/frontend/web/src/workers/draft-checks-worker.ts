/// <reference lib="webworker" />

/**
 * Validates and checks draft Gesture clips off the main thread
 * (`runDraftChecks`). `load` parses the Included Avatars' files once, as
 * skeletons with placeholder textures; each `check` then measures a clip on
 * them. The client is `lib/avatar/motion-authoring/draftChecksClient.ts`.
 */

import type { MotionCheckAvatar } from "@/lib/avatar/motion-authoring/checks";
import {
  runDraftChecks,
  type DraftChecksWorkerRequest,
  type DraftChecksWorkerResponse,
} from "@/lib/avatar/motion-authoring/draftChecks";
import { loadHeadlessVrm } from "@/lib/avatar/motion-authoring/headlessVrm";

const scope = self as unknown as DedicatedWorkerGlobalScope;

let avatars: MotionCheckAvatar[] = [];

async function handle(
  request: DraftChecksWorkerRequest,
): Promise<DraftChecksWorkerResponse> {
  const { requestId } = request;
  if (request.type === "load") {
    avatars = await Promise.all(
      request.avatars.map(async ({ id, bytes }) => ({
        id,
        vrm: await loadHeadlessVrm(bytes),
      })),
    );
    return { type: "loaded", requestId };
  }
  // Motion checks on no Avatar would pass what they never measured.
  if (avatars.length === 0)
    throw new Error("The Included Avatars are not loaded.");
  return {
    type: "checked",
    requestId,
    report: runDraftChecks(request.clip, avatars),
  };
}

// Requests are handled in order, so a check never starts before the load
// ahead of it has finished.
let queue: Promise<void> = Promise.resolve();
scope.addEventListener(
  "message",
  (event: MessageEvent<DraftChecksWorkerRequest>) => {
    const request = event.data;
    queue = queue.then(async () => {
      let response: DraftChecksWorkerResponse;
      try {
        response = await handle(request);
      } catch (error) {
        response = {
          type: "failed",
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      scope.postMessage(response);
    });
  },
);
