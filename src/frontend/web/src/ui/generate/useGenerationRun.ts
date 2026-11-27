import { useProductApiClient } from "@animama/product-ui";
import { activeUiLocale } from "@animama/product-ui/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  PyGenerationAnswer,
  PyGenerationRunRequest,
} from "@animama/runtime-contracts/api-types";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { groupExpressionNames } from "@/lib/avatar/motion-authoring/expressionInventory";
import { createLogger } from "@/lib/logger";
import {
  refreshGenerationConversation,
  useGenerationConversation,
  writeGenerationDraft,
} from "@/query/hooks/useGeneration";
import {
  applyGenerationRunEvent,
  beginGenerationRun,
  clearGenerationPendingTurn,
  dismissGenerationFailure,
  endGenerationRun,
  generationRunState,
  useGenerationRunState,
  type GenerationRunFailure,
  type GenerationRunRequest,
  type GenerationRunState,
} from "@/stores/generation-store";
import {
  pendingGenerationQuestions,
  type PendingGenerationQuestions,
} from "./generationDrafts";
import {
  GenerationRunHttpError,
  streamGenerationRun,
} from "./generationStream";

const logger = createLogger("GenerationRun");

/** The longest request the backend takes, in characters. */
export const MAX_GENERATION_MESSAGE_LENGTH = 4000;
/** The longest answer to one question, and how many answers a run takes. */
export const MAX_GENERATION_ANSWER_LENGTH = 1000;
export const MAX_GENERATION_ANSWERS = 4;

/** A run that ended without the server's last frame. */
export const GENERATION_STREAM_INTERRUPTED = "generation_stream_interrupted";
/** A run request that got no usable answer. */
export const GENERATION_REQUEST_FAILED = "generation_request_failed";

/**
 * After a run ends without the server's last frame, the server may still be
 * settling its draft and storing the assistant's turn (it bounds that at five
 * seconds). The conversation is read again at these delays to pick it up.
 */
const SETTLE_REFRESH_DELAYS_MS = [1_500, 6_000];

/**
 * The body of a run request. Of the chosen preview Avatar only its expression
 * names are sent, grouped by family and bounded as
 * `groupExpressionNames` does; families without a name are left out.
 */
export function generationRunBody(input: {
  request: GenerationRunRequest;
  modelProviderId: string;
  /** The level chosen for the model; none leaves the model's own default. */
  reasoningEffort?: string | null;
  uiLocale?: string | null;
  avatarExpressionNames?: readonly string[] | null;
  /** The names that count as ARKit shapes; the canonical 52 by default. */
  arkitNames?: Iterable<string>;
  /**
   * The item open in a creator, as an `animamaActionProject/1.0` project: the
   * run revises it instead of a stored draft. Only a creator's conversation
   * sends one.
   */
  document?: Record<string, unknown> | null;
}): PyGenerationRunRequest {
  const { request } = input;
  const families = input.avatarExpressionNames
    ? Object.fromEntries(
        Object.entries(
          groupExpressionNames(input.avatarExpressionNames, input.arkitNames)
            .families,
        ).filter(([, names]) => names.length > 0),
      )
    : null;
  return {
    message: request.message,
    model_provider_id: input.modelProviderId,
    ...(input.reasoningEffort
      ? { reasoning_effort: input.reasoningEffort }
      : {}),
    ...(request.draftId ? { draft_id: request.draftId } : {}),
    // A revision takes its draft's own kind; a new draft is the kind asked for.
    intent: request.intent ?? "gesture",
    ...(input.uiLocale ? { ui_locale: input.uiLocale } : {}),
    ...(request.answers ? { answers: request.answers } : {}),
    ...(families && Object.keys(families).length > 0
      ? { avatar_expressions: families }
      : {}),
    ...(input.document ? { document: input.document } : {}),
  };
}

/**
 * The answers a run sends: at most four, each with its question, cut to the
 * lengths the backend takes. Without a usable answer the questions count as
 * skipped.
 */
export function generationAnswers(
  answers: readonly PyGenerationAnswer[] | null,
): NonNullable<GenerationRunRequest["answers"]> {
  const given = (answers ?? [])
    .map(({ question, answer }) => ({
      question: question.trim().slice(0, 300),
      answer: answer.trim().slice(0, MAX_GENERATION_ANSWER_LENGTH),
    }))
    .filter(({ question, answer }) => question && answer)
    .slice(0, MAX_GENERATION_ANSWERS);
  return given.length > 0 ? { answers: given } : { skipped: true };
}

