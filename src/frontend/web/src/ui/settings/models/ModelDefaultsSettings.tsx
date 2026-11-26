import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { getI18n, useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { PyModelRoleAssignment } from "@animama/runtime-contracts/api-types";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import {
  modelRolePatch,
  readModelRoleId,
  type ModelRole,
} from "@/lib/settings/preferences";
import { useModelRoles } from "@/query/hooks/useModelConfiguration";
import { useModelProviders } from "@/query/hooks/useModelProviders";
import { queryKeys } from "@/query/keys";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import { SettingsRow } from "@/ui/settings/SettingsLayout";
import { useSettings } from "@/ui/settings/SettingsProvider";

import { alternateModelIds, modelOptionLabel } from "@/lib/chat/model-catalog";

import {
  embeddingsStatusText,
  roleCandidates,
} from "./model-configuration-state";

const DEFAULT_CHOICE = "__role_default__";

/** Display copy for one default model role. */
export type ModelDefaultCopy = {
  label: string;
  description: string;
  /** The choice that leaves the role to its default. */
  defaultLabel: string;
};

/** Copy for a default model section in App Settings → Models, in the active UI Locale. */
export function modelDefaultCopy(
  role: ModelRole,
  t: TFunction<"models"> = getI18n().getFixedT(null, "models"),
): ModelDefaultCopy {
  switch (role) {
    case "chat":
      return {
        label: t("defaults.roles.chat.label"),
        description: t("defaults.roles.chat.description"),
        defaultLabel: t("defaults.roles.chat.default"),
      };
    case "memory_manager":
      return {
        label: t("defaults.roles.memoryManager.label"),
        description: t("defaults.roles.memoryManager.description"),
        defaultLabel: t("defaults.roles.memoryManager.default"),
      };
    case "utility":
      return {
        label: t("defaults.roles.utility.label"),
        description: t("defaults.roles.utility.description"),
        defaultLabel: t("defaults.roles.utility.default"),
      };
    case "embeddings":
      return {
        label: t("defaults.roles.embeddings.label"),
        description: t("defaults.roles.embeddings.description"),
        defaultLabel: t("defaults.roles.embeddings.default"),
      };
    default: {
      // Every role needs its own copy.
      const unworded: never = role;
      return unworded;
    }
  }
}

/** Where the role's model comes from when the owner has not chosen one. */
export function effectiveNote(
  t: TFunction<"models">,
  assignment: PyModelRoleAssignment | undefined,
): string | null {
  if (!assignment) return null;
  // An unavailable ChatGPT plan model does not fall back: the role waits for it.
  if (!assignment.assignment_available)
    return assignment.source === "off"
      ? t("defaults.unavailableWaiting")
      : t("defaults.unavailable");
  if (assignment.source === "off")
    return assignment.role === "embeddings"
      ? null
      : t("defaults.noCapableModel");
  if (assignment.source === "owner") return null;
  const model = assignment.model_label ?? assignment.model_provider_id;
  if (!model) return null;
  return assignment.connection_name
    ? t("defaults.currentOn", {
        model,
        connection: assignment.connection_name,
      })
    : t("defaults.current", { model });
}

/**
 * One default model in App Settings → Models. Each role stores a catalog row
 * id in user preferences; the server reports the model in effect.
 */
export function ModelDefaultSetting({
  role,
  disabled,
}: {
  role: ModelRole;
  disabled: boolean;
}) {
  const { t } = useTranslation("models");
  const { userPreferences, updateUserPreferences } = useSettings();
  const providers = useModelProviders();
  const roles = useModelRoles(true);
  const queryClient = useQueryClient();
  const ownerKey = useRuntimeCacheKey() ?? "__anon__";
  const { label, description, defaultLabel } = modelDefaultCopy(role, t);

  const stored = readModelRoleId(userPreferences, role);
  const candidates = roleCandidates(providers.data ?? [], role, stored);
  const alternates = alternateModelIds(candidates);
  const storedMissing =
    Boolean(stored) &&
    providers.isSuccess &&
    !candidates.some((item) => item.id === stored);
  const assignment = roles.data?.roles.find((entry) => entry.role === role);
  const notes = [
    providers.isError ? t("defaults.loadFailed") : null,
    effectiveNote(t, assignment),
    role === "embeddings"
      ? embeddingsStatusText(roles.data?.embeddings_refresh)
      : null,
  ].filter(Boolean);

  const choose = (value: string) => {
    const next = value === DEFAULT_CHOICE ? null : value;
    void updateUserPreferences(modelRolePatch(role, next))
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: queryKeys.modelConfiguration.roles(ownerKey),
        }),
      )
      .catch(() => toast.error(t("defaults.saveFailed", { role: label })));
  };

  return (
    <SettingsRow
      label={label}
      description={description}
      control={
        <Select
          value={stored ?? DEFAULT_CHOICE}
          disabled={disabled || !providers.isSuccess}
          onValueChange={choose}
        >
          <SelectTrigger
            className="w-56"
            aria-label={t("defaults.roleModel", { role: label })}
          >
            <SelectValue placeholder={defaultLabel} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_CHOICE}>{defaultLabel}</SelectItem>
            {storedMissing && stored ? (
              <SelectItem value={stored} disabled>
                {t("defaults.unavailableChoice", { model: stored })}
              </SelectItem>
            ) : null}
            {candidates.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {modelOptionLabel(item, alternates.has(item.id))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {notes.length > 0 ? (
        <p className="text-muted-foreground text-xs" role="status">
          {notes.join(" ")}
        </p>
      ) : null}
    </SettingsRow>
  );
}
