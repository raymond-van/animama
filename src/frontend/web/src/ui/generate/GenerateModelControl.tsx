import { ChevronDown, Loader2, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useFormatters } from "@animama/product-ui/i18n";
import type {
  PyGenerationConversationUsage,
  PyGenerationCostEstimate,
  PyModelProviderCatalogItem,
} from "@animama/runtime-contracts/api-types";

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
import {
  ReasoningEffortSlider,
  reasoningEffortLabel,
} from "@/ui/components/reasoning-effort-slider";
import {
  MIN_GENERATION_CONTEXT_WINDOW_TOKENS,
  generationModelReviewsFrames,
  isChatGPTPlanModel,
  type ListedGenerationModel,
} from "./generateModels";
import type { GenerationModelChoice } from "./useGenerationModel";

type ListedModel = ListedGenerationModel<PyModelProviderCatalogItem>;
type UnavailableReason = NonNullable<ListedModel["unavailable"]>;

/**
 * Why a listed model cannot be chosen, in the assistant's own words (R2.2);
 * `null` for the two reasons chat's picker already words.
 */
function unavailableText(
  t: TFunction<"generate">,
  reason: UnavailableReason,
): string | null {
  switch (reason) {
    case "tools_unsupported":
      return t("model.unavailable.toolsUnsupported");
    case "streaming_unsupported":
      return t("model.unavailable.streamingUnsupported");
    case "context_too_small":
      return t("model.unavailable.contextTooSmall", {
        tokens: MIN_GENERATION_CONTEXT_WINDOW_TOKENS,
      });
    case "context_window_missing":
    case "chat_unsupported":
      return null;
  }
}

/**
 * The models as the chat's picker lists them: grouped by connection, each
 * with its name and the line under it. A model the assistant cannot use is
 * listed disabled, with the reason in place of that line (R2.2). Shared by
 * the control and setup.
 */
