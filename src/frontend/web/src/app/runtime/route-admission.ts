import type { RuntimeCapabilities } from "@animama/runtime-contracts";
import type { TFunction } from "i18next";
import { getI18n } from "react-i18next";

/** The seven capabilities a hosted runtime withholds from direct navigation and corresponding controls. */
export type HostedExclusion =
  | "anima_creation"
  | "chat_file_uploads"
  | "document_processing"
  | "provider_credentials"
  | "local_filesystem_administration"
  | "native_features"
  | "content_generation";

/** Why a route is unavailable here: a hosted exclusion, or installation setup in a hosted runtime. */
export type UnavailableRouteReason = HostedExclusion | "hosted_setup";

/**
 * Word an unavailable-route reason. Components pass their `t` so the text
 * follows a locale switch; other callers get the active UI Locale.
 */
export function unavailableReasonText(
  reason: UnavailableRouteReason,
  t: TFunction<"app"> = getI18n().getFixedT(null, "app"),
): string {
  switch (reason) {
    case "anima_creation":
      return t("unavailable.reasons.animaCreation");
    case "chat_file_uploads":
      return t("unavailable.reasons.chatFileUploads");
    case "document_processing":
      return t("unavailable.reasons.documentProcessing");
    case "provider_credentials":
      return t("unavailable.reasons.providerCredentials");
    case "local_filesystem_administration":
      return t("unavailable.reasons.localFilesystemAdministration");
    case "native_features":
      return t("unavailable.reasons.nativeFeatures");
    case "content_generation":
      return t("unavailable.reasons.contentGeneration");
    case "hosted_setup":
      return t("unavailable.reasons.hostedSetup");
  }
}

/**
 * The hosted exclusion reasons shared by direct navigation and corresponding
 * controls, worded in the active UI Locale when read.
 */
export const hostedExclusionReasons: Readonly<Record<HostedExclusion, string>> =
  {
    get anima_creation() {
      return unavailableReasonText("anima_creation");
    },
    get chat_file_uploads() {
      return unavailableReasonText("chat_file_uploads");
    },
    get document_processing() {
      return unavailableReasonText("document_processing");
    },
    get provider_credentials() {
      return unavailableReasonText("provider_credentials");
    },
    get local_filesystem_administration() {
      return unavailableReasonText("local_filesystem_administration");
    },
    get native_features() {
      return unavailableReasonText("native_features");
    },
    get content_generation() {
      return unavailableReasonText("content_generation");
    },
  };

/** Why `pathname` is unavailable with these capabilities, or `null` when it is offered. */
export function unavailableRouteReason(
  pathname: string,
  capabilities: RuntimeCapabilities,
): UnavailableRouteReason | null {
  if (pathname === "/animas/new" && !capabilities.anima_creation)
    return "anima_creation";
  if (
    /^\/(?:attachments|chat-files)(?:\/|$)/.test(pathname) &&
    !capabilities.chat_file_uploads
  )
    return "chat_file_uploads";
  if (
    /^\/(?:documents|document-processing)(?:\/|$)/.test(pathname) &&
    !capabilities.user_file_processing.enabled
  )
    return "document_processing";
  if (
    /^\/(?:providers|api-keys|settings\/connections)(?:\/|$)/.test(pathname) &&
    !capabilities.provider_credentials
  )
    return "provider_credentials";
  if (
    /^\/(?:local-files|filesystem)(?:\/|$)/.test(pathname) &&
    !capabilities.local_filesystem_administration
  )
    return "local_filesystem_administration";
  // Local Compose does not advertise a supervised renderer capability. Its
  // auxiliary routes still enforce the actual preload bridge and window role.
  if (
    pathname.startsWith("/desktop/") &&
    capabilities.runtime_kind === "hosted"
  )
    return "native_features";
  if (pathname === "/setup" && capabilities.runtime_kind === "hosted")
    return "hosted_setup";
  // The content assistant is local-only: offered only when reported true.
  if (
    /^\/generate(?:\/|$)/.test(pathname) &&
    capabilities.content_generation !== true
  )
    return "content_generation";
  return null;
}
