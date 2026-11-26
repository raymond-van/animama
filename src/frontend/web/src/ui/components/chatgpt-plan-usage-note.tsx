import { useTranslation } from "react-i18next";
import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";

import { CHATGPT_PLAN_PROVIDER_TYPE } from "@/lib/chat/model-catalog";
import { cn } from "@/lib/utils";
import { ModelSelectorLogo } from "@/ui/components/model-selector";
import { ManageUsageLink } from "@/ui/settings/models/ChatGPTPlanCard";

/**
 * "Using ChatGPT plan" with **Manage usage**, the last row of the chat's model
 * picker while the selected model is a ChatGPT plan model (spec #919 R3.7;
 * OpenAI asks for it near the composer or the model selector). Nothing for
 * any other model.
 */
export function ChatGPTPlanUsageNote({
  model,
  className,
}: {
  model:
    | Pick<PyModelProviderCatalogItem, "model_provider" | "logo_provider">
    | null
    | undefined;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  if (model?.model_provider !== CHATGPT_PLAN_PROVIDER_TYPE) return null;
  return (
    <p
      className={cn(
        "border-border/60 text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 border-t text-xs",
        className,
      )}
    >
      <ModelSelectorLogo
        provider={model.logo_provider ?? "openai"}
        className="size-3.5"
        aria-hidden="true"
      />
      <span>{t("composer.chatgptPlan.using")}</span>
      <ManageUsageLink className="ml-auto text-xs" />
    </p>
  );
}
