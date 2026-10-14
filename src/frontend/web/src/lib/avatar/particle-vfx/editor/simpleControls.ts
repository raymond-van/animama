/**
 * Simple mode's broad Particle controls (decision P-MAP): Amount, Size, Speed
 * and Spread each scale the whole effect while keeping the relationships
 * between its emitters (layers). The colour theme (decision P-COLOUR,
 * `colourTheme.ts`) recolours it.
 *
 * The controls are percentages of a reference: the effect as it was when a
 * Simple control was first used after opening, or after the last edit made
 * anywhere else (an Advanced edit makes the edited effect the new reference;
 * the page does this at its draft-update boundary). The scaled and themed
 * effect is always recomputed from the reference, so every control back at
 * 100 % and Original restores it byte for byte and rounded burst counts
 * never drift. The reference, percentages and theme live on the draft
 * (`draft.simple`), so undo, redo and recovery restore them; Save writes only
 * the resulting effect.
 *
 * Fields, for three.quarks 0.17.1. `a`, `s`, `k` and `p` are Amount, Size,
 * Speed and Spread as fractions (150 % is 1.5). Speed is tempo: the same
 * paths and choreography, k times faster. Spread is the footprint: where
 * particles start and how far they travel, without resizing them.
 *
 * | Field | Treatment |
 * | --- | --- |
 * | node translation (matrix 12–14) below the root | × p; rotation and scale stay; the root (a group or one emitter) is placed by the catalog transform |
 * | `ps.duration` (cycle length, s) | ÷ k |
 * | `startLife` (s) | ÷ k |
 * | `startSpeed` (m/s) | × k·p |
 * | `startSize` (m) | × s |
 * | `startRotation`, `startColor`, `startTileIndex` | unchanged |
 * | `emissionOverTime` (per s) | × a·k (a: multi-particle layers only) |
 * | `emissionOverDistance` (per m the emitter travels) | × a for multi-particle layers; the travel is the Avatar's |
 * | every `emissionBursts[]` entry | `count` × a, rounded, at least 1 where it was (multi-particle layers only); `time`, `interval` ÷ k; `cycle`, `probability` unchanged |
 * | `shape` `radius`, `width`, `height`, `donutRadius` (m) | × p, except the width and height of a rectangle the Avatar auto-fit sizes |
 * | `shape.speed` (loops per second, Loop and PingPong modes) | × k |
 * | `shape` `arc`, `angle`, `thickness`, `spread` (fractions), `mode`, grid `column`/`row` | unchanged |
 * | `rendererEmitterSettings.speedFactor` (stretched billboard length per m/s) | ÷ k·p, so a streak keeps its length beside its particle |
 * | `rendererEmitterSettings` `lengthFactor`, trail `startLength` (points, one per frame) | unchanged |
 * | ForceOverLife `x`, `y`, `z`; ApplyForce `magnitude` (m/s²) | × k²·p |
 * | GravityForce | `center` × p; `magnitude` (pull × distance²) × k²·p³ |
 * | RotationOverLife, RotationBySpeed `angularVelocity` (rad/s) | × k |
 * | Rotation3DOverLife AxisAngle `angle`, Euler `angleX/Y/Z` (rad/s) | × k; RandomQuat (a fixed turn per frame) unchanged |
 * | OrbitOverLife `orbitSpeed` (rad/s) | × k; `axis` unchanged |
 * | Noise | `frequency` × k; `positionAmount` (a displacement) × p; `power`, `rotationAmount` unchanged |
 * | TurbulenceField | `scale` (field length) × p; `velocityMultiplier` (acceleration) × k²·p; `timeScale` × k; `octaves` unchanged |
 * | LimitSpeedOverLife | `speed` (m/s) × k·p; `dampen` (a rate per second) × k |
 * | RotationBySpeed, SizeBySpeed, ColorBySpeed `speedRange` (m/s) | × k·p |
 * | SpeedOverLife, SizeOverLife, ColorOverLife, FrameOverLife, WidthOverLength | unchanged: relative to the start values or the particle's life |
 * | ChangeEmitDirection, EmitSubParticleSystem, other behaviours | unchanged |
 * | catalog `defaultDurationSec`, `performanceBudget.maxDurationSec` | ÷ k |
 * | catalog `performanceBudget.maxParticles` | min(512, max(reference, estimate)) when the estimate is finite |
 * | catalog transform, anchor, `shapeAutoFit` and the rest | unchanged |
 *
 * Value generators: `ConstantValue` (`value`), `IntervalValue` (`a`, `b`)
 * and `PiecewiseBezier` (control points `p0`–`p3`, as absolute values over
 * normalized time) are scaled; any other generator is left untouched. Burst
 * counts scale `ConstantValue` and `IntervalValue` only. World-space emitters
 * scale the same way. A single-particle layer emits no stream (both rates 0)
 * and at most one particle from all its bursts: a hero, halo, ring or flash.
 */
