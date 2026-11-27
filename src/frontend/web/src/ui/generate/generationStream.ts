import {
  runGenerationSseV1GenerationConversationsConversationIdRunsSsePost,
  type Client,
} from "@animama/runtime-contracts/sdk";
import type {
  PyGenerationDraft,
  PyGenerationRunRequest,
} from "@animama/runtime-contracts/api-types";

import { isRecord } from "@/lib/records";
import type { GenerationRunUsage } from "@/stores/generation-store";
import {
  parseGenerationQuestions,
  type GenerationQuestion,
} from "./generationDrafts";

/**
 * A run's event stream: `POST /v1/generation/conversations/{id}/runs:sse`,
 * read through the product API client as chat's stream is, so it carries the
 * same request configuration. Each frame has an `event` name and JSON `data`.
 * Frames are read tolerantly: an unknown name or an unusable payload is
 * skipped, and missing fields take a harmless value, so a backend that adds
 * events or fields does not break a run.
 */

/** A run's steps as the backend names them. */
export type GenerationProgressPhase =
  | "thinking"
  | "writing"
  | "checking"
  | "repairing"
  | "reviewing_frames";

const PROGRESS_PHASES: ReadonlySet<string> = new Set<GenerationProgressPhase>([
  "thinking",
  "writing",
  "checking",
  "repairing",
  "reviewing_frames",
]);

export type GenerationRunEvent =
  | { type: "run.started"; runId: string | null }
  /** `phase` is `null` for a step this page does not know; `draftId` until the draft exists. */
  | {
      type: "progress";
      phase: GenerationProgressPhase | null;
      draftId: string | null;
    }
  /** More of the assistant's text; the pieces in order are the stored message. */
  | { type: "message.delta"; text: string }
  /** The run ends here: the assistant asks before writing. */
  | { type: "questions"; questions: GenerationQuestion[] }
  /** A draft as it is stored now: a new version, or a new status. */
  | { type: "draft.updated"; draft: PyGenerationDraft }
  /** The page should render and upload this draft version's review sheets. */
  | { type: "frames.requested"; draftId: string; version: number }
  | {
      type: "run.failed";
      code: string;
      category: string | null;
      details: Record<string, unknown>;
    }
  /** Always the last event, also after `run.failed`. */
  | { type: "run.completed"; usage: GenerationRunUsage | null };

/** The failure code of a `run.failed` frame that names none. */
export const GENERATION_RUN_FAILED = "generation_run_failed";

const text = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Read a draft resource. A draft needs its identity, its conversation, a
 * version and a status to be placed; every other field takes its empty value
 * when missing, and fields this page does not know are kept as sent.
 */
export function parseGenerationDraft(value: unknown): PyGenerationDraft | null {
  if (!isRecord(value)) return null;
  const { id, conversation_id, version, status } = value;
  if (
    typeof id !== "string" ||
    !id ||
    typeof conversation_id !== "string" ||
    !conversation_id ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    typeof status !== "string"
  )
    return null;
  return {
    ...value,
    id,
    conversation_id,
    version,
    status: status as PyGenerationDraft["status"],
    intent: value.intent === "reaction" ? "reaction" : "gesture",
    position: typeof value.position === "number" ? value.position : 0,
    project: isRecord(value.project) ? value.project : null,
    has_previous_version: value.has_previous_version === true,
    check_report: isRecord(value.check_report) ? value.check_report : null,
    checked_version:
      typeof value.checked_version === "number" ? value.checked_version : null,
    repair_count: count(value.repair_count),
    failure_reason: text(value.failure_reason),
    saved_item_id: text(value.saved_item_id),
    created_at: text(value.created_at) ?? "",
    updated_at: text(value.updated_at) ?? "",
  };
}

function parseUsage(value: unknown): GenerationRunUsage | null {
  if (!isRecord(value)) return null;
  return {
    inputTokens: count(value.input_tokens),
    cachedInputTokens: count(value.cached_input_tokens),
    outputTokens: count(value.output_tokens),
    reasoningTokens: count(value.reasoning_tokens),
    requests: count(value.requests),
  };
}