export function GenerateModelList({
  listed,
  chosenId,
  disabled = false,
  searchable = true,
  onChoose,
}: {
  listed: readonly ListedModel[];
  chosenId: string | null;
  disabled?: boolean;
  /** A short list needs no search field. */
  searchable?: boolean;
  onChoose: (model: PyModelProviderCatalogItem) => void;
}) {
  const { t } = useTranslation("generate");
  const { t: tChat } = useTranslation("chat");
  const models = useMemo(() => listed.map(({ item }) => item), [listed]);
  const reasons = useMemo(
    () =>
      new Map(listed.map(({ item, unavailable }) => [item.id, unavailable])),
    [listed],
  );
  const groups = useMemo(() => pickerModelGroups(models), [models]);
  const alternates = useMemo(() => alternateModelIds(models), [models]);
  const splitOpenAI = listsChatGPTPlanModels(models);
  const reasonText = (reason: UnavailableReason): string => {
    // The two reasons chat's own picker gives, in its words.
    if (reason === "context_window_missing")
      return tChat("composer.model.needsWindow");
    if (reason === "chat_unsupported") return tChat("composer.model.notDirect");
    return unavailableText(t, reason) ?? "";
  };
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
              const reason = reasons.get(item.id) ?? null;
              return (
                <CommandItem
                  key={item.id}
                  // The index keeps values unique without making the row's
                  // internal id searchable, as in the chat's picker.
                  value={`${group.providerLabel} ${detail} ${name} ${item.model} ${index}`}
                  disabled={disabled || reason !== null}
                  data-checked={item.id === chosenId}
                  // A model that cannot be chosen is not an option: journeys
                  // and tests pick from `generate-model-option` alone.
                  data-testid={
                    reason === null
                      ? "generate-model-option"
                      : "generate-model-unavailable"
                  }
                  data-model-id={item.id}
                  data-reason={reason ?? undefined}
                  onSelect={() => {
                    if (reason === null) onChoose(item);
                  }}
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
                      {reason === null ? detail : reasonText(reason)}
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

/** The slider's first stop: no level named, so the model's own default applies. */
const DEFAULT_EFFORT_STOP = "generate:model-default";

/**
 * The assistant's reasoning effort on the chosen model (R2.5), with the
 * chat picker's slider. Its first stop names no level, which leaves the
 * model's own default; the others are the model's levels. Nothing is shown
 * for a model that offers none.
 */
function GenerateEffortControl({
  choice,
  disabled,
}: {
  choice: GenerationModelChoice;
  disabled: boolean;
}) {
  const { t } = useTranslation("generate");
  const { t: tChat } = useTranslation("chat");
  // The level picked on the slider, shown until its save settles.
  const [pending, setPending] = useState<{ effort: string | null } | null>(
    null,
  );
  const { efforts } = choice;
  if (efforts.length === 0) return null;
  const effort = pending ? pending.effort : choice.effort;
  const label =
    effort === null
      ? t("model.effort.default")
      : reasoningEffortLabel(tChat, effort);

  const select = (index: number) => {
    const next = index === 0 ? null : (efforts[index - 1] ?? null);
    if (next === effort) return;
    const picked = { effort: next };
    setPending(picked);
    choice
      .chooseEffort(next)
      .catch(() => toast.error(t("model.effort.saveFailed")))
      // A later pick's save is the one still shown.
      .finally(() =>
        setPending((current) => (current === picked ? null : current)),
      );
  };

  return (
    <div
      className="border-border/60 mx-1 mt-1 space-y-2 border-t px-2 pt-2 pb-1"
      data-testid="generate-effort"
      data-effort={effort ?? "default"}
    >
      <p className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {tChat("composer.model.reasoningEffort")}
        </span>
        <span className="font-medium">{label}</span>
      </p>
      <ReasoningEffortSlider
        stops={[DEFAULT_EFFORT_STOP, ...efforts]}
        selectedIndex={effort === null ? 0 : efforts.indexOf(effort) + 1}
        label={tChat("composer.model.reasoningEffort")}
        valueText={label}
        disabled={disabled}
        onSelect={select}
      />
    </div>
  );
}

/** The smallest amount shown: a run of a few thousand tokens does not read as free. */
const SMALLEST_SHOWN_COST = 0.0001;

/**
 * Words an estimate as money in the UI Locale. Amounts under one unit keep
 * four decimals.
 */
function useCostText(): (cost: PyGenerationCostEstimate) => string {
  const formatters = useFormatters();
  return (cost) => {
    const amount = Number(cost.amount);
    if (!Number.isFinite(amount)) return cost.amount;
    try {
      return formatters.number(
        amount > 0 ? Math.max(amount, SMALLEST_SHOWN_COST) : 0,
        {
          style: "currency",
          currency: cost.currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: amount < 1 ? 4 : 2,
        },
      );
    } catch {
      // A currency code `Intl` does not know: the stored figures as they are.
      return `${cost.amount} ${cost.currency}`;
    }
  };
}

/**
 * What the open conversation has used (R6.3): the last run's tokens and the
 * conversation's, each with an estimated cost where its model had a listed
 * price. A ChatGPT plan run has no amount, and none is shown at all while a
 * plan model is chosen: the plan notice stands in its place.
 */
export function GenerateUsageSummary({
  usage,
  model,
  className,
}: {
  usage: PyGenerationConversationUsage | null | undefined;
  /** The assistant's chosen model. */
  model: Pick<PyModelProviderCatalogItem, "model_provider"> | null;
  className?: string;
}) {
  const { t } = useTranslation("generate");
  const costText = useCostText();
  // Nothing to report until a run has made a model request.
  if (!usage || usage.requests === 0) return null;
  const onPlan = model ? isChatGPTPlanModel(model) : false;
  const last =
    usage.last_run && usage.last_run.requests > 0 ? usage.last_run : null;
  const lastCost = last && !last.plan && !onPlan ? last.cost : null;
  const totalCost = onPlan ? null : usage.cost;
  const lastTokens = last
    ? { input: last.input_tokens, output: last.output_tokens }
    : null;
  const totalTokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
  };
  return (
    <div
      className={cn("text-muted-foreground space-y-0.5 text-xs", className)}
      data-testid="generate-usage"
      data-requests={usage.requests}
    >
      <p className="text-foreground font-medium">{t("usage.title")}</p>
      {lastTokens ? (
        <p data-testid="generate-usage-last-run">
          {lastCost
            ? t("usage.lastRunCost", {
                ...lastTokens,
                cost: costText(lastCost),
              })
            : t("usage.lastRun", lastTokens)}
        </p>
      ) : null}
      <p data-testid="generate-usage-conversation">
        {totalCost
          ? usage.cost_complete
            ? t("usage.conversationCost", {
                ...totalTokens,
                cost: costText(totalCost),
              })
            : t("usage.conversationCostPartial", {
                ...totalTokens,
                cost: costText(totalCost),
              })
          : t("usage.conversation", totalTokens)}
      </p>
      {lastCost || totalCost ? <p>{t("usage.estimate")}</p> : null}
    </div>
  );
}

/**
 * The assistant's model choice (R2.1): the models it may use, the saved
 * choice with its reasoning effort (R2.5), what the open conversation has
 * used (R6.3), and a way back to setup. On a ChatGPT plan model its last row
 * is the plan notice with **Manage usage**, as in the chat's model picker.
 *
 * The page may open it from elsewhere (the failure notice's **Choose another
 * model**) through `open` and `onOpenChange`; without them it keeps its own
 * open state.
 */
export function GenerateModelControl({
  choice,
  disabled = false,
  onOpenSetup,
  usage,
  open: controlledOpen,
  onOpenChange,
  className,
}: {
  choice: GenerationModelChoice;
  /** A run is in flight: it keeps the model it started with. */
  disabled?: boolean;
  onOpenSetup: () => void;
  /** The open conversation's token use, once it is read. */
  usage?: PyGenerationConversationUsage | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const { t } = useTranslation("generate");
  const { t: tChat } = useTranslation("chat");
  const [ownOpen, setOwnOpen] = useState(false);
  const { model, models } = choice;
  const alternates = useMemo(() => alternateModelIds(models), [models]);
  const name = model
    ? modelDisplayName(model, alternates.has(model.id), tChat)
    : t("model.none");
  const busy = disabled || choice.isChoosing;
  // Never open while a run is in flight, whoever asks.
  const open = (controlledOpen ?? ownOpen) && !busy;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };

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
          <p className="text-muted-foreground mt-1 text-xs" role="note">
            {t("model.expectation")}
          </p>
        </div>
        <GenerateModelList
          listed={choice.listed}
          chosenId={model?.id ?? null}
          disabled={busy}
          onChoose={(item) => void choose(item)}
        />
        {model && !generationModelReviewsFrames(model) ? (
          <p className="text-muted-foreground px-3 py-1 text-xs" role="note">
            {t("model.noFrames")}
          </p>
        ) : null}
        <GenerateEffortControl
          // Another model starts from its own saved level.
          key={model?.id ?? "none"}
          choice={choice}
          disabled={busy}
        />
        <GenerateUsageSummary
          usage={usage}
          model={model}
          className="border-border/60 mx-1 mt-1 border-t px-2 pt-2 pb-1"
        />
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
