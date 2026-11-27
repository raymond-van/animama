import { useProductApiClient } from "@animama/product-ui";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  recordGenerationCheckReportV1GenerationDraftsDraftIdCheckReportPut,
  uploadGenerationReviewFramesV1GenerationDraftsDraftIdReviewFramesPut,
} from "@animama/runtime-contracts/sdk";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import type { DraftCheckReport } from "@/lib/avatar/motion-authoring/draftChecks";
import type { AnimaPoseClipV2 } from "@/lib/avatar/poses/animaPoseClip";
import {
  createDraftChecksClient,
  type DraftChecksClient,
  type IncludedAvatarBytes,
} from "@/lib/avatar/motion-authoring/draftChecksClient";
import {
  avatarOnlyExpressionNames,
  missingExpressionNames,
} from "@/lib/avatar/motion-authoring/expressionInventory";
import {
  validateClip,
  type ClipIssue,
} from "@/lib/avatar/motion-authoring/validateClip";
import { readApiError } from "@/lib/errors/apiError";
import { createLogger } from "@/lib/logger";
import { isRecord } from "@/lib/records";
import { writeGenerationDraft } from "@/query/hooks/useGeneration";
import {
  clearGenerationFramesRequest,
  useGenerationFramesRequest,
  useGenerationRunning,
} from "@/stores/generation-store";
import { buildCheckReport } from "./checkReport";
import {
  draftAwaitsCheck,
  draftLeftUnchecked,
  draftSequence,
} from "./generationDrafts";
import { parseGenerationDraft } from "./generationStream";
import { createIncludedAvatarFiles } from "./includedAvatarFiles";
import {
  reviewSheetTimes,
  usePreviewSheetRenderer,
} from "./previewSheetRenderer";

const logger = createLogger("GenerationDrafts");

/**
 * How long a check waits for the chosen preview Avatar to load, so the report
 * can say which keyed expression names that Avatar would not show. A run
 * waits two minutes for a report, so this leaves the checks ample time.
 */
export const AVATAR_NAMES_WAIT_MS = 10_000;

/** The largest review sheet the backend takes (`MAX_REVIEW_SHEET_BYTES` in `review_frames.py`). */
const MAX_REVIEW_SHEET_BYTES = 4 * 1024 * 1024;

/**
 * The page's own validation of one draft version. Only a draft whose
 * `sequence` is set may be played or saved: this, never the stored report,
 * decides what reaches the preview (threat T1).
 */
export type DraftValidation = {
  version: number;
  /** Whether the app can load and play the clip. */
  loadable: boolean;
  /** The clip to hand to the preview, or `null` when it must not be played. */
  sequence: Record<string, unknown> | null;
  /** Structure, anatomical limit and size problems, by JSON path. */
  issues: ClipIssue[];
};

/** Why a draft version's checks did not reach the backend. */
export type DraftCheckFailure = {
  version: number;
  /**
   * `checks_unavailable`: the motion checks could not run (the Included
   * Avatars could not be read, or the checks worker failed).
   * `report_failed`: the report could not be sent or was refused; `code` is
   * the backend's refusal code when it gave one.
   */
  kind: "checks_unavailable" | "report_failed";
  code: string | null;
};

/**
 * Where the review sheets of the run in flight stand. `unavailable`: the run
 * asked for sheets but no preview canvas is mounted to draw them, so the
 * review will be skipped unless one appears. `failed`: drawing or uploading
 * them failed.
 */
export type DraftFramesStatus = "idle" | "rendering" | "unavailable" | "failed";

export type DraftWorker = {
  /** Each draft's validation at its current version, by draft id. */
  validations: Readonly<Record<string, DraftValidation>>;
  /** The draft whose checks are running now. */
  checkingDraftId: string | null;
  /** Checks that did not reach the backend, by draft id, until retried or superseded. */
  failures: Readonly<Record<string, DraftCheckFailure>>;
  /** Run a failed draft's checks again. */
  retryCheck: (draftId: string) => void;
  frames: { status: DraftFramesStatus; draftId: string | null };
};