function requestFailure(
  error: unknown,
  request: GenerationRunRequest,
): GenerationRunFailure {
  const refused = error instanceof GenerationRunHttpError ? error : null;
  return {
    code: refused?.code ?? GENERATION_REQUEST_FAILED,
    category: "request",
    reason: refused?.reason ?? null,
    details: {},
    status: refused?.status ?? null,
    // `fetch` rejects with a TypeError when the connection itself fails.
    network: error instanceof TypeError,
    request,
  };
}

export type GenerationRunController = {
  /** What the run in flight is doing, and what the last one left. */
  run: GenerationRunState;
  /**
   * Questions waiting for an answer: from the run that just asked, or from
   * the stored conversation after a reload.
   */
  questions: PendingGenerationQuestions | null;
  /**
   * Send a request: a new draft, or a revision of `draftId`. Resolves `true`
   * once the run has ended (however it ended) and `false` when it was not
   * started: no conversation or model, a blank or over-long message, or a
   * run already in flight on the conversation.
   */
  send: (
    message: string,
    options?: {
      draftId?: string | null;
      /** The kind of a new draft; a Gesture when left out. */
      intent?: "gesture" | "reaction";
    },
  ) => Promise<boolean>;
  /** Answer the pending questions, or skip them with `null`. */
  answer: (answers: readonly PyGenerationAnswer[] | null) => Promise<boolean>;
  /** Send the failed request again. */
  retry: () => Promise<boolean>;
  /** Stop the run in flight. Drafts stored so far stay. */
  stop: () => void;
  dismissFailure: () => void;
};

/**
 * Start, follow and stop the assistant's runs on one conversation.
 *
 * A run is one streamed request. Its events update the run state
 * (`stores/generation-store.ts`) and write drafts into the conversation's
 * cached snapshot; when it ends, the conversation is read again for the turns
 * the server stored. Stop closes the request, which is how the backend learns
 * of it. Leaving the page or switching conversation stops the run too: the
 * page's checks, which a run waits for, stop with it.
 *
 * `modelProviderId`, `reasoningEffort` and `avatarExpressionNames` are read
 * when a run starts, so they may change between runs: a retry and an answer
 * to the assistant's questions go out with the model and level chosen then.
 */
