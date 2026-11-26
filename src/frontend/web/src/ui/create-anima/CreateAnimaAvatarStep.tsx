import { Check, Upload } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useFormatters } from "@animama/product-ui/i18n";

import type {
  ItemRevisionRef,
  PyAvatarContent,
} from "@animama/runtime-contracts/sdk";
import { ContentSaveApiError } from "@/lib/content/contentSaveErrors";
import type { ApiErrorText } from "@/lib/errors/apiError";
import { cn } from "@/lib/utils";
import type {
  AnimaCreationOperations,
  AnimaCreationSources,
} from "@/query/hooks/useAnimaCreation";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/ui/components/dialog";
import { Input } from "@/ui/components/input";
import { ModelLink } from "@/ui/components/model-link";
import { contentEntryName } from "@/lib/content/nameIdentifiers";
import { itemReference } from "./createAnimaContent";
import { AvatarThumbnail } from "@/ui/avatar-preview/AvatarThumbnail";
import { sameRef, type CreateAnimaDraft } from "./createAnimaDraft";
import { creatorErrorText } from "./createAnimaErrors";
import { checkCreationVrm } from "./createAnimaFiles";
import type { CreationStageAvatar } from "./CreateAnimaStage";
import { CreateAnimaUploadDiagnostics } from "./CreateAnimaUploadDiagnostics";

/** The converter's guide for MikuMikuDance (PMX) models, which upload only as VRM. */
const MMD_CONVERTER_GUIDE =
  "https://github.com/raymond-van/animama-avatar-converter#mmd-models";

