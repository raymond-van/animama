import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AVATAR_PARTICLE_VFX_CATALOG } from "../catalog";
import { validateParticleVFXContentReadiness } from "./contentReadiness";
import {
  createParticleVFXEditorDraftFromBlank,
  createParticleVFXEditorDraftFromCatalog,
  createParticleVFXEditorDraftFromImport,
} from "./draft";
import { estimateParticleVFXParticles } from "./particleEstimate";
import {
  PARTICLE_VFX_SIMPLE_CONTROLS,
  PARTICLE_VFX_SIMPLE_NEUTRAL,
  PARTICLE_VFX_SIMPLE_RANGES,
  applyParticleVFXSimpleControls,
  countParticleVFXMultiParticleLayers,
  isSingleParticleSystem,
  particleVFXSimpleControlBounds,
  particleVFXSimpleFactors,
  renameParticleVFXEditorDraft,
  setParticleVFXSimpleControl,
  type ParticleVFXSimpleFactors,
  type ParticleVFXSimpleReference,
} from "./simpleControls";
import type { JsonObject } from "./types";

/** The 16 Included Particle Effects, each as the creator opens it. */
const INCLUDED = AVATAR_PARTICLE_VFX_CATALOG.map((entry) => {
  const quarksJson = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          `../../../../../../../../content/included/vfx/particle/quark/${entry.id}/particle.json`,
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ) as JsonObject;
  const draft = createParticleVFXEditorDraftFromCatalog(entry.id, quarksJson);
  const reference: ParticleVFXSimpleReference = {
    catalog: draft.catalog,
    quarksJson: draft.quarksJson,
  };
  return { id: entry.id, draft, reference };
});

const factors = (
  patch: Partial<ParticleVFXSimpleFactors>,
): ParticleVFXSimpleFactors => ({ ...PARTICLE_VFX_SIMPLE_NEUTRAL, ...patch });

/** Every emitter system (`ps`) of an effect, in tree order. */
function systems(quarksJson: JsonObject): JsonObject[] {
  const found: JsonObject[] = [];
  const visit = (node: JsonObject) => {
    if (node.type === "ParticleEmitter") found.push(node.ps as JsonObject);
    for (const child of (node.children as JsonObject[] | undefined) ?? [])
      visit(child);
  };
  visit(quarksJson.object as JsonObject);
  return found;
}

/** Every emitter node below the root, in tree order. */
function emitterNodes(quarksJson: JsonObject): JsonObject[] {
  return ((quarksJson.object as JsonObject).children as JsonObject[]) ?? [];
}

/** The numbers of a Constant or Interval generator, in order. */
function numbers(generator: unknown): number[] {
  const value = generator as JsonObject;
  if (value.type === "ConstantValue") return [value.value as number];
  if (value.type === "IntervalValue")
    return [value.a as number, value.b as number];
  throw new Error(`Unexpected generator ${JSON.stringify(generator)}`);
}

function behavior(ps: JsonObject, type: string): JsonObject | undefined {
  return (ps.behaviors as JsonObject[]).find(
    (candidate) => candidate.type === type,
  );
}

/** Expect `actual` to be `expected` within the creator's 4-decimal rounding. */
function expectScaled(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    Math.max(0.00006, Math.abs(expected) * 0.001),
  );
}

function expectScaledList(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expectScaled(value, expected[index]!));
}

/** Paths of every leaf that differs between two JSON values. */
function changedPaths(left: unknown, right: unknown, at = ""): string[] {
  if (
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object" &&
    Array.isArray(left) === Array.isArray(right)
  ) {
    const keys = new Set([
      ...Object.keys(left as object),
      ...Object.keys(right as object),
    ]);
    return [...keys].flatMap((key) =>
      changedPaths(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        `${at}.${key}`,
      ),
    );
  }
  return Object.is(left, right) ? [] : [at];
}

/** Longest duration the effect declares: the creator caps each at 30 s. */
function longestDuration(effect: ParticleVFXSimpleReference): number {
  return Math.max(
    effect.catalog.defaultDurationSec,
    effect.catalog.performanceBudget.maxDurationSec,
    ...systems(effect.quarksJson).map((ps) => ps.duration as number),
  );
}