export function useGenerationRun(input: {
  conversationId: string | null;
  /** The assistant's chosen model. */
  modelProviderId: string | null;
  /** The reasoning effort chosen for that model, or `null` for its default. */
  reasoningEffort?: string | null;
  /** The chosen preview Avatar's expression names, or `null` without one. */
  avatarExpressionNames?: readonly string[] | null;
  /** The names that count as ARKit shapes on that Avatar. */
  arkitNames?: Iterable<string>;
  /**
   * What a creator's run starts from, read when the run starts (so a retry
   * and an answer to questions send the item as it stands then): the item
   * open in the creator as a project, or `null` for an empty one, and the
   * conversation's draft the result is stored into. Returning `false` keeps
   * the run from starting. The Generate page passes none.
   */
  creatorSource?: () =>
    | { document: Record<string, unknown> | null; draftId: string | null }
    | false;
}): GenerationRunController {
  const { conversationId } = input;
  const apiClient = useProductApiClient();
  const queryClient = useQueryClient();
  const ownerKey = useRuntimeCacheKey() ?? "__anon__";
  const run = useGenerationRunState(conversationId);
  const snapshot = useGenerationConversation(conversationId).data;
  const inputRef = useRef(input);
  inputRef.current = input;
  const active = useRef<{
    conversationId: string;
    controller: AbortController;
  } | null>(null);
  const mounted = useRef(true);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    mounted.current = true;
    const pending = timers.current;
    return () => {
      mounted.current = false;
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  // A run belongs to the conversation on screen: leaving it stops the run.
  useEffect(
    () => () => {
      if (active.current?.conversationId === conversationId)
        active.current.controller.abort();
    },
    [conversationId],
  );

  const start = useCallback(
    async (asked: GenerationRunRequest): Promise<boolean> => {
      const { conversationId, modelProviderId, reasoningEffort, ...avatar } =
        inputRef.current;
      if (!conversationId || !modelProviderId) return false;
      if (
        !asked.message.trim() ||
        asked.message.length > MAX_GENERATION_MESSAGE_LENGTH
      )
        return false;
      // A creator's run revises the item as it stands now, into the
      // conversation's own draft.
      const source = avatar.creatorSource?.();
      if (source === false) return false;
      const request = source ? { ...asked, draftId: source.draftId } : asked;
      if (!beginGenerationRun(conversationId, request)) return false;
      // The late reads of the run before would land in this one, where a
      // read can put back an older draft than the stream has delivered.
      for (const timer of timers.current) clearTimeout(timer);
      timers.current.clear();

      const controller = new AbortController();
      active.current = { conversationId, controller };
      let completed = false;
      let events = 0;
      let failure: GenerationRunFailure | null = null;
      // Ids and flags only: the request's words are never logged.
      logger.milestone("Run", "Generation run started", {
        conversationId,
        revises: Boolean(request.draftId),
        answers: Boolean(request.answers),
      });
      try {
        const stream = streamGenerationRun(apiClient, {
          conversationId,
          body: generationRunBody({
            request,
            modelProviderId,
            reasoningEffort,
            uiLocale: activeUiLocale(),
            avatarExpressionNames: avatar.avatarExpressionNames,
            arkitNames: avatar.arkitNames,
            document: source ? source.document : null,
          }),
          signal: controller.signal,
        });
        for await (const event of stream) {
          events += 1;
          if (
            event.type === "draft.updated" &&
            !writeGenerationDraft(queryClient, ownerKey, event.draft)
          )
            // The conversation was not read yet: read it, so the page's
            // checks, which the run waits for, see the draft.
            void refreshGenerationConversation(
              queryClient,
              ownerKey,
              conversationId,
            ).catch(() => undefined);
          applyGenerationRunEvent(conversationId, event, request);
          if (event.type === "run.completed") {
            completed = true;
            break;
          }
        }
        // A failure the stream reported itself says more than its early end.
        if (
          !completed &&
          !controller.signal.aborted &&
          !generationRunState(conversationId).failure
        )
          failure = {
            ...requestFailure(null, request),
            code: GENERATION_STREAM_INTERRUPTED,
          };
      } catch (error) {
        // A failure the run reported itself is not replaced by the broken
        // connection that followed it.
        if (
          !controller.signal.aborted &&
          !generationRunState(conversationId).failure
        ) {
          failure = requestFailure(error, request);
          // Once the stream had begun the request did reach the assistant:
          // the connection was lost while it worked.
          if (events > 0 && !(error instanceof GenerationRunHttpError))
            failure.code = GENERATION_STREAM_INTERRUPTED;
        }
      }

      const stopped = controller.signal.aborted && !completed;
      // A terminal frame can precede the transport's end: release the request.
      controller.abort();
      if (active.current?.controller === controller) active.current = null;
      endGenerationRun(conversationId, { stopped, failure });
      const failed = failure ?? generationRunState(conversationId).failure;
      logger.milestone(
        "Run",
        `Generation run ended (${failed ? "failed" : stopped ? "stopped" : "completed"})`,
        { conversationId, events, code: failed?.code, status: failed?.status },
      );

      const refresh = () =>
        refreshGenerationConversation(
          queryClient,
          ownerKey,
          conversationId,
        ).catch(() => undefined);
      if (mounted.current) {
        await refresh();
        if (!completed)
          for (const delay of SETTLE_REFRESH_DELAYS_MS) {
            const timer = setTimeout(() => {
              timers.current.delete(timer);
              void refresh();
            }, delay);
            timers.current.add(timer);
          }
      }
      // The stored conversation now holds the turn, or it was never stored.
      clearGenerationPendingTurn(conversationId);
      return true;
    },
    [apiClient, ownerKey, queryClient],
  );

  // The stored conversation is behind while a run's turn is still pending:
  // its last turn may be questions that this very run answered.
  const questions = useMemo(
    () =>
      run.running
        ? null
        : (run.questions ??
          (run.pendingTurn ? null : pendingGenerationQuestions(snapshot))),
    [run.running, run.questions, run.pendingTurn, snapshot],
  );
  const questionsRef = useRef(questions);
  questionsRef.current = questions;

  const send = useCallback<GenerationRunController["send"]>(
    (message, options) =>
      start({
        message: message.trim(),
        draftId: options?.draftId ?? null,
        ...(options?.intent ? { intent: options.intent } : {}),
        answers: null,
      }),
    [start],
  );
  const answer = useCallback<GenerationRunController["answer"]>(
    async (answers) => {
      const pending = questionsRef.current;
      if (!pending) return false;
      return start({
        ...pending.request,
        answers: generationAnswers(answers),
      });
    },
    [start],
  );
  const retry = useCallback<GenerationRunController["retry"]>(async () => {
    const id = inputRef.current.conversationId;
    const failed = id ? generationRunState(id).failure : null;
    return failed ? start(failed.request) : false;
  }, [start]);
  const stop = useCallback(() => {
    if (active.current?.conversationId === inputRef.current.conversationId)
      active.current?.controller.abort();
  }, []);
  const dismissFailure = useCallback(() => {
    const id = inputRef.current.conversationId;
    if (id) dismissGenerationFailure(id);
  }, []);

  return { run, questions, send, answer, retry, stop, dismissFailure };
}