import { normalizeParticleVFXShapeAutoFit } from "../autoFit";
import type {
  ParticleVFXColourTransform,
  ParticleVFXTextureSample,
} from "./colourPixels";
import {
  applyParticleVFXSimpleTheme,
  isIdentityParticleVFXColourTransform,
  isParticleVFXThemeColouredTexture,
  particleVFXThemeTransform,
  particleVFXThemedTextureReference,
} from "./colourTheme";
import {
  PARTICLE_VFX_MAX_DURATION_SECONDS,
  PARTICLE_VFX_MAX_PARTICLES,
} from "./contentReadiness";
import {
  replaceParticleVFXEditorEffect,
  updateParticleVFXEditorCatalogDraft,
} from "./draft";
import { cloneJsonObject, readJsonArrayObjects, readJsonObject } from "./json";
import { roundEditorNumber } from "./numbers";
import { estimateParticleVFXParticles } from "./particleEstimate";
import {
  particleVFXTextureLimitMessage,
  particleVFXTextureReferences,
  readParticleVFXTextureFile,
} from "./textureFiles";
import type {
  JsonObject,
  ParticleVFXColourThemeId,
  ParticleVFXEditorDraft,
  ParticleVFXEditorTextureFile,
  ParticleVFXSimpleControl,
  ParticleVFXSimpleFactors,
  ParticleVFXSimpleReference,
  ParticleVFXSimpleState,
  ParticleVFXSimpleTheme,
} from "./types";

export type {
  ParticleVFXColourThemeId,
  ParticleVFXSimpleControl,
  ParticleVFXSimpleFactors,
  ParticleVFXSimpleReference,
  ParticleVFXSimpleState,
  ParticleVFXSimpleTheme,
} from "./types";

/** The four controls, in the order Simple shows them. */
export const PARTICLE_VFX_SIMPLE_CONTROLS: readonly ParticleVFXSimpleControl[] =
  ["amount", "size", "speed", "spread"];

/** Every control at 100 %: the reference unchanged. */
export const PARTICLE_VFX_SIMPLE_NEUTRAL: Readonly<ParticleVFXSimpleFactors> = {
  amount: 100,
  size: 100,
  speed: 100,
  spread: 100,
};

/** Each control's range in percent (owner-accepted), before the limits. */
export const PARTICLE_VFX_SIMPLE_RANGES: Readonly<
  Record<ParticleVFXSimpleControl, { min: number; max: number }>
> = {
  amount: { min: 25, max: 400 },
  size: { min: 25, max: 300 },
  speed: { min: 25, max: 300 },
  spread: { min: 25, max: 300 },
};

/** Controls move on a 5 % grid. */
export const PARTICLE_VFX_SIMPLE_STEP = 5;

/** The private Particle Effect limits a control may not cross. */
const MAX_PARTICLES = PARTICLE_VFX_MAX_PARTICLES;
const MAX_DURATION_SECONDS = PARTICLE_VFX_MAX_DURATION_SECONDS;

/** three.quarks' stretched billboard render mode (`RenderMode.StretchedBillBoard`). */
const STRETCHED_BILLBOARD_RENDER_MODE = 1;

/** A limit that stopped a control: the 512-particle estimate or 30 seconds. */
export type ParticleVFXSimpleLimit = "particles" | "duration";

/**
 * How far one control can move from where it is with the others held, on
 * its 5 % grid. A limit names what stopped it short of its range end.
 */
export type ParticleVFXSimpleBounds = {
  min: number;
  max: number;
  minLimit: ParticleVFXSimpleLimit | null;
  maxLimit: ParticleVFXSimpleLimit | null;
};

type Scale = { amount: number; size: number; speed: number; spread: number };

