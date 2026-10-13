import { describe, expect, it } from "vitest";

import type { PyAnimaLoadout } from "@animama/runtime-contracts/api-types";
import type { PyGesture } from "@/lib/content/catalogTypes";
import {
  presentGestureCatalog,
  presentGestureLoadout,
  presentUnifiedGestureList,
  reactionStateLabel,
} from "./animaLoadoutPresentation";

const includedSource = (id: string) => ({
  type: "catalog" as const,
  catalog_item_id: `included-${id}`,
  source: "included" as const,
  logical_key: `builtin:gesture:${id}`,
});

function loadout(): PyAnimaLoadout {
  return {
    anima_id: "anima-1",
    aggregate_revision: 2,
    revision: 2,
    starter_version: 1,
    disabled_starter_gestures: ["wave"],
    starter_gesture_implementation_kinds: { wave: "vrma" },
    warnings: [],
    reactions: [],
    idle_style: { state: "starter" },
    gestures: [
      {
        binding_id: "starter:bow",
        name: "Bow",
        semantic_key: "bow",
        origin: "starter",
        implementation_kind: "vrma",
        source: includedSource("bow"),
      },
      {
        binding_id: "custom-1",
        name: "Sparkle wave",
        semantic_key: "sparkle-wave",
        origin: "custom",
        implementation_kind: "anima_clip",
        source: {
          type: "catalog",
          catalog_item_id: "gesture-sparkle",
          source: "local",
          logical_key: "local:gesture:sparkle-wave",
        },
      },
    ],
  };
}

const builtinWave: PyGesture = {
  item_id: "starter-wave",
  name: "Wave",
  description: "A friendly greeting",
  origin: "builtin",
  source: {
    type: "catalog",
    catalog_item_id: "starter-wave",
    source: "included",
    logical_key: "builtin:gesture:wave",
  },
  state: "ready",
  created_at: null,
  updated_at: null,
  semantic_key: "wave",
  implementation_kind: "vrma",
};

