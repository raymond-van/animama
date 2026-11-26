import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAvatarContents } from "@/query/hooks/useAnimaCreation";
import { useAnimaLoadout } from "@/query/hooks/useAnimaLoadout";
import { useAnimas } from "@/query/hooks/useAnimas";
import { AnimaAvatarPicker } from "@/ui/animas/AnimaAvatarPicker";
import { Button } from "@/ui/components/button";

/** The Anima's current Avatar, with Change Avatar opening the picker. */
export function AnimaAvatarChoiceRow({ animaId }: { animaId: string }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const loadout = useAnimaLoadout(animaId);
  const avatars = useAvatarContents();
  const animas = useAnimas();
  const itemId = loadout.data?.avatar_source?.catalog_item_id ?? null;
  const avatarName = avatars.data?.find(
    (item) => item.item_id === itemId,
  )?.name;
  const animaName =
    animas.data?.find((anima) => anima.id === animaId)?.display_name ?? "";
  return (
    <div className="border-border/60 bg-background flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">
          {t("animaSettings.rows.avatar_choice.label")}
        </p>
        <p className="text-muted-foreground text-xs break-words">
          {avatarName
            ? t("animaSettings.rows.avatar_choice.current", {
                name: avatarName,
              })
            : t("animaSettings.rows.avatar_choice.description")}
        </p>
      </div>
      <Button
        variant="outline"
        className="w-full shrink-0 sm:w-48"
        disabled={!loadout.data}
        onClick={() => setOpen(true)}
      >
        <RefreshCw /> {t("animaSettings.rows.avatar_choice.open")}
      </Button>
      <AnimaAvatarPicker
        animaId={animaId}
        animaName={animaName}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