/** Validate a draft's clip as the page will play it. Never throws. */
export function validateDraft(
  draft: Pick<PyGenerationDraft, "version" | "project">,
): DraftValidation {
  const sequence = draftSequence(draft);
  const validation = validateClip(sequence);
  const loadable = validation.loadable && isRecord(sequence);
  return {
    version: draft.version,
    loadable,
    sequence: loadable ? (sequence as Record<string, unknown>) : null,
    issues: validation.issues,
  };
}

/**
 * The keyed expression names of a clip that will not show everywhere, judged
 * against the chosen preview Avatar's names: those it lacks, and those it has
 * that other Avatars may lack.
 */
export function draftExpressionNames(
  sequence: Record<string, unknown>,
  avatarNames: readonly string[],
): { missing: string[]; avatarOnly: string[] } {
  const clip = {
    expressions: (isRecord(sequence.expressions)
      ? sequence.expressions
      : {}) as AnimaPoseClipV2["expressions"],
  };
  const available = new Set(avatarNames);
  const supports = (name: string) => available.has(name);
  return {
    missing: missingExpressionNames(clip, supports),
    avatarOnly: avatarOnlyExpressionNames(clip, supports),
  };
}

type FramesAttempt = { key: string; status: DraftFramesStatus };

/**
 * The page's side of a run: validates every draft, checks the ones the
 * backend waits on, and draws review sheets when a run asks.
 *
 * - Every draft's current version is validated here. A clip that does not
 *   load is reported as such and never handed to the preview.
 * - A draft left `checking` at a version nobody checked gets the motion
 *   checks on the two Included Avatars (in a worker, one draft at a time),
 *   the keyed expression names the chosen preview Avatar would not show, and
 *   one report to the backend. That holds during a run, after a restore, and
 *   after a reload for a draft a stopped run left unchecked. Each version is
 *   checked once; a failure is kept for `retryCheck` instead of looping.
 * - A version a run stopped waiting for (its stored report says only "not
 *   checked") is checked the same way once no run is in flight on the
 *   conversation, so the report replaces that placeholder.
 * - When the run in flight requests review sheets, they are drawn on the
 *   preview's renderer and uploaded, only then and only while a preview
 *   canvas has registered its renderer. A Gesture's sheets show the body and
 *   the face; a Reaction's show the face only.
 *
 * The checks worker is stopped on unmount and when the runtime session is
 * replaced.
 */