describe("typed Anima loadout presentation", () => {
  it("separates Included defaults from explicit Local Gesture roots", () => {
    const result = presentGestureLoadout(loadout(), [builtinWave]);
    expect(result.starterSummary).toBe("1 active · 1 disabled");
    expect(result.custom.map((row) => row.name)).toEqual(["Sparkle wave"]);
    expect(result.disabledStarter[0]?.gesture?.source).toEqual(
      builtinWave.source,
    );
  });

  it("builds a searchable custom-first list without release updates", () => {
    const presentation = presentGestureLoadout(loadout(), [builtinWave]);
    const catalog = presentGestureCatalog(
      [
        {
          item_id: "gesture-high-five",
          name: "High Five",
          description: "Friendly greeting",
          origin: "owned",
          source: {
            type: "catalog",
            catalog_item_id: "gesture-high-five",
            source: "local",
            logical_key: "local:gesture:high-five",
          },
          state: "ready",
          created_at: null,
          updated_at: null,
          semantic_key: "high-five",
          implementation_kind: "vrma",
        },
      ],
      [...presentation.custom, ...presentation.starter],
    );

    const result = presentUnifiedGestureList({
      presentation,
      catalog,
      showIncluded: true,
      showLocal: true,
      updatesOnly: false,
      status: "all",
      motionType: "all",
      sort: "custom-first",
      query: "",
    });
    expect(result.rows.map((row) => [row.kind, row.name])).toEqual([
      ["custom", "High Five"],
      ["custom", "Sparkle wave"],
      ["starter", "Bow"],
      ["starter", "Wave"],
    ]);
    expect(result.updateAvailableCount).toBe(0);
    expect(result.rows.every((row) => !row.updateAvailable)).toBe(true);
  });

  it("lists the full Included catalog once alongside Local gestures and bindings", () => {
    const current = loadout();
    const bow: PyGesture = {
      ...builtinWave,
      item_id: "included-bow",
      semantic_key: "bow",
      name: "Bow",
      source: includedSource("bow"),
    };
    const idle: PyGesture = {
      ...builtinWave,
      item_id: "included-idle",
      semantic_key: "idle",
      name: "Idle",
      source: includedSource("idle"),
    };
    const gestures = [bow, builtinWave, idle, idle];
    const result = presentUnifiedGestureList({
      presentation: presentGestureLoadout(current, gestures),
      catalog: presentGestureCatalog(gestures, current.gestures),
      showIncluded: true,
      showLocal: true,
      updatesOnly: false,
      status: "all",
      motionType: "all",
      sort: "name-asc",
      query: "",
    });

    expect(
      result.rows.map((row) => [row.name, row.kind, row.equipped]),
    ).toEqual([
      ["Bow", "starter", true],
      ["Idle", "custom", false],
      ["Sparkle wave", "custom", true],
      ["Wave", "starter", false],
    ]);
    expect(result).toMatchObject({
      equippedCount: 2,
      totalCount: 4,
      includedCount: 3,
      localCount: 1,
    });
  });

  it.each([
    [true, false, ["Bow", "Idle", "Wave"]],
    [false, true, ["Sparkle wave"]],
    [false, false, []],
  ] as const)(
    "filters by physical source with Included=%s and Local=%s, independent of binding origin",
    (showIncluded, showLocal, names) => {
      const current = loadout();
      const idle: PyGesture = {
        ...builtinWave,
        item_id: "included-idle",
        semantic_key: "idle",
        name: "Idle",
        source: includedSource("idle"),
      };
      current.gestures.push({
        binding_id: "custom-idle",
        name: "Idle",
        semantic_key: "idle",
        origin: "custom",
        implementation_kind: "vrma",
        source: includedSource("idle"),
      });
      const gestures = [builtinWave, idle];
      const result = presentUnifiedGestureList({
        presentation: presentGestureLoadout(current, gestures),
        catalog: presentGestureCatalog(gestures, current.gestures),
        showIncluded,
        showLocal,
        updatesOnly: false,
        status: "all",
        motionType: "all",
        sort: "name-asc",
        query: "",
      });
      expect(result.rows.map((row) => row.name)).toEqual(names);
      expect(result).toMatchObject({ equippedCount: 3, totalCount: 4 });
      if (showIncluded) {
        expect(result.rows.find((row) => row.name === "Idle")).toMatchObject({
          kind: "custom",
          source: "included",
          equipped: true,
          binding: { binding_id: "custom-idle" },
        });
      }
    },
  );

  it("does not duplicate an explicitly equipped Included starter while its catalog entry is unavailable", () => {
    const current = loadout();
    current.gestures.push({
      binding_id: "explicit-wave",
      name: "Wave",
      semantic_key: "wave",
      origin: "custom",
      implementation_kind: "vrma",
      source: includedSource("wave"),
    });
    const result = presentUnifiedGestureList({
      presentation: presentGestureLoadout(current),
      catalog: presentGestureCatalog([], current.gestures),
      showIncluded: true,
      showLocal: true,
      updatesOnly: false,
      status: "all",
      motionType: "all",
      sort: "name-asc",
      query: "",
    });
    expect(result.rows.map((row) => row.name)).toEqual([
      "Bow",
      "Sparkle wave",
      "Wave",
    ]);
    expect(result.rows[2]).toMatchObject({
      kind: "custom",
      equipped: true,
      source: "included",
    });
    expect(result.totalCount).toBe(3);
  });

  it.each([true, false])(
    "reconciles an explicit Included binding by logical slug when catalog available=%s",
    (catalogAvailable) => {
      const current = loadout();
      const airQuotes: PyGesture = {
        ...builtinWave,
        item_id: "included-air-quotes",
        name: "Air Quotes",
        semantic_key: "air_quotes",
        source: includedSource("air-quotes"),
      };
      current.disabled_starter_gestures = ["air-quotes"];
      current.gestures = [
        {
          binding_id: "explicit-air-quotes",
          name: "Air Quotes",
          semantic_key: "air_quotes",
          origin: "custom",
          implementation_kind: "vrma",
          source: includedSource("air-quotes"),
        },
      ];
      const gestures = catalogAvailable ? [airQuotes] : [];
      const result = presentUnifiedGestureList({
        presentation: presentGestureLoadout(current, gestures),
        catalog: presentGestureCatalog(gestures, current.gestures),
        showIncluded: true,
        showLocal: true,
        updatesOnly: false,
        status: "all",
        motionType: "all",
        sort: "name-asc",
        query: "",
      });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        name: "Air Quotes",
        kind: "custom",
        source: "included",
        equipped: true,
      });
      expect(result).toMatchObject({ totalCount: 1, equippedCount: 1 });
    },
  );

  it("resolves a disabled starter's metadata and restore ID by logical slug, not selector", () => {
    const current = loadout();
    current.gestures = [];
    current.disabled_starter_gestures = ["air-quotes"];
    const airQuotes: PyGesture = {
      ...builtinWave,
      item_id: "included-air-quotes",
      name: "Air Quotes",
      semantic_key: "air_quotes",
      source: includedSource("air-quotes"),
    };
    const presentation = presentGestureLoadout(current, [airQuotes]);
    expect(presentation.disabledStarter[0]?.gesture).toBe(airQuotes);
    const result = presentUnifiedGestureList({
      presentation,
      catalog: presentGestureCatalog([airQuotes], current.gestures),
      showIncluded: true,
      showLocal: true,
      updatesOnly: false,
      status: "all",
      motionType: "all",
      sort: "name-asc",
      query: "",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      name: "Air Quotes",
      kind: "starter",
      equipped: false,
      starterId: "air-quotes",
    });
  });

  it("keeps full inventory totals while combining search, type and status filters", () => {
    const current = loadout();
    const result = presentUnifiedGestureList({
      presentation: presentGestureLoadout(current, [builtinWave]),
      catalog: presentGestureCatalog([builtinWave], current.gestures),
      showIncluded: true,
      showLocal: true,
      updatesOnly: false,
      status: "unequipped",
      motionType: "vrma",
      sort: "name-desc",
      query: " FRIENDLY ",
    });
    expect(result.rows.map((row) => row.name)).toEqual(["Wave"]);
    expect(result).toMatchObject({
      equippedCount: 2,
      totalCount: 3,
      includedCount: 2,
      localCount: 1,
      motionTypeCounts: { vrma: 2, anima_clip: 1 },
    });
  });

  it("uses product-facing Reaction state labels", () => {
    expect(reactionStateLabel("starter")).toBe("Starter");
    expect(reactionStateLabel("custom")).toBe("Custom");
    expect(reactionStateLabel("empty")).toBe("Empty");
  });
});
