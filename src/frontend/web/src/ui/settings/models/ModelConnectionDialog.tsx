import {
  useEffect,
  useId,
  useImperativeHandle,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { getI18n, useTranslation } from "react-i18next";
import { toast } from "sonner";

import type {
  PyModelConnection,
  PyModelConnectionCompatibility,
  PyModelConnectionCredential,
  PyModelConnectionDetection,
  PyModelConnectionPreset,
} from "@animama/runtime-contracts/api-types";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import {
  useCreateModelConnection,
  useDetectModelServer,
  useUpdateModelConnection,
} from "@/query/mutations/useModelConfiguration";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import type {
  CredentialChange,
  CredentialStatus,
  CredentialsBridge,
} from "../../../../../shared/desktop-runtime";
import { credentialTarget } from "../../../../../shared/desktop-runtime";
import {
  DesktopKeyStorageNote,
  type DesktopCredentialsController,
} from "@/ui/settings/DesktopCredentialsPanel";
import {
  applyCredentialChanges,
  credentialFailureMessage,
  refreshCredentialDependents,
} from "@/ui/settings/desktop-credential-state";

import {
  detectionMessage,
  keyOrigin,
  keyOriginVariable,
  keyWouldTravelInsecurely,
  modelConfigurationErrorMessage,
} from "./model-configuration-state";

type Draft = {
  preset: string;
  name: string;
  baseUrl: string;
  timeout: string;
  compatibility: Required<PyModelConnectionCompatibility>;
  /** Desktop: a new key to store; never prefilled. */
  key: string;
  removeKey: boolean;
  /** Self-hosted web: the environment variable holding the key. */
  envName: string;
};

const DEFAULT_COMPATIBILITY: Required<PyModelConnectionCompatibility> = {
  fold_developer_role: false,
  send_openai_extensions: true,
  send_stream_usage: true,
  strip_function_strict: false,
  reasoning_mode: "openai_effort",
};

type CompatibilityOption = Exclude<
  keyof PyModelConnectionCompatibility,
  "reasoning_mode"
>;

const COMPATIBILITY_OPTIONS: readonly CompatibilityOption[] = [
  "fold_developer_role",
  "send_openai_extensions",
  "send_stream_usage",
  "strip_function_strict",
];

/** The checkbox label for one compatibility option. */
function compatibilityLabel(
  t: TFunction<"models">,
  option: CompatibilityOption,
): string {
  switch (option) {
    case "fold_developer_role":
      return t("connectionForm.compatibility.foldDeveloperRole");
    case "send_openai_extensions":
      return t("connectionForm.compatibility.sendOpenaiExtensions");
    case "send_stream_usage":
      return t("connectionForm.compatibility.sendStreamUsage");
    case "strip_function_strict":
      return t("connectionForm.compatibility.stripFunctionStrict");
    default: {
      // Every option needs its own label.
      const unlabelled: never = option;
      return unlabelled;
    }
  }
}

/** What an option changes, when its label alone cannot say. */
function compatibilityHelp(
  t: TFunction<"models">,
  option: CompatibilityOption,
): string | null {
  return option === "fold_developer_role"
    ? t("connectionForm.compatibility.foldDeveloperRoleHelp")
    : null;
}

/** Example variable name for a server that suggests none. */
const EXAMPLE_KEY_ENV = "MY_SERVER_API_KEY";

function draftFromPreset(preset: PyModelConnectionPreset): Draft {
  return {
    preset: preset.id,
    name: preset.label,
    baseUrl: preset.default_base_url ?? "",
    timeout: String(preset.timeout_seconds),
    compatibility: { ...DEFAULT_COMPATIBILITY, ...preset.compatibility },
    key: "",
    removeKey: false,
    envName: preset.suggested_credential_env ?? "",
  };
}

function draftFromConnection(connection: PyModelConnection): Draft {
  return {
    preset: connection.preset,
    name: connection.name,
    baseUrl: connection.base_url ?? "",
    timeout:
      connection.timeout_seconds != null
        ? String(connection.timeout_seconds)
        : "",
    compatibility: { ...DEFAULT_COMPATIBILITY, ...connection.compatibility },
    key: "",
    removeKey: false,
    envName: connection.credential_env ?? "",
  };
}

/**
 * Delete a connection's saved desktop key, offering a retry on failure because
 * nothing else lists the key once the connection no longer names it.
 */
export async function deleteConnectionKey(
  bridge: Pick<CredentialsBridge, "list" | "apply">,
  env: string,
): Promise<void> {
  await applyCredentialChanges(bridge, [{ connection: env }]).catch(() => {
    const t = getI18n().getFixedT(null, "models");
    toast.error(t("connectionForm.keyNotDeleted"), {
      action: {
        label: t("actions.retry"),
        onClick: () => void deleteConnectionKey(bridge, env),
      },
    });
  });
}

/** A desktop key, saved with the origin of the address it was entered for. */
function connectionKeyChange(
  env: string,
  value: string,
  baseUrl: string | null | undefined,
): CredentialChange {
  const origin = keyOrigin(baseUrl);
  return origin
    ? { connection: env, value, origin }
    : { connection: env, value };
}

/** Why a saved connection's key was not stored, from main's reported status. */
function keyFailureMessage(error: unknown, env: string | null): string {
  const statuses = (error as { statuses?: CredentialStatus[] }).statuses ?? [];
  const status = statuses.find((item) => credentialTarget(item) === env);
  const reason = status ? credentialFailureMessage(status) : null;
  const t = getI18n().getFixedT(null, "models");
  return reason
    ? t("connectionForm.keyNotStored", { reason })
    : t("connectionForm.keyNotStoredRetry");
}

/** Busy and validity state a connection form's footer needs. */
export type ModelConnectionFormState = { saving: boolean; valid: boolean };

/**
 * The fields for adding or editing a model connection; `footer` renders
 * inside the form, so its submit button saves. On desktop the key is stored
 * in the encrypted vault under the connection's managed variable and applies
 * immediately; on self-hosted web the owner
 * names the environment variable that holds the key. A new connection to a
 * local server type can **Detect** whether one is running at its default
 * address.
 */
type ModelConnectionFormProps = {
  /** Example address for an empty Base URL, e.g. a cloud URL on the Cloud tab. */
  baseUrlPlaceholder?: string;
  /**
   * At least one preset; a new connection starts from the first. With a
   * single preset the server type is fixed and its choice is not shown.
   */
  presets: readonly PyModelConnectionPreset[];
  connection?: PyModelConnection;
  /** Desktop with its embedded runtime: keys go to the encrypted vault. */
  managedKeys: boolean;
  onSaved: (connection: PyModelConnection) => void;
  onSavingChange?: (saving: boolean) => void;
  /**
   * Whether a typed (desktop) key is unsaved, so a host such as setup can
   * ask before leaving; reported false again when the form closes.
   */
  onKeyDirtyChange?: (dirty: boolean) => void;
  /** Save (connect) or discard the typed key from outside the form. */
  controllerRef?: Ref<DesktopCredentialsController>;
  footer: (state: ModelConnectionFormState) => ReactNode;
};

export function ModelConnectionForm(props: ModelConnectionFormProps) {
  // Without a connection or a preset there is nothing to start from.
  if (!props.connection && !props.presets[0]) return null;
  return <ModelConnectionFields {...props} />;
}

function ModelConnectionFields({
  presets,
  connection,
  managedKeys,
  onSaved,
  onSavingChange,
  onKeyDirtyChange,
  controllerRef,
  footer,
  baseUrlPlaceholder = "http://127.0.0.1:11434/v1",
}: ModelConnectionFormProps) {
  const { t } = useTranslation("models");
  const formId = useId();
  const platform = useRuntimePlatform();
  const queryClient = useQueryClient();
  const ownerId = useRuntimeCacheKey();
  const bridge =
    platform.kind === "desktop"
      ? platform.desktopBridge.credentials
      : undefined;
  const create = useCreateModelConnection();
  const update = useUpdateModelConnection();
  const detect = useDetectModelServer();
  const [draft, setDraft] = useState<Draft>(() =>
    connection ? draftFromConnection(connection) : draftFromPreset(presets[0]),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSavingState] = useState(false);
  const [detection, setDetection] = useState<PyModelConnectionDetection | null>(
    null,
  );

  const keyDirty = managedKeys && draft.key.trim() !== "";
  useEffect(() => {
    onKeyDirtyChange?.(keyDirty);
  }, [keyDirty, onKeyDirtyChange]);
  useEffect(() => () => onKeyDirtyChange?.(false), [onKeyDirtyChange]);

  const preset = presets.find((item) => item.id === draft.preset);
  const canDetect = !connection && Boolean(preset?.local);
  const savedManagedKey =
    Boolean(connection?.credential_env) &&
    connection?.credential_state === "configured";
  const sendsKey = managedKeys
    ? Boolean(draft.key.trim()) || (savedManagedKey && !draft.removeKey)
    : Boolean(draft.envName.trim());
  const insecure = sendsKey && keyWouldTravelInsecurely(draft.baseUrl);
  const draftOrigin = keyOrigin(draft.baseUrl);
  // A saved desktop key goes only to the origin it was entered for, so a new
  // origin needs the key again (or no key).
  const keyForAnotherAddress =
    managedKeys &&
    savedManagedKey &&
    !draft.removeKey &&
    !draft.key.trim() &&
    draftOrigin !== null &&
    draftOrigin !== keyOrigin(connection?.base_url);
  const originVariable = managedKeys ? null : keyOriginVariable(draft.envName);
  const timeout = draft.timeout.trim() ? Number(draft.timeout) : null;
  const valid =
    Boolean(draft.name.trim()) &&
    Boolean(draft.baseUrl.trim()) &&
    (timeout === null || (Number.isFinite(timeout) && timeout > 0)) &&
    !insecure &&
    !keyForAnotherAddress;
  const change = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const setSaving = (next: boolean) => {
    setSavingState(next);
    onSavingChange?.(next);
  };

  const credential = (): PyModelConnectionCredential => {
    if (managedKeys) return sendsKey ? { mode: "managed" } : { mode: "none" };
    const env = draft.envName.trim();
    return env ? { mode: "env", env } : { mode: "none" };
  };

  /** Check the preset's default address on the server and fill it in when found. */
  const runDetect = async () => {
    setDetection(null);
    try {
      const result = await detect.mutateAsync({ presetId: draft.preset });
      setDetection(result);
      if (result.reachable) change({ baseUrl: result.base_url });
    } catch (error) {
      toast.error(modelConfigurationErrorMessage(error));
    }
  };

  /** Save the connection and any typed key; resolves to whether both finished. */
  const save = async (): Promise<boolean> => {
    if (!valid || saving) return false;
    setSaving(true);
    const body = {
      name: draft.name.trim(),
      preset: draft.preset,
      base_url: draft.baseUrl.trim(),
      credential: credential(),
      compatibility: draft.compatibility,
      timeout_seconds: timeout,
    };
    let saved: PyModelConnection;
    try {
      saved = connection
        ? await update.mutateAsync({ connectionId: connection.id, body })
        : await create.mutateAsync(body);
    } catch (error) {
      toast.error(modelConfigurationErrorMessage(error));
      setSaving(false);
      return false;
    }
    const key = draft.key.trim();
    setDraft((current) => ({ ...current, key: "" }));
    // A save that drops the connection's variable deletes its desktop key,
    // including one withheld because it was entered for another address.
    const removedEnv =
      connection?.credential_env && !saved.credential_env
        ? connection.credential_env
        : null;
    try {
      if (managedKeys && bridge) {
        if (key && saved.credential_env)
          await applyCredentialChanges(bridge, [
            connectionKeyChange(saved.credential_env, key, saved.base_url),
          ]);
        else if (removedEnv) await deleteConnectionKey(bridge, removedEnv);
        await refreshCredentialDependents(queryClient, ownerId);
      }
      toast.success(
        connection ? t("connections.saved") : t("connections.added"),
      );
      onSaved(saved);
      return true;
    } catch (error) {
      toast.error(keyFailureMessage(error, saved.credential_env ?? null));
      return false;
    } finally {
      setSaving(false);
    }
  };
  useImperativeHandle(controllerRef, () => ({
    save,
    discard: () => change({ key: "" }),
  }));

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {presets.length > 1 ? (
        <div className="space-y-2">
          <Label htmlFor={`${formId}-preset`}>
            {t("connectionForm.serverType")}
          </Label>
          <Select
            value={draft.preset}
            disabled={saving}
            onValueChange={(value) => {
              const next = presets.find((item) => item.id === value);
              if (!next) return;
              setDetection(null);
              // Editing keeps the owner's URL and key; a new connection
              // takes the preset's defaults.
              setDraft(
                connection
                  ? { ...draft, preset: next.id }
                  : draftFromPreset(next),
              );
            }}
          >
            <SelectTrigger id={`${formId}-preset`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {presets.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={`${formId}-name`}>{t("connectionForm.name")}</Label>
        <Input
          id={`${formId}-name`}
          value={draft.name}
          maxLength={80}
          disabled={saving}
          onChange={(event) => change({ name: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${formId}-url`}>{t("connectionForm.baseUrl")}</Label>
        <div className="flex gap-2">
          <Input
            id={`${formId}-url`}
            value={draft.baseUrl}
            placeholder={baseUrlPlaceholder}
            inputMode="url"
            disabled={saving}
            onChange={(event) => {
              // A detected address no longer describes a hand-edited one.
              setDetection(null);
              change({ baseUrl: event.target.value });
            }}
          />
          {canDetect ? (
            <Button
              type="button"
              variant="outline"
              disabled={saving || detect.isPending}
              onClick={() => void runDetect()}
            >
              {detect.isPending
                ? t("connectionForm.detecting")
                : t("connectionForm.detect")}
            </Button>
          ) : null}
        </div>
        {detection && preset ? (
          <p
            className={cn(
              "text-xs",
              detection.reachable
                ? "text-muted-foreground"
                : "text-destructive",
            )}
            role="status"
          >
            {detectionMessage(detection, preset.label)}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {t("connectionForm.baseUrlHelp")}
        </p>
      </div>
      {managedKeys ? (
        <div className="space-y-2">
          <Label htmlFor={`${formId}-key`}>
            {t("connectionForm.apiKey")}{" "}
            <span className="text-muted-foreground font-normal">
              {preset?.expects_key ? t("required") : t("optional")}
            </span>
          </Label>
          <Input
            id={`${formId}-key`}
            type="password"
            autoComplete="off"
            value={draft.key}
            placeholder={savedManagedKey ? t("keys.replacePlaceholder") : ""}
            disabled={saving}
            onChange={(event) =>
              change({ key: event.target.value, removeKey: false })
            }
          />
          {savedManagedKey ? (
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={draft.removeKey}
                disabled={saving || Boolean(draft.key.trim())}
                onCheckedChange={(checked) =>
                  change({ removeKey: checked === true })
                }
              />
              {t("connectionForm.removeSavedKey")}
            </label>
          ) : null}
          {keyForAnotherAddress ? (
            <p className="text-destructive text-xs" role="alert">
              {t("connectionForm.keyForAnotherAddress")}
            </p>
          ) : null}
          <DesktopKeyStorageNote className="text-muted-foreground text-xs">
            {t("keys.encrypted")}
          </DesktopKeyStorageNote>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={`${formId}-env`}>
            {t("connectionForm.apiKeyVariable")}{" "}
            <span className="text-muted-foreground font-normal">
              {preset?.expects_key ? t("required") : t("optional")}
            </span>
          </Label>
          <Input
            id={`${formId}-env`}
            value={draft.envName}
            placeholder={preset?.suggested_credential_env ?? EXAMPLE_KEY_ENV}
            autoCapitalize="characters"
            disabled={saving}
            onChange={(event) => change({ envName: event.target.value })}
          />
          <p className="text-muted-foreground text-xs">
            {connection?.credential_env
              ? connection.credential_state === "configured"
                ? t("connectionForm.env.set")
                : originVariable
                  ? t("connectionForm.env.notUsable")
                  : t("connectionForm.env.notSet")
              : t("connectionForm.env.setVariable")}
          </p>
          {originVariable && draftOrigin ? (
            <p className="text-muted-foreground text-xs">
              {t("connectionForm.env.origin", {
                variable: originVariable,
                origin: draftOrigin,
              })}
            </p>
          ) : null}
        </div>
      )}
      {insecure ? (
        <p className="text-destructive text-xs" role="alert">
          {t("connectionForm.insecureKey")}
        </p>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={`${formId}-timeout`}>
          {t("connectionForm.timeout")}
        </Label>
        <Input
          id={`${formId}-timeout`}
          value={draft.timeout}
          inputMode="decimal"
          disabled={saving}
          onChange={(event) => change({ timeout: event.target.value })}
        />
        <p className="text-muted-foreground text-xs">
          {t("connectionForm.timeoutHelp")}
        </p>
      </div>
      <div className="space-y-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((value) => !value)}
        >
          {showAdvanced
            ? t("connectionForm.hideAdvanced")
            : t("connectionForm.advanced")}
        </Button>
        {showAdvanced ? (
          <div className="space-y-3">
            {COMPATIBILITY_OPTIONS.map((option) => {
              const help = compatibilityHelp(t, option);
              const helpId = `${formId}-${option}-help`;
              return (
                <div key={option} className="space-y-1">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.compatibility[option]}
                      disabled={saving}
                      aria-describedby={help ? helpId : undefined}
                      onCheckedChange={(checked) =>
                        change({
                          compatibility: {
                            ...draft.compatibility,
                            [option]: checked === true,
                          },
                        })
                      }
                    />
                    {compatibilityLabel(t, option)}
                  </label>
                  {help ? (
                    <p
                      id={helpId}
                      className="text-muted-foreground pl-6 text-xs"
                    >
                      {help}
                    </p>
                  ) : null}
                </div>
              );
            })}
            <div className="space-y-2">
              <Label htmlFor={`${formId}-reasoning`}>
                {t("connectionForm.reasoning.label")}
              </Label>
              <Select
                value={draft.compatibility.reasoning_mode}
                disabled={saving}
                onValueChange={(value) =>
                  change({
                    compatibility: {
                      ...draft.compatibility,
                      reasoning_mode:
                        value as Draft["compatibility"]["reasoning_mode"],
                    },
                  })
                }
              >
                <SelectTrigger id={`${formId}-reasoning`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai_effort">
                    {t("connectionForm.reasoning.openaiEffort")}
                  </SelectItem>
                  <SelectItem value="deepseek_thinking">
                    {t("connectionForm.reasoning.deepseekThinking")}
                  </SelectItem>
                  <SelectItem value="omit">
                    {t("connectionForm.reasoning.omit")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : null}
      </div>
      {footer({ saving, valid })}
    </form>
  );
}

/**
 * Edit a model connection in a dialog. The dialog stays open while a save,
 * including a desktop key change, is in flight.
 */
export function ModelConnectionDialog({
  open,
  onOpenChange,
  presets,
  connection,
  managedKeys,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presets: readonly PyModelConnectionPreset[];
  connection: PyModelConnection;
  managedKeys: boolean;
}) {
  const { t } = useTranslation("models");
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("connections.editNamed", { name: connection.name })}
          </DialogTitle>
          <DialogDescription>
            {t("connectionForm.editDescription")}
          </DialogDescription>
        </DialogHeader>
        <ModelConnectionForm
          presets={presets}
          connection={connection}
          managedKeys={managedKeys}
          onSaved={() => onOpenChange(false)}
          onSavingChange={setSaving}
          footer={({ saving: busy, valid }) => (
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={!valid || busy}>
                {busy ? t("actions.saving") : t("actions.save")}
              </Button>
            </DialogFooter>
          )}
        />
      </DialogContent>
    </Dialog>
  );
}