/** A draft's control positions; a draft without Simple state is at 100 %. */
export function particleVFXSimpleFactors(
  draft: Pick<ParticleVFXEditorDraft, "simple">,
): ParticleVFXSimpleFactors {
  return draft.simple?.factors ?? { ...PARTICLE_VFX_SIMPLE_NEUTRAL };
}

/** Whether two sets of control positions are the same. */
export function equalParticleVFXSimpleFactors(
  left: ParticleVFXSimpleFactors,
  right: ParticleVFXSimpleFactors,
): boolean {
  return PARTICLE_VFX_SIMPLE_CONTROLS.every(
    (control) => left[control] === right[control],
  );
}

/** Whether every control is at 100 %. */
export function isNeutralParticleVFXSimpleFactors(
  factors: ParticleVFXSimpleFactors,
): boolean {
  return equalParticleVFXSimpleFactors(factors, PARTICLE_VFX_SIMPLE_NEUTRAL);
}

/** The draft's colour theme swatch; a draft without one is Original. */
export function particleVFXColourThemeId(
  draft: Pick<ParticleVFXEditorDraft, "simple">,
): ParticleVFXColourThemeId {
  return draft.simple?.theme?.id ?? "original";
}

/**
 * Whether two Simple states leave the reference the same way: the same
 * control positions and the same theme with the same step. (Their copies'
 * bytes count in the document fingerprint.)
 */
export function equalParticleVFXSimpleSettings(
  left: Pick<ParticleVFXEditorDraft, "simple">,
  right: Pick<ParticleVFXEditorDraft, "simple">,
): boolean {
  const leftTheme = left.simple?.theme ?? null;
  const rightTheme = right.simple?.theme ?? null;
  return (
    equalParticleVFXSimpleFactors(
      particleVFXSimpleFactors(left),
      particleVFXSimpleFactors(right),
    ) &&
    leftTheme?.id === rightTheme?.id &&
    JSON.stringify(leftTheme?.transform) ===
      JSON.stringify(rightTheme?.transform)
  );
}

/** Whether a Simple state changes nothing: 100 % everywhere and Original. */
export function isNeutralParticleVFXSimpleState(
  state: ParticleVFXSimpleState | null,
): boolean {
  return (
    !state || (isNeutralParticleVFXSimpleFactors(state.factors) && !state.theme)
  );
}

/** The effect as it is now: the reference a first Simple use captures. */
function captureParticleVFXSimpleReference(
  draft: ParticleVFXEditorDraft,
): ParticleVFXSimpleReference {
  return {
    catalog: structuredClone(draft.catalog),
    quarksJson: cloneJsonObject(draft.quarksJson),
  };
}

/**
 * The draft with `state` written into it: the reference scaled by its
 * factors and recoloured by its theme. Simple never names the effect, so
 * the draft keeps any name given since the reference.
 */
function withParticleVFXSimpleState(
  draft: ParticleVFXEditorDraft,
  state: ParticleVFXSimpleState,
  textureFiles: ParticleVFXEditorDraft["textureFiles"] = draft.textureFiles,
): ParticleVFXEditorDraft {
  const effect = applyParticleVFXSimpleControls(state.reference, state.factors);
  applyParticleVFXSimpleTheme(effect.quarksJson, state.theme);
  effect.catalog.label = draft.catalog.label;
  return {
    ...replaceParticleVFXEditorEffect({ ...draft, textureFiles }, effect),
    simple: state,
  };
}

/**
 * Move one control on a draft and write the scaled effect into it, keeping
 * its colour theme. The first use captures the draft's effect as the
 * reference; later uses scale that same reference. `percent` snaps to the
 * 5 % grid within the control's range; callers keep it within
 * `particleVFXSimpleControlBounds`.
 */
export function setParticleVFXSimpleControl(
  draft: ParticleVFXEditorDraft,
  control: ParticleVFXSimpleControl,
  percent: number,
): ParticleVFXEditorDraft {
  const range = PARTICLE_VFX_SIMPLE_RANGES[control];
  const snapped =
    Math.round(percent / PARTICLE_VFX_SIMPLE_STEP) * PARTICLE_VFX_SIMPLE_STEP;
  return withParticleVFXSimpleState(draft, {
    reference:
      draft.simple?.reference ?? captureParticleVFXSimpleReference(draft),
    factors: {
      ...particleVFXSimpleFactors(draft),
      [control]: Math.min(range.max, Math.max(range.min, snapped)),
    },
    theme: draft.simple?.theme ?? null,
  });
}

