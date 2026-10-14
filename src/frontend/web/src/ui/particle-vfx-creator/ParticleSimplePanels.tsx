import { Loader2Icon, RotateCcwIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  PARTICLE_VFX_COLOUR_THEMES,
  PARTICLE_VFX_SIMPLE_CONTROLS,
  PARTICLE_VFX_SIMPLE_STEP,
  countParticleVFXMultiParticleLayers,
  isParticleVFXColourThemeId,
  particleVFXSimpleControlBounds,
  type ParticleVFXColourThemeId,
  type ParticleVFXSimpleBounds,
  type ParticleVFXSimpleControl,
  type ParticleVFXSimpleFactors,
  type ParticleVFXSimpleReference,
} from "@/lib/avatar/particle-vfx";
import { cn } from "@/lib/utils";
import { CreatorFloatingPanel } from "@/ui/content-creator";
import { RadioGroup, RadioGroupOption } from "@/ui/components/radio-group";
import { Slider } from "@/ui/components/slider";

/** Each control's label and what it changes, as Simple shows them. */
const SIMPLE_CONTROL_TEXT: Record<
  ParticleVFXSimpleControl,
  { label: string; description: string }
> = {
  amount: {
    label: "Amount",
    description: "How many particles each layer emits",
  },
  size: { label: "Size", description: "How big every particle is" },
  speed: { label: "Speed", description: "How fast the whole effect plays" },
  spread: { label: "Spread", description: "How far the effect reaches" },
};

/** "150 %", for the visible value and the slider's value text. */
function simplePercentText(value: number): string {
  return `${value} %`;
}

/**
 * Why a control stops short of its range end, or null when it does not.
 * Speed is the only control a limit stops from below (a long effect played
 * slower would run past 30 seconds).
 */
export function simpleLimitNote(
  bounds: ParticleVFXSimpleBounds,
): string | null {
  const notes = (
    [
      [bounds.maxLimit, bounds.max, "higher"],
      [bounds.minLimit, bounds.min, "lower"],
    ] as const
  ).flatMap(([limit, value, direction]) =>
    limit
      ? [
          `Stops at ${simplePercentText(value)}: ${direction} would ${
            limit === "particles"
              ? "pass the 512-particle limit"
              : "run longer than 30 seconds"
          }.`,
        ]
      : [],
  );
  return notes.length ? notes.join(" ") : null;
}

/**
 * Simple mode's left panel: what the effect is (its template, or its name),
 * where it plays and how many layers it has. Read-only.
 */
