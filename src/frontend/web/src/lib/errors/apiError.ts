import { getI18n } from "react-i18next";
import { SOURCE_LOCALE } from "@animama/runtime-contracts/locale";

/**
 * Wording for backend failures.
 *
 * The backend sends stable codes and parameters; the `errors` catalog words
 * them per area (`errors:<area>.<code>`). Backend English stays for logs and
 * API clients: an unworded code shows that English text in English, and a
 * translated generic message with the English as secondary detail elsewhere.
 */

/** The stable parts of an API failure. */
export type ApiErrorInfo = {
  status: number | null;
  code: string | null;
  reason: string | null;
  field: string | null;
  params: Record<string, unknown>;
  /** The backend's English detail, when it sent one. */
  message: string | null;
  /** True when `message` is already worded in the UI Locale (`WordedError`). */
  worded?: boolean;
};

/**
 * An error whose message is already worded in the UI Locale. `readApiError`
 * marks it, so `apiErrorText` shows the message as it is.
 */
export class WordedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WordedError";
  }
}

/** Text to show for a failure: `detail` is secondary technical text, if any. */
export type ApiErrorText = { message: string; detail: string | null };

/** Catalog areas holding wording for backend codes. */
export type ErrorArea =
  | "creation"
  | "loadout"
  | "contentSave"
  | "sharing"
  | "uploads"
  | "profile"
  | "settings"
  | "modelConfiguration"
  | "webSearch";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Read a failure thrown by the generated client (`{ detail }`, `{ data: { detail } }`,
 * a string `detail`, or an `Error`).
 */
export function readApiError(error: unknown): ApiErrorInfo {
  const root = record(error);
  const envelope = record(root?.data) ?? root;
  const detail = envelope?.detail;
  const body = record(detail);
  const status =
    typeof root?.status === "number"
      ? root.status
      : typeof record(root?.response)?.status === "number"
        ? (record(root?.response)?.status as number)
        : null;
  return {
    status,
    code: text(body?.code),
    reason: text(body?.reason),
    field: text(body?.field),
    params: record(body?.params) ?? {},
    message:
      text(body?.message) ??
      text(detail) ??
      (error instanceof Error ? text(error.message) : null),
    ...(error instanceof WordedError ? { worded: true } : {}),
  };
}

/** Catalog wording for one code in an area, or `null` when the code is not worded. */
export function errorWording(
  area: ErrorArea,
  code: string,
  params: Record<string, unknown> = {},
): string | null {
  const i18n = getI18n();
  const key = `errors:${area}.${code}`;
  if (!i18n?.exists(key)) return null;
  // Backend codes are runtime values, so these keys cannot be typed literals.
  const translate = i18n.t as (key: string, options?: object) => string;
  return translate(key, params);
}

/** True while the interface is in English, the language of backend detail. */
export function sourceLocaleActive(): boolean {
  const i18n = getI18n();
  return (
    (i18n?.resolvedLanguage ?? i18n?.language ?? SOURCE_LOCALE) ===
    SOURCE_LOCALE
  );
}

/**
 * The text for a failure in an area. `fallback` names the generic message used
 * when the code is not worded (default `errors:generic.unexpected`). A `null`
 * area is for services that send no codes (memory), so only the fallback rule
 * applies.
 */
export function apiErrorText(
  info: ApiErrorInfo,
  area: ErrorArea | null,
  fallback?: string,
): ApiErrorText {
  const worded =
    area &&
    ((info.code && errorWording(area, info.code, info.params)) ??
      (info.reason && errorWording(area, info.reason, info.params)));
  if (worded) return { message: worded, detail: null };
  if (info.worded && info.message)
    return { message: info.message, detail: null };
  if (sourceLocaleActive() && info.message)
    return { message: info.message, detail: null };
  const translate = getI18n().t as (key: string) => string;
  return {
    message: fallback ?? translate("errors:generic.unexpected"),
    detail: info.message,
  };
}

/**
 * Text for English that carries no code, such as an error a service stored
 * with a run or file: that English in English, else `fallback` with the
 * English as detail.
 */
export function uncodedErrorText(
  message: string | null,
  fallback: string,
): ApiErrorText {
  return apiErrorText(
    {
      status: null,
      code: null,
      reason: null,
      field: null,
      params: {},
      message,
    },
    null,
    fallback,
  );
}

/**
 * One line for a failure outside a coded area: a `WordedError` as it is, other
 * English primary in English and secondary detail under `fallback` elsewhere.
 */
export function failureLine(error: unknown, fallback: string): string {
  return apiErrorLine(apiErrorText(readApiError(error), null, fallback));
}

/** One string for places that show a single line: the message, then any detail. */
export function apiErrorLine({ message, detail }: ApiErrorText): string {
  return detail
    ? getI18n().t("errors:generic.withDetail", { message, detail })
    : message;
}