/**
 * Decoding and encoding for the colour theme: in a worker where the browser
 * allows, otherwise on the main thread (`particleTextureCodec.ts`).
 */
export type ParticleVFXTextureCodec = {
  /** The texture scaled to at most 128 px on its longer side, as RGBA. */
  sample: (blob: Blob) => Promise<ParticleVFXTextureSample>;
  /** The texture with every pixel recoloured by `transform`, as a PNG. */
  recolour: (
    blob: Blob,
    transform: ParticleVFXColourTransform,
  ) => Promise<Blob>;
};

export type ParticleVFXColourThemeResult =
  | { ok: true; draft: ParticleVFXEditorDraft }
  | { ok: false; message: string };

function basename(reference: string): string {
  return reference.split("/").at(-1) ?? reference;
}

/**
 * Choose a colour theme swatch (decision P-COLOUR) and write the recoloured
 * effect into the draft, as one edit; Original is the reference again.
 *
 * The step is measured on the reference (`particleVFXThemeTransform`): it
 * moves the effect's dominant hue onto the swatch's target hue, and White
 * desaturates instead. Every emitter colour takes the step, and so does every
 * texture of the reference that is not near grey: it is decoded, recoloured
 * and encoded as a PNG through `codec`, checked against the texture limits,
 * and added as the effect's own file under a deterministic name
 * (`particleVFXThemedTextureReference`); built-in textures are fetched
 * through `loadTexture` (null when unavailable). The reference's own
 * textures stay in the draft, so Original restores them exactly; the copies
 * an earlier theme added are dropped. The Amount, Size, Speed and Spread
 * positions are kept.
 *
 * A failure (decoding, encoding, a limit, or an effect showing no colour for
 * a colour theme to move) returns why and leaves the draft as it was. An
 * aborted `signal` rejects with its reason.
 */
export async function setParticleVFXColourTheme(
  draft: ParticleVFXEditorDraft,
  themeId: ParticleVFXColourThemeId,
  {
    codec,
    loadTexture,
    signal,
  }: {
    codec: ParticleVFXTextureCodec;
    loadTexture: (reference: string) => Promise<Blob | null>;
    signal?: AbortSignal;
  },
): Promise<ParticleVFXColourThemeResult> {
  if (themeId === particleVFXColourThemeId(draft)) return { ok: true, draft };
  const reference =
    draft.simple?.reference ?? captureParticleVFXSimpleReference(draft);
  const factors = particleVFXSimpleFactors(draft);
  // The earlier theme's copies go; the reference's own textures stay.
  const earlierCopies = new Set(
    Object.values(draft.simple?.theme?.textures ?? {}),
  );
  const kept = Object.fromEntries(
    Object.entries(draft.textureFiles).filter(
      ([path]) => !earlierCopies.has(path),
    ),
  );
  if (themeId === "original")
    return {
      ok: true,
      draft: withParticleVFXSimpleState(
        draft,
        { reference, factors, theme: null },
        kept,
      ),
    };

  const references = particleVFXTextureReferences(reference.quarksJson);
  const sources = new Map<
    string,
    { blob: Blob; sample: ParticleVFXTextureSample }
  >();
  for (const path of references) {
    signal?.throwIfAborted();
    const blob = kept[path]?.blob ?? (await loadTexture(path));
    if (!blob) continue;
    try {
      sources.set(path, { blob, sample: await codec.sample(blob) });
    } catch (error) {
      signal?.throwIfAborted();
      return { ok: false, message: textureFailure(path, "read", error) };
    }
  }
  const transform = particleVFXThemeTransform(
    themeId,
    reference.quarksJson,
    new Map([...sources].map(([path, { sample }]) => [path, sample])),
  );
  if (!transform)
    return {
      ok: false,
      message: "This effect shows no colour for a theme to change.",
    };

  const textures: Record<string, string> = {};
  const copies: Record<string, ParticleVFXEditorTextureFile> = {};
  const taken = new Set([...Object.keys(kept), ...references]);
  if (!isIdentityParticleVFXColourTransform(transform))
    for (const [path, { blob, sample }] of sources) {
      // Near-grey art shows the emitter colours, which the theme changes.
      if (!isParticleVFXThemeColouredTexture(sample)) continue;
      signal?.throwIfAborted();
      let recoloured: Blob;
      try {
        recoloured = await codec.recolour(blob, transform);
      } catch (error) {
        signal?.throwIfAborted();
        return {
          ok: false,
          message: textureFailure(path, "recoloured", error),
        };
      }
      const read = await readParticleVFXTextureFile(recoloured);
      if (!read.ok)
        return {
          ok: false,
          message: `${basename(path)} could not be recoloured: ${read.message}`,
        };
      const copy = particleVFXThemedTextureReference(path, themeId, taken);
      taken.add(copy);
      textures[path] = copy;
      copies[copy] = read.file;
    }
  signal?.throwIfAborted();

  const theme: ParticleVFXSimpleTheme = { id: themeId, transform, textures };
  const next = withParticleVFXSimpleState(
    draft,
    { reference, factors, theme },
    { ...kept, ...copies },
  );
  const limit = particleVFXTextureLimitMessage(next);
  return limit ? { ok: false, message: limit } : { ok: true, draft: next };
}