/** The server remains authoritative; offer only an unambiguous caller-editable collision. */
export function avatarCollisionTarget(
  name: string,
  items: PyAvatarContent[],
): PyAvatarContent | undefined {
  const entryName = contentEntryName(name);
  if (!entryName) return undefined;
  const filename = `${entryName}.vrm`;
  const matches = items.filter(
    (item) =>
      item.source === "local" &&
      item.editable &&
      item.files?.some((file) => file.filename === filename),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

const UNLOADED_STAGE: CreationStageAvatar = { avatar: null, status: "loading" };

export function CreateAnimaAvatarStep({
  draft,
  sources,
  operations,
  file,
  fileInputRef,
  onFile,
  onSelect,
  onWorking,
  stageAvatar = UNLOADED_STAGE,
}: {
  draft: CreateAnimaDraft;
  sources: AnimaCreationSources;
  operations: AnimaCreationOperations;
  file: File | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFile: (file: File | null) => void;
  onSelect: (source: ItemRevisionRef, meaningful?: boolean) => Promise<void>;
  onWorking: (working: boolean) => void;
  /** The stage's Avatar for the chosen file, for its Diagnostics status. */
  stageAvatar?: CreationStageAvatar;
}) {
  const { t } = useTranslation("create");
  const formatters = useFormatters();
  const avatars = sources.avatars.data ?? [];
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(8);
  const [name, setName] = useState(file?.name.replace(/\.vrm$/i, "") ?? "");
  const [error, setError] = useState<ApiErrorText | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collision, setCollision] = useState<PyAvatarContent | null>(null);
  const request = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const currentRequest = request;
    return () => {
      alive.current = false;
      currentRequest.current++;
    };
  }, []);

  const working = (value: boolean) => {
    setBusy(value);
    onWorking(value);
  };
  const choose = async (source: ItemRevisionRef) => {
    if (busy) return;
    working(true);
    setError(null);
    setNotice(null);
    try {
      await onSelect(source);
      onFile(null);
    } catch (reason) {
      setError(creatorErrorText(reason, t("avatarStep.needsAttention")));
    } finally {
      if (alive.current) working(false);
    }
  };
  const selectFile = async (next: File | undefined) => {
    if (!next || busy) return;
    const token = ++request.current;
    working(true);
    setError(null);
    setNotice(null);
    try {
      await checkCreationVrm(next);
      if (!alive.current || request.current !== token) return;
      onFile(next);
      setName(next.name.replace(/\.vrm$/i, ""));
    } catch (reason) {
      if (alive.current && request.current === token)
        setError(creatorErrorText(reason, t("avatarStep.readFailed")));
    } finally {
      if (alive.current && request.current === token) working(false);
    }
  };
  const save = async (replace?: PyAvatarContent) => {
    if (!file || busy || !name.trim()) return;
    working(true);
    setError(null);
    setCollision(null);
    try {
      const saved = await operations.saveAvatar.mutateAsync({
        file,
        name: name.trim(),
        replace: replace ? itemReference(replace) : undefined,
      });
      if (!alive.current) return;
      await onSelect(itemReference(saved));
      onFile(null);
      setNotice(
        !replace && avatars.some((item) => item.item_id === saved.item_id)
          ? t("avatarStep.alreadySaved")
          : t("avatarStep.saved"),
      );
    } catch (reason) {
      if (!alive.current) return;
      if (
        reason instanceof ContentSaveApiError &&
        reason.code === "content_path_exists"
      ) {
        const fresh = await sources.avatars.refetch();
        setCollision(
          avatarCollisionTarget(name, fresh.data ?? avatars) ?? null,
        );
        setError({ message: t("avatarStep.nameUsed"), detail: null });
      } else
        setError(
          reason instanceof ContentSaveApiError &&
            reason.code === "avatar_in_use_choose_new_name"
            ? { message: t("avatarStep.inUse"), detail: null }
            : creatorErrorText(reason, t("avatarStep.saveFailed")),
        );
    } finally {
      if (alive.current) working(false);
    }
  };
  const filtered = avatars.filter((item) =>
    `${item.name} ${item.description ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-5">
      <section
        id="creation-avatar"
        tabIndex={-1}
        aria-label={t("avatarStep.label")}
      >
        <Input
          ref={fileInputRef}
          id="creation-vrm-file"
          className="hidden"
          type="file"
          accept=".vrm"
          aria-label={t("avatarStep.fileInput")}
          aria-hidden="true"
          tabIndex={-1}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.files?.[0];
            event.target.value = "";
            void selectFile(next);
          }}
        />
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              className="min-w-0 flex-1"
              aria-label={t("avatarStep.search")}
              placeholder={t("avatarStep.searchPlaceholder")}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(8);
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={busy}
              aria-label={t("avatarStep.upload")}
              title={t("avatarStep.upload")}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-4" />
              {/* Phones give the search the room; the stage also offers upload. */}
              <span className="hidden sm:inline">{t("avatarStep.upload")}</span>
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            <Trans
              t={t}
              i18nKey="avatarStep.mmdHint"
              components={{ link: <ModelLink href={MMD_CONVERTER_GUIDE} /> }}
            />
          </p>
          {sources.avatars.isLoading ? (
            <p role="status" className="text-muted-foreground text-sm">
              {t("avatarStep.loading")}
            </p>
          ) : sources.avatars.isError ? (
            <div role="alert" className="space-y-2 text-sm">
              <p>{t("avatarStep.loadFailed")}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void sources.avatars.refetch()}
              >
                {t("avatarStep.retry")}
              </Button>
            </div>
          ) : !filtered.length ? (
            <p className="text-muted-foreground rounded-xl border border-dashed p-5 text-sm">
              {search ? t("avatarStep.noMatches") : t("avatarStep.empty")}
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-label={t("avatarStep.groupLabel")}
              className="grid grid-cols-2 gap-3"
            >
              {filtered.slice(0, limit).map((item) => {
                const checked = sameRef(draft.avatar, item);
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
                      name="creation-avatar-source"
                      aria-label={
                        item.source === "local"
                          ? t("avatarStep.optionLabel.local", {
                              name: item.name,
                            })
                          : t("avatarStep.optionLabel.included", {
                              name: item.name,
                            })
                      }
                      checked={checked}
                      disabled={busy}
                      value={item.item_id}
                      onChange={() => void choose(itemReference(item))}
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
                      {item.source === "local"
                        ? t("sources.local")
                        : t("sources.included")}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {filtered.length > limit ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLimit((value) => value + 12)}
            >
              {t("avatarStep.showMore")}
            </Button>
          ) : null}
        </div>
        {file ? (
          <div className="mt-4 space-y-3 rounded-xl border p-4">
            <p className="text-sm break-all">
              {t("avatarStep.previewing", {
                name: file.name,
                size: formatters.fileSize(file.size),
              })}
            </p>
            <CreateAnimaUploadDiagnostics file={file} stage={stageAvatar} />
            <label htmlFor="creation-vrm-name" className="text-sm font-medium">
              {t("avatarStep.saveAs")}
            </label>
            <Input
              id="creation-vrm-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setCollision(null);
              }}
              disabled={busy}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void save()}
                disabled={busy || !name.trim()}
              >
                {busy ? t("avatarStep.saving") : t("avatarStep.save")}
              </Button>
              <Button
                variant="outline"
                onClick={() => onFile(null)}
                disabled={busy}
              >
                {t("avatarStep.cancelUpload")}
              </Button>
            </div>
          </div>
        ) : draft.needs_file_reselection ? (
          <div className="mt-4 space-y-2 rounded-xl border p-4 text-sm">
            <p>{t("avatarStep.reselect")}</p>
            <Button variant="outline" onClick={() => onFile(null)}>
              {t("avatarStep.discardUpload")}
            </Button>
          </div>
        ) : null}
      </section>
      {error ? (
        <p role="alert" className="text-destructive text-sm break-words">
          {error.message}
          {error.detail ? (
            <span className="text-muted-foreground mt-1 block text-xs">
              {error.detail}
            </span>
          ) : null}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-muted-foreground text-sm">
          {notice}
        </p>
      ) : null}
      {collision ? (
        <Dialog open onOpenChange={(open) => !open && setCollision(null)}>
          <DialogContent>
            <DialogTitle>{t("avatarStep.collision.title")}</DialogTitle>
            <DialogDescription>
              {t("avatarStep.collision.description")}
            </DialogDescription>
            <p className="text-sm break-words">
              {t("avatarStep.collision.item", {
                name: collision.name,
                id: collision.item_id,
              })}
            </p>
            <p className="text-muted-foreground font-mono text-xs break-all">
              {collision.revision_sha256}
            </p>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setCollision(null);
                  document.getElementById("creation-vrm-name")?.focus();
                }}
              >
                {t("avatarStep.collision.chooseNewName")}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void save(collision)}
              >
                {t("avatarStep.collision.replace")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
