import { useAnima } from "@/query/hooks/useAnima";
import { useModelProviders } from "@/query/hooks/useModelProviders";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import { useUpdateAnimaChatProfile } from "@/query/mutations/useUpdateAnimaChatProfile";
import { USER_FILE_UPLOAD_ACCEPT } from "@/lib/user-files/uploads";
import { isUserImageFile } from "@/lib/user-files/chat-images";
import { UserFileThumbnail } from "@/ui/components/user-file-thumbnail";
import { Button } from "@/ui/components/button";
import { attachmentSize } from "@/ui/components/chat-input-file-tray";
import { ChatGPTPlanUsageNote } from "@/ui/components/chatgpt-plan-usage-note";
import { Checkbox } from "@/ui/components/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/ui/components/command";
import { LiveWaveform, SyntheticWaveform } from "@/ui/components/live-waveform";
import {
  ModelSelectorLogo,
  ModelSelectorName,
} from "@/ui/components/model-selector";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/components/popover";
import { Slider } from "@/ui/components/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipDetails,
  TooltipLabel,
  TooltipTrigger,
} from "@/ui/components/tooltip";
import { UnavailableAction } from "@/ui/components/unavailable-action";
import { useSettings } from "@/ui/settings/SettingsProvider";
import { cn } from "@/lib/utils";
import type { UserFileUploadUppy } from "@/hooks/useUserFileUpload";
import {
  UppyContextProvider,
  useFileInput,
  useUppyContext,
  useUppyState,
} from "@uppy/react";
import type {
  PyChatResponse,
  PyModelProviderCatalogItem,
  PyUserFileResponse,
} from "@/lib/content/catalogTypes";
import { chatRequestOptions } from "@/lib/chat/chat-request-options";
import { chatModelSendGate } from "@/lib/chat/model-provider-compatibility";
import {
  selectableNativeTools,
  WEB_SEARCH_TOOL,
  webSearchAvailability,
  withWebSearch,
  type WebSearchUnavailableCode,
} from "@/lib/chat/model-provider-native-tools";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  Settings2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import {
  alternateModelIds,
  modelDisplayName,
  modelOptionDetail,
  modelOptionLabel,
  listsChatGPTPlanModels,
  pickerModelGroups,
  selectableChatModels,
  supportedReasoningEfforts,
} from "@/lib/chat/model-catalog";
import type React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useFormatters, type LocaleFormatters } from "@animama/product-ui/i18n";
import {
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  ChatInput,
  ChatInputTextArea,
  ChatInputSubmit,
  ChatInputContext,
} from "@animama/product-ui/components";

type ChatInputFileUploadButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "children"
> & {
  existingFiles: readonly PyUserFileResponse[];
  existingFilesError?: boolean;
  existingFilesLoading?: boolean;
  onToggleExistingFile: (file: PyUserFileResponse) => void;
  selectedExistingFileIds: readonly string[];
  uppy: UserFileUploadUppy;
};

function ChatInputFileUploadButton({
  uppy,
  existingFiles,
  existingFilesError,
  existingFilesLoading,
  onToggleExistingFile,
  selectedExistingFileIds,
  className,
  disabled,
  ...props
}: ChatInputFileUploadButtonProps) {
  return (
    <UppyContextProvider uppy={uppy}>
      <ChatInputFileUploadButtonInner
        uppy={uppy}
        existingFiles={existingFiles}
        existingFilesError={existingFilesError}
        existingFilesLoading={existingFilesLoading}
        onToggleExistingFile={onToggleExistingFile}
        selectedExistingFileIds={selectedExistingFileIds}
        className={className}
        disabled={disabled}
        {...props}
      />
    </UppyContextProvider>
  );
}