/** Why one texture stopped a theme, naming the texture. */
function textureFailure(
  path: string,
  failed: "read" | "recoloured",
  error: unknown,
): string {
  const reason =
    error instanceof Error && error.message
      ? error.message
      : "The image could not be decoded.";
  return `${basename(path)} could not be ${failed}: ${reason}`;
}

/**
 * Rename the effect. Simple never scales the name, and a Simple move keeps
 * the draft's own, so renaming keeps the Simple state as it is (the same
 * reference and positions) rather than causing the rebase other edits do.
 */
export function renameParticleVFXEditorDraft(
  draft: ParticleVFXEditorDraft,
  label: string,
): ParticleVFXEditorDraft {
  return updateParticleVFXEditorCatalogDraft(draft, { label });
}

/**
 * The reference scaled by `factors` (see the module comment for each field),
 * as new copies. All controls at 100 % return an exact copy of the reference.
 */
export function applyParticleVFXSimpleControls(
  reference: ParticleVFXSimpleReference,
  factors: ParticleVFXSimpleFactors,
): ParticleVFXSimpleReference {
  const catalog = structuredClone(reference.catalog);
  const quarksJson = cloneJsonObject(reference.quarksJson);
  if (isNeutralParticleVFXSimpleFactors(factors))
    return { catalog, quarksJson };

  const scale: Scale = {
    amount: factors.amount / 100,
    size: factors.size / 100,
    speed: factors.speed / 100,
    spread: factors.spread / 100,
  };
  const autoFit = normalizeParticleVFXShapeAutoFit(catalog.shapeAutoFit);
  const autoFitNames = autoFit?.emitterNames
    ? new Set(autoFit.emitterNames)
    : null;
  // Every emitter, the root included (an imported single-emitter effect may
  // be one); every node's offset but the root's, which the catalog places.
  const visit = (node: JsonObject, isRoot: boolean) => {
    if (!isRoot) scaleTranslation(node, scale.spread);
    const ps = readJsonObject(node.ps);
    if (node.type === "ParticleEmitter" && ps) {
      const autoFitted =
        !!autoFit &&
        (!autoFitNames ||
          (typeof node.name === "string" && autoFitNames.has(node.name)));
      scaleSystem(ps, scale, autoFitted);
    }
    for (const child of readJsonArrayObjects(node.children))
      visit(child, false);
  };
  const root = readJsonObject(quarksJson.object);
  if (root) visit(root, true);

  const k = scale.speed;
  catalog.defaultDurationSec = scaleNumber(catalog.defaultDurationSec, 1 / k);
  const budget = catalog.performanceBudget;
  budget.maxDurationSec = scaleNumber(budget.maxDurationSec, 1 / k);
  // The declared budget follows the estimate up to the limit, never lower
  // than the reference declared.
  const estimate = estimateParticleVFXParticles(quarksJson);
  if (Number.isFinite(estimate))
    budget.maxParticles = Math.min(
      MAX_PARTICLES,
      Math.max(budget.maxParticles, estimate),
    );
  return { catalog, quarksJson };
}

/**
 * A layer that emits exactly one particle per cycle (a hero, halo, ring or
 * flash): no stream, and at most one particle from all its bursts. Amount
 * leaves such a layer single. An unreadable rate or count is not single.
 */
