import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { unavailableReasonText } from "@/app/runtime/route-admission";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";

/** Backend-reported features whose UI entry points the composition can withhold. */
export type RuntimeFeatureCapability =
  | "chat_file_uploads"
  | "anima_creation"
  | "content_generation";

/**
 * Whether entry points for a runtime feature should be offered.
 *
 * A feature is offered only after the runtime explicitly reports it available.
 * Admission supplies the initial capabilities, so local controls remain stable
 * while hosted loading and unreadable responses cannot enable excluded work.
 */
export function useRuntimeFeatureEnabled(
  capability: RuntimeFeatureCapability,
): boolean {
  return useRuntimeCapabilities().data?.[capability] === true;
}

/**
 * The shared reason to show on a feature's familiar entry points when the
 * runtime explicitly withholds it, or `null` while it is offered or its
 * capability is still unknown (entry points then stay hidden). It is the same
 * text that direct navigation to the excluded route shows.
 */
export function useRuntimeFeatureUnavailableReason(
  capability: RuntimeFeatureCapability,
): string | null {
  const { t } = useTranslation("app");
  return useRuntimeCapabilities().data?.[capability] === false
    ? unavailableReasonText(capability, t)
    : null;
}

/**
 * Render children only while `capability` is offered; see
 * `useRuntimeFeatureEnabled`. When the runtime withholds it, `unavailable`
 * renders the disabled entry point with the shared reason instead.
 */
export function RuntimeFeatureGate({
  capability,
  unavailable,
  children,
}: {
  capability: RuntimeFeatureCapability;
  unavailable?: (reason: string) => ReactNode;
  children: ReactNode;
}) {
  const enabled = useRuntimeFeatureEnabled(capability);
  const reason = useRuntimeFeatureUnavailableReason(capability);
  if (enabled) return children;
  return reason && unavailable ? unavailable(reason) : null;
}
