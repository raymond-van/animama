import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  modelConnectionLabel,
  modelDisplayName,
} from "@/lib/chat/model-catalog";
import { useAppSettingsOpener } from "@/stores/app-settings-request-store";
import { Button } from "@/ui/components/button";
import type { ChatModelSelectorControl } from "@/ui/components/chat-input";

import type { AnimaModelKeyState } from "./useAnimaModelKeyState";

/**
 * Above the composer when the Anima's model has no key, so a first message
 * does not just fail: it names the model and offers the way out. One action
 * switches to the model that can reply (through the picker's own switch, so
 * an open chat is treated the same), or opens the model list when the owner
 * has several; another opens App Settings → Models to add the key.
 */
export function ChatModelKeyNotice({
  animaName,
  state,
  disabled = false,
  selector,
}: {
  animaName: string;
  state: AnimaModelKeyState;
  /** The picker is busy (a reply is streaming or a switch is saving). */
  disabled?: boolean;
  selector: () => ChatModelSelectorControl | null;
}) {
  const { t } = useTranslation("chat");
  const openSettings = useAppSettingsOpener();
  const [switching, setSwitching] = useState(false);
  const { model, replacement, hasAbleModel } = state;

  const switchToReplacement = async () => {
    if (!replacement) return;
    setSwitching(true);
    try {
      await selector()?.select(replacement);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div
      role="status"
      className="border-warning/35 bg-background/80 mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
    >
      <p className="min-w-40 flex-1">
        {t("composer.modelKey.notice", {
          anima: animaName,
          model: modelDisplayName(model),
          provider: modelConnectionLabel(model),
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        {replacement ? (
          <Button
            type="button"
            size="sm"
            disabled={disabled || switching}
            onClick={() => void switchToReplacement()}
          >
            {t("composer.modelKey.use", {
              model: modelDisplayName(replacement),
            })}
          </Button>
        ) : hasAbleModel ? (
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() => selector()?.openModels()}
          >
            {t("composer.modelKey.choose")}
          </Button>
        ) : null}
        {openSettings ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => openSettings("model-connections")}
          >
            {t("composer.modelKey.settings")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