export function isSingleParticleSystem(ps: JsonObject): boolean {
  // three.quarks emits 10 per second without a rate, and none per metre.
  if (generatorMaximum(ps.emissionOverTime) !== 0) return false;
  if (
    ps.emissionOverDistance !== undefined &&
    generatorMaximum(ps.emissionOverDistance) !== 0
  )
    return false;
  let total = 0;
  for (const burst of readJsonArrayObjects(ps.emissionBursts)) {
    const count = generatorMaximum(burst.count);
    if (count === null) return false;
    total += count;
  }
  return total <= 1;
}

/** How many of an effect's layers Amount scales (not single-particle). */
export function countParticleVFXMultiParticleLayers(
  quarksJson: JsonObject,
): number {
  let count = 0;
  const visit = (node: JsonObject) => {
    const ps = readJsonObject(node.ps);
    if (node.type === "ParticleEmitter" && ps && !isSingleParticleSystem(ps))
      count += 1;
    readJsonArrayObjects(node.children).forEach(visit);
  };
  const root = readJsonObject(quarksJson.object);
  if (root) visit(root);
  return count;
}

/**
 * The controls a limit can stop. Size and Spread change no field the
 * particle estimate or a duration reads (`LIMIT_FIELDS` and the catalog
 * durations), so they always span their whole range.
 */
const LIMITED_CONTROLS: ReadonlySet<ParticleVFXSimpleControl> = new Set([
  "amount",
  "speed",
]);

/**
 * How far each control can move from `factors` with the others held: the
 * furthest values on the 5 % grid, within its range, that keep the particle
 * estimate within 512 and every duration within 30 seconds. A move that does
 * not make an exceeded limit worse stays allowed, so an effect already over
 * a limit can still move back toward it.
 */
export function particleVFXSimpleControlBounds(
  reference: ParticleVFXSimpleReference,
  factors: ParticleVFXSimpleFactors,
): Record<ParticleVFXSimpleControl, ParticleVFXSimpleBounds> {
  const skeleton = limitSkeleton(reference);
  const measure = (candidate: ParticleVFXSimpleFactors) => {
    const effect = applyParticleVFXSimpleControls(skeleton, candidate);
    return {
      particles: estimateParticleVFXParticles(effect.quarksJson),
      duration: longestDuration(effect),
    };
  };
  const current = measure(factors);
  const exceeded = (
    candidate: ParticleVFXSimpleFactors,
  ): ParticleVFXSimpleLimit | null => {
    const next = measure(candidate);
    if (next.particles > MAX_PARTICLES && next.particles > current.particles)
      return "particles";
    if (
      next.duration > MAX_DURATION_SECONDS &&
      next.duration > current.duration
    )
      return "duration";
    return null;
  };
  const reach = (control: ParticleVFXSimpleControl, direction: 1 | -1) => {
    const range = PARTICLE_VFX_SIMPLE_RANGES[control];
    const end = direction > 0 ? range.max : range.min;
    if (!LIMITED_CONTROLS.has(control)) return { value: end, limit: null };
    let value = factors[control];
    while (direction > 0 ? value < end : value > end) {
      const step = value + direction * PARTICLE_VFX_SIMPLE_STEP;
      const next = direction > 0 ? Math.min(end, step) : Math.max(end, step);
      const limit = exceeded({ ...factors, [control]: next });
      if (limit) return { value, limit };
      value = next;
    }
    return { value, limit: null };
  };
  return Object.fromEntries(
    PARTICLE_VFX_SIMPLE_CONTROLS.map((control) => {
      const lower = reach(control, -1);
      const upper = reach(control, 1);
      return [
        control,
        {
          min: lower.value,
          max: upper.value,
          minLimit: lower.limit,
          maxLimit: upper.limit,
        },
      ];
    }),
  ) as Record<ParticleVFXSimpleControl, ParticleVFXSimpleBounds>;
}

