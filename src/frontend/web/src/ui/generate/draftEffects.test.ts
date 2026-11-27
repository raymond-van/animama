import { describe, expect, it } from "vitest";

import {
  draftEffects,
  draftEffectsInfo,
  goneEffectRootKeys,
  listedEffectDependencies,
} from "./draftEffects";
import {
  effectGestureProject,
  generationDraft,
  gestureProject,
  sparkleDependency,
  waveHelloClip,
} from "./testing/generationFixtures";

const event = (overrides: Record<string, unknown>) => ({
  id: "effect-1",
  time: 0,
  kind: "avatar_vfx",
  effectId: "sparkle",
  ...overrides,
});
const withEvents = (
  events: unknown[],
  dependencies: unknown = [sparkleDependency()],
) =>
  generationDraft({
    project: gestureProject({
      sequence: { ...waveHelloClip(), events },
      dependencies,
    }),
  });
const rain = {
  alias: "rain",
  content_type: "particle_effect",
  source: { type: "catalog", catalog_item_id: "effect-item-2" },
};
const backdrop = {
  alias: "backdrop",
  content_type: "scene_effect",
  source: {
    type: "catalog",
    catalog_item_id: "effect-item-3",
    logical_key: null,
  },
};

describe("draftEffects", () => {
  it("reads nothing from a draft whose timeline plays no effect", () => {
    for (const draft of [
      generationDraft(),
      generationDraft({ project: null }),
      generationDraft({ project: { name: "Broken", sequence: "none" } }),
      // A dependency no event uses is left out, as Save leaves it out.
      withEvents([]),
    ])
      expect(draftEffects(draft)).toEqual({
        dependencies: [],
        aliases: [],
        undeclared: [],
      });
  });

  it("reads the effects the events name, with the dependencies that pin them", () => {
    const effects = draftEffects(
      generationDraft({ project: effectGestureProject() }),
    );
    expect(effects).toEqual({
      dependencies: [sparkleDependency()],
      aliases: ["sparkle"],
      undeclared: [],
    });
  });

  it("reads every kind of effect once, however often it plays", () => {
    const effects = draftEffects(
      withEvents(
        [
          event({ id: "a" }),
          event({ id: "b", time: 1 }),
          event({ id: "c", kind: "particle_vfx", effectId: "rain" }),
          event({
            id: "d",
            kind: "scene_vfx",
            sceneKind: "background_layers",
            effectId: undefined,
            presetId: "backdrop",
          }),
        ],
        [sparkleDependency(), rain, backdrop],
      ),
    );
    expect(effects.aliases).toEqual(["backdrop", "rain", "sparkle"]);
    expect(effects.dependencies.map(({ alias }) => alias)).toEqual([
      "sparkle",
      "rain",
      "backdrop",
    ]);
    // Read as the creator's Import reads them: a missing key is `null`.
    expect(effects.dependencies[1]!.source).toEqual({
      type: "catalog",
      catalog_item_id: "effect-item-2",
      logical_key: null,
    });
    expect(effects.undeclared).toEqual([]);
  });

  it("names an alias an event uses without a dependency", () => {
    expect(
      draftEffects(withEvents([event({}), event({ id: "b", effectId: "x" })])),
    ).toMatchObject({ aliases: ["sparkle", "x"], undeclared: ["x"] });
    // Dependencies the creator's Import would refuse declare nothing.
    for (const dependencies of [
      null,
      "none",
      [{ alias: "sparkle", content_type: "avatar_effect", source: null }],
    ])
      expect(draftEffects(withEvents([event({})], dependencies))).toEqual({
        dependencies: [],
        aliases: ["sparkle"],
        undeclared: ["sparkle"],
      });
  });

  it("answers with the same object for the same project", () => {
    const draft = generationDraft({ project: effectGestureProject() });
    // A status update keeps the project: its readers stay still.
    expect(draftEffects({ ...draft })).toBe(draftEffects(draft));
  });
});

describe("listedEffectDependencies", () => {
  it("lists each effect the drafts play once, in a stable order", () => {
    const first = draftEffects(
      withEvents(
        [event({}), event({ id: "c", kind: "particle_vfx", effectId: "rain" })],
        [sparkleDependency(), rain],
      ),
    );
    // The same effect under another alias in another draft.
    const second = draftEffects(
      withEvents(
        [event({ effectId: "glitter" })],
        [{ ...sparkleDependency(), alias: "glitter" }],
      ),
    );
    const listed = listedEffectDependencies([first, second]);
    expect(listed.map(({ source }) => source)).toEqual([
      sparkleDependency().source,
      { type: "catalog", catalog_item_id: "effect-item-2", logical_key: null },
    ]);
    expect(listedEffectDependencies([second, first])).toEqual(
      listedEffectDependencies([first, second]).map((dependency) => ({
        ...dependency,
        alias: expect.any(String),
      })),
    );
    expect(listedEffectDependencies([])).toEqual([]);
  });
});

describe("goneEffectRootKeys", () => {
  it("keeps only the sources the Library no longer holds", () => {
    expect(
      goneEffectRootKeys([
        { root_key: "catalog:effect-item-1", code: "source_unavailable" },
        // Still in the Library, though it cannot be shown at the moment.
        { root_key: "catalog:effect-item-2", code: "source_scan_required" },
        { root_key: "catalog:effect-item-3", code: "source_invalid" },
        { root_key: "catalog:effect-item-4", code: "runtime_byte_budget" },
      ]),
    ).toEqual(new Set(["catalog:effect-item-1"]));
    expect(goneEffectRootKeys([]).size).toBe(0);
  });
});

describe("draftEffectsInfo", () => {
  const effects = draftEffects(
    withEvents(
      [
        event({}),
        event({ id: "c", kind: "particle_vfx", effectId: "rain" }),
        event({ id: "x", effectId: "ghost" }),
      ],
      [sparkleDependency(), rain],
    ),
  );

  it("is absent for a draft that plays no effect", () => {
    expect(
      draftEffectsInfo(draftEffects(generationDraft()), new Set()),
    ).toBeNull();
  });

  it("names the effects, and as missing only an undeclared alias, while nothing is known to be gone", () => {
    expect(draftEffectsInfo(effects, new Set())).toEqual({
      aliases: ["ghost", "rain", "sparkle"],
      missing: ["ghost"],
    });
  });

  it("names as missing an effect whose source the Library no longer holds", () => {
    expect(
      draftEffectsInfo(effects, new Set(["catalog:effect-item-2"])),
    ).toEqual({
      aliases: ["ghost", "rain", "sparkle"],
      missing: ["ghost", "rain"],
    });
    const whole = draftEffects(
      generationDraft({ project: effectGestureProject() }),
    );
    expect(draftEffectsInfo(whole, new Set())).toEqual({
      aliases: ["sparkle"],
      missing: [],
    });
    expect(draftEffectsInfo(whole, new Set(["catalog:effect-item-1"]))).toEqual(
      { aliases: ["sparkle"], missing: ["sparkle"] },
    );
  });
});
