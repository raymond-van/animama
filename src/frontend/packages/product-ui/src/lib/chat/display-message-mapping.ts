import { replyBubbleTexts } from "./structured-response-stream";
import type { ChatFailure } from "../../chat/chat-failure";
import type { PyChatMessage } from "@animama/runtime-contracts/api-types";
import { parseMemoryCue, type ChatMemoryCue } from "./memory-cue";
import type { ChatRunStatusKind } from "./run-status";

/** An image the person sent with a message: its stored file and name. */
export type ChatDisplayImage = {
  fileId: string;
  name: string;
  width?: number;
  height?: number;
};

export type ChatDisplayMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Images sent with a user message; the host renders them. */
  images?: ChatDisplayImage[];
  createdAt?: string;
  failure?: ChatFailure;
  isPending?: boolean;
  /** Backend work shown while the bubble is pending, such as summarizing. */
  pendingStatus?: ChatRunStatusKind;
  animateOnEnter?: boolean;
  animateTextEffect?: boolean;
  streamingSegments?: string[];
  /** What the turn remembered; only on the last visible bubble of its reply. */
  memoryCue?: ChatMemoryCue;
};

export function chatRunMessageId(
  runId: string,
  role: "user" | "assistant",
  ordinal = 0,
): string {
  const base = `run-${runId}-${role}`;
  return ordinal > 0 ? `${base}-${ordinal}` : base;
}

/** An explicit UTC designator or numeric offset ends the timestamp. */
const TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Epoch milliseconds for a message timestamp, or 0 when it is missing or
 * invalid.
 *
 * The backend stores UTC in `timestamp without time zone` columns, so persisted
 * rows arrive without an offset. `Date.parse` would read those as local time
 * and misorder them against client timestamps from `toISOString()`, so a
 * date-time without an offset is treated as UTC.
 */
export function messageTimestampMs(value: string | undefined): number {
  if (!value) return 0;
  const isDateTime = value.includes("T");
  const utcValue =
    isDateTime && !TIMEZONE_SUFFIX.test(value) ? `${value}Z` : value;
  return Date.parse(utcValue) || 0;
}

/**
 * Order display messages chronologically. The sort is stable, so messages
 * with equal or missing timestamps keep their incoming order.
 */
export function sortDisplayMessagesByCreatedAt<T extends ChatDisplayMessage>(
  messages: T[],
): T[] {
  return messages.sort(
    (a, b) => messageTimestampMs(a.createdAt) - messageTimestampMs(b.createdAt),
  );
}

export function mapServerMessagesForDisplay(
  messages: PyChatMessage[],
): ChatDisplayMessage[] {
  const messageIdCounts = new Map<string, number>();
  const displayMessages: ChatDisplayMessage[] = [];

  messages.forEach((message, index) => {
    if (message.internal) return;

    const role = message.role === "user" ? "user" : "assistant";
    const structuredTexts =
      role === "assistant" ? structuredAssistantTexts(message) : null;
    // A message with images shows the person's own text beside them; its
    // `content` also names each image for readers without images.
    const images = role === "user" ? userMessageImages(message) : [];
    const userText = images.length ? message.data?.user_text : undefined;
    const rawContent =
      typeof userText === "string" ? userText : (message.content ?? "");
    // A structured reply shows only its own bubbles, possibly none (speech of
    // only tags); `content` would repeat the speech with its tags.
    const texts =
      structuredTexts ??
      (rawContent.trim() || images.length ? [rawContent] : []);

    // One row may render as speech plus display bubbles; the cue follows the
    // reply, so it belongs on the last one, matching the live stream.
    const memoryCue =
      role === "assistant" ? parseMemoryCue(message.memory_cue) : null;
    texts.forEach((text, textIndex) => {
      displayMessages.push({
        id: serverMessageDisplayId(message, role, index, messageIdCounts),
        role,
        text,
        ...(images.length && textIndex === 0 ? { images } : {}),
        ...(message.created_at ? { createdAt: message.created_at } : {}),
        ...(memoryCue && textIndex === texts.length - 1 ? { memoryCue } : {}),
      });
    });
  });

  return displayMessages;
}

/** The images a persisted user row carries in `data.images`; unreadable entries are skipped. */
function userMessageImages(message: PyChatMessage): ChatDisplayImage[] {
  const value = message.data?.images;
  if (!Array.isArray(value)) return [];
  const images: ChatDisplayImage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { file_id, name, width, height } = entry as Record<string, unknown>;
    if (typeof file_id !== "string" || !file_id) continue;
    images.push({
      fileId: file_id,
      name: typeof name === "string" ? name : "",
      ...(positiveInteger(width) ? { width } : {}),
      ...(positiveInteger(height) ? { height } : {}),
    });
  }
  return images;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Restores the live SSE speech/display projection from one provider-shaped
 * persisted assistant row. The history API keeps both values in
 * `data.structured`, while its legacy `content` projection prefers display.
 */
function structuredAssistantTexts(message: PyChatMessage): string[] | null {
  const structured = message.data?.structured;
  if (
    !structured ||
    typeof structured !== "object" ||
    Array.isArray(structured)
  ) {
    return null;
  }

  const structuredRecord = structured as Record<string, unknown>;
  const speechValue = structuredRecord.speech;
  const displayValue = structuredRecord.display;
  const speech = typeof speechValue === "string" ? speechValue : "";
  const display = typeof displayValue === "string" ? displayValue : "";
  // Unusable structured data falls back to the row's content.
  if (!speech.trim() && !display.trim()) return null;
  return replyBubbleTexts(speech, display);
}

function serverMessageDisplayId(
  message: PyChatMessage,
  role: "user" | "assistant",
  index: number,
  messageIdCounts: Map<string, number>,
): string {
  const runId = typeof message.run_id === "string" ? message.run_id.trim() : "";
  if (runId) {
    const countKey = `${runId}:${role}`;
    const ordinal = messageIdCounts.get(countKey) ?? 0;
    messageIdCounts.set(countKey, ordinal + 1);
    return chatRunMessageId(runId, role, ordinal);
  }

  const idBase =
    message.id ?? message.created_at ?? message.chat_id ?? `${role}-${index}`;
  const base = `msg-${idBase}`;
  const countKey = `persisted:${base}`;
  const ordinal = messageIdCounts.get(countKey) ?? 0;
  messageIdCounts.set(countKey, ordinal + 1);
  return ordinal > 0 ? `${base}-${ordinal}` : base;
}
