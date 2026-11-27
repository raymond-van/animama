import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import { Switch } from "@/ui/components/switch";

export type CreatorSelectOption = {
  value: string;
  label: string;
};

export type CreatorCanvasSelect = {
  label: string;
  value: string;
  placeholder?: string;
  options: readonly CreatorSelectOption[];
  onValueChange: (value: string) => void;
  triggerClassName?: string;
  disabled?: boolean;
  /** `data-testid` of the select's trigger. */
  testId?: string;
};

/** Value and callback are either both present or both omitted. */
type CreatorGuidesControl =
  | { guides: boolean; onGuidesChange: (checked: boolean) => void }
  | { guides?: never; onGuidesChange?: never };

/** Shared preview chrome with optional Guides, domain tools and playback controls. */
export function CreatorCanvasControls({
  model,
  view,
  guides,
  guidesLabel,
  guidesAriaLabel,
  guidesDisabled,
  onGuidesChange,
  domainControl,
  playbackControl,
  restartDisabled,
  onRestart,
  className,
}: {
  model?: CreatorCanvasSelect;
  view?: CreatorCanvasSelect;
  guidesLabel?: string;
  guidesAriaLabel?: string;
  guidesDisabled?: boolean;
  domainControl?: ReactNode;
  /** Full transport replaces the standalone Restart button when supplied. */
  playbackControl?: ReactNode;
  restartDisabled?: boolean;
  onRestart?: () => void;
  className?: string;
} & CreatorGuidesControl) {
  const { t } = useTranslation("creator");
  return (
    <div
      role="group"
      aria-label={t("canvas.controls")}
      data-creator-preview-controls=""
      className={cn(
        "bg-background border-border/70 flex max-w-full flex-wrap items-center gap-2 rounded-xl border p-2 shadow-sm",
        className,
      )}
    >
      {model ? <CreatorCanvasSelectControl control={model} /> : null}
      {model && view ? <span className="bg-border h-5 w-px shrink-0" /> : null}
      {view ? <CreatorCanvasSelectControl control={view} /> : null}
      {guides !== undefined ? (
        <label className="flex shrink-0 items-center gap-2 text-xs">
          <Switch
            checked={guides}
            disabled={guidesDisabled}
            onCheckedChange={onGuidesChange}
            aria-label={guidesAriaLabel ?? t("canvas.showGuides")}
          />
          <span className="text-muted-foreground shrink-0 text-xs">
            {guidesLabel ?? t("canvas.guides")}
          </span>
        </label>
      ) : null}
      {domainControl}
      {playbackControl ??
        (onRestart ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={restartDisabled}
            onClick={onRestart}
            aria-label={t("canvas.restart")}
            title={t("canvas.restart")}
          >
            <RefreshCwIcon />
          </Button>
        ) : null)}
    </div>
  );
}

function CreatorCanvasSelectControl({
  control,
}: {
  control: CreatorCanvasSelect;
}) {
  const { t } = useTranslation("creator");
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="text-muted-foreground shrink-0 pl-1 text-xs">
        {control.label}
      </span>
      <Select
        value={control.value}
        onValueChange={control.onValueChange}
        disabled={control.disabled}
      >
        <SelectTrigger
          className={cn(
            "h-8 max-w-32 border-0 bg-transparent text-xs shadow-none focus-visible:ring-0 dark:bg-transparent",
            control.triggerClassName,
          )}
          aria-label={t("canvas.select", { label: control.label })}
          data-testid={control.testId}
        >
          <SelectValue placeholder={control.placeholder} />
        </SelectTrigger>
        <SelectContent>
          {control.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
