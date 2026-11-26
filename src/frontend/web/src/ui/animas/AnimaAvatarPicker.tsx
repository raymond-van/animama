import { useFormatters } from "@animama/product-ui/i18n";
import type { PyAvatarContent } from "@animama/runtime-contracts/api-types";
import { Check, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ContentSaveApiError } from "@/lib/content/contentSaveErrors";
import { apiErrorLine, type ApiErrorText } from "@/lib/errors/apiError";
import { poolChangeFailureText } from "@/lib/errors/loadoutErrors";
import { cn } from "@/lib/utils";
import {
  useAnimaCreationOperations,
  useAvatarContents,
} from "@/query/hooks/useAnimaCreation";
import { useAnimaLoadout } from "@/query/hooks/useAnimaLoadout";
import { useAvatarSelection } from "@/query/mutations/useAvatarSelection";
import { useAvatarRuntimeStore } from "@/stores/avatar-runtime-store";
import { useOptionalMountedAnimaRuntimeContent } from "@/ui/app/AnimaRouteProviders";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";
import { Input } from "@/ui/components/input";
import { AvatarThumbnail } from "@/ui/avatar-preview/AvatarThumbnail";
import { creatorErrorText } from "@/ui/create-anima/createAnimaErrors";
import { checkCreationVrm } from "@/ui/create-anima/createAnimaFiles";

/**
 * Choose the Avatar an existing Anima uses: any Included or Local Avatar, or
 * a VRM uploaded and saved here as a new Local Avatar. Only the Loadout's
 * Avatar changes; the Anima keeps its identity, memories, chats, Actions and
 * voice. Opened in this Anima's chat, it waits for any reply and its speech to
 * end, then remounts the chat before closing so it shows the new model; a
 * reply that starts while the change saves leaves the model to the next load.
 */
