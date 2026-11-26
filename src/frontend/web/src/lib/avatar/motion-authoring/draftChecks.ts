import {
  checkMotion,
  type MotionCheckAvatar,
  type MotionCheckFinding,
} from "./checks";
import type { IncludedAvatarId } from "./headlessVrm";
import { validateClip, type ClipIssue } from "./validateClip";

/**
 * The checks the app runs on a draft Gesture clip: the authoring validation
 * `pnpm animation validate` runs, then the motion checks `pnpm animation
 * check` runs. The app runs them in a worker (`draftChecksClient.ts`), since a
 * check blocks its thread for up to a few hundred milliseconds.
 */

/**
 * What the checks found in one draft. Plain data, so it crosses a worker
 * boundary and can be sent to the backend as it is.
 */
export type DraftCheckReport = {
  /**
   * Nothing to repair: no validation issue and no failed motion check.
   * Warnings do not count.
   */
  ok: boolean;
  /**
   * Whether the app can load and play the clip. The motion checks run only on
   * a clip that loads.
   */
  loadable: boolean;
  /** Validation problems by JSON path: structure, anatomical limits, size. */
  issues: ClipIssue[];
  /** Motion check findings; empty for a clip that does not load. */
  findings: MotionCheckFinding[];
};

/**
 * Validate `clip` and, when it loads, run the motion checks on `avatars`. A
 * clip that only exceeds anatomical limits still loads, so it gets both its
 * validation issues and its findings. Never throws on a malformed clip.
 */
export function runDraftChecks(
  clip: unknown,
  avatars: readonly MotionCheckAvatar[],
): DraftCheckReport {
  const validation = validateClip(clip);
  if (!validation.loadable)
    return {
      ok: false,
      loadable: false,
      issues: validation.issues,
      findings: [],
    };
  const motion = checkMotion(clip, avatars);
  return {
    ok: validation.ok && motion.ok,
    loadable: true,
    issues: validation.issues,
    findings: motion.findings,
  };
}

/** Messages to the draft checks worker (`workers/draft-checks-worker.ts`). */
export type DraftChecksWorkerRequest =
  /** Parse the Included Avatars' files; sent once, before the first check. */
  | {
      type: "load";
      requestId: number;
      avatars: { id: IncludedAvatarId; bytes: ArrayBuffer }[];
    }
  | { type: "check"; requestId: number; clip: unknown };

/** The worker's answer to the request with the same `requestId`. */
export type DraftChecksWorkerResponse =
  | { type: "loaded"; requestId: number }
  | { type: "checked"; requestId: number; report: DraftCheckReport }
  | { type: "failed"; requestId: number; message: string };
