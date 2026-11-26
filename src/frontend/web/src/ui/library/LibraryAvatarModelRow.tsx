import { useFormatters } from "@animama/product-ui/i18n";
import type { PyAvatarContent } from "@animama/runtime-contracts/api-types";
import { FileUp } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toContentSaveApiError } from "@/lib/content/contentSaveErrors";
import { useAnimas } from "@/query/hooks/useAnimas";
import { useAvatarFaceParts } from "@/query/hooks/useAvatarFaceParts";
import { useReplaceAvatarModel } from "@/query/mutations/useReplaceAvatarModel";
import { Button } from "@/ui/components/button";
import { checkCreationVrm } from "@/ui/create-anima/createAnimaFiles";
import { creatorErrorText } from "@/ui/create-anima/createAnimaErrors";

/**
 * The Library Avatar settings row that replaces a Local Avatar's VRM in
 * place. A chosen file passes Create Anima's browser checks, then the owner
 * reviews what changes (the Animas that use the Avatar, a face part
 * correction that stops applying) before the revision-fenced write.
 */
export function LibraryAvatarModelRow({
  itemId,
  onReplaced,
}: {
  itemId: string;
  onReplaced: (saved: PyAvatarContent) => void;
}) {
  const { t } = useTranslation("library");
  const { fileSize, list } = useFormatters();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  // One write attempt: a retry after an uncertain failure resends the same
  // operation and revision, so the server replays its saved result.
  const attempt = useRef<{ operationId: string; revision: string } | null>(
    null,
  );
  const [file, setFile] = useState<File | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Its revision fences the write; its correction is what stops applying.
  const faceParts = useAvatarFaceParts(itemId);
  const animas = useAnimas();
  const replace = useReplaceAvatarModel();
  const busy = checking || replace.isPending;
  const users = animas.data
    ?.filter((anima) => anima.avatar_catalog_item_id === itemId)
    .map((anima) => anima.display_name);

  const choose = async (next: File | undefined) => {
    if (!next) return;
    setError(null);
    setFile(null);
    attempt.current = null;
    setChecking(true);
    try {
      await checkCreationVrm(next);
      setFile(next);
    } catch (cause) {
      setError(
        creatorErrorText(cause, t("inventory.avatarSettings.model.invalid"))
          .message,
      );
    } finally {
      setChecking(false);
      // Choosing the same file again after Cancel still fires a change.
      if (input.current) input.current.value = "";
    }
  };

  const cancel = () => {
    setFile(null);
    setError(null);
    attempt.current = null;
  };

  const confirm = async () => {
    const revision = faceParts.data?.revision;
    if (!file || !revision) return;
    setError(null);
    attempt.current ??= { operationId: crypto.randomUUID(), revision };
    try {
      const saved = await replace.mutateAsync({
        itemId,
        expectedRevision: attempt.current.revision,
        file,
        operationId: attempt.current.operationId,
      });
      setFile(null);
      attempt.current = null;
      onReplaced(saved);
    } catch (cause) {
      const failure = toContentSaveApiError(cause);
      if (failure.code === "catalog_revision_conflict") {
        // Show what changed before the owner confirms again.
        attempt.current = null;
        setError(t("inventory.avatarSettings.model.changed"));
        void faceParts.refetch();
        void animas.refetch();
      } else {
        setError(failure.message);
      }
    }
  };

  return (
    <div className="border-border/60 bg-background grid gap-3 rounded-lg border px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">
            {t("inventory.avatarSettings.model.label")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("inventory.avatarSettings.model.description")}
          </p>
        </div>
        <input
          ref={input}
          id={inputId}
          className="sr-only"
          type="file"
          accept=".vrm,model/vrm,application/octet-stream"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void choose(event.target.files?.[0])}
        />
        <Button
          variant="outline"
          className="w-full shrink-0 sm:w-48"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <FileUp />{" "}
          {checking
            ? t("inventory.avatarSettings.model.checking")
            : t("inventory.avatarSettings.model.replace")}
        </Button>
      </div>
      {file ? (
        <div
          className="grid gap-2 border-t pt-3 text-sm"
          role="group"
          aria-labelledby={`${inputId}-confirm`}
        >
          <p id={`${inputId}-confirm`} className="font-medium break-words">
            {t("inventory.avatarSettings.model.confirmTitle", {
              file: file.name,
              size: fileSize(file.size),
            })}
          </p>
          <p className="text-muted-foreground text-xs">
            {users === undefined
              ? t("inventory.avatarSettings.model.usersUnknown")
              : users.length === 0
                ? t("inventory.avatarSettings.model.unused")
                : t("inventory.avatarSettings.model.usedBy", {
                    count: users.length,
                    names: list(users),
                  })}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("inventory.avatarSettings.model.keeps")}
          </p>
          {faceParts.isError ? (
            <p className="text-destructive text-xs">
              {t("inventory.avatarSettings.model.unreadable")}
            </p>
          ) : null}
          {faceParts.data?.face_parts ? (
            <p className="text-muted-foreground text-xs">
              {t("inventory.avatarSettings.model.faceParts")}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={cancel}>
              {t("inventory.avatarSettings.model.cancel")}
            </Button>
            <Button
              disabled={busy || !faceParts.data?.revision}
              onClick={() => void confirm()}
            >
              {replace.isPending
                ? t("inventory.avatarSettings.model.replacing")
                : t("inventory.avatarSettings.model.confirm")}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
