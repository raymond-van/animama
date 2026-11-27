import type { PyAvatarContent } from "@animama/runtime-contracts/api-types";
import { Stethoscope } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAvatarSettingsAvailable } from "@/query/hooks/useAvatarSettings";
import { AvatarDiagnosticsDialog } from "@/ui/animas/AvatarDiagnosticsDialog";
import { AvatarSettingsRows } from "@/ui/animas/AvatarSettingsRows";
import { useAvatarItemFileTraits } from "@/ui/animas/useAvatarItemFileTraits";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";
import { LibraryAvatarModelRow } from "./LibraryAvatarModelRow";

/** The Avatar card a Library settings dialog belongs to. */
export type LibraryAvatarTarget = {
  itemId: string;
  source: "included" | "local";
  name: string;
};

/**
 * A Library Avatar's settings (wind and, for files with lilToon materials,
 * Materials) and its Diagnostics. The settings are the Anima settings' rows
 * for the same Avatar item, so a change applies wherever the Avatar is used,
 * the preview dock included. Where the runtime keeps no settings (the hosted
 * app) it offers no settings rows. A Local Avatar also offers Replace VRM
 * everywhere; `onReplaced` receives the new revision.
 */
export function LibraryAvatarSettingsDialog({
  avatar,
  onClose,
  onReplaced,
}: {
  avatar: LibraryAvatarTarget;
  onClose: () => void;
  onReplaced?: (saved: PyAvatarContent) => void;
}) {
  const { t } = useTranslation("library");
  const { t: tSettings } = useTranslation("settings");
  const { available } = useAvatarSettingsAvailable();
  const { vrmSha256 } = useAvatarItemFileTraits(avatar.itemId, available);
  const [diagnostics, setDiagnostics] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("inventory.avatarSettings.title")}</DialogTitle>
          <DialogDescription className="break-words">
            {available
              ? t("inventory.avatarSettings.description", { name: avatar.name })
              : t("inventory.avatarSettings.diagnosticsOnly", {
                  name: avatar.name,
                })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <AvatarSettingsRows itemId={avatar.itemId} vrmSha256={vrmSha256} />
          {avatar.source === "local" && onReplaced ? (
            <LibraryAvatarModelRow
              itemId={avatar.itemId}
              onReplaced={onReplaced}
            />
          ) : null}
          <div className="border-border/60 bg-background flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">
                {tSettings("animaSettings.rows.avatar_diagnostics.label")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("inventory.avatarSettings.diagnostics")}
              </p>
            </div>
            <Button
              variant="outline"
              className="w-full shrink-0 sm:w-48"
              onClick={() => setDiagnostics(true)}
            >
              <Stethoscope />{" "}
              {tSettings("animaSettings.rows.avatar_diagnostics.open")}
            </Button>
          </div>
        </div>
        <AvatarDiagnosticsDialog
          source={{
            kind: "avatar",
            itemId: avatar.itemId,
            source: avatar.source,
          }}
          open={diagnostics}
          onOpenChange={setDiagnostics}
        />
      </DialogContent>
    </Dialog>
  );
}