export function AnimaAvatarPicker({
  animaId,
  animaName,
  open,
  onOpenChange,
}: {
  animaId: string;
  animaName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  const { fileSize } = useFormatters();
  const loadout = useAnimaLoadout(open ? animaId : null);
  const avatars = useAvatarContents(open);
  const operations = useAnimaCreationOperations();
  const selection = useAvatarSelection(animaId);
  const mounted = useOptionalMountedAnimaRuntimeContent();
  const fileInput = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<ApiErrorText | null>(null);
  const [changing, setChanging] = useState(false);
  // In this Anima's chat, a change waits for the reply and its speech: the
  // chat reloads its runtime for the new Avatar, which would cut them off.
  const inChat = mounted?.animaId === animaId;
  const chatReplying = useAvatarRuntimeStore((state) =>
    Boolean(state.activeRunId || state.activeSpeechRunId),
  );
  const waitForReply = inChat && chatReplying;

  const current = loadout.data?.avatar_source?.catalog_item_id ?? null;
  const selected = chosen ?? current;
  const items = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (avatars.data ?? []).filter(
      (item) => !query || item.name.toLocaleLowerCase().includes(query),
    );
  }, [avatars.data, search]);
  const busy = working || changing || selection.isPending;

  const reset = () => {
    setChosen(null);
    setSearch("");
    setFile(null);
    setName("");
    setError(null);
  };

  const pickFile = async (next: File | undefined) => {
    if (!next) return;
    setError(null);
    setWorking(true);
    try {
      await checkCreationVrm(next);
      setFile(next);
      setName(next.name.replace(/\.vrm$/i, ""));
    } catch (cause) {
      setFile(null);
      setError(
        creatorErrorText(cause, t("animaSettings.avatarPicker.readFailed")),
      );
    } finally {
      setWorking(false);
    }
  };

  /** Save the uploaded VRM as a Local Avatar and choose it. */
  const saveUpload = async () => {
    if (!file || !name.trim()) return;
    setError(null);
    setWorking(true);
    try {
      const saved = await operations.saveAvatar.mutateAsync({
        file,
        name: name.trim(),
      });
      setFile(null);
      setName("");
      setChosen(saved.item_id);
      // The list refreshes after the save; keep it current for the choice.
      await avatars.refetch();
    } catch (cause) {
      setError(
        cause instanceof ContentSaveApiError &&
          cause.code === "content_path_exists"
          ? { message: t("animaSettings.avatarPicker.nameUsed"), detail: null }
          : creatorErrorText(cause, t("animaSettings.avatarPicker.saveFailed")),
      );
    } finally {
      setWorking(false);
    }
  };

  const use = async () => {
    const avatar = avatars.data?.find((item) => item.item_id === selected);
    const revision = loadout.data?.revision;
    if (
      !avatar ||
      revision === undefined ||
      avatar.item_id === current ||
      waitForReply
    )
      return;
    setError(null);
    setChanging(true);
    try {
      await selection.mutateAsync({ avatar, expectedRevision: revision });
      const words = { anima: animaName, avatar: avatar.name };
      if (inChat && mounted) {
        const { activeRunId, activeSpeechRunId } =
          useAvatarRuntimeStore.getState();
        if (activeRunId || activeSpeechRunId) {
          // A reply began while the change was saving (a voice turn): keep it.
          toast.success(t("animaSettings.avatarPicker.changedNextLoad", words));
        } else {
          // Reload this chat's runtime before closing, so the owner cannot
          // leave for another Anima while the reload is under way.
          await mounted.remountLatest();
          toast.success(t("animaSettings.avatarPicker.changed", words));
        }
      } else {
        toast.success(t("animaSettings.avatarPicker.changed", words));
      }
      reset();
      onOpenChange(false);
    } catch (cause) {
      setChosen(null);
      setError(
        poolChangeFailureText(
          cause,
          t("animaSettings.avatarPicker.changedElsewhere"),
          t("animaSettings.avatarPicker.changeFailed"),
        ),
      );
    } finally {
      setChanging(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("animaSettings.avatarPicker.title")}</DialogTitle>
          <DialogDescription>
            {t("animaSettings.avatarPicker.description", { name: animaName })}
          </DialogDescription>
        </DialogHeader>
        <input
          ref={fileInput}
          className="sr-only"
          type="file"
          accept=".vrm,model/vrm,application/octet-stream"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const next = event.target.files?.[0];
            event.target.value = "";
            void pickFile(next);
          }}
        />
        <div className="flex items-center gap-2">
          <Input
            className="min-w-0 flex-1"
            aria-label={t("animaSettings.avatarPicker.search")}
            placeholder={t("animaSettings.avatarPicker.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            className="shrink-0"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <Upload /> {t("animaSettings.avatarPicker.upload")}
          </Button>
        </div>
        {file ? (
          <div className="grid gap-2 rounded-lg border p-3 text-sm">
            <p className="break-words">
              {t("animaSettings.avatarPicker.uploadFile", {
                file: file.name,
                size: fileSize(file.size),
              })}
            </p>
            <label className="grid gap-1 text-xs">
              {t("animaSettings.avatarPicker.uploadName")}
              <Input
                value={name}
                maxLength={120}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setFile(null)}
              >
                {t("animaSettings.avatarPicker.cancelUpload")}
              </Button>
              <Button
                disabled={busy || !name.trim()}
                onClick={() => void saveUpload()}
              >
                {t("animaSettings.avatarPicker.saveUpload")}
              </Button>
            </div>
          </div>
        ) : null}
        <div className="max-h-[50vh] overflow-y-auto">
          {avatars.isLoading || loadout.isLoading ? (
            <p role="status" className="text-muted-foreground text-sm">
              {t("animaSettings.avatarPicker.loading")}
            </p>
          ) : avatars.isError || loadout.isError ? (
            <div role="alert" className="space-y-2 text-sm">
              <p>{t("animaSettings.avatarPicker.loadFailed")}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void avatars.refetch();
                  void loadout.refetch();
                }}
              >
                {t("animaSettings.avatarPicker.retry")}
              </Button>
            </div>
          ) : !items.length ? (
            <p className="text-muted-foreground rounded-xl border border-dashed p-5 text-sm">
              {t("animaSettings.avatarPicker.noMatches")}
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-label={t("animaSettings.avatarPicker.groupLabel")}
              className="grid grid-cols-2 gap-3 sm:grid-cols-3"
            >
              {items.map((item: PyAvatarContent) => {
                const checked = item.item_id === selected;
                return (
                  <label
                    key={item.item_id}
                    className={cn(
                      "focus-within:ring-ring relative flex cursor-pointer flex-col gap-2 rounded-xl border p-3 focus-within:ring-2",
                      checked
                        ? "border-primary bg-primary/5"
                        : "bg-background hover:bg-muted/30",
                      busy && "pointer-events-none opacity-60",
                    )}
                  >
                    <input
                      className="sr-only"
                      type="radio"
                      name={`anima-avatar-${animaId}`}
                      checked={checked}
                      disabled={busy}
                      value={item.item_id}
                      onChange={() => {
                        setError(null);
                        setChosen(item.item_id);
                      }}
                    />
                    <AvatarThumbnail
                      itemId={item.item_id}
                      portraitUrl={item.portrait?.url}
                    />
                    <span className="flex items-center justify-between gap-2 text-sm font-medium">
                      <span className="min-w-0 break-words">{item.name}</span>
                      {checked ? (
                        <Check
                          className="text-primary size-4 shrink-0"
                          aria-hidden="true"
                        />
                      ) : null}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {item.item_id === current
                        ? t("animaSettings.avatarPicker.current")
                        : item.source === "local"
                          ? t("animaSettings.avatarPicker.local")
                          : t("animaSettings.avatarPicker.included")}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        {waitForReply ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t("animaSettings.avatarPicker.waitForReply", { name: animaName })}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {apiErrorLine(error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            {t("animaSettings.avatarPicker.cancel")}
          </Button>
          <Button
            disabled={busy || waitForReply || !selected || selected === current}
            onClick={() => void use()}
          >
            {changing
              ? t("animaSettings.avatarPicker.using")
              : t("animaSettings.avatarPicker.use")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
