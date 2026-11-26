import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@animama/product-ui/i18n";
import { POCKET_VOICE_ENCODER_ASSET_ID } from "@/lib/speech/pocket/voice-cloning-encoder";
import {
  useModelAssets,
  useOperatorManagedModelAssets,
} from "@/query/hooks/useModelAssets";
import { useModelAssetAction } from "@/query/mutations/useModelAssetActions";
import { modelDownloadsEnded } from "@/query/model-download-coordination";
import { VoiceCloneLibrary } from "@/ui/animas/VoiceCloneLibrary";
import { Button } from "@/ui/components/button";
import {
  modelDownloadsEndedNote,
  operatorManagedModelsNote,
} from "./operator-managed-models";
import { SavedVoiceClones } from "./SavedVoiceClones";

/**
 * Reuse the Anima voice-cloning form without tying creation to a selected
 * Anima, then list the saved clones so a new one stays visible and can be
 * given to the current Anima.
 */
export function VoiceCloneSettings() {
  const [cloning, setCloning] = useState(false);
  return (
    <div className="space-y-4">
      <VoiceCloningStatus busy={cloning} />
      <VoiceCloneLibrary
        heading={false}
        disabled={false}
        deleting={null}
        onDeleteClose={() => {}}
        onBusyChange={setCloning}
      />
      <SavedVoiceClones busy={cloning} />
    </div>
  );
}

/**
 * Managing the encoder never changes or deletes a saved clone or its original
 * sample. An operator-provided encoder shows only its state; once downloads
 * have ended, an encoder that was never installed is explained, not offered.
 */
function VoiceCloningStatus({ busy = false }: { busy?: boolean }) {
  const { t } = useTranslation("voice");
  const { fileSize, number } = useFormatters();
  const assets = useModelAssets({ enabled: true });
  const operatorManaged = useOperatorManagedModelAssets();
  const action = useModelAssetAction();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const downloadsEnded = modelDownloadsEnded(assets.data);
  const asset = assets.data?.assets.find(
    (item) => item.id === POCKET_VOICE_ENCODER_ASSET_ID,
  );
  const installed = asset?.status === "installed";
  const downloading = asset?.status === "downloading";
  const progress =
    downloading && asset.total_bytes
      ? Math.min(1, (asset.bytes_downloaded ?? 0) / asset.total_bytes)
      : undefined;
  const retry =
    asset?.status === "failed" ||
    assets.retryAssetIds?.has(POCKET_VOICE_ENCODER_ASSET_ID);
  const change = (operation: "install" | "remove") =>
    action.mutate({
      action: operation,
      assetId: POCKET_VOICE_ENCODER_ASSET_ID,
    });
  const blockedReason = action.blockedReason;
  const size = asset ? fileSize(asset.size_bytes) : "";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-40 flex-1">
          <p className="text-muted-foreground text-xs">
            {t("cloning.description")}
          </p>
        </div>
        {operatorManaged ? null : (
          <>
            {asset && !installed && !downloading && !downloadsEnded ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  busy ||
                  action.busy ||
                  action.isPending ||
                  Boolean(blockedReason)
                }
                onClick={() => change("install")}
              >
                {retry ? t("cloning.retry") : t("cloning.download")}
              </Button>
            ) : null}
            {downloading ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={action.isPending}
                onClick={() => change("remove")}
              >
                {t("downloads.cancel")}
              </Button>
            ) : null}
            {installed ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy || action.isPending || action.busy}
                onClick={() => {
                  if (!confirmRemove) setConfirmRemove(true);
                  else {
                    setConfirmRemove(false);
                    change("remove");
                  }
                }}
              >
                {confirmRemove
                  ? t("downloads.confirmRemoval")
                  : t("cloning.remove")}
              </Button>
            ) : null}
          </>
        )}
      </div>
      <p role="status" className="text-muted-foreground text-xs">
        {installed
          ? t("cloning.installed")
          : downloading
            ? progress === 1
              ? t("cloning.verifying")
              : t("downloads.downloading", {
                  percent: number(progress ?? 0, {
                    style: "percent",
                    maximumFractionDigits: 0,
                  }),
                })
            : asset
              ? operatorManaged || downloadsEnded
                ? t("downloads.notAvailable")
                : retry
                  ? t("downloads.sizeRetry", { size })
                  : t("downloads.size", { size })
              : assets.isError
                ? t("cloning.listUnavailable")
                : t("cloning.checking")}
      </p>
      {operatorManaged ? (
        <p className="text-muted-foreground text-xs">
          {operatorManagedModelsNote()}
        </p>
      ) : downloadsEnded && asset && !installed && !downloading ? (
        <p className="text-muted-foreground text-xs">
          {modelDownloadsEndedNote()}
        </p>
      ) : null}
      {downloading ? (
        <progress
          className="w-full"
          max={1}
          value={progress}
          aria-label={t("cloning.progressLabel")}
        />
      ) : null}
      {blockedReason || action.isError ? (
        <p role="alert" className="text-muted-foreground text-xs">
          {blockedReason || t("cloning.changeFailed")}
        </p>
      ) : null}
      {asset?.status === "failed" ? (
        <p role="status" className="text-muted-foreground text-xs">
          {t("cloning.downloadFailed")}
        </p>
      ) : null}
    </div>
  );
}