function ChatInputFileUploadButtonInner({
  uppy,
  existingFiles,
  existingFilesError,
  existingFilesLoading,
  onToggleExistingFile,
  selectedExistingFileIds,
  className,
  disabled,
  ...props
}: ChatInputFileUploadButtonProps) {
  const { t } = useTranslation("chat");
  const formatters = useFormatters();
  const fileInputOptions = useMemo(
    () => ({ multiple: true, accept: USER_FILE_UPLOAD_ACCEPT }),
    [],
  );
  const { getButtonProps, getInputProps } = useFileInput(fileInputOptions);
  const { status, progress } = useUppyContext();
  const uppyFiles = useUppyState(uppy, (state) => state.files);
  const [open, setOpen] = useState(false);
  const buttonProps = getButtonProps();
  const inputProps = getInputProps();
  const isUploading = status === "uploading";
  const label = isUploading
    ? t("composer.attach.uploading", {
        percent: formatters.number(progress / 100, {
          style: "percent",
          maximumFractionDigits: 0,
        }),
      })
    : t("composer.attach.add");
  const isDisabled = Boolean(disabled);
  const selectedFileIds = useMemo(
    () => new Set(selectedExistingFileIds),
    [selectedExistingFileIds],
  );
  const uppyBackendFileIds = useMemo(
    () =>
      new Set(
        Object.values(uppyFiles)
          .map((file) => file.meta.file_id)
          .filter(
            (fileId): fileId is string =>
              typeof fileId === "string" && fileId.trim().length > 0,
          )
          .map((fileId) => fileId.trim()),
      ),
    [uppyFiles],
  );

  return (
    <>
      <input {...inputProps} className="sr-only" tabIndex={-1} />
      <Popover
        open={open}
        onOpenChange={(nextOpen) => setOpen(isDisabled ? false : nextOpen)}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                {...props}
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={isDisabled}
                className={cn(
                  "text-muted-foreground hover:text-foreground rounded-full",
                  className,
                )}
              >
                {isUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
                <span className="sr-only">{label}</span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent avoidCollisions={false} side="bottom">
            {label}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          side="top"
          className="w-[min(22rem,calc(100vw-2rem))] p-1"
        >
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start gap-2 px-2 py-2 font-normal"
            onClick={() => {
              setOpen(false);
              buttonProps.onClick();
            }}
          >
            <Upload className="size-4" aria-hidden="true" />
            {t("composer.attach.fromComputer")}
          </Button>
          <div className="bg-border mx-1 my-1 h-px" />
          <Command>
            <CommandInput placeholder={t("composer.attach.search")} />
            <CommandList className="max-h-64">
              {existingFilesLoading ? (
                <div className="text-muted-foreground flex items-center gap-2 px-3 py-5 text-sm">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {t("composer.attach.loading")}
                </div>
              ) : existingFilesError ? (
                <div className="text-destructive px-3 py-5 text-sm">
                  {t("composer.attach.loadFailed")}
                </div>
              ) : (
                <>
                  <CommandEmpty>{t("composer.attach.empty")}</CommandEmpty>
                  <CommandGroup heading={t("composer.attach.files")}>
                    {existingFiles.map((file) => {
                      const selected = selectedFileIds.has(file.file_id);
                      const representedByUppy = uppyBackendFileIds.has(
                        file.file_id,
                      );
                      const attached = selected || representedByUppy;
                      return (
                        <CommandItem
                          key={file.file_id}
                          value={`${file.original_filename} ${file.normalized_extension} ${file.file_id}`}
                          disabled={representedByUppy}
                          data-checked={attached}
                          aria-pressed={attached}
                          onSelect={() => onToggleExistingFile(file)}
                          className="items-start py-2"
                        >
                          {isUserImageFile(file) ? (
                            <UserFileThumbnail
                              fileId={file.file_id}
                              className="mt-0.5 size-5"
                            />
                          ) : (
                            <FileText
                              className="mt-0.5 size-4"
                              aria-hidden="true"
                            />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {file.original_filename}
                            </span>
                            <span className="text-muted-foreground block truncate text-xs">
                              {attachmentDetails(t, formatters, file)}
                            </span>
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}

ChatInputFileUploadButton.displayName = "ChatInputFileUploadButton";

/**
 * The attach button where the runtime withholds chat uploads: it keeps its
 * familiar place, explains why, and has no uploader, picker or file list.
 */
function ChatInputFileUploadUnavailable({ reason }: { reason: string }) {
  const { t } = useTranslation("chat");
  return (
    <UnavailableAction reason={reason} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground rounded-full"
      >
        <Paperclip className="h-4 w-4" />
        <span className="sr-only">{t("composer.attach.add")}</span>
      </Button>
    </UnavailableAction>
  );
}

/** Why web search is unavailable for a model row, in the active locale. */
function searchUnavailableText(
  t: TFunction<"chat">,
  code: WebSearchUnavailableCode,
): string {
  switch (code) {
    case "tools_unsupported":
      return t("composer.model.searchUnavailable.tools_unsupported");
    case "not_configured":
      return t("composer.model.searchUnavailable.not_configured");
    case "key_missing":
      return t("composer.model.searchUnavailable.key_missing");
  }
}

/** Size, chunk count and search status for an attached file; an image has no chunks. */
function attachmentDetails(
  t: TFunction<"chat">,
  formatters: LocaleFormatters,
  file: PyUserFileResponse,
): string {
  const size = attachmentSize(
    formatters,
    file.stored_size_bytes ?? file.declared_size_bytes,
  );
  if (isUserImageFile(file)) {
    const status = t("composer.files.ready");
    return size ? t("composer.attach.imageDetails", { size, status }) : status;
  }
  const values = {
    chunks: t("composer.attach.chunks", { count: file.chunk_count ?? 0 }),
    status:
      file.status === "ready"
        ? t("composer.files.ready")
        : t("composer.attach.keywordOnly"),
  };
  return size
    ? t("composer.attach.fileDetails", { ...values, size })
    : t("composer.attach.fileDetailsNoSize", values);
}

/** A native tool's name; tools without wording show their provider identifier. */
function nativeToolLabel(t: TFunction<"chat">, tool: string) {
  if (tool === "web_search") return t("composer.model.webSearch");
  return tool.replaceAll("_", " ");
}

/**
 * Reasoning effort names, without changing the catalog's supported effort
 * values; an effort the app does not know shows its identifier, capitalized.
 */
function reasoningEffortLabel(t: TFunction<"chat">, effort: string) {
  switch (effort) {
    case "none":
      return t("composer.model.reasoningEfforts.none");
    case "minimal":
      return t("composer.model.reasoningEfforts.minimal");
    case "low":
      return t("composer.model.reasoningEfforts.low");
    case "medium":
      return t("composer.model.reasoningEfforts.medium");
    case "high":
      return t("composer.model.reasoningEfforts.high");
    case "xhigh":
      return t("composer.model.reasoningEfforts.xhigh");
    case "max":
      return t("composer.model.reasoningEfforts.max");
    default:
      return (
        effort.charAt(0).toUpperCase() + effort.slice(1).replaceAll("_", " ")
      );
  }
}

/** Drives the model picker from outside it, e.g. the composer's no-key notice. */
export type ChatModelSelectorControl = {
  /** Open the picker on its model list. */
  openModels: () => void;
  /** Switch to `item` exactly as choosing it in the list does. */
  select: (item: PyModelProviderCatalogItem) => Promise<void>;
};

type ChatInputModelSelectorProps = React.ComponentProps<typeof Button> & {
  animaId: string;
  activeChat?: PyChatResponse | null;
  closeSignal?: number;
  controlRef?: React.Ref<ChatModelSelectorControl>;
  disabled?: boolean;
  /** The active model's connection has no key, so it cannot reply. */
  keyMissing?: boolean;
  onIncompatibleModelSelect?: (item: PyModelProviderCatalogItem) => void;
  onModelChange?: () => void;
};

function ChatInputModelSelector({
  activeChat = null,
  animaId,
  className,
  closeSignal = 0,
  controlRef,
  disabled: disabledProp,
  keyMissing = false,
  onIncompatibleModelSelect,
  onModelChange,
  ...props
}: ChatInputModelSelectorProps) {
  const { t, i18n } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"reasoning" | "models" | "features">(
    "reasoning",
  );
  const { data: anima } = useAnima(animaId);
  const { data: catalog = [], isSuccess: catalogLoaded } = useModelProviders();
  const updateAnimaChatProfile = useUpdateAnimaChatProfile();
  // Effort saves use their own mutation so the picker stays enabled while one
  // is in flight; the shared scope keeps every profile save in order.
  const saveReasoningEffort = useUpdateAnimaChatProfile();
  const webSearch = useRuntimeCapabilities().data?.web_search;
  const { chatFeatureChoice, setChatFeatureChoice } = useSettings();
  // The latest effort picked on the slider, shown until its save settles;
  // afterwards the saved profile value shows.
  const [pendingEffort, setPendingEffort] = useState<string | null>(null);
  const latestEffortSave = useRef(0);
  const activeItemId = anima?.chat_profile?.default_model_provider_id ?? null;
  // Embedding models never appear; hidden ones only while they are the choice.
  const models = useMemo(
    () => selectableChatModels(catalog, activeItemId),
    [activeItemId, catalog],
  );
  const activeItem = useMemo(
    () => models.find((item) => item.id === activeItemId) ?? null,
    [activeItemId, models],
  );
  // A removed model (or connection) leaves the Anima's choice unavailable.
  const activeUnavailable =
    Boolean(activeItemId) && catalogLoaded && !activeItem;
  const modelGroups = useMemo(
    () => pickerModelGroups(models),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- headings read the UI Locale, which can change while the chat is open
    [models, i18n.language],
  );
  const splitOpenAI = useMemo(() => listsChatGPTPlanModels(models), [models]);
  // Rows sharing a name on one connection are told apart without naming APIs.
  const alternateIds = useMemo(() => alternateModelIds(models), [models]);
  // The same options the chat session sends with each turn.
  const requestOptions = useMemo(
    () =>
      chatRequestOptions({
        animaId,
        item: activeItem,
        savedEffort: anima?.chat_profile?.reasoning_effort,
        webSearch,
        featureChoice: chatFeatureChoice,
      }),
    [
      activeItem,
      anima?.chat_profile?.reasoning_effort,
      animaId,
      chatFeatureChoice,
      webSearch,
    ],
  );
  const selectedNativeTools = useMemo(
    () => new Set(requestOptions?.native_tools ?? []),
    [requestOptions],
  );
  const reasoningEfforts = supportedReasoningEfforts(activeItem);
  const savedReasoningEffort = requestOptions?.reasoning_effort ?? null;
  const selectedReasoningEffort =
    pendingEffort && reasoningEfforts.includes(pendingEffort)
      ? pendingEffort
      : savedReasoningEffort;
  const selectedEffortIndex = Math.max(
    0,
    reasoningEfforts.indexOf(selectedReasoningEffort ?? ""),
  );
  const effortLabel = selectedReasoningEffort
    ? reasoningEffortLabel(t, selectedReasoningEffort)
    : t("composer.model.fallbackLabel");
  const nativeTools = selectableNativeTools(activeItem, webSearch);
  const searchAvailability = webSearchAvailability(activeItem, webSearch);
  const isDisabled = Boolean(
    disabledProp || updateAnimaChatProfile.isPending || !anima?.chat_profile,
  );
  const activeLabel = activeItem
    ? modelOptionLabel(activeItem, alternateIds.has(activeItem.id), t)
    : null;
  const tooltipLabel = activeLabel
    ? keyMissing
      ? t("composer.model.keyMissing", { model: activeLabel })
      : activeLabel
    : activeUnavailable
      ? t("composer.model.unavailable")
      : anima?.chat_profile
        ? t("composer.model.select")
        : t("composer.model.noProfile");

  const handleSelect = async (item: PyModelProviderCatalogItem) => {
    if (isDisabled) return;

    const gate = chatModelSendGate(activeChat, item);
    if (!gate.ok) {
      if (gate.reason === "api_standard_mismatch") {
        onIncompatibleModelSelect?.(item);
      } else if (gate.reason === "unsupported_model") {
        toast.error(t("composer.model.toasts.unsupported"));
      } else {
        toast.error(t("composer.model.toasts.selectFirst"));
      }
      return;
    }
    // Re-selecting the active model keeps its effort and Chat features.
    if (item.id === activeItemId) {
      setView("reasoning");
      return;
    }

    // Without an effort, the saved one is cleared, so the new model starts at
    // its own default; Chat features are kept per model and start at theirs.
    try {
      await updateAnimaChatProfile.mutateAsync({
        animaId,
        body: { default_model_provider_id: item.id },
      });
    } catch {
      toast.error(t("composer.model.toasts.updateFailed"));
      return;
    }

    setView("reasoning");
    onModelChange?.();
  };
  useImperativeHandle(controlRef, () => ({
    openModels: () => {
      if (isDisabled) return;
      setOpen(true);
      setView("models");
    },
    select: handleSelect,
  }));

  const handleNativeToolChange = (tool: string, checked: boolean) => {
    if (isDisabled || !activeItem || !nativeTools.includes(tool)) return;
    const nextTools = checked
      ? Array.from(new Set([...selectedNativeTools, tool]))
      : Array.from(selectedNativeTools).filter(
          (activeTool) => activeTool !== tool,
        );
    // Kept for this Anima and model only; an empty list keeps tools off.
    setChatFeatureChoice({
      animaId,
      modelProviderId: activeItem.id,
      nativeTools: nextTools,
    });
  };

  /**
   * Saves a slider effort on the Anima's chat profile. A drag saves each step
   * it crosses; the saves run in order, so the last one wins.
   */
  const handleReasoningChange = (effort: string) => {
    if (isDisabled || !activeItem || !reasoningEfforts.includes(effort)) return;
    const save = ++latestEffortSave.current;
    setPendingEffort(effort);
    saveReasoningEffort
      .mutateAsync({
        animaId,
        body: {
          default_model_provider_id: activeItem.id,
          reasoning_effort: effort,
        },
      })
      .catch(() => {
        // A failed step of a drag is replaced by the later saves.
        if (latestEffortSave.current === save) {
          toast.error(t("composer.model.toasts.effortUpdateFailed"));
        }
      })
      .finally(() => {
        // A newer pick stays shown until its own save settles.
        if (latestEffortSave.current === save) setPendingEffort(null);
      });
  };

  useEffect(() => {
    if (closeSignal > 0) {
      setOpen(false);
      setView("reasoning");
    }
  }, [closeSignal]);

  // Search availability can change while the same model stays selected: the
  // capability loads after the catalog, or the owner configures or removes
  // the backend. A Chat features choice follows the default then (on when
  // available) without touching other tools; without one, the defaults
  // already follow availability.
  const activeSearchState = webSearchAvailability(activeItem, webSearch)?.state;
  const lastSearchStateRef = useRef<{ id: string; state?: string } | null>(
    null,
  );
  useEffect(() => {
    if (!activeItemId) return;
    const previous = lastSearchStateRef.current;
    lastSearchStateRef.current = { id: activeItemId, state: activeSearchState };
    if (previous?.id !== activeItemId || previous.state === activeSearchState)
      return;
    const available =
      activeSearchState === "hosted" || activeSearchState === "application";
    setChatFeatureChoice((current) =>
      current?.animaId === animaId && current.modelProviderId === activeItemId
        ? {
            ...current,
            nativeTools: withWebSearch(current.nativeTools, available),
          }
        : current,
    );
  }, [activeItemId, activeSearchState, animaId, setChatFeatureChoice]);

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen && isDisabled) return;
        setOpen(nextOpen);
        if (nextOpen) setView("reasoning");
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn(
                "text-muted-foreground hover:text-foreground rounded-full",
                className,
              )}
              disabled={isDisabled}
              aria-label={t("composer.model.trigger", { model: tooltipLabel })}
              {...props}
            >
              {updateAnimaChatProfile.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : activeUnavailable || keyMissing ? (
                <TriangleAlert className="text-destructive size-4" />
              ) : (
                <ModelSelectorLogo
                  provider={
                    activeItem?.logo_provider ??
                    activeItem?.model_provider ??
                    "AI"
                  }
                />
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent avoidCollisions={false} side="top">
          {tooltipLabel}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        aria-label={
          view === "models"
            ? t("composer.model.select")
            : view === "features"
              ? t("composer.model.features")
              : t("composer.model.panel")
        }
        className={cn(
          "w-[min(20rem,calc(100vw-2rem))] rounded-xl",
          view === "models" ? "p-1" : "p-4",
        )}
      >
        {view === "reasoning" ? (
          <>
            <div className="flex items-start gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground size-7 shrink-0 rounded-full"
                    disabled={isDisabled || !activeItem}
                    aria-label={t("composer.model.features")}
                    onClick={() => setView("features")}
                  >
                    <Settings2 className="size-4" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t("composer.model.features")}
                </TooltipContent>
              </Tooltip>
              <div className="min-w-0 flex-1 text-center">
                <p className="text-base font-medium">
                  {selectedReasoningEffort
                    ? effortLabel
                    : t("composer.model.select")}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  autoFocus
                  className="text-muted-foreground h-auto max-w-full gap-1 px-2 py-1 text-xs font-normal"
                  disabled={isDisabled}
                  aria-label={t("composer.model.select")}
                  onClick={() => setView("models")}
                >
                  <span className="truncate">
                    {activeItem
                      ? modelDisplayName(
                          activeItem,
                          alternateIds.has(activeItem.id),
                          t,
                        )
                      : activeUnavailable
                        ? t("composer.model.unavailableShort")
                        : t("composer.model.choose")}
                  </span>
                  <ChevronRight
                    className="size-3 shrink-0"
                    aria-hidden="true"
                  />
                </Button>
              </div>
              <span className="size-7 shrink-0" aria-hidden="true" />
            </div>
            {reasoningEfforts.length > 1 ? (
              <div className="relative mt-4">
                <Slider
                  min={0}
                  max={reasoningEfforts.length - 1}
                  step={1}
                  value={[selectedEffortIndex]}
                  disabled={isDisabled}
                  onValueChange={([index]) => {
                    const effort = reasoningEfforts[index];
                    if (effort) handleReasoningChange(effort);
                  }}
                  thumbProps={{
                    "aria-label": t("composer.model.reasoningEffort"),
                    "aria-valuetext": effortLabel,
                  }}
                  className="[&_[data-slot=slider-thumb]]:border-border h-8 [&_[data-slot=slider-thumb]]:size-8 [&_[data-slot=slider-track]]:h-7"
                />
                <div
                  className="pointer-events-none absolute inset-x-4 top-1/2 flex -translate-y-1/2 justify-between"
                  aria-hidden="true"
                >
                  {reasoningEfforts.map((effort, index) => (
                    <span
                      key={effort}
                      className={cn(
                        "size-1 rounded-full",
                        index < selectedEffortIndex
                          ? "bg-primary-foreground/50"
                          : "bg-muted-foreground/50",
                        index === selectedEffortIndex && "opacity-0",
                      )}
                    />
                  ))}
                </div>
              </div>
            ) : activeItem && reasoningEfforts.length === 0 ? (
              <p className="text-muted-foreground mt-3 text-center text-xs">
                {t("composer.model.noReasoning")}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div
              className={cn(
                "mb-3 flex items-center gap-2",
                view === "models" && "px-2 pt-2",
              )}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                autoFocus={view === "features"}
                className="text-muted-foreground size-7 shrink-0 rounded-full"
                aria-label={t("composer.model.back")}
                onClick={() => setView("reasoning")}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
              </Button>
              <p className="text-sm font-medium">
                {view === "models"
                  ? t("composer.model.select")
                  : t("composer.model.features")}
              </p>
            </div>
            {view === "features" ? (
              <div className="space-y-3">
                {searchAvailability?.state === "unavailable" ? (
                  <div className="space-y-1">
                    <label className="text-muted-foreground flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={false}
                        disabled
                        aria-describedby={`${animaId}-web-search-reason`}
                      />
                      <span>{nativeToolLabel(t, WEB_SEARCH_TOOL)}</span>
                    </label>
                    <p
                      id={`${animaId}-web-search-reason`}
                      className="text-muted-foreground text-xs"
                    >
                      {searchUnavailableText(t, searchAvailability.code)}
                    </p>
                  </div>
                ) : null}
                {nativeTools.map((tool) => (
                  <label
                    key={tool}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={selectedNativeTools.has(tool)}
                      disabled={isDisabled}
                      onCheckedChange={(checked) =>
                        handleNativeToolChange(tool, checked === true)
                      }
                    />
                    <span>{nativeToolLabel(t, tool)}</span>
                  </label>
                ))}
                {nativeTools.length === 0 && !searchAvailability ? (
                  <p className="text-muted-foreground text-xs">
                    {t("composer.model.noFeatures")}
                  </p>
                ) : null}
              </div>
            ) : (
              <Command>
                <CommandInput
                  autoFocus
                  placeholder={t("composer.model.search")}
                />
                <CommandList>
                  <CommandEmpty>{t("composer.model.empty")}</CommandEmpty>
                  {modelGroups.map((group) => (
                    <CommandGroup
                      key={group.providerLabel}
                      heading={group.providerLabel}
                    >
                      {group.models.map((item, index) => {
                        const isActive = item.id === activeItemId;
                        const rowGate = chatModelSendGate(activeChat, item);
                        const rowUnsupported =
                          !rowGate.ok && rowGate.reason === "unsupported_model";
                        // Owner models need a context window before they can chat.
                        const rowNeedsWindow =
                          item.source === "owner" &&
                          item.context_window_tokens == null;
                        const modelName = modelDisplayName(
                          item,
                          alternateIds.has(item.id),
                          t,
                        );
                        const providerName = modelOptionDetail(
                          item,
                          splitOpenAI,
                        );
                        return (
                          <CommandItem
                            key={item.id}
                            // The group heading keeps "OpenAI" searchable on
                            // rows that say only "API key"; the index keeps
                            // values unique without making the row's internal
                            // id searchable.
                            value={`${group.providerLabel} ${providerName} ${modelName} ${item.model} ${index}`}
                            disabled={
                              isDisabled || rowUnsupported || rowNeedsWindow
                            }
                            data-checked={isActive}
                            onSelect={() => void handleSelect(item)}
                            className="data-[selected=true]:bg-muted gap-2"
                          >
                            {item.logo_provider ? (
                              <ModelSelectorLogo
                                provider={item.logo_provider}
                              />
                            ) : null}
                            <div className="min-w-0 flex-1">
                              <ModelSelectorName className="block">
                                {modelName}
                              </ModelSelectorName>
                              <span className="text-muted-foreground block truncate text-xs">
                                {rowUnsupported
                                  ? t("composer.model.notDirect")
                                  : rowNeedsWindow
                                    ? t("composer.model.needsWindow")
                                    : providerName}
                              </span>
                            </div>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ))}
                </CommandList>
              </Command>
            )}
          </>
        )}
        {view === "features" ? null : (
          <ChatGPTPlanUsageNote
            model={activeItem}
            className={
              view === "models" ? "mx-1 mt-1 px-2 pt-2 pb-1" : "mt-4 pt-3"
            }
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

ChatInputModelSelector.displayName = "ChatInputModelSelector";

type ChatInputDictationProps = React.ComponentProps<typeof Button> & {
  /** Lines under the Dictate tooltip, e.g. its speech engine. */
  engineDetails?: readonly string[] | null;
  /**
   * Speech recognition is not set up here but can be: while idle, the button
   * opens its settings instead of dictating, and says so.
   */
  onSetUp?: (() => void) | null;
};

function ChatInputDictation({
  className,
  engineDetails,
  onSetUp = null,
  ...props
}: ChatInputDictationProps) {
  const { t } = useTranslation("chat");
  const context = useContext(ChatInputContext);
  const activeMicMode = context.activeMicMode ?? null;
  const isMicCaptureActive = context.isMicCaptureActive ?? false;
  const isDictationPreparing = context.isDictationPreparing ?? false;
  const isUserSpeaking = context.isUserSpeaking ?? false;
  const isVoiceMicMuted = context.isVoiceMicMuted ?? false;
  const onDictationStart = context.onDictationStart;
  const onMicSessionStop = context.onMicSessionStop;
  const onVoiceMicToggle = context.onVoiceMicToggle;
  const dictationStream = context.dictationStream;
  const hasDictationStream = Boolean(dictationStream);
  const shortcuts = context.micShortcuts;
  const micWaveformMode =
    context.micWaveformMode ??
    (context.showMicWaveform === false ? "none" : "live");
  const showMicWaveform = micWaveformMode !== "none";

  if (activeMicMode) {
    const isVoiceMode = activeMicMode === "voice";
    const actionLabel = isVoiceMode
      ? isVoiceMicMuted
        ? t("composer.dictation.unmute")
        : t("composer.dictation.mute")
      : t("composer.dictation.stop");
    const actionIcon = isVoiceMode ? (
      isVoiceMicMuted ? (
        <MicOff className="h-4 w-4" />
      ) : (
        <Mic className="h-4 w-4" />
      )
    ) : (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-label={t("composer.dictation.stopIcon")}
      >
        <title>{t("composer.dictation.stopIcon")}</title>
        <rect x="6" y="6" width="12" height="12" />
      </svg>
    );
    const handleClick = isVoiceMode ? onVoiceMicToggle : onMicSessionStop;

    return (
      <div className="flex items-center gap-2">
        {showMicWaveform || isDictationPreparing ? (
          isDictationPreparing ? (
            <div className="text-muted-foreground flex h-12 w-12 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : micWaveformMode === "synthetic" ? (
            <SyntheticWaveform
              active={isUserSpeaking && isMicCaptureActive && !isVoiceMicMuted}
              muted={!isMicCaptureActive || isVoiceMicMuted}
              height={48}
              className="text-muted-foreground w-12"
            />
          ) : (
            <LiveWaveform
              active={hasDictationStream && isMicCaptureActive}
              processing={isMicCaptureActive && !hasDictationStream}
              mode="static"
              height={48}
              stream={dictationStream ?? undefined}
              className="text-muted-foreground w-12"
            />
          )
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                "border-border text-muted-foreground hover:text-foreground rounded-full border-1",
                isVoiceMode &&
                  isVoiceMicMuted &&
                  "border-red-500/30 bg-red-500/10 text-red-500 hover:bg-red-500/15 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300",
                className,
              )}
              onClick={handleClick}
              {...props}
            >
              {actionIcon}
              <span className="sr-only">{actionLabel}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent avoidCollisions={false} side="bottom">
            <TooltipLabel
              label={actionLabel}
              shortcut={
                isVoiceMode ? shortcuts?.voiceMute : shortcuts?.dictation
              }
            />
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "text-muted-foreground hover:text-foreground rounded-full",
            className,
          )}
          onClick={onSetUp ?? onDictationStart}
          {...props}
        >
          <Mic className="h-4 w-4" />
          <span className="sr-only">
            {onSetUp
              ? t("composer.speechSetup.title")
              : t("composer.dictation.start")}
          </span>
        </Button>
      </TooltipTrigger>
      {/* Flips above a composer at the window's bottom edge, like Voice
          Mode, so the engine line stays visible. */}
      <TooltipContent side="bottom">
        <TooltipDetails
          title={
            onSetUp ? (
              <TooltipLabel label={t("composer.speechSetup.title")} />
            ) : (
              <TooltipLabel
                label={t("composer.dictation.start")}
                shortcut={shortcuts?.dictation}
              />
            )
          }
          lines={onSetUp ? [t("composer.speechSetup.detail")] : engineDetails}
        />
      </TooltipContent>
    </Tooltip>
  );
}
ChatInputDictation.displayName = "ChatInputDictation";

export {
  ChatInput,
  ChatInputTextArea,
  ChatInputSubmit,
  ChatInputFileUploadButton,
  ChatInputFileUploadUnavailable,
  ChatInputModelSelector,
  ChatInputDictation,
};