/** Scale one emitter system in place. */
function scaleSystem(ps: JsonObject, scale: Scale, autoFitted: boolean): void {
  const { size: s, speed: k, spread: p } = scale;
  const a = isSingleParticleSystem(ps) ? 1 : scale.amount;
  scaleNumberField(ps, "duration", 1 / k);
  scaleGeneratorField(ps, "startLife", 1 / k);
  scaleGeneratorField(ps, "startSpeed", k * p);
  scaleGeneratorField(ps, "startSize", s);
  scaleGeneratorField(ps, "emissionOverTime", a * k);
  scaleGeneratorField(ps, "emissionOverDistance", a);
  for (const burst of readJsonArrayObjects(ps.emissionBursts)) {
    if (a !== 1) burst.count = scaleCount(burst.count, a);
    scaleNumberField(burst, "time", 1 / k);
    scaleNumberField(burst, "interval", 1 / k);
  }

  const shape = readJsonObject(ps.shape);
  if (shape) {
    const fitsAvatar = autoFitted && shape.type === "rectangle";
    for (const key of ["radius", "donutRadius"])
      scaleNumberField(shape, key, p);
    if (!fitsAvatar)
      for (const key of ["width", "height"]) scaleNumberField(shape, key, p);
    scaleGeneratorField(shape, "speed", k);
  }

  const settings = readJsonObject(ps.rendererEmitterSettings);
  if (settings && ps.renderMode === STRETCHED_BILLBOARD_RENDER_MODE)
    scaleNumberField(settings, "speedFactor", 1 / (k * p));

  for (const behavior of readJsonArrayObjects(ps.behaviors))
    scaleBehavior(behavior, scale);
}

/** Scale one behaviour in place; see the module comment's table. */
function scaleBehavior(behavior: JsonObject, { speed: k, spread: p }: Scale) {
  switch (behavior.type) {
    case "ForceOverLife":
      for (const axis of ["x", "y", "z"])
        scaleGeneratorField(behavior, axis, k * k * p);
      return;
    case "ApplyForce":
      scaleGeneratorField(behavior, "magnitude", k * k * p);
      return;
    case "GravityForce":
      scaleVectorField(behavior, "center", p);
      scaleNumberField(behavior, "magnitude", k * k * p * p * p);
      return;
    case "RotationOverLife":
      scaleGeneratorField(behavior, "angularVelocity", k);
      return;
    case "RotationBySpeed":
      scaleGeneratorField(behavior, "angularVelocity", k);
      scaleGeneratorField(behavior, "speedRange", k * p);
      return;
    case "SizeBySpeed":
    case "ColorBySpeed":
      scaleGeneratorField(behavior, "speedRange", k * p);
      return;
    case "Rotation3DOverLife": {
      const rotation = readJsonObject(behavior.angularVelocity);
      if (rotation?.type === "AxisAngle")
        scaleGeneratorField(rotation, "angle", k);
      if (rotation?.type === "Euler")
        for (const axis of ["angleX", "angleY", "angleZ"])
          scaleGeneratorField(rotation, axis, k);
      return;
    }
    case "OrbitOverLife":
      scaleGeneratorField(behavior, "orbitSpeed", k);
      return;
    case "Noise":
      scaleGeneratorField(behavior, "frequency", k);
      scaleGeneratorField(behavior, "positionAmount", p);
      return;
    case "TurbulenceField":
      scaleVectorField(behavior, "scale", p);
      scaleVectorField(behavior, "velocityMultiplier", k * k * p);
      scaleVectorField(behavior, "timeScale", k);
      return;
    case "LimitSpeedOverLife":
      scaleGeneratorField(behavior, "speed", k * p);
      scaleNumberField(behavior, "dampen", k);
      return;
  }
}

/** A node's translation (matrix elements 12–14) × `factor`. */
function scaleTranslation(node: JsonObject, factor: number): void {
  if (factor === 1 || !Array.isArray(node.matrix)) return;
  node.matrix = node.matrix.map((value: unknown, index) =>
    index >= 12 && index <= 14 && typeof value === "number"
      ? scaleNumber(value, factor)
      : value,
  );
}

/**
 * `ConstantValue`, `IntervalValue` and `PiecewiseBezier` generators × `factor`;
 * any other value is returned unchanged.
 */
function scaleGenerator(value: unknown, factor: number): unknown {
  const generator = readJsonObject(value);
  if (!generator || factor === 1) return value;
  if (generator.type === "ConstantValue" || generator.type === "IntervalValue")
    for (const key of ["value", "a", "b"])
      scaleNumberField(generator, key, factor);
  if (generator.type === "PiecewiseBezier")
    for (const piece of readJsonArrayObjects(generator.functions)) {
      const curve = readJsonObject(piece.function);
      if (curve)
        for (const key of ["p0", "p1", "p2", "p3"])
          scaleNumberField(curve, key, factor);
    }
  return generator;
}

/**
 * A burst count × `factor`, in whole particles; a count of at least one
 * stays at least one. Only `ConstantValue` and `IntervalValue` scale.
 */
