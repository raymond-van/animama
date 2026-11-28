import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { PromptSuggestion } from "@/ui/main/chat/PromptSuggestion";

/**
 * The Generate page's prompt starters (R8.4): a short list of requests to
 * begin from. One covers each kind of request the assistant takes: a
 * one-shot Gesture, one that is held, one for the whole body, a Reaction, and
 * a batch of several items.
 */
export const GENERATION_STARTERS = [
  "shyWave",
  "thinkingHold",
  "heartyLaugh",
  "fistPump",
  "surpriseReaction",
  "threeGreetings",
] as const;

export type GenerationStarterId = (typeof GENERATION_STARTERS)[number];

/** A starter's request, in the UI Locale. */
function starterText(
  t: TFunction<"generate">,
  starter: GenerationStarterId,
): string {
  switch (starter) {
    case "shyWave":
      return t("starters.items.shyWave");
    case "thinkingHold":
      return t("starters.items.thinkingHold");
    case "heartyLaugh":
      return t("starters.items.heartyLaugh");
    case "fistPump":
      return t("starters.items.fistPump");
    case "surpriseReaction":
      return t("starters.items.surpriseReaction");
    case "threeGreetings":
      return t("starters.items.threeGreetings");
  }
}

/**
 * The starters as a list of buttons. Choosing one hands its text to
 * `onChoose`, which puts it in the request field for editing: a starter
 * sends nothing and leaves the Gesture or Reaction choice as it is.
 */
export function GenerateStarters({
  onChoose,
  className,
}: {
  onChoose: (text: string) => void;
  className?: string;
}) {
  const { t } = useTranslation("generate");
  return (
    <ul
      aria-label={t("starters.label")}
      data-testid="generate-starters"
      className={cn("flex flex-wrap gap-1.5", className)}
    >
      {GENERATION_STARTERS.map((starter) => {
        const text = starterText(t, starter);
        return (
          <li key={starter} className="max-w-full">
            <PromptSuggestion
              data-testid="generate-starter"
              data-starter={starter}
              className="h-auto min-h-7 max-w-full py-1 text-left whitespace-normal"
              onClick={() => onChoose(text)}
            >
              {text}
            </PromptSuggestion>
          </li>
        );
      })}
    </ul>
  );
}
