/**
 * UI Locale contract shared by Animama and its consumers.
 *
 * A UI Locale chooses the language and regional conventions of the interface
 * text and of date, number and plural formatting, and the Anima's conversation
 * language (ADR 0024). It never chooses the crisis-resource region.
 */

/** Canonical UI Locale tags, in picker order. English is the source locale. */
export const SUPPORTED_LOCALES = [
  "en",
  "ja",
  "ko",
  "zh-Hans",
  "zh-Hant",
] as const;

/** A canonical UI Locale tag; the only values a saved preference may hold. */
export type UiLocale = (typeof SUPPORTED_LOCALES)[number];

/** Optional hosted runtime-context display hints; neither grants admission. */
export interface HostedLocaleInput {
  /** The account's nullable saved choice, distinct from the resolved language. */
  readonly preference: UiLocale | null;
  /** The nullable browser visitor choice, supplied by the hosting composition. */
  readonly visitor: UiLocale | null;
}

/** The locale whose catalogs are authored and used as every fallback. */
export const SOURCE_LOCALE: UiLocale = "en";

const BETA_LOCALES: ReadonlySet<UiLocale> = new Set([
  "ja",
  "ko",
  "zh-Hans",
  "zh-Hant",
]);

const NATIVE_NAMES: Readonly<Record<UiLocale, string>> = {
  en: "English",
  ja: "日本語",
  ko: "한국어",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
};

/** Regions whose Chinese text is conventionally written in Traditional script. */
const TRADITIONAL_CHINESE_REGIONS: ReadonlySet<string> = new Set([
  "TW",
  "HK",
  "MO",
]);

/** True only for canonical supported tags, so legacy values such as `en-US` read as unset. */
export function isUiLocale(value: unknown): value is UiLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/** Beta locales ship machine translations and are marked as beta in pickers. */
export function isBetaLocale(locale: UiLocale): boolean {
  return BETA_LOCALES.has(locale);
}

/** The locale's name written in its own script, readable whatever locale is active. */
export function localeNativeName(locale: UiLocale): string {
  return NATIVE_NAMES[locale];
}

/** Languages written right-to-left; none is a UI Locale yet, but documents must not assume `ltr`. */
const RIGHT_TO_LEFT_LANGUAGES: ReadonlySet<string> = new Set([
  "ar",
  "fa",
  "he",
  "ur",
]);

/** Text direction for a locale tag; all current UI Locales are left-to-right. */
export function localeDirection(locale: string): "ltr" | "rtl" {
  const language = locale.split(/[-_]/)[0]?.toLowerCase() ?? "";
  return RIGHT_TO_LEFT_LANGUAGES.has(language) ? "rtl" : "ltr";
}

/**
 * Map any BCP 47 language tag to a supported UI Locale, or `null`.
 *
 * Tags match on their language subtag. Chinese uses an explicit script first,
 * then the region (TW, HK and MO are Traditional), and defaults to Simplified.
 */
export function matchLocale(tag: string): UiLocale | null {
  const [language = "", ...rest] = tag.trim().replace(/_/g, "-").split("-");
  switch (language.toLowerCase()) {
    case "en":
      return "en";
    case "ja":
      return "ja";
    case "ko":
      return "ko";
    case "zh": {
      const script = rest.find((part) => part.length === 4)?.toLowerCase();
      if (script === "hans") return "zh-Hans";
      if (script === "hant") return "zh-Hant";
      const region = rest.find((part) => part.length === 2)?.toUpperCase();
      return region && TRADITIONAL_CHINESE_REGIONS.has(region)
        ? "zh-Hant"
        : "zh-Hans";
    }
    default:
      return null;
  }
}

/** Inputs to {@link resolveLocale}. */
export interface LocaleResolutionInput {
  /** The saved preference; anything other than a canonical tag means "System default". */
  readonly saved?: string | null;
  /** A canonical visitor choice, below an account preference and above the browser. */
  readonly visitor?: string | null;
  /** The OS or browser preferred-language list, most preferred first. */
  readonly preferred?: readonly string[];
}

/** Resolve saved preference, visitor choice, preferred languages in order, then English. */
export function resolveLocale({
  saved,
  visitor,
  preferred = [],
}: LocaleResolutionInput): UiLocale {
  if (isUiLocale(saved)) return saved;
  if (isUiLocale(visitor)) return visitor;
  for (const tag of preferred) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return SOURCE_LOCALE;
}

/**
 * The tag used for `Intl` formatting under an active UI Locale.
 *
 * The first preferred tag in the same UI Locale supplies its region (English
 * text with British dates on an `en-GB` system); otherwise the locale's default.
 */
export function formattingLocale(
  locale: UiLocale,
  preferred: readonly string[] = [],
): string {
  for (const tag of preferred) {
    if (matchLocale(tag) !== locale) continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(tag.replace(/_/g, "-"));
      if (canonical) return canonical;
    } catch {
      // An invalid tag cannot supply formatting conventions; keep looking.
    }
  }
  return locale;
}