function scaleCount(value: unknown, factor: number): unknown {
  const generator = readJsonObject(value);
  if (
    generator?.type !== "ConstantValue" &&
    generator?.type !== "IntervalValue"
  )
    return value;
  for (const key of ["value", "a", "b"]) {
    const count = generator[key];
    if (typeof count !== "number" || !Number.isFinite(count)) continue;
    const scaled = Math.round(count * factor);
    generator[key] = count >= 1 ? Math.max(1, scaled) : scaled;
  }
  return generator;
}

function scaleGeneratorField(object: JsonObject, key: string, factor: number) {
  if (object[key] !== undefined)
    object[key] = scaleGenerator(object[key], factor);
}

function scaleNumberField(object: JsonObject, key: string, factor: number) {
  const value = object[key];
  if (typeof value === "number" && Number.isFinite(value))
    object[key] = scaleNumber(value, factor);
}

/** A `[x, y, z]` vector × `factor`. */
function scaleVectorField(object: JsonObject, key: string, factor: number) {
  const value = object[key];
  if (Array.isArray(value))
    object[key] = value.map((item: unknown) =>
      typeof item === "number" && Number.isFinite(item)
        ? scaleNumber(item, factor)
        : item,
    );
}

/**
 * `value` × `factor` at the editor's 4-decimal precision; a non-zero value
 * keeps two significant digits rather than rounding to 0. A factor of 1
 * returns the value untouched.
 */
function scaleNumber(value: number, factor: number): number {
  if (factor === 1) return value;
  const scaled = value * factor;
  const rounded = roundEditorNumber(scaled);
  return rounded !== 0 || scaled === 0
    ? rounded
    : Number(scaled.toPrecision(2));
}

/** The largest number a Constant or Interval generator yields, else null. */
function generatorMaximum(value: unknown): number | null {
  const generator = readJsonObject(value);
  const finite = (number: unknown) =>
    typeof number === "number" && Number.isFinite(number) ? number : null;
  if (generator?.type === "ConstantValue") return finite(generator.value);
  if (generator?.type === "IntervalValue") {
    const a = finite(generator.a);
    const b = finite(generator.b);
    return a === null || b === null ? null : Math.max(a, b);
  }
  return null;
}

/** The longest duration an effect declares; each must fit 30 seconds. */
function longestDuration(effect: ParticleVFXSimpleReference): number {
  let longest = Math.max(
    effect.catalog.defaultDurationSec,
    effect.catalog.performanceBudget.maxDurationSec,
  );
  const visit = (node: JsonObject) => {
    const duration = readJsonObject(node.ps)?.duration;
    if (typeof duration === "number") longest = Math.max(longest, duration);
    readJsonArrayObjects(node.children).forEach(visit);
  };
  const root = readJsonObject(effect.quarksJson.object);
  if (root) visit(root);
  return longest;
}

/** The fields the particle estimate and the duration limit read. */
const LIMIT_FIELDS = [
  "duration",
  "looping",
  "renderMode",
  "rendererEmitterSettings",
  "startLife",
  "emissionOverTime",
  "emissionOverDistance",
  "emissionBursts",
] as const;

const limitSkeletons = new WeakMap<
  ParticleVFXSimpleReference,
  ParticleVFXSimpleReference
>();

/**
 * The reference reduced to what the limits read, so a slider's bounds can
 * be searched quickly. Scaling it computes those fields exactly as scaling
 * the whole effect does.
 */
function limitSkeleton(
  reference: ParticleVFXSimpleReference,
): ParticleVFXSimpleReference {
  const cached = limitSkeletons.get(reference);
  if (cached) return cached;
  const strip = (node: JsonObject): JsonObject => {
    const ps = readJsonObject(node.ps);
    return {
      type: node.type,
      ...(ps
        ? {
            ps: Object.fromEntries(
              LIMIT_FIELDS.filter((key) => key in ps).map((key) => [
                key,
                ps[key],
              ]),
            ),
          }
        : {}),
      children: readJsonArrayObjects(node.children).map(strip),
    };
  };
  const root = readJsonObject(reference.quarksJson.object);
  const skeleton = {
    catalog: reference.catalog,
    quarksJson: root ? { object: strip(root) } : {},
  };
  limitSkeletons.set(reference, skeleton);
  return skeleton;
}
