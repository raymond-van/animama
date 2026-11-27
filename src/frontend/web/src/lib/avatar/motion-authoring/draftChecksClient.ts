import { createLogger } from "@/lib/logger";
import type {
  DraftCheckReport,
  DraftChecksWorkerRequest,
  DraftChecksWorkerResponse,
} from "./draftChecks";
import { INCLUDED_AVATAR_FILES, type IncludedAvatarId } from "./headlessVrm";

/**
 * The app's side of the draft checks worker
 * (`workers/draft-checks-worker.ts`): validation and motion checks for a draft
 * Gesture clip, off the main thread, on the two Included Avatars only.
 */

const logger = createLogger("DraftChecksClient");

const INCLUDED_AVATAR_IDS = Object.keys(
  INCLUDED_AVATAR_FILES,
) as IncludedAvatarId[];

const DISPOSED = "The draft checks were disposed.";
const WORKER_FAILED = "The draft checks worker failed.";

/** Returns the bytes of an Included Avatar's VRM file. */
export type IncludedAvatarBytes = (
  id: IncludedAvatarId,
) => Promise<ArrayBuffer>;

export type DraftChecksClient = {
  /**
   * Validate `clip` and, when it loads, run the motion checks on both
   * Included Avatars. Rejects when the Avatars cannot be read, the worker
   * fails or the client is disposed; a malformed clip is a report, not a
   * rejection.
   */
  check(clip: unknown): Promise<DraftCheckReport>;
  /** Stop the worker. Checks in flight and later checks are rejected. */
  dispose(): void;
};

type PendingRequest = {
  resolve: (response: DraftChecksWorkerResponse) => void;
  reject: (error: unknown) => void;
};

/**
 * Create a client for the draft checks worker. Nothing starts until the first
 * check: that one starts the worker, reads both Included Avatars through
 * `avatarBytes` and has the worker parse them, once per worker. The files are
 * copied to the worker, so the caller may keep and reuse its buffers.
 *
 * A worker that crashes fails the checks it owed; the next check starts a new
 * worker and loads the Avatars again.
 */
export function createDraftChecksClient(
  avatarBytes: IncludedAvatarBytes,
): DraftChecksClient {
  /** The current worker, and whether it holds the Avatars (or is loading). */
  let session: { worker: Worker; loaded: Promise<void> | null } | null = null;
  let disposed = false;
  let requestCount = 0;
  // Only the current worker has requests outstanding.
  const pending = new Map<number, PendingRequest>();

  /** Forget `worker` if it is still current: stop it and fail what it owed. */
  const endWorker = (worker: Worker, reason: string) => {
    if (session?.worker !== worker) return;
    session = null;
    worker.terminate();
    for (const { reject } of pending.values()) reject(new Error(reason));
    pending.clear();
  };

  const assertCurrent = (worker: Worker) => {
    if (session?.worker !== worker)
      throw new Error(disposed ? DISPOSED : WORKER_FAILED);
  };

  const startWorker = (): Worker => {
    const worker = new Worker(
      new URL("../../../workers/draft-checks-worker.ts", import.meta.url),
      { type: "module", name: "draft-checks-worker" },
    );
    worker.addEventListener(
      "message",
      (event: MessageEvent<DraftChecksWorkerResponse>) => {
        const response = event.data;
        const request = pending.get(response.requestId);
        if (!request) return;
        pending.delete(response.requestId);
        if (response.type === "failed")
          request.reject(new Error(response.message));
        else request.resolve(response);
      },
    );
    // A worker that fails to start or crashes never answers.
    worker.addEventListener("error", (event) => {
      logger.error("Worker", "Draft checks worker error", {
        message: event.message,
      });
      endWorker(worker, WORKER_FAILED);
    });
    worker.addEventListener("messageerror", () => {
      logger.error("Worker", "Draft checks worker message error");
      endWorker(worker, WORKER_FAILED);
    });
    return worker;
  };

  const ask = (
    worker: Worker,
    request: (requestId: number) => DraftChecksWorkerRequest,
  ) =>
    new Promise<DraftChecksWorkerResponse>((resolve, reject) => {
      requestCount += 1;
      const requestId = requestCount;
      pending.set(requestId, { resolve, reject });
      try {
        worker.postMessage(request(requestId));
      } catch (error) {
        // A value that cannot be cloned never reaches the worker.
        pending.delete(requestId);
        reject(error);
      }
    });

  const loadAvatars = async (worker: Worker): Promise<void> => {
    const avatars = await Promise.all(
      INCLUDED_AVATAR_IDS.map(async (id) => ({
        id,
        bytes: await avatarBytes(id),
      })),
    );
    // The worker may have ended while the files were read.
    assertCurrent(worker);
    await ask(worker, (requestId) => ({ type: "load", requestId, avatars }));
  };

  /** The current worker, once it holds both Included Avatars. */
  const readyWorker = async (): Promise<Worker> => {
    if (typeof Worker === "undefined")
      throw new Error("Draft checks need Web Workers, which are unavailable.");
    session ??= { worker: startWorker(), loaded: null };
    const current = session;
    current.loaded ??= loadAvatars(current.worker).catch((error: unknown) => {
      // The next check reads and loads the Avatars again.
      current.loaded = null;
      throw error;
    });
    await current.loaded;
    assertCurrent(current.worker);
    return current.worker;
  };

  return {
    async check(clip) {
      if (disposed) throw new Error(DISPOSED);
      const worker = await readyWorker();
      const response = await ask(worker, (requestId) => ({
        type: "check",
        requestId,
        clip,
      }));
      if (response.type !== "checked") throw new Error(WORKER_FAILED);
      return response.report;
    },
    dispose() {
      disposed = true;
      if (session) endWorker(session.worker, DISPOSED);
    },
  };
}
