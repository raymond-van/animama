import type { TFunction } from "i18next";

import { cn } from "@/lib/utils";
import { Slider } from "@/ui/components/slider";

/**
 * Reasoning effort names, without changing the catalog's supported effort
 * values; an effort the app does not know shows its identifier, capitalized.
 */
export function reasoningEffortLabel(t: TFunction<"chat">, effort: string) {
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

/**
 * The model pickers' reasoning effort slider: one stop per level, in the
 * order given, with a dot marking each stop the thumb is not on. The chat's
 * picker and the content assistant's model control share it.
 */
export function ReasoningEffortSlider({
  stops,
  selectedIndex,
  label,
  valueText,
  disabled = false,
  onSelect,
  className,
}: {
  /** One key per stop, in order; at least two. */
  stops: readonly string[];
  selectedIndex: number;
  /** The slider's accessible name. */
  label: string;
  /** The selected stop in words, for assistive technology. */
  valueText: string;
  disabled?: boolean;
  onSelect: (index: number) => void;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Slider
        min={0}
        max={stops.length - 1}
        step={1}
        value={[selectedIndex]}
        disabled={disabled}
        onValueChange={([index]) => {
          if (index !== undefined && index in stops) onSelect(index);
        }}
        thumbProps={{ "aria-label": label, "aria-valuetext": valueText }}
        className="[&_[data-slot=slider-thumb]]:border-border h-8 [&_[data-slot=slider-thumb]]:size-8 [&_[data-slot=slider-track]]:h-7"
      />
      <div
        className="pointer-events-none absolute inset-x-4 top-1/2 flex -translate-y-1/2 justify-between"
        aria-hidden="true"
      >
        {stops.map((stop, index) => (
          <span
            key={stop}
            className={cn(
              "size-1 rounded-full",
              index < selectedIndex
                ? "bg-primary-foreground/50"
                : "bg-muted-foreground/50",
              index === selectedIndex && "opacity-0",
            )}
          />
        ))}
      </div>
    </div>
  );
}
