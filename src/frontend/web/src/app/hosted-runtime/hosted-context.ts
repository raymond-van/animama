import {
  isUiLocale,
  type HostedLocaleInput,
} from "@animama/runtime-contracts/locale";

/** Decode only display hints. Admission validates the rest of the context separately. */
export function hostedLocaleInput(
  context: unknown,
): HostedLocaleInput | undefined {
  if (!context || typeof context !== "object" || !("locale" in context))
    return undefined;
  const value = context.locale;
  const hints = value && typeof value === "object" ? value : {};
  return {
    preference:
      "preference" in hints && isUiLocale(hints.preference)
        ? hints.preference
        : null,
    visitor:
      "visitor" in hints && isUiLocale(hints.visitor) ? hints.visitor : null,
  };
}

/** Read through the original transport before app modules/i18n or admission exist. */
export async function readHostedStartup(
  baseUrl: string,
  fetch: typeof globalThis.fetch,
) {
  try {
    const response = await fetch(
      new Request(new URL("/v1/hosted/runtime-context", baseUrl), {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }),
    );
    const locale = response.ok
      ? hostedLocaleInput(await response.clone().json())
      : null;
    return { response, locale };
  } catch {
    // Admission's normal read/retry owns recovery; never use an account cache here.
    return { response: undefined, locale: null };
  }
}
