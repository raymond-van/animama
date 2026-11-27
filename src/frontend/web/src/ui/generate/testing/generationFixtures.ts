import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  PyGenerationConversation,
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
  PyGenerationMessage,
} from "@animama/runtime-contracts/api-types";

/**
 * Fixtures for the content assistant's tests: stored resources as the backend
 * returns them, and the HTTP answers of its routes. Test-only; nothing in the
 * application imports this module.
 */

// Resolved from this directory: under a DOM test environment Vite turns
// `new URL(…, import.meta.url)` into an http URL.
const WAVE_HELLO_PATH = resolve(
  import.meta.dirname,
  "../../../../../../../content/included/gestures/wave-hello/wave-hello.json",
);

/** A valid Included Gesture clip (`animaPoseClip/2.0`), parsed anew each call. */
export function waveHelloClip(): Record<string, unknown> {
  return JSON.parse(readFileSync(WAVE_HELLO_PATH, "utf8")) as Record<
    string,
    unknown
  >;
}

/** A draft's `animamaActionProject/1.0` project, as the backend builds one. */
export function gestureProject(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: "animamaActionProject/1.0",
    intent: "gesture",
    name: "Shy Wave",
    description: "",
    aiDescription: "A small, shy wave with a smile.",
    semanticKey: "shy_wave",
    suggestedEmotion: "",
    suggestedIntensity: 1,
    notes: "",
    sequence: { ...waveHelloClip(), id: "shy-wave", name: "Shy Wave" },
    dependencies: [],
    ...overrides,
  };
}

export function generationConversation(
  overrides: Partial<PyGenerationConversation> = {},
): PyGenerationConversation {
  return {
    id: "conversation-1",
    title: "",
    scope: { kind: "page" },
    style_preset: null,
    created_at: "2026-11-26T10:00:00Z",
    updated_at: "2026-11-26T10:00:00Z",
    ...overrides,
  };
}

export function generationDraft(
  overrides: Partial<PyGenerationDraft> = {},
): PyGenerationDraft {
  return {
    id: "draft-1",
    conversation_id: "conversation-1",
    intent: "gesture",
    position: 0,
    status: "checking",
    version: 1,
    project: gestureProject(),
    has_previous_version: false,
    check_report: null,
    checked_version: null,
    repair_count: 0,
    failure_reason: null,
    saved_item_id: null,
    created_at: "2026-11-26T10:00:00Z",
    updated_at: "2026-11-26T10:00:00Z",
    ...overrides,
  };
}

export function generationMessage(
  overrides: Partial<PyGenerationMessage> = {},
): PyGenerationMessage {
  return {
    id: "message-1",
    role: "user",
    text: "a shy little wave",
    data: {},
    created_at: "2026-11-26T10:00:00Z",
    ...overrides,
  };
}

export function generationSnapshot(
  overrides: Partial<PyGenerationConversationSnapshot> = {},
): PyGenerationConversationSnapshot {
  return {
    conversation: generationConversation(),
    messages: [],
    drafts: [],
    ...overrides,
  };
}

/** A JSON answer; a refusal carries its code as `{ detail: { code, … } }`. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** One named frame of a run's stream. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A run's stream that the test feeds frame by frame. `close` ends it as the
 * server does, `drop` breaks it as a lost connection does, and the reader's
 * cancel (Stop) is recorded in `cancelled`.
 */
export function controlledSseResponse(): {
  response: Response;
  send: (frame: string) => void;
  close: () => void;
  drop: () => void;
  cancelled: () => boolean;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    send: (frame) => controller.enqueue(encoder.encode(frame)),
    close: () => {
      if (!cancelled) controller.close();
    },
    // As `fetch` reports a connection that broke while the body was read.
    drop: () => controller.error(new TypeError("network error")),
    cancelled: () => cancelled,
  };
}

/** A whole run's stream at once. */
export function sseResponse(frames: readonly string[]): Response {
  const stream = controlledSseResponse();
  for (const frame of frames) stream.send(frame);
  stream.close();
  return stream.response;
}

/**
 * `sha256File` without its Web Worker, for tests that save content: mock
 * `@/lib/content/contentUploads` with this in place of the original.
 */
export async function sha256FileInline(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