/** A one-emitter effect for focused cases. */
function syntheticReference(
  ps: JsonObject,
  {
    name = "layer",
    catalog = {},
  }: {
    name?: string;
    catalog?: Parameters<typeof createParticleVFXEditorDraftFromImport>[1];
  } = {},
): ParticleVFXSimpleReference {
  const draft = createParticleVFXEditorDraftFromImport(
    {
      object: {
        type: "Group",
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        children: [
          {
            type: "ParticleEmitter",
            name,
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0.2, -0.3, 1],
            ps: {
              duration: 2,
              looping: false,
              startLife: { type: "ConstantValue", value: 1 },
              startSpeed: { type: "ConstantValue", value: 0.5 },
              startSize: { type: "ConstantValue", value: 0.2 },
              emissionOverTime: { type: "ConstantValue", value: 0 },
              emissionOverDistance: { type: "ConstantValue", value: 0 },
              emissionBursts: [],
              shape: { type: "point" },
              behaviors: [],
              ...ps,
            },
          },
        ],
      },
    },
    { defaultDurationSec: 2, ...catalog },
  );
  return { catalog: draft.catalog, quarksJson: draft.quarksJson };
}

describe("Particle Simple controls over the Included effects", () => {
  it("covers all 16 Included Particle Effects", () => {
    expect(INCLUDED).toHaveLength(16);
  });

  it.each(INCLUDED)(
    "$id: 100 % restores the reference exactly",
    ({ reference }) => {
      const neutral = applyParticleVFXSimpleControls(
        reference,
        PARTICLE_VFX_SIMPLE_NEUTRAL,
      );
      expect(JSON.stringify(neutral.quarksJson)).toBe(
        JSON.stringify(reference.quarksJson),
      );
      expect(neutral.catalog).toEqual(reference.catalog);
      // The reference is never changed in place.
      applyParticleVFXSimpleControls(
        reference,
        factors({ amount: 300, size: 50, speed: 250, spread: 40 }),
      );
      expect(
        JSON.stringify(
          applyParticleVFXSimpleControls(reference, PARTICLE_VFX_SIMPLE_NEUTRAL)
            .quarksJson,
        ),
      ).toBe(JSON.stringify(reference.quarksJson));
    },
  );

  it.each(INCLUDED)(
    "$id: Amount 200 % keeps single-particle layers single and doubles the rest",
    ({ reference }) => {
      const result = applyParticleVFXSimpleControls(
        reference,
        factors({ amount: 200 }),
      );
      const before = systems(reference.quarksJson);
      const after = systems(result.quarksJson);
      before.forEach((ps, index) => {
        const scaled = after[index]!;
        if (isSingleParticleSystem(ps)) {
          expect(scaled.emissionOverTime).toEqual(ps.emissionOverTime);
          expect(scaled.emissionOverDistance).toEqual(ps.emissionOverDistance);
          expect(scaled.emissionBursts).toEqual(ps.emissionBursts);
          expect(isSingleParticleSystem(scaled)).toBe(true);
          return;
        }
        expectScaledList(
          numbers(scaled.emissionOverTime),
          numbers(ps.emissionOverTime).map((value) => value * 2),
        );
        expectScaledList(
          numbers(scaled.emissionOverDistance),
          numbers(ps.emissionOverDistance).map((value) => value * 2),
        );
        const bursts = ps.emissionBursts as JsonObject[];
        (scaled.emissionBursts as JsonObject[]).forEach((burst, burstIndex) => {
          // Every burst, not only the first the editor shows.
          expect(numbers(burst.count)).toEqual(
            numbers(bursts[burstIndex]!.count).map((count) =>
              count >= 1 ? Math.max(1, Math.round(count * 2)) : count,
            ),
          );
          expect(burst.time).toBe(bursts[burstIndex]!.time);
        });
        // Amount changes nothing but emission.
        expect(scaled.startSize).toEqual(ps.startSize);
        expect(scaled.startSpeed).toEqual(ps.startSpeed);
        expect(scaled.startLife).toEqual(ps.startLife);
      });
    },
  );

  it.each(INCLUDED)(
    "$id: Speed 200 % keeps every timing ratio and each trajectory",
    ({ reference }) => {
      const k = 2;
      const result = applyParticleVFXSimpleControls(
        reference,
        factors({ speed: 200 }),
      );
      expectScaled(
        result.catalog.defaultDurationSec,
        reference.catalog.defaultDurationSec / k,
      );
      expectScaled(
        result.catalog.performanceBudget.maxDurationSec,
        reference.catalog.performanceBudget.maxDurationSec / k,
      );
      const before = systems(reference.quarksJson);
      systems(result.quarksJson).forEach((scaled, index) => {
        const ps = before[index]!;
        expectScaled(scaled.duration as number, (ps.duration as number) / k);
        const life = numbers(ps.startLife);
        const scaledLife = numbers(scaled.startLife);
        expectScaledList(
          scaledLife,
          life.map((value) => value / k),
        );
        expectScaledList(
          numbers(scaled.emissionOverTime),
          numbers(ps.emissionOverTime).map((value) => value * k),
        );
        const bursts = ps.emissionBursts as JsonObject[];
        (scaled.emissionBursts as JsonObject[]).forEach((burst, burstIndex) => {
          const source = bursts[burstIndex]!;
          expectScaled(burst.time as number, (source.time as number) / k);
          expectScaled(
            burst.interval as number,
            (source.interval as number) / k,
          );
          expect(burst.count).toEqual(source.count);
          expect(burst.cycle).toBe(source.cycle);
        });
        // The same path k times faster: v·t and ½·a·t² over a lifetime hold.
        const speed = numbers(ps.startSpeed);
        const scaledSpeed = numbers(scaled.startSpeed);
        expectScaledList(
          scaledSpeed,
          speed.map((value) => value * k),
        );
        expectScaled(
          scaledSpeed.at(-1)! * scaledLife.at(-1)!,
          speed.at(-1)! * life.at(-1)!,
        );
        const force = behavior(ps, "ForceOverLife");
        if (force) {
          const scaledForce = behavior(scaled, "ForceOverLife")!;
          for (const axis of ["x", "y", "z"]) {
            const accel = numbers(force[axis]);
            const scaledAccel = numbers(scaledForce[axis]);
            expectScaledList(
              scaledAccel,
              accel.map((value) => value * k * k),
            );
            expectScaled(
              scaledAccel[0]! * scaledLife.at(-1)! ** 2,
              accel[0]! * life.at(-1)! ** 2,
            );
          }
        }
        for (const [type, field] of [
          ["RotationOverLife", "angularVelocity"],
          ["OrbitOverLife", "orbitSpeed"],
          ["Noise", "frequency"],
        ] as const) {
          const source = behavior(ps, type);
          if (!source) continue;
          expectScaledList(
            numbers(behavior(scaled, type)![field]),
            numbers(source[field]).map((value) => value * k),
          );
        }
        // Sizes and the footprint stay; only a looping shape's travel speeds up.
        expect(scaled.startSize).toEqual(ps.startSize);
        const { speed: shapeSpeed, ...shape } = ps.shape as JsonObject;
        const { speed: scaledShapeSpeed, ...scaledShape } =
          scaled.shape as JsonObject;
        expect(scaledShape).toEqual(shape);
        if (shapeSpeed)
          expectScaledList(
            numbers(scaledShapeSpeed),
            numbers(shapeSpeed).map((value) => value * k),
          );
      });
    },
  );

  it.each(INCLUDED)(
    "$id: Spread 200 % moves the footprint and leaves every size alone",
    ({ reference }) => {
      const p = 2;
      const result = applyParticleVFXSimpleControls(
        reference,
        factors({ spread: 200 }),
      );
      const before = systems(reference.quarksJson);
      systems(result.quarksJson).forEach((scaled, index) => {
        const ps = before[index]!;
        expect(scaled.startSize).toEqual(ps.startSize);
        expect(behavior(scaled, "SizeOverLife")).toEqual(
          behavior(ps, "SizeOverLife"),
        );
        expect(scaled.startLife).toEqual(ps.startLife);
        expect(scaled.duration).toBe(ps.duration);
        expectScaledList(
          numbers(scaled.startSpeed),
          numbers(ps.startSpeed).map((value) => value * p),
        );
        const shape = ps.shape as JsonObject;
        const scaledShape = scaled.shape as JsonObject;
        for (const key of ["radius", "width", "height"])
          if (typeof shape[key] === "number")
            expectScaled(
              scaledShape[key] as number,
              (shape[key] as number) * p,
            );
        for (const key of ["arc", "angle", "thickness", "spread", "mode"])
          expect(scaledShape[key]).toEqual(shape[key]);
      });
      const nodes = emitterNodes(reference.quarksJson);
      emitterNodes(result.quarksJson).forEach((node, index) => {
        const matrix = node.matrix as number[];
        const source = nodes[index]!.matrix as number[];
        expect(matrix.slice(0, 12)).toEqual(source.slice(0, 12));
        expectScaledList(
          matrix.slice(12, 15),
          source.slice(12, 15).map((value) => value * p),
        );
      });
    },
  );

  it.each(INCLUDED)("$id: Size changes only start sizes", ({ reference }) => {
    const result = applyParticleVFXSimpleControls(
      reference,
      factors({ size: 150 }),
    );
    const paths = changedPaths(reference.quarksJson, result.quarksJson);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).toMatch(/\.ps\.startSize\.\w+$/);
    expect(result.catalog).toEqual(reference.catalog);
    systems(result.quarksJson).forEach((ps, index) =>
      expectScaledList(
        numbers(ps.startSize),
        numbers(systems(reference.quarksJson)[index]!.startSize).map(
          (value) => value * 1.5,
        ),
      ),
    );
  });

  it.each(INCLUDED)(
    "$id: every slider bound keeps the estimate within the declared budget, 512 particles and 30 s",
    ({ reference }) => {
      const bounds = particleVFXSimpleControlBounds(
        reference,
        PARTICLE_VFX_SIMPLE_NEUTRAL,
      );
      for (const control of PARTICLE_VFX_SIMPLE_CONTROLS) {
        const { min, max } = bounds[control];
        expect(min % 5).toBe(0);
        expect(max % 5).toBe(0);
        expect(min).toBeGreaterThanOrEqual(
          PARTICLE_VFX_SIMPLE_RANGES[control].min,
        );
        expect(max).toBeLessThanOrEqual(
          PARTICLE_VFX_SIMPLE_RANGES[control].max,
        );
        expect(min).toBeLessThanOrEqual(100);
        expect(max).toBeGreaterThanOrEqual(100);
        for (const value of [min, max]) {
          const result = applyParticleVFXSimpleControls(
            reference,
            factors({ [control]: value }),
          );
          const estimate = estimateParticleVFXParticles(result.quarksJson);
          const budget = result.catalog.performanceBudget.maxParticles;
          expect(estimate).toBeLessThanOrEqual(budget);
          expect(budget).toBeLessThanOrEqual(512);
          expect(longestDuration(result)).toBeLessThanOrEqual(30);
          expect(result.catalog.defaultDurationSec).toBeLessThanOrEqual(
            result.catalog.performanceBudget.maxDurationSec,
          );
          for (const ps of systems(result.quarksJson))
            expect(ps.duration as number).toBeLessThanOrEqual(
              result.catalog.performanceBudget.maxDurationSec,
            );
        }
      }
      // Size and Spread change neither the particle count nor any duration.
      expect(bounds.size).toEqual({
        ...PARTICLE_VFX_SIMPLE_RANGES.size,
        minLimit: null,
        maxLimit: null,
      });
      expect(bounds.spread).toEqual({
        ...PARTICLE_VFX_SIMPLE_RANGES.spread,
        minLimit: null,
        maxLimit: null,
      });
    },
  );

  it.each(INCLUDED)(
    "$id: Size and Spread change neither the estimate nor any duration",
    ({ reference }) => {
      const measure = (patch: Partial<ParticleVFXSimpleFactors>) => {
        const effect = applyParticleVFXSimpleControls(
          reference,
          factors(patch),
        );
        return [
          estimateParticleVFXParticles(effect.quarksJson),
          longestDuration(effect),
          effect.catalog.defaultDurationSec,
        ];
      };
      const neutral = measure({});
      for (const patch of [
        { size: 25 },
        { size: 300 },
        { spread: 25 },
        { spread: 300 },
      ])
        expect(measure(patch)).toEqual(neutral);
    },
  );

  it("stops Speed for a 30-second effect at 100 % because slower would run past 30 s", () => {
    const hearts = INCLUDED.find(({ id }) => id === "hearts-v1")!;
    expect(
      particleVFXSimpleControlBounds(
        hearts.reference,
        PARTICLE_VFX_SIMPLE_NEUTRAL,
      ).speed,
    ).toEqual({ min: 100, max: 300, minLimit: "duration", maxLimit: null });
  });

  it("counts Fume Puffs' layers as single-particle, so Amount has nothing to scale", () => {
    const fume = INCLUDED.find(({ id }) => id === "fume-puffs")!;
    expect(countParticleVFXMultiParticleLayers(fume.reference.quarksJson)).toBe(
      0,
    );
    const heartBurst = INCLUDED.find(({ id }) => id === "heart-burst")!;
    expect(
      countParticleVFXMultiParticleLayers(heartBurst.reference.quarksJson),
    ).toBe(3);
  });

  it("computes the four bounds quickly enough for a slider drag", () => {
    const sparkle = INCLUDED.find(({ id }) => id === "sparkle-hearts")!;
    const started = performance.now();
    for (let index = 0; index < 10; index += 1)
      particleVFXSimpleControlBounds(
        sparkle.reference,
        factors({ amount: 150 + index * 5 }),
      );
    expect((performance.now() - started) / 10).toBeLessThan(40);
  });
});

