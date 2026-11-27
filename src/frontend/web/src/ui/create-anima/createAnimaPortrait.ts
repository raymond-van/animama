import { useEffect } from "react";

import type {
  ItemRevisionRef,
  PyAvatarContent,
} from "@animama/runtime-contracts/api-types";
import { AvatarPortraitCaptureError } from "@/lib/avatar/portrait/captureAvatarPortrait";
import { AvatarPortraitGenerationCoordinator } from "@/lib/avatar/portrait/generationCoordinator";
import { portraitRetakeTarget } from "@/lib/avatar/portrait/retakeTarget";
import { createLogger } from "@/lib/logger";

const log = createLogger("CreateAnimaPortrait");

/** Create Anima abandons a portrait capture and save after this long. */
export const CREATION_PORTRAIT_TIMEOUT_MS = 15_000;

/**
 * The selected Avatar revision that needs a portrait, or null: never an
 * unsaved upload, otherwise the shared rule in `portraitRetakeTarget`.
 */
export function creationPortraitTarget({
  selected,
  file,
  avatars,
}: {
  selected: ItemRevisionRef | null;
  file: File | null;
  avatars: readonly PyAvatarContent[];
}): ItemRevisionRef | null {
  return file ? null : portraitRetakeTarget(selected, avatars);
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof AvatarPortraitCaptureError && error.code === "aborted")
  );
}

export type CreationPortraitOutcome =
  | "saved"
  | "skipped"
  | "failed"
  | "aborted";

/**
 * One background portrait attempt per Avatar revision per page session. A
 * failure or timeout is not retried until the next session; an attempt the
 * stage abandoned (source change, unmount, hidden page) may run again.
 */
export class CreationPortraits {
  private readonly coordinator = new AvatarPortraitGenerationCoordinator();
  private readonly failed = new Set<string>();

  /** Capture and save the target's portrait; never throws. */
  async generate({
    target,
    capture,
    save,
    signal,
  }: {
    target: ItemRevisionRef;
    capture: (signal: AbortSignal) => Promise<Blob>;
    save: (
      target: ItemRevisionRef,
      blob: Blob,
      signal: AbortSignal,
    ) => Promise<void>;
    signal: AbortSignal;
  }): Promise<CreationPortraitOutcome> {
    const key = `${target.item_id}:${target.revision_sha256}`;
    if (this.failed.has(key)) return "skipped";
    const timeout = new AbortController();
    const timer = setTimeout(
      () =>
        timeout.abort(new DOMException("Portrait timed out.", "TimeoutError")),
      CREATION_PORTRAIT_TIMEOUT_MS,
    );
    try {
      const result = await this.coordinator.run({
        key,
        signal: AbortSignal.any([signal, timeout.signal]),
        operation: async (operationSignal) => {
          const blob = await capture(operationSignal);
          await save(target, blob, operationSignal);
        },
      });
      return result.status === "completed" ? "saved" : "skipped";
    } catch (error) {
      // An abort that is not the timeout, including one inherited from an
      // attempt that was abandoned just before, is not a failure.
      if (signal.aborted || (!timeout.signal.aborted && isAbort(error)))
        return "aborted";
      this.failed.add(key);
      log.warn("portrait", "Avatar portrait was not saved", {
        itemId: target.item_id,
        error,
      });
      return "failed";
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The page session's portrait attempts, shared by every Create Anima stage. */
export const creationPortraits = new CreationPortraits();

/**
 * Give the shown Local Avatar a portrait in the background once it is on the
 * stage (`ready`) and `target` names its revision. It never blocks the flow;
 * a source change, unmount or hidden page abandons the attempt.
 */
export function useCreationPortraitCapture({
  ready,
  source,
  target,
  capture,
  save,
  portraits = creationPortraits,
}: {
  ready: boolean;
  source: ItemRevisionRef | null;
  target: ItemRevisionRef | null;
  capture: (signal: AbortSignal) => Promise<Blob>;
  save?: (
    target: ItemRevisionRef,
    blob: Blob,
    signal: AbortSignal,
  ) => Promise<void>;
  portraits?: CreationPortraits;
}): void {
  const targetItem = target?.item_id;
  const targetRevision = target?.revision_sha256;
  const shown =
    ready &&
    targetItem !== undefined &&
    source?.item_id === targetItem &&
    source.revision_sha256 === targetRevision;
  useEffect(() => {
    if (!shown || !save || !targetItem || !targetRevision) return;
    const controller = new AbortController();
    let started = false;
    const start = () => {
      started = true;
      void portraits.generate({
        target: { item_id: targetItem, revision_sha256: targetRevision },
        capture,
        save,
        signal: controller.signal,
      });
    };
    // A hidden page waits to start; hiding it later abandons the attempt.
    const visibility = () => {
      if (!started && !document.hidden) start();
      else if (started && document.hidden) controller.abort();
    };
    document.addEventListener("visibilitychange", visibility);
    if (!document.hidden) start();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      controller.abort();
    };
  }, [capture, portraits, save, shown, targetItem, targetRevision]);
}