export function ParticleSimpleEffectPanel({
  templateName,
  effectName,
  anchorLabel,
  layerCount,
}: {
  /** The template a new draft started from, if any (page state). */
  templateName: string | null;
  effectName: string;
  anchorLabel: string;
  layerCount: number;
}) {
  const rows: ReadonlyArray<readonly [string, string]> = [
    templateName
      ? ["From template", templateName]
      : ["Effect", effectName.trim() || "New Particle FX"],
    ["Plays at", anchorLabel],
    ["Layers", String(layerCount)],
  ];
  return (
    <CreatorFloatingPanel title="Effect">
      <dl className="space-y-3">
        {rows.map(([term, value]) => (
          <div key={term} className="space-y-0.5">
            <dt className="text-muted-foreground text-xs">{term}</dt>
            <dd className="text-sm font-medium break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground mt-4 text-xs">
        Adjust the whole effect with the controls. Switch to Advanced to edit
        each layer.
      </p>
    </CreatorFloatingPanel>
  );
}

/**
 * A swatch's look: a colour theme's target hue, White, or (for Original,
 * which has its own icon) the muted surface. Data colours, so inline.
 */
function swatchStyle(hue: number | null, id: ParticleVFXColourThemeId) {
  if (hue !== null)
    return { backgroundColor: `hsl(${hue} 75% 58%)` } satisfies CSSProperties;
  return id === "white"
    ? ({ backgroundColor: "hsl(0 0% 100%)" } satisfies CSSProperties)
    : undefined;
}

/** What the colour theme is doing: the swatch being applied, or why not. */
export type ParticleSimpleThemeStatus = {
  /** The swatch whose recolouring is under way, if any. */
  pending: ParticleVFXColourThemeId | null;
  error: string | null;
};

/**
 * The colour theme swatches (decision P-COLOUR) as a labelled radio group:
 * arrow keys move between swatches and choose one. While a theme is being
 * applied the group stays usable and announces the work; choosing again
 * replaces the earlier choice.
 */
function ParticleColourThemeField({
  value,
  status,
  onChange,
}: {
  value: ParticleVFXColourThemeId;
  status: ParticleSimpleThemeStatus;
  onChange: (theme: ParticleVFXColourThemeId) => void;
}) {
  const id = useId();
  return (
    <div>
      <div>
        <div id={`${id}-label`} className="text-sm font-medium">
          Colour theme
        </div>
        <p id={`${id}-description`} className="text-muted-foreground text-xs">
          Recolours the art and the colours together
        </p>
      </div>
      <RadioGroup
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        aria-busy={status.pending !== null}
        value={status.pending ?? value}
        onValueChange={(next) => {
          if (isParticleVFXColourThemeId(next)) onChange(next);
        }}
        className="mt-2 grid grid-cols-7 gap-1"
      >
        {PARTICLE_VFX_COLOUR_THEMES.map(({ id: theme, label, hue }) => (
          <RadioGroupOption
            key={theme}
            value={theme}
            className="group flex min-w-0 flex-col items-center gap-1.5 rounded-md py-1"
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-7 items-center justify-center rounded-full border transition-shadow duration-150",
                "group-data-[state=checked]:ring-primary group-data-[state=checked]:ring-offset-background group-data-[state=checked]:ring-2 group-data-[state=checked]:ring-offset-2",
                theme === "original" && "bg-muted text-muted-foreground",
              )}
              style={swatchStyle(hue, theme)}
            >
              {theme === "original" ? (
                <RotateCcwIcon className="size-3.5" />
              ) : null}
            </span>
            <span className="text-muted-foreground group-data-[state=checked]:text-foreground text-2xs max-w-full truncate group-data-[state=checked]:font-medium">
              {label}
            </span>
          </RadioGroupOption>
        ))}
      </RadioGroup>
      {/* A persistent live region, so the work is announced when it starts. */}
      <p
        aria-live="polite"
        className="text-muted-foreground flex items-center gap-1.5 text-xs [&:not(:empty)]:mt-2"
      >
        {status.pending ? (
          <>
            <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
            Recolouring the art…
          </>
        ) : null}
      </p>
      {status.error ? (
        <p role="alert" className="text-destructive mt-2 text-xs">
          {status.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Simple mode's right panel: Amount, Size, Speed and Spread as percentages
 * of the reference, each limited to where the effect stays within 512
 * particles and 30 seconds (and saying which limit stopped it), and the
 * colour theme swatches.
 *
 * A pointer drag is one undo step: `onAdjustStart` on pointer down and
 * `onAdjustEnd` on release, with the draft (and so the preview) updated at
 * most once per animation frame in between. Each keyboard step is applied
 * at once, as its own step. While a slider drags, the bounds stay those from
 * when it started: a control's own bounds depend only on the others. While
 * a theme is being applied the sliders wait.
 */
export function ParticleSimpleAdjustPanel({
  reference,
  factors,
  colourTheme,
  themeStatus,
  onAdjustStart,
  onAdjust,
  onAdjustEnd,
  onColourTheme,
}: {
  reference: ParticleVFXSimpleReference;
  factors: ParticleVFXSimpleFactors;
  colourTheme: ParticleVFXColourThemeId;
  themeStatus: ParticleSimpleThemeStatus;
  onAdjustStart: () => void;
  onAdjust: (control: ParticleVFXSimpleControl, percent: number) => void;
  onAdjustEnd: () => void;
  onColourTheme: (theme: ParticleVFXColourThemeId) => void;
}) {
  const [drag, setDrag] = useState<{
    control: ParticleVFXSimpleControl;
    value: number;
    factors: ParticleVFXSimpleFactors;
  } | null>(null);
  // Frozen at a drag's start, so the search does not rerun every frame.
  const boundsFactors = drag?.factors ?? factors;
  const bounds = useMemo(
    () => particleVFXSimpleControlBounds(reference, boundsFactors),
    [boundsFactors, reference],
  );
  const idPrefix = useId();
  const amountApplies = useMemo(
    () => countParticleVFXMultiParticleLayers(reference.quarksJson) > 0,
    [reference],
  );

  // The latest callbacks, so a frame or unmount never calls stale ones.
  const callbacks = useRef({ onAdjustStart, onAdjust, onAdjustEnd });
  callbacks.current = { onAdjustStart, onAdjust, onAdjustEnd };
  const dragging = useRef<ParticleVFXSimpleControl | null>(null);
  const pending = useRef<{
    control: ParticleVFXSimpleControl;
    value: number;
  } | null>(null);
  const frame = useRef<number | null>(null);

  const flush = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) callbacks.current.onAdjust(next.control, next.value);
  };
  const endDrag = () => {
    if (!dragging.current) return;
    flush();
    dragging.current = null;
    setDrag(null);
    callbacks.current.onAdjustEnd();
  };
  // Leaving mid-drag still applies the last value and closes the undo step.
  useEffect(() => () => endDrag(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const startDrag = (control: ParticleVFXSimpleControl) => {
    if (dragging.current) return;
    dragging.current = control;
    setDrag({ control, value: factors[control], factors });
    callbacks.current.onAdjustStart();
  };
  const change = (control: ParticleVFXSimpleControl, value: number) => {
    if (dragging.current !== control) {
      callbacks.current.onAdjust(control, value);
      return;
    }
    pending.current = { control, value };
    setDrag((current) => current && { ...current, value });
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      flush();
    });
  };

  return (
    <CreatorFloatingPanel title="Adjust">
      <div className="space-y-5">
        {PARTICLE_VFX_SIMPLE_CONTROLS.map((control) => {
          const { label, description } = SIMPLE_CONTROL_TEXT[control];
          const value =
            drag?.control === control ? drag.value : factors[control];
          const controlBounds = bounds[control];
          const nothingToScale = control === "amount" && !amountApplies;
          const disabled =
            nothingToScale ||
            controlBounds.min === controlBounds.max ||
            themeStatus.pending !== null;
          const note = nothingToScale
            ? "Each layer shows a single particle, so there is nothing to scale."
            : simpleLimitNote(controlBounds);
          const descriptionId = `${idPrefix}-${control}-description`;
          const noteId = `${idPrefix}-${control}-note`;
          return (
            <div key={control} className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{label}</div>
                  <p
                    id={descriptionId}
                    className="text-muted-foreground text-xs"
                  >
                    {description}
                  </p>
                </div>
                <span
                  aria-hidden="true"
                  className="text-sm font-medium whitespace-nowrap tabular-nums"
                >
                  {simplePercentText(value)}
                </span>
              </div>
              <Slider
                value={[value]}
                min={controlBounds.min}
                max={controlBounds.max}
                step={PARTICLE_VFX_SIMPLE_STEP}
                disabled={disabled}
                thumbProps={{
                  "aria-label": label,
                  "aria-valuetext": simplePercentText(value),
                  "aria-describedby": note
                    ? `${descriptionId} ${noteId}`
                    : descriptionId,
                }}
                onValueChange={([next]) => {
                  if (typeof next === "number" && next !== value)
                    change(control, next);
                }}
                onPointerDown={() => {
                  if (!disabled) startDrag(control);
                }}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onLostPointerCapture={endDrag}
                className="py-1"
              />
              {note ? (
                <p id={noteId} className="text-muted-foreground text-xs">
                  {note}
                </p>
              ) : null}
            </div>
          );
        })}
        <ParticleColourThemeField
          value={colourTheme}
          status={themeStatus}
          onChange={onColourTheme}
        />
      </div>
    </CreatorFloatingPanel>
  );
}
