import { ChevronDown, Loader2, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";

import {
  alternateModelIds,
  listsChatGPTPlanModels,
  modelDisplayName,
  modelOptionDetail,
  pickerModelGroups,
} from "@/lib/chat/model-catalog";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/components/button";
import { ChatGPTPlanUsageNote } from "@/ui/components/chatgpt-plan-usage-note";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/ui/components/command";
import {
  ModelSelectorLogo,
  ModelSelectorName,
} from "@/ui/components/model-selector";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/components/popover";
import { generationModelReviewsFrames } from "./generateModels";
import type { GenerationModelChoice } from "./useGenerationModel";

/**
 * The eligible models as the chat's picker lists them: grouped by connection,
 * each with its name and the line under it. Shared by the control and setup.
 */
export function GenerateModelList({
  models,
  chosenId,
  disabled = false,
  searchable = true,
  onChoose,
}: {
  models: readonly PyModelProviderCatalogItem[];
  chosenId: string | null;
  disabled?: boolean;
  /** A short list needs no search field. */
  searchable?: boolean;
  onChoose: (model: PyModelProviderCatalogItem) => void;
}) {
  const { t } = useTranslation("generate");
  const { t: tChat } = useTranslation("chat");
  const groups = useMemo(() => pickerModelGroups(models), [models]);
  const alternates = useMemo(() => alternateModelIds(models), [models]);
  const splitOpenAI = listsChatGPTPlanModels(models);
  return (
    <Command label={t("model.title")}>
      {searchable ? <CommandInput placeholder={t("model.search")} /> : null}
      <CommandList label={t("model.title")}>
        <CommandEmpty>{t("model.empty")}</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup key={group.providerLabel} heading={group.providerLabel}>
            {group.models.map((item, index) => {
              const name = modelDisplayName(
                item,
                alternates.has(item.id),
                tChat,
              );
              const detail = modelOptionDetail(item, splitOpenAI);
              return (
                <CommandItem
                  key={item.id}
                  // The index keeps values unique without making the row's
                  // internal id searchable, as in the chat's picker.
                  value={`${group.providerLabel} ${detail} ${name} ${item.model} ${index}`}
                  disabled={disabled}
                  data-checked={item.id === chosenId}
                  data-testid="generate-model-option"
                  data-model-id={item.id}
                  onSelect={() => onChoose(item)}
                  className="data-[selected=true]:bg-muted gap-2"
                >
                  {item.logo_provider ? (
                    <ModelSelectorLogo provider={item.logo_provider} />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <ModelSelectorName className="block">
                      {name}
                    </ModelSelectorName>
                    <span className="text-muted-foreground block truncate text-xs">
                      {detail}
                    </span>
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}

/**
 * The assistant's model choice (R2.1): the models it may use, the saved
 * choice, and a way back to setup. On a ChatGPT plan model its last row is the
 * plan notice with **Manage usage**, as in the chat's model picker (R6.3).
 */
export function GenerateModelControl({
  choice,
  disabled = false,
  onOpenSetup,
  className,
}: {
  choice: GenerationModelChoice;
  /** A run is in flight: it keeps the model it started with. */
  disabled?: boolean;
  onOpenSetup: () => void;
  className?: string;
}) {
  const { t } = useTranslation("generate");
  const { t: tChat } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const { model, models } = choice;
  const alternates = useMemo(() => alternateModelIds(models), [models]);
  const name = model
    ? modelDisplayName(model, alternates.has(model.id), tChat)
    : t("model.none");
  const busy = disabled || choice.isChoosing;

  const choose = async (item: PyModelProviderCatalogItem) => {
    setOpen(false);
    if (item.id === model?.id) return;
    try {
      await choice.choose(item.id);
    } catch {
      toast.error(t("model.chooseFailed"));
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next && busy) return;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          aria-label={t("model.trigger", { model: name })}
          data-testid="generate-model-control"
          data-model-id={model?.id}
          className={cn(
            "dark:bg-background dark:hover:bg-accent h-11 max-w-56 min-w-0 gap-2 rounded-xl px-3 shadow-sm lg:h-12",
            className,
          )}
        >
          {choice.isChoosing ? (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : model ? (
            <ModelSelectorLogo
              provider={model.logo_provider ?? model.model_provider ?? "AI"}
              aria-hidden="true"
            />
          ) : null}
          <span className="truncate">{name}</span>
          <ChevronDown className="text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        aria-label={t("model.title")}
        className="w-[min(20rem,calc(100vw-2rem))] rounded-xl p-1"
      >
        <div className="px-3 pt-2 pb-1">
          <p className="text-sm font-medium">{t("model.title")}</p>
          <p className="text-muted-foreground text-xs">
            {t("model.description")}
          </p>
        </div>
        <GenerateModelList
          models={models}
          chosenId={model?.id ?? null}
          disabled={busy}
          onChoose={(item) => void choose(item)}
        />
        {model && !generationModelReviewsFrames(model) ? (
          <p className="text-muted-foreground px-3 py-1 text-xs" role="note">
            {t("model.noFrames")}
          </p>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground w-full justify-start gap-2 px-3"
          data-testid="generate-model-setup"
          onClick={() => {
            setOpen(false);
            onOpenSetup();
          }}
        >
          <Settings2 aria-hidden="true" />
          {t("model.setup")}
        </Button>
        <ChatGPTPlanUsageNote
          model={model}
          className="mx-1 mt-1 px-2 pt-2 pb-1"
        />
      </PopoverContent>
    </Popover>
  );
}