export function useDraftWorker(input: {
  conversationId: string | null;
  drafts: readonly PyGenerationDraft[];
  /**
   * The chosen preview Avatar's expression names, as
   * `getAvailableExpressions` lists them. `undefined` while that Avatar is
   * loading (a check waits a little for it); `null` when no Avatar can be
   * shown (names are then not compared).
   */
  avatarExpressionNames: readonly string[] | null | undefined;
}): DraftWorker {
  const { conversationId, drafts, avatarExpressionNames } = input;
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const ownerKey = useRuntimeCacheKey() ?? "__anon__";
  const framesRequest = useGenerationFramesRequest(conversationId);
  const running = useGenerationRunning(conversationId);
  const renderSheets = usePreviewSheetRenderer();

  // --- Validation ----------------------------------------------------------
  const validated = useRef(
    new Map<string, { project: unknown; validation: DraftValidation }>(),
  );
  const validations = useMemo(() => {
    const cache = validated.current;
    const next: Record<string, DraftValidation> = {};
    for (const draft of drafts) {
      if (draft.project === null) continue;
      const known = cache.get(draft.id);
      const entry =
        known &&
        known.validation.version === draft.version &&
        known.project === draft.project
          ? known
          : { project: draft.project, validation: validateDraft(draft) };
      cache.set(draft.id, entry);
      next[draft.id] = entry.validation;
    }
    for (const id of cache.keys()) if (!(id in next)) cache.delete(id);
    return next;
  }, [drafts]);

  // --- The checks worker and the Included Avatars ---------------------------
  const tools = useRef<{
    avatarBytes: IncludedAvatarBytes;
    checks: DraftChecksClient;
  } | null>(null);
  useEffect(() => {
    const avatarBytes = createIncludedAvatarFiles(apiClient);
    const created = {
      avatarBytes,
      checks: createDraftChecksClient(avatarBytes),
    };
    tools.current = created;
    return () => {
      // A new session gets a new API client: its worker starts afresh.
      created.checks.dispose();
      if (tools.current === created) tools.current = null;
    };
  }, [apiClient]);

  // --- Checks -----------------------------------------------------------------
  /** The version of each draft whose check was started, so each runs once. */
  const attempted = useRef(new Map<string, number>());
  const namesRef = useRef(avatarExpressionNames);
  namesRef.current = avatarExpressionNames;
  /** Wakes a check that waits for the preview Avatar's names. */
  const namesArrived = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (avatarExpressionNames !== undefined) namesArrived.current?.();
  }, [avatarExpressionNames]);
  const [checkingDraftId, setCheckingDraftId] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, DraftCheckFailure>>(
    {},
  );
  /** Bumped to look for the next draft once a check ends or a retry is asked. */
  const [turn, setTurn] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      namesArrived.current?.();
    };
  }, []);

  const checkDraft = useCallback(
    async (
      draft: PyGenerationDraft,
      validation: DraftValidation,
    ): Promise<DraftCheckFailure | null> => {
      const failure = (
        kind: DraftCheckFailure["kind"],
        code: string | null = null,
      ): DraftCheckFailure => ({ version: draft.version, kind, code });
      let checks: Pick<DraftCheckReport, "loadable" | "issues" | "findings">;
      if (validation.sequence) {
        for (;;) {
          const client = tools.current?.checks;
          if (!client) return failure("checks_unavailable");
          try {
            checks = await client.check(validation.sequence);
            break;
          } catch {
            // The worker was replaced under this check (a new session, or
            // development's replayed effects): ask the one that replaced it.
            const replacement = tools.current?.checks;
            if (replacement && replacement !== client) continue;
            // The error's text may quote the clip; only the outcome is logged.
            logger.warn("Checks", "Draft checks could not run", {
              draftId: draft.id,
              version: draft.version,
            });
            return failure("checks_unavailable");
          }
        }
      } else {
        // A clip that does not load is not measured: the validation says why.
        checks = { loadable: false, issues: validation.issues, findings: [] };
      }

      if (checks.loadable && namesRef.current === undefined)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, AVATAR_NAMES_WAIT_MS);
          namesArrived.current = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      namesArrived.current = null;
      if (!mounted.current) return null;
      const avatarNames = namesRef.current;
      const { body, dropped } = buildCheckReport({
        version: draft.version,
        checks,
        expressionNames:
          checks.loadable && validation.sequence && avatarNames
            ? draftExpressionNames(validation.sequence, avatarNames)
            : undefined,
      });
      const counts = {
        draftId: draft.id,
        version: draft.version,
        loadable: body.loadable,
        issues: body.issues?.length ?? 0,
        findings: body.findings?.length ?? 0,
        missingNames: body.expression_names?.missing?.length ?? 0,
        avatarOnlyNames: body.expression_names?.avatar_only?.length ?? 0,
        namesCompared: Boolean(avatarNames),
        droppedIssues: dropped.issues,
        droppedFindings: dropped.findings,
        droppedNames: dropped.names,
      };
      try {
        const { data } =
          await recordGenerationCheckReportV1GenerationDraftsDraftIdCheckReportPut(
            {
              client: apiClient,
              path: { draft_id: draft.id },
              body,
              responseValidator: undefined,
              throwOnError: true,
            },
          );
        const stored = parseGenerationDraft(data);
        if (stored) writeGenerationDraft(queryClient, ownerKey, stored);
        logger.info("Checks", "Draft check report stored", counts);
        return null;
      } catch (error) {
        const code = readApiError(error).code;
        // The draft moved on to another version; that one is checked instead.
        if (code === "generation_stale_version") return null;
        // Logged once, with counts and never the report's text. A refused
        // report is not sent again: the same report would be refused again.
        logger.warn("Checks", "Draft check report was not stored", {
          ...counts,
          code,
        });
        return failure("report_failed", code);
      }
    },
    [apiClient, ownerKey, queryClient],
  );

  useEffect(() => {
    if (checkingDraftId !== null) return;
    const next = drafts.find(
      (draft) =>
        // A version left unchecked waits for the run to end: until then its
        // checks are the run's to ask for.
        (draftAwaitsCheck(draft) || (!running && draftLeftUnchecked(draft))) &&
        attempted.current.get(draft.id) !== draft.version &&
        validations[draft.id]?.version === draft.version,
    );
    if (!next) return;
    attempted.current.set(next.id, next.version);
    setCheckingDraftId(next.id);
    // A failure of an earlier version no longer describes the draft.
    setFailures((current) =>
      next.id in current
        ? Object.fromEntries(
            Object.entries(current).filter(([id]) => id !== next.id),
          )
        : current,
    );
    void checkDraft(next, validations[next.id]!).then((failed) => {
      if (!mounted.current) return;
      if (failed) setFailures((current) => ({ ...current, [next.id]: failed }));
      setCheckingDraftId(null);
      setTurn((value) => value + 1);
    });
  }, [checkDraft, checkingDraftId, drafts, running, turn, validations]);

  const retryCheck = useCallback((draftId: string) => {
    attempted.current.delete(draftId);
    setFailures((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== draftId),
      ),
    );
    setTurn((value) => value + 1);
  }, []);

  // --- Review sheets ----------------------------------------------------------
  const [framesAttempt, setFramesAttempt] = useState<FramesAttempt | null>(
    null,
  );
  const framesKey = framesRequest
    ? `${framesRequest.draftId}:${framesRequest.version}`
    : null;
  const framesSequence =
    framesRequest &&
    validations[framesRequest.draftId]?.version === framesRequest.version
      ? validations[framesRequest.draftId]!.sequence
      : null;
  // A Reaction moves no body: its sheets hold face views only.
  const framesView =
    framesRequest &&
    drafts.find(({ id }) => id === framesRequest.draftId)?.intent === "reaction"
      ? "face"
      : "body";
  useEffect(() => {
    if (!framesRequest || !framesKey || !conversationId) return;
    // Each request is answered once, and only with a clip this page validated.
    if (framesAttempt?.key === framesKey || !framesSequence || !renderSheets)
      return;
    const avatarBytes = tools.current?.avatarBytes;
    if (!avatarBytes) return;
    setFramesAttempt({ key: framesKey, status: "rendering" });
    const request = framesRequest;
    void (async () => {
      let status: DraftFramesStatus = "idle";
      try {
        const sheets = await renderSheets({
          clip: framesSequence,
          times: reviewSheetTimes(framesSequence),
          avatarFile: avatarBytes,
          view: framesView,
        });
        const frames = sheets
          .filter(
            ({ blob }) => blob.size > 0 && blob.size <= MAX_REVIEW_SHEET_BYTES,
          )
          .map(
            ({ avatar, blob }) =>
              new File(
                [blob],
                `${avatar}.${blob.type === "image/png" ? "png" : "jpg"}`,
                { type: blob.type },
              ),
          );
        if (frames.length === 0) throw new Error("No sheet could be sent.");
        await uploadGenerationReviewFramesV1GenerationDraftsDraftIdReviewFramesPut(
          {
            client: apiClient,
            path: { draft_id: request.draftId },
            query: { version: request.version },
            body: { frames },
            // The generated validator expects text where the route takes files.
            requestValidator: undefined,
            responseValidator: undefined,
            throwOnError: true,
          },
        );
        logger.info("Frames", "Review sheets uploaded", {
          draftId: request.draftId,
          version: request.version,
          sheets: frames.length,
          bytes: frames.reduce((total, frame) => total + frame.size, 0),
        });
        clearGenerationFramesRequest(conversationId, request);
      } catch (error) {
        status = "failed";
        // The run skips its review when no sheets arrive; nothing is retried.
        logger.warn("Frames", "Review sheets were not uploaded", {
          draftId: request.draftId,
          version: request.version,
          code: readApiError(error).code,
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
      if (mounted.current) setFramesAttempt({ key: framesKey, status });
    })();
  }, [
    apiClient,
    conversationId,
    framesAttempt?.key,
    framesKey,
    framesRequest,
    framesSequence,
    framesView,
    renderSheets,
  ]);

  const frames = useMemo<DraftWorker["frames"]>(() => {
    if (!framesRequest || !framesKey) return { status: "idle", draftId: null };
    const { draftId } = framesRequest;
    if (framesAttempt?.key === framesKey)
      return { status: framesAttempt.status, draftId };
    return { status: renderSheets ? "idle" : "unavailable", draftId };
  }, [framesAttempt, framesKey, framesRequest, renderSheets]);

  return { validations, checkingDraftId, failures, retryCheck, frames };
}
