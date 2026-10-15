import { useRef, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { systemPreferredLanguages } from "@animama/product-ui/i18n";
import {
  SUPPORTED_LOCALES,
  isBetaLocale,
  isUiLocale,
  localeNativeName,
  resolveLocale,
} from "@animama/runtime-contracts/locale";

import { cn } from "@/lib/utils";
import { useUserSettings } from "@/query/hooks/useUserSettings";
import { useUpdateUserSettings } from "@/query/mutations/useUpdateUserSettings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import { SettingsRow } from "@/ui/settings/SettingsLayout";
import { useOptionalLocaleInput } from "@/app/runtime/RuntimeAdmissionProvider";
import {
  apiErrorLine,
  apiErrorText,
  readApiError,
} from "@/lib/errors/apiError";

/** Select value standing for "follow the OS or browser language". */
const SYSTEM_LOCALE = "system";

/** Radix suppresses unchanged values; an explicit re-selection can still update the visitor choice. */
function LanguageOption({
  onReselect,
  ...props
}: ComponentProps<typeof SelectItem> & { onReselect?: () => void }) {
  const pointerType = useRef("touch");
  return (
    <SelectItem
      {...props}
      onPointerDown={(event) => {
        pointerType.current = event.pointerType;
      }}
      onPointerMove={(event) => {
        pointerType.current = event.pointerType;
      }}
      onPointerUp={(event) => {
        // Radix cancels the opening release before it reaches this item.
        if (!event.defaultPrevented && pointerType.current === "mouse")
          onReselect?.();
      }}
      onClick={(event) => {
        if (!event.defaultPrevented && pointerType.current !== "mouse")
          onReselect?.();
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (event.key === "Enter") onReselect?.();
        if (event.key === " ") {
          // Radix consumes Space for selection, but leaves it unconsumed
          // during typeahead. Wait for its handler before deciding to save.
          queueMicrotask(() => {
            if (event.defaultPrevented) onReselect?.();
          });
        }
      }}
    />
  );
}

/**
 * Language picker, saved as soon as it changes. "System default" stores no
 * preference so the app follows the OS or browser; every language is named in
 * its own script, so a user who cannot read the active language can still
 * find theirs. Used by App Settings and the first-run Welcome step.
 */
export function LanguageSelect({
  id,
  className,
}: {
  /** Lets a visible `<Label htmlFor>` name the picker. */
  id?: string;
  className?: string;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: settings } = useUserSettings();
  const hosted = useOptionalLocaleInput();
  const { mutateAsync: updateUserSettings, isPending } =
    useUpdateUserSettings();
  const saved = hosted
    ? hosted.preference
    : isUiLocale(settings?.locale)
      ? settings.locale
      : null;
  const systemLocale = resolveLocale({ preferred: systemPreferredLanguages() });
  const nameWithBeta = (locale: (typeof SUPPORTED_LOCALES)[number]) =>
    isBetaLocale(locale)
      ? `${localeNativeName(locale)} · ${t("common:beta")}`
      : localeNativeName(locale);
  const save = (locale: (typeof SUPPORTED_LOCALES)[number] | null) => {
    void updateUserSettings({ body: { locale } }).catch((error: unknown) =>
      toast.error(
        apiErrorLine(
          apiErrorText(
            readApiError(error),
            "settings",
            t("language.saveFailed"),
          ),
        ),
      ),
    );
  };
  const reselect = (locale: (typeof SUPPORTED_LOCALES)[number] | null) =>
    hosted && saved === locale && hosted.visitor !== locale
      ? () => save(locale)
      : undefined;

  return (
    <Select
      value={saved ?? SYSTEM_LOCALE}
      disabled={!settings || isPending}
      onValueChange={(value) => {
        const locale = isUiLocale(value) ? value : null;
        save(locale);
      }}
    >
      <SelectTrigger
        id={id}
        className={cn("w-56", className)}
        aria-label={id ? undefined : t("language.label")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <LanguageOption value={SYSTEM_LOCALE} onReselect={reselect(null)}>
          {t("language.systemDefaultResolved", {
            language: localeNativeName(systemLocale),
          })}
        </LanguageOption>
        {SUPPORTED_LOCALES.map((locale) => (
          <LanguageOption
            key={locale}
            value={locale}
            lang={locale}
            onReselect={reselect(locale)}
          >
            {nameWithBeta(locale)}
          </LanguageOption>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The language picker as an App Settings row. */
export function LanguageSetting() {
  const { t } = useTranslation("settings");
  return (
    <SettingsRow
      label={t("language.label")}
      description={t("language.description")}
      control={<LanguageSelect />}
    />
  );
}