describe("Particle Simple control mapping", () => {
  it("rounds burst counts to whole particles and keeps at least one", () => {
    const reference = syntheticReference({
      emissionOverTime: { type: "ConstantValue", value: 4 },
      emissionBursts: [
        { time: 0, count: { type: "ConstantValue", value: 3 }, cycle: 1 },
        { time: 0.5, count: { type: "IntervalValue", a: 1, b: 5 }, cycle: 2 },
        { time: 0.7, count: { type: "ConstantValue", value: 0 }, cycle: 1 },
      ],
    });
    const quarter = systems(
      applyParticleVFXSimpleControls(reference, factors({ amount: 25 }))
        .quarksJson,
    )[0]!;
    expect(
      (quarter.emissionBursts as JsonObject[]).map((burst) =>
        numbers(burst.count),
      ),
    ).toEqual([[1], [1, 1], [0]]);
    const more = systems(
      applyParticleVFXSimpleControls(reference, factors({ amount: 150 }))
        .quarksJson,
    )[0]!;
    expect(
      (more.emissionBursts as JsonObject[]).map((burst) =>
        numbers(burst.count),
      ),
    ).toEqual([[5], [2, 8], [0]]);
  });

  it("treats a layer of one burst particle and no stream as single", () => {
    expect(
      isSingleParticleSystem({
        emissionOverTime: { type: "ConstantValue", value: 0 },
        emissionBursts: [{ count: { type: "ConstantValue", value: 1 } }],
      }),
    ).toBe(true);
    expect(
      isSingleParticleSystem({
        emissionOverTime: { type: "ConstantValue", value: 0 },
        emissionOverDistance: { type: "ConstantValue", value: 2 },
        emissionBursts: [{ count: { type: "ConstantValue", value: 1 } }],
      }),
    ).toBe(false);
    expect(
      isSingleParticleSystem({
        emissionOverTime: { type: "ConstantValue", value: 0 },
        emissionBursts: [
          { count: { type: "ConstantValue", value: 1 } },
          { count: { type: "ConstantValue", value: 1 } },
        ],
      }),
    ).toBe(false);
    // three.quarks emits 10 per second when no rate is given.
    expect(
      isSingleParticleSystem({
        emissionBursts: [{ count: { type: "ConstantValue", value: 1 } }],
      }),
    ).toBe(false);
  });

  it("composes Speed and Spread: speeds × k·p, forces × k²·p", () => {
    const reference = syntheticReference({
      startSpeed: { type: "IntervalValue", a: 0.2, b: 0.4 },
      behaviors: [
        {
          type: "ForceOverLife",
          x: { type: "ConstantValue", value: 0 },
          y: { type: "ConstantValue", value: -0.5 },
          z: { type: "ConstantValue", value: 0.1 },
        },
        {
          type: "LimitSpeedOverLife",
          speed: { type: "ConstantValue", value: 1 },
          dampen: 0.4,
        },
      ],
    });
    const ps = systems(
      applyParticleVFXSimpleControls(
        reference,
        factors({ speed: 200, spread: 150 }),
      ).quarksJson,
    )[0]!;
    expectScaledList(numbers(ps.startSpeed), [0.6, 1.2]);
    const force = behavior(ps, "ForceOverLife")!;
    expectScaledList(numbers(force.y), [-0.5 * 4 * 1.5]);
    expectScaledList(numbers(force.z), [0.1 * 4 * 1.5]);
    const limit = behavior(ps, "LimitSpeedOverLife")!;
    expectScaledList(numbers(limit.speed), [3]);
    expectScaled(limit.dampen as number, 0.8);
  });

  it("scales absolute curves, keeps relative over-life curves and leaves unknown generators untouched", () => {
    const unknown = { type: "MysteryValue", seed: 7 };
    const sizeOverLife = {
      type: "SizeOverLife",
      size: {
        type: "PiecewiseBezier",
        functions: [{ function: { p0: 0, p1: 1, p2: 1, p3: 0 }, start: 0 }],
      },
    };
    const reference = syntheticReference({
      startLife: unknown,
      startSize: {
        type: "PiecewiseBezier",
        functions: [
          { function: { p0: 0.1, p1: 0.2, p2: 0.3, p3: 0.4 }, start: 0 },
        ],
      },
      behaviors: [
        sizeOverLife,
        { type: "OrbitOverLife", orbitSpeed: unknown, axis: [0, 1, 0] },
        { type: "Mystery", strength: 3 },
      ],
    });
    const ps = systems(
      applyParticleVFXSimpleControls(
        reference,
        factors({ size: 200, speed: 300, spread: 50 }),
      ).quarksJson,
    )[0]!;
    expect(ps.startLife).toEqual(unknown);
    expect(
      (
        (ps.startSize as JsonObject).functions as Array<{
          function: JsonObject;
        }>
      )[0]!.function,
    ).toEqual({ p0: 0.2, p1: 0.4, p2: 0.6, p3: 0.8 });
    expect(behavior(ps, "SizeOverLife")).toEqual(sizeOverLife);
    expect(behavior(ps, "OrbitOverLife")!.orbitSpeed).toEqual(unknown);
    expect(behavior(ps, "Mystery")).toEqual({ type: "Mystery", strength: 3 });
  });

  it("keeps auto-fit rectangles fitting the Avatar: Spread scales their offsets and speeds only", () => {
    const rectangle = {
      type: "rectangle",
      width: 1.2,
      height: 1.6,
      thickness: 1,
      mode: 0,
      spread: 0,
      speed: { type: "ConstantValue", value: 1 },
    };
    const fitted = syntheticReference(
      { shape: rectangle },
      {
        name: "outline",
        catalog: {
          shapeAutoFit: {
            kind: "avatarBoundsRectangle",
            emitterNames: ["outline"],
          },
        },
      },
    );
    const result = applyParticleVFXSimpleControls(
      fitted,
      factors({ spread: 200 }),
    );
    const ps = systems(result.quarksJson)[0]!;
    expect(ps.shape).toEqual(rectangle);
    expectScaledList(numbers(ps.startSpeed), [1]);
    expectScaledList(
      (emitterNodes(result.quarksJson)[0]!.matrix as number[]).slice(12, 15),
      [0.2, 0.4, -0.6],
    );
    expect(result.catalog.shapeAutoFit).toEqual(fitted.catalog.shapeAutoFit);

    // A rectangle the fit does not name is an ordinary footprint.
    const named = syntheticReference(
      { shape: rectangle },
      {
        name: "rain",
        catalog: {
          shapeAutoFit: {
            kind: "avatarBoundsRectangle",
            emitterNames: ["outline"],
          },
        },
      },
    );
    const scaledShape = systems(
      applyParticleVFXSimpleControls(named, factors({ spread: 200 }))
        .quarksJson,
    )[0]!.shape as JsonObject;
    expect([scaledShape.width, scaledShape.height]).toEqual([2.4, 3.2]);
  });

  it("raises the declared budget to the estimate, up to 512, and never lowers it", () => {
    const reference = syntheticReference(
      {
        emissionBursts: [
          { time: 0, count: { type: "ConstantValue", value: 40 }, cycle: 1 },
        ],
      },
      {
        catalog: {
          performanceBudget: {
            maxDurationSec: 3,
            maxParticles: 60,
            loopingAllowed: false,
            canCoexist: true,
          },
        },
      },
    );
    const budget = (amount: number) =>
      applyParticleVFXSimpleControls(reference, factors({ amount })).catalog
        .performanceBudget.maxParticles;
    expect(budget(50)).toBe(60);
    expect(budget(200)).toBe(80);
    expect(budget(400)).toBe(160);
  });

  it("stops Amount where the estimate would pass 512 particles", () => {
    const reference = syntheticReference({
      emissionBursts: [
        { time: 0, count: { type: "ConstantValue", value: 200 }, cycle: 1 },
      ],
    });
    expect(
      particleVFXSimpleControlBounds(reference, PARTICLE_VFX_SIMPLE_NEUTRAL)
        .amount,
    ).toEqual({ min: 25, max: 255, minLimit: null, maxLimit: "particles" });
  });

  it("stops Speed where the effect would run longer than 30 seconds", () => {
    const reference = syntheticReference(
      {},
      {
        catalog: {
          defaultDurationSec: 8,
          performanceBudget: {
            maxDurationSec: 10,
            maxParticles: 16,
            loopingAllowed: false,
            canCoexist: true,
          },
        },
      },
    );
    expect(
      particleVFXSimpleControlBounds(reference, PARTICLE_VFX_SIMPLE_NEUTRAL)
        .speed,
    ).toEqual({ min: 35, max: 300, minLimit: "duration", maxLimit: null });
  });

  it("lets an effect already over a limit move back toward it", () => {
    const reference = syntheticReference({
      emissionBursts: [
        { time: 0, count: { type: "ConstantValue", value: 600 }, cycle: 1 },
      ],
    });
    expect(
      particleVFXSimpleControlBounds(reference, PARTICLE_VFX_SIMPLE_NEUTRAL)
        .amount,
    ).toEqual({ min: 25, max: 100, minLimit: null, maxLimit: "particles" });
  });
});

