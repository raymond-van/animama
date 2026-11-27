import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type {
  PyConfiguredModel,
  PyModelConnection,
  PyModelUsage,
} from "@animama/runtime-contracts/api-types";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import {
  useRemoveModel,
  useRemoveModelConnection,
} from "@/query/mutations/useModelConfiguration";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";

import {
  modelConfigurationErrorMessage,
  modelInUseUsage,
  removalConsequences,
  removalUsageSummary,
} from "./model-configuration-state";
import { deleteConnectionKey } from "./ModelConnectionDialog";

/** A connection or model to remove, with its usage once the server reports it. */
export type ModelRemoval =
  | {
      kind: "connection";
      connection: PyModelConnection;
      usage: PyModelUsage | null;
    }
  | { kind: "model"; model: PyConfiguredModel; usage: PyModelUsage | null };

/**
 * Removing a model connection or model, shared by App Settings → Models and
 * setup's AI step. An unused item goes at once; one in use, or a connection
 * with a saved desktop key, asks first in the returned dialog. Removing a
 * connection also deletes its desktop key.
 *
 * `managedKeys` says whether desktop keys are available
 * (`useDesktopCredentialsAvailable`).
 */
export function useModelRemoval(managedKeys: boolean): {
  startRemoval: (target: ModelRemoval) => void;
  dialog: ReactNode;
} {
  const { t } = useTranslation("models");
  const platform = useRuntimePlatform();
  const removeConnection = useRemoveModelConnection();
  const removeModel = useRemoveModel();
  const [removal, setRemoval] = useState<ModelRemoval | null>(null);
  const [removing, setRemoving] = useState(false);

  const credentials =
    platform.kind === "desktop"
      ? platform.desktopBridge.credentials
      : undefined;

  /**
   * The vault variable that may hold a connection's desktop key. Removing the
   * connection deletes it, even a key the backend withholds because it was
   * entered for another address.
   */
  const managedKeyEnv = (connection: PyModelConnection): string | null =>
    managedKeys && connection.credential_env?.startsWith("ANIMAMA_CONNECTION_")
      ? connection.credential_env
      : null;
  /** A saved key in use; removal asks first, because it cannot be recovered. */
  const savedKey = (connection: PyModelConnection): string | null =>
    connection.credential_state === "configured"
      ? managedKeyEnv(connection)
      : null;

  /**
   * Without confirmation the server removes only an unused item and otherwise
   * refuses with its usage, which the dialog then shows.
   */
  const remove = async (target: ModelRemoval, confirm: boolean) => {
    try {
      if (target.kind === "connection")
        await removeConnection.mutateAsync({
          connectionId: target.connection.id,
          confirm,
        });
      else
        await removeModel.mutateAsync({
          modelProviderId: target.model.id,
          confirm,
        });
    } catch (error) {
      const usage = confirm ? null : modelInUseUsage(error);
      if (usage) setRemoval({ ...target, usage });
      else toast.error(modelConfigurationErrorMessage(error));
      return;
    }
    setRemoval(null);
    toast.success(
      target.kind === "connection"
        ? t("connections.removed")
        : t("ownerModel.removed"),
    );
    const env =
      target.kind === "connection" ? managedKeyEnv(target.connection) : null;
    if (env && credentials) await deleteConnectionKey(credentials, env);
  };

  /** A connection with a saved key always confirms first: the key cannot be recovered. */
  const startRemoval = (target: ModelRemoval) => {
    if (target.kind === "connection" && savedKey(target.connection))
      setRemoval(target);
    else void remove(target, false);
  };

  const confirmRemoval = async () => {
    if (!removal) return;
    setRemoving(true);
    // Confirm only once the usage has been shown.
    await remove(removal, removal.usage !== null);
    setRemoving(false);
  };

  const dialog = (
    <Dialog
      open={Boolean(removal)}
      onOpenChange={(open) => !open && !removing && setRemoval(null)}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t("removal.title", {
              name:
                (removal?.kind === "connection"
                  ? removal.connection.name
                  : removal?.model.model_label) ?? "",
            })}
          </DialogTitle>
          <DialogDescription>
            {[
              removal?.usage
                ? `${removalUsageSummary(removal.usage)} ${removalConsequences(removal.usage)}`
                : null,
              removal?.kind === "connection" && savedKey(removal.connection)
                ? t("removal.savedKeyDeleted")
                : null,
            ]
              .filter(Boolean)
              .join(" ")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={removing}
            onClick={() => setRemoval(null)}
          >
            {t("actions.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={removing}
            onClick={() => void confirmRemoval()}
          >
            {removing ? t("actions.removing") : t("actions.remove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { startRemoval, dialog };
}
