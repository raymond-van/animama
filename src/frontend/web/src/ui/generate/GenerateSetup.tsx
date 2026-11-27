import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";

import { useAppSettingsOpener } from "@/stores/app-settings-request-store";
import { Button } from "@/ui/components/button";
import { ChatGPTPlanCard } from "@/ui/settings/models/ChatGPTPlanCard";
import { SidebarMenuButton } from "@/ui/sidebar/SidebarMenuButton";
import { GenerateModelList } from "./GenerateModelControl";
import type { GenerationModelChoice } from "./useGenerationModel";

/** From this many models on, the list gets a search field. */
const SEARCHABLE_MODEL_COUNT = 8;

/**
 * Setup for the assistant (R1.4): shown while it has no usable model, and
 * again from the model control. It offers the ChatGPT plan's own sign-in
 * (where the plan connection offers it), every visible chat model (the ones
 * the assistant cannot use disabled, with the reason), what to expect from a
 * smaller model, and the way to Model connections for any other, such as a
 * Claude API key.
 */
export function GenerateSetup({
  choice,
  onDone,
}: {
  choice: GenerationModelChoice;
  /** Leave setup for the page; offered once a model is chosen. */
  onDone: () => void;
}) {
  const { t } = useTranslation("generate");
  const openSettings = useAppSettingsOpener();
  const { model, models, listed } = choice;

  const choose = async (item: PyModelProviderCatalogItem) => {
    try {
      if (item.id !== model?.id) await choice.choose(item.id);
      onDone();
    } catch {
      toast.error(t("model.chooseFailed"));
    }
  };

  return (
    <div
      className="mx-auto flex w-full max-w-2xl flex-col gap-6"
      data-testid="generate-setup"
    >
      <header className="flex items-start gap-2">
        <SidebarMenuButton />
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold">{t("setup.title")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("setup.description")}
          </p>
        </div>
      </header>

      <section aria-labelledby="generate-setup-model" className="space-y-4">
        <h2 id="generate-setup-model" className="text-lg font-semibold">
          {t("setup.modelTitle")}
        </h2>

        {/* The plan connection's own card: sign-in where it offers one. */}
        <ChatGPTPlanCard headingLevel={3} disabled={choice.isChoosing} />

        <div className="border-border/60 space-y-3 rounded-xl border p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">{t("setup.modelsTitle")}</h3>
            <p className="text-muted-foreground text-xs">
              {t("setup.modelsDescription")}
            </p>
            <p className="text-muted-foreground text-xs" role="note">
              {t("model.expectation")}
            </p>
          </div>
          {models.length === 0 ? (
            <p className="text-sm" role="status">
              {t("setup.noModels")}
            </p>
          ) : null}
          {/* Models that cannot be chosen are listed too, each with why. */}
          {listed.length > 0 ? (
            <GenerateModelList
              listed={listed}
              chosenId={model?.id ?? null}
              disabled={choice.isChoosing}
              searchable={listed.length >= SEARCHABLE_MODEL_COUNT}
              onChoose={(item) => void choose(item)}
            />
          ) : null}
        </div>

        <div className="border-border/60 space-y-3 rounded-xl border p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">{t("setup.otherTitle")}</h3>
            <p className="text-muted-foreground text-sm">
              {t("setup.claudeNote")}
            </p>
          </div>
          {openSettings ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="generate-setup-model-connections"
              onClick={() => openSettings("model-connections")}
            >
              {t("setup.openConnections")}
            </Button>
          ) : null}
        </div>
      </section>

      {model ? (
        <div>
          <Button
            type="button"
            data-testid="generate-setup-done"
            disabled={choice.isChoosing}
            onClick={onDone}
          >
            {t("setup.done")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