describe("Simple controls on a draft", () => {
  const heartBurst = INCLUDED.find(({ id }) => id === "heart-burst")!;

  it("captures the reference on first use and computes every later value from it", () => {
    const { draft } = heartBurst;
    expect(draft.simple).toBeNull();
    expect(particleVFXSimpleFactors(draft)).toEqual(
      PARTICLE_VFX_SIMPLE_NEUTRAL,
    );

    const doubled = setParticleVFXSimpleControl(draft, "amount", 200);
    expect(doubled.simple?.factors).toEqual(factors({ amount: 200 }));
    expect(doubled.simple?.reference.quarksJson).toEqual(draft.quarksJson);
    // The derived emitters follow the scaled JSON.
    const sparkles = doubled.emitters.find(
      (emitter) => emitter.name === "burst-sparkles",
    )!;
    expect(sparkles.burstCount).toEqual({ min: 24, max: 24 });

    const faster = setParticleVFXSimpleControl(doubled, "speed", 150);
    expect(faster.simple?.reference).toBe(doubled.simple?.reference);
    expect(faster.simple?.factors).toEqual(
      factors({ amount: 200, speed: 150 }),
    );

    // Back to 100 % restores the opened effect byte for byte.
    const restored = setParticleVFXSimpleControl(
      setParticleVFXSimpleControl(faster, "amount", 100),
      "speed",
      100,
    );
    expect(JSON.stringify(restored.quarksJson)).toBe(
      JSON.stringify(draft.quarksJson),
    );
    expect(restored.catalog).toEqual(draft.catalog);
    expect(restored.textureFiles).toBe(draft.textureFiles);
  });

  it("renames the effect, keeping the controls and their reference", () => {
    const doubled = setParticleVFXSimpleControl(
      heartBurst.draft,
      "amount",
      200,
    );
    const renamed = renameParticleVFXEditorDraft(doubled, "Big Hearts");

    expect(renamed.catalog.label).toBe("Big Hearts");
    // The same state, so the slider bounds need no new search.
    expect(renamed.simple).toBe(doubled.simple);
    expect(renamed.quarksJson).toEqual(doubled.quarksJson);
    // A later move keeps the new name.
    expect(
      setParticleVFXSimpleControl(renamed, "amount", 100).catalog.label,
    ).toBe("Big Hearts");
    expect(
      renameParticleVFXEditorDraft(heartBurst.draft, "Plain").simple,
    ).toBeNull();
  });

  it("snaps a control to its 5 % grid and range", () => {
    const { draft } = heartBurst;
    expect(
      setParticleVFXSimpleControl(draft, "size", 1000).simple?.factors.size,
    ).toBe(300);
    expect(
      setParticleVFXSimpleControl(draft, "spread", 37).simple?.factors.spread,
    ).toBe(35);
  });
});

