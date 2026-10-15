import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { systemPreferredLanguages } from "@animama/product-ui/i18n";
import { resolveLocale } from "@animama/runtime-contracts/locale";

import { useUserSettings } from "@/query/hooks/useUserSettings";
import { useOptionalLocaleInput } from "@/app/runtime/RuntimeAdmissionProvider";
import {
  pseudoLocaleActive,
  rememberAppliedLocale,
  shareAppliedLocaleWithShell,
} from "./locale-preference";

/** Bumps when the OS or browser language list changes, re-resolving "System default". */
function useSystemLanguages(): readonly string[] {
  const [languages, setLanguages] = useState(systemPreferredLanguages);
  useEffect(() => {
    const update = () => setLanguages(systemPreferredLanguages());
    window.addEventListener("languagechange", update);
    return () => window.removeEventListener("languagechange", update);
  }, []);
  return languages;
}

/**
 * Applies the owner's UI Locale once App settings load, and whenever the saved
 * preference or the system language changes. Switching keeps every mounted
 * screen and its state; only text and formatting update. On desktop the shell
 * follows the same locale; the pseudo-locale never reaches it.
 */
export function LocaleSync() {
  const { i18n } = useTranslation();
  const { data: settings, isSuccess } = useUserSettings();
  const saved = settings?.locale ?? null;
  const preferred = useSystemLanguages();
  const hosted = useOptionalLocaleInput();

  useEffect(() => {
    if (hosted || !isSuccess || pseudoLocaleActive()) return;
    const locale = resolveLocale({ saved, preferred });
    rememberAppliedLocale(locale);
    shareAppliedLocaleWithShell(locale);
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
  }, [hosted, i18n, isSuccess, preferred, saved]);

  return null;
}

/** Hosted display hints also apply on signed-out, setup and unavailable screens. */
export function HostedLocaleSync() {
  const { i18n } = useTranslation();
  const hosted = useOptionalLocaleInput();
  const preferred = useSystemLanguages();
  useEffect(() => {
    if (!hosted || pseudoLocaleActive()) return;
    const locale = resolveLocale({
      saved: hosted.preference,
      visitor: hosted.visitor,
      preferred,
    });
    rememberAppliedLocale(locale);
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
  }, [hosted, i18n, preferred]);
  return null;
}