/** Read one frame; `null` for a name this page does not know or a payload it cannot use. */
export function parseGenerationRunEvent(
  name: string | undefined,
  data: unknown,
): GenerationRunEvent | null {
  const payload = isRecord(data) ? data : {};
  switch (name) {
    case "run.started":
      return { type: "run.started", runId: text(payload.run_id) };
    case "progress":
      return {
        type: "progress",
        phase:
          typeof payload.phase === "string" &&
          PROGRESS_PHASES.has(payload.phase)
            ? (payload.phase as GenerationProgressPhase)
            : null,
        draftId: text(payload.draft_id),
      };
    case "message.delta": {
      const delta = text(payload.text);
      return delta ? { type: "message.delta", text: delta } : null;
    }
    case "questions":
      return {
        type: "questions",
        questions: parseGenerationQuestions(payload.questions),
      };
    case "draft.updated": {
      const draft = parseGenerationDraft(payload.draft);
      return draft ? { type: "draft.updated", draft } : null;
    }
    case "frames.requested": {
      const draftId = text(payload.draft_id);
      return draftId &&
        typeof payload.version === "number" &&
        Number.isInteger(payload.version) &&
        payload.version >= 1
        ? { type: "frames.requested", draftId, version: payload.version }
        : null;
    }
    case "run.failed":
      return {
        type: "run.failed",
        code: text(payload.code) ?? GENERATION_RUN_FAILED,
        category: text(payload.category),
        details: isRecord(payload.details) ? payload.details : {},
      };
    case "run.completed":
      return { type: "run.completed", usage: parseUsage(payload.usage) };
    default:
      return null;
  }
}

/** A run request the server refused before its stream started. */
export class GenerationRunHttpError extends Error {
  readonly status: number;
  /** The refusal's stable code, such as `generation_run_in_progress`. */
  readonly code: string | null;
  /** Why a model cannot be used (`generation_model_unusable`). */
  readonly reason: string | null;

  constructor(status: number, body: unknown) {
    super(`Generation run refused: HTTP ${status}`);
    this.name = "GenerationRunHttpError";
    this.status = status;
    const detail = isRecord(body) && isRecord(body.detail) ? body.detail : {};
    this.code = text(detail.code);
    this.reason = text(detail.reason);
  }
}

async function errorBody(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return null;
  }
}

/**
 * Start one run and yield its events until the server ends the stream.
 * Aborting `signal` stops the run: the request is closed, which is how the
 * backend learns of it, and the generator returns without throwing. A refused
 * request throws `GenerationRunHttpError`; a lost connection throws the
 * transport's own error.
 */
export async function* streamGenerationRun(
  client: Client,
  options: {
    conversationId: string;
    body: PyGenerationRunRequest;
    signal: AbortSignal;
  },
): AsyncGenerator<GenerationRunEvent, void, void> {
  const { signal } = options;
  const configuredFetch = client.getConfig().fetch ?? globalThis.fetch;
  const guardedFetch: typeof fetch = async (input, init) => {
    const response = await configuredFetch(input, init);
    if (signal.aborted) {
      // A custom transport can resolve after the abort; release its late body.
      await response.body?.cancel();
      throw new DOMException("Generation run cancelled", "AbortError");
    }
    if (!response.ok)
      throw new GenerationRunHttpError(
        response.status,
        await errorBody(response),
      );
    return response;
  };

  let streamError: unknown = null;
  // The generated reader yields a frame's data only. Its name arrives through
  // `onSseEvent`, which runs just before that frame's data is yielded.
  let frameName: string | undefined;
  const result =
    await runGenerationSseV1GenerationConversationsConversationIdRunsSsePost({
      client: { post: client.sse.post } as unknown as Client,
      path: { conversation_id: options.conversationId },
      body: options.body,
      signal,
      fetch: guardedFetch,
      // A POST stream must never reconnect by itself: the first request may
      // already have reached the model.
      sseMaxRetryAttempts: 1,
      onSseError: (error) => {
        streamError = error;
      },
      onSseEvent: (event) => {
        // A heartbeat comment has no data and is not yielded.
        if (event.data !== undefined) frameName = event.event;
      },
      throwOnError: true,
    });
  const { stream } = result as unknown as { stream: AsyncGenerator<unknown> };

  for await (const data of stream) {
    // The reader may already hold frames when the run is stopped.
    if (signal.aborted) return;
    const event = parseGenerationRunEvent(frameName, data);
    frameName = undefined;
    if (event) yield event;
  }
  if (streamError && !signal.aborted) throw streamError;
}