describe("an imported effect whose root object is the emitter", () => {
  /**
   * Import keeps a root `ParticleEmitter`, as three.quarks exports a
   * single-emitter effect: the blank effect's one emitter, made the root.
   */
  function rootEmitterDraft() {
    const blank = createParticleVFXEditorDraftFromBlank();
    const emitter = (
      (blank.quarksJson.object as JsonObject).children as JsonObject[]
    )[0]!;
    return createParticleVFXEditorDraftFromImport(
      {
        ...blank.quarksJson,
        object: {
          ...emitter,
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0.2, 0, 1],
          children: [],
        },
      },
      { ...blank.catalog, id: "root-emitter", label: "Root emitter" },
    );
  }
  const root = (draft: { quarksJson: JsonObject }) =>
    draft.quarksJson.object as JsonObject;
  const ps = (draft: { quarksJson: JsonObject }) =>
    root(draft).ps as JsonObject;

  it("is read as one emitter and is ready to save", () => {
    const draft = rootEmitterDraft();
    expect(draft.emitters).toHaveLength(1);
    expect(draft.emitters[0]!.path).toBe("/object");
    expect(countParticleVFXMultiParticleLayers(draft.quarksJson)).toBe(1);
    expect(validateParticleVFXContentReadiness(draft).ready).toBe(true);
  });

  it("scales the root emitter's sizes, amount and timing", () => {
    const draft = rootEmitterDraft();
    expectScaledList(
      numbers(ps(setParticleVFXSimpleControl(draft, "size", 200)).startSize),
      numbers(ps(draft).startSize).map((value) => value * 2),
    );
    const doubled = setParticleVFXSimpleControl(draft, "amount", 200);
    expect(doubled.emitters[0]!.burstCount).toEqual({ min: 24, max: 24 });

    const faster = setParticleVFXSimpleControl(draft, "speed", 200);
    expectScaled(ps(faster).duration as number, 0.6);
    expectScaledList(
      numbers(ps(faster).startLife),
      numbers(ps(draft).startLife).map((value) => value / 2),
    );
    expectScaled(faster.catalog.defaultDurationSec, 0.6);
    // Durations stay consistent, so the effect stays ready to save.
    expect(validateParticleVFXContentReadiness(faster).ready).toBe(true);
    expect(
      validateParticleVFXContentReadiness(
        setParticleVFXSimpleControl(draft, "speed", 25),
      ).ready,
    ).toBe(true);
  });

  it("spreads the root emitter's footprint but leaves its own placement", () => {
    const draft = rootEmitterDraft();
    const spread = setParticleVFXSimpleControl(draft, "spread", 200);
    // The catalog transform places the root; only child offsets spread.
    expect(root(spread).matrix).toEqual(root(draft).matrix);
    expectScaled(
      (ps(spread).shape as JsonObject).radius as number,
      ((ps(draft).shape as JsonObject).radius as number) * 2,
    );
    expectScaledList(
      numbers(ps(spread).startSpeed),
      numbers(ps(draft).startSpeed).map((value) => value * 2),
    );
    expect(ps(spread).startSize).toEqual(ps(draft).startSize);
  });

  it("restores the root emitter exactly at 100 %", () => {
    const draft = rootEmitterDraft();
    let moved = draft;
    for (const [control, value] of [
      ["amount", 300],
      ["size", 50],
      ["speed", 175],
      ["spread", 40],
    ] as const)
      moved = setParticleVFXSimpleControl(moved, control, value);
    for (const control of PARTICLE_VFX_SIMPLE_CONTROLS)
      moved = setParticleVFXSimpleControl(moved, control, 100);
    expect(JSON.stringify(moved.quarksJson)).toBe(
      JSON.stringify(draft.quarksJson),
    );
    expect(moved.catalog).toEqual(draft.catalog);
  });
});
