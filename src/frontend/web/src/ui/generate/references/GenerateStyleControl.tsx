import { ChevronDown } from "lucide-react";
import type { TFunction } from "i18next";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { errorWording } from "@/lib/errors/apiError";
import {
  GENERATION_STYLE_PRESETS,
  knownStylePreset,
  stylePresetName,
} from "../stylePresets";
import type { GenerationStyleChoice } from "./useGenerationStyle";

/**
 * Why a style was not stored, after the sentence that says it was not: the
 * backend's code in words, or to try again when nothing words it.
 */
function styleFailureReason(
  t: TFunction<"generate">,
  code: string | null,
): string {
  // A preset this build lists and the backend does not.
  if (code === "generation_style_preset_unknown")
    return t("style.failure.unknown");
  return (
    (code ? errorWording("generation", code) : null) ?? t("style.failure.retry")
  );
}

/**
 * The conversation's style, as a labelled choice in the references row:
 * None, or one of the presets by name. Choosing stores the preset's id on the
 * conversation, where it stays until changed or cleared; the run in flight
 * keeps the style it started with. A choice that was not stored is said in
 * `GenerateStyleFailure`, which this control is described by.
 */
export function GenerateStyleControl({
  style,
  disabled,
  failureId,
}: {
  style: GenerationStyleChoice;
  /** The conversation is not ready to take a style. */
  disabled: boolean;
  /** The id of the notice that says a choice was not stored, when shown. */
  failureId?: string;
}) {
  const { t } = useTranslation("generate");
  const selectId = useId();
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <label htmlFor={selectId} className="text-muted-foreground text-xs">
        {t("style.label")}
      </label>
      <span className="relative">
        {/* A native menu, as the camera presets use: it works by keyboard
            and inside the floating panel without a portal. */}
        <select
          id={selectId}
          data-testid="generate-style"
          className="border-input bg-background focus-visible:ring-ring/50 h-8 max-w-44 appearance-none truncate rounded-md border pr-7 pl-2 text-xs outline-none focus-visible:ring-[3px] disabled:opacity-60 aria-disabled:opacity-60"
          value={style.value ?? ""}
          disabled={disabled}
          // While a choice is stored the control stays enabled, so the
          // keyboard's focus stays on it; a change made meanwhile is
          // ignored, and the choice being stored stays shown.
          aria-disabled={style.saving || undefined}
          aria-busy={style.saving}
          aria-describedby={failureId}
          onChange={(event) => {
            if (style.saving) return;
            style.choose(knownStylePreset(event.target.value));
          }}
        >
          <option value="">{t("style.none")}</option>
          {GENERATION_STYLE_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {stylePresetName(t, preset)}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2"
        />
      </span>
    </span>
  );
}

/** Says that the last style chosen was not stored, and why. */
export function GenerateStyleFailure({
  id,
  code,
}: {
  id: string;
  /** The backend's code for the refusal, or `null` when it gave none. */
  code: string | null;
}) {
  const { t } = useTranslation("generate");
  return (
    <p
      id={id}
      role="alert"
      data-testid="generate-style-failure"
      className="text-destructive text-xs"
    >
      {t("style.failure.notSaved")} {styleFailureReason(t, code)}
    </p>
  );
}
