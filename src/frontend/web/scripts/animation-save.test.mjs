import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  gestureProject,
  parseSaveItems,
  planSaves,
} from "./animation-save.mjs";

const itemsFile = path.join("/work", "batch", "items.json");
const item = {
  clip: "../clips/wave.clip.json",
  name: "Wave Hello",
  aiDescription: "A friendly wave.",
  selectorId: "wave_hello",
};

test("resolves clips beside the items file and trims texts", () => {
  const [parsed] = parseSaveItems(
    [{ ...item, name: " Wave Hello " }],
    itemsFile,
  );
  assert.deepEqual(parsed, {
    ...item,
    clip: path.join("/work", "clips", "wave.clip.json"),
    // The Library description defaults to the AI description.
    description: "A friendly wave.",
  });
  assert.equal(
    parseSaveItems([{ ...item, description: "Waves hello." }], itemsFile)[0]
      .description,
    "Waves hello.",
  );
});

test("names the item and field of each problem", () => {
  assert.throws(() => parseSaveItems([], itemsFile), /non-empty array/);
  assert.throws(
    () => parseSaveItems([{ ...item, aiDescription: " " }], itemsFile),
    /item 1: "aiDescription"/,
  );
  assert.throws(
    () => parseSaveItems([{ ...item, selectorId: "Wave-Hello" }], itemsFile),
    /snake_case/,
  );
  assert.throws(
    () => parseSaveItems([item, { ...item, clip: "b.json" }], itemsFile),
    /item 2: Selector ID "wave_hello" repeats/,
  );
});

test("needs a clip only when the item has no project", () => {
  const { clip: _clip, ...projectOnly } = item;
  const [parsed] = parseSaveItems(
    [{ ...projectOnly, project: "../clips/wave.project.json" }],
    itemsFile,
  );
  assert.equal(parsed.clip, undefined);
  assert.equal(
    parsed.project,
    path.join("/work", "clips", "wave.project.json"),
  );
  assert.throws(
    () => parseSaveItems([projectOnly], itemsFile),
    /item 1: "clip" must be a non-empty string/,
  );
});

test("resolves optional project paths and rejects unusable paths", () => {
  for (const project of ["../clips/wave.project.json", "/drafts/wave.json"]) {
    assert.equal(
      parseSaveItems([{ ...item, project }], itemsFile)[0].project,
      path.resolve(path.dirname(itemsFile), project),
    );
  }
  for (const project of [null, " ", 42])
    assert.throws(
      () => parseSaveItems([{ ...item, project }], itemsFile),
      /item 1: "project" must be a non-empty string/,
    );
});

const project = {
  schema: "animamaActionProject/1.0",
  intent: "gesture",
  name: "Draft name",
  aiDescription: "Draft description",
  semanticKey: "draft_selector",
  sequence: {
    schema: "animaPoseClip/2.0",
    beats: [{ id: "start", label: "Start", time: 0 }],
    events: [
      { kind: "avatar_vfx", effectId: "spark", time: 0, duration: 1 },
      { kind: "scene_vfx", presetId: "rays", time: 0, duration: 1 },
    ],
  },
  dependencies: [
    {
      ref: "local:avatar-effect:spark",
      alias: "spark",
      content_type: "avatar_effect",
      config: { strength: 0.7 },
    },
    {
      ref: "builtin:scene-effect:rays",
      alias: "rays",
      content_type: "scene_effect",
      config: {},
    },
  ],
};
const effects = project.dependencies.map((dependency, index) => ({
  item_id: `effect-${index}`,
  logical_key: dependency.ref,
  kind: dependency.content_type,
  source: index ? "included" : "local",
  status: "valid",
}));

test("imports project motion and exact Library dependencies with item metadata", () => {
  const before = structuredClone(project);
  const imported = gestureProject(
    parseSaveItems([item], itemsFile)[0],
    project,
    effects,
  );
  assert.equal(imported.name, item.name);
  assert.equal(imported.aiDescription, item.aiDescription);
  assert.equal(imported.semanticKey, item.selectorId);
  assert.deepEqual(imported.sequence, project.sequence);
  assert.deepEqual(
    imported.dependencies,
    project.dependencies.map(({ ref, ...dependency }, index) => ({
      ...dependency,
      source: {
        type: "catalog",
        catalog_item_id: `effect-${index}`,
        logical_key: ref,
      },
    })),
  );
  assert.deepEqual(project, before);
});

test("resolves Library item IDs and preserves already exact dependency pins", () => {
  const exact = {
    alias: "particles",
    content_type: "particle_effect",
    source: { type: "builtin", content_id: "builtin:particles", version: 3 },
    config: {},
  };
  const imported = gestureProject(
    item,
    {
      ...project,
      dependencies: [{ ...project.dependencies[0], ref: "effect-0" }, exact],
    },
    effects,
  );
  assert.equal(imported.dependencies[0].source.catalog_item_id, "effect-0");
  assert.deepEqual(imported.dependencies[1], exact);
});

test("refuses unresolved, ambiguous, invalid or wrongly typed dependencies", () => {
  for (const [library, problem] of [
    [[], /spark.*not found/],
    [[...effects, effects[0]], /spark.*ambiguous/],
    [[{ ...effects[0], status: "invalid" }, effects[1]], /spark.*invalid/],
    [
      [{ ...effects[0], kind: "scene_effect" }, effects[1]],
      /spark.*avatar_effect/,
    ],
  ])
    assert.throws(() => gestureProject(item, project, library), problem);
});

test("refuses malformed projects instead of saving an empty dependency set", () => {
  for (const malformed of [
    { ...project, intent: "reaction" },
    { ...project, dependencies: undefined },
    { ...project, sequence: null },
  ])
    assert.throws(() => gestureProject(item, malformed, effects), /project/i);
});

test("imports a new Gesture as a creator project with its Selector ID", () => {
  const sequence = { schema: "animaPoseClip/2.0" };
  assert.deepEqual(
    gestureProject(parseSaveItems([item], itemsFile)[0], sequence),
    {
      schema: "animamaActionProject/1.0",
      intent: "gesture",
      name: "Wave Hello",
      description: "A friendly wave.",
      aiDescription: "A friendly wave.",
      semanticKey: "wave_hello",
      sequence,
      dependencies: [],
    },
  );
});

test("revises a Local Gesture by Selector ID and refuses an Included one", () => {
  const items = parseSaveItems(
    [item, { ...item, clip: "b.json", selectorId: "shy_wave" }],
    itemsFile,
  );
  const library = [
    {
      item_id: "i1",
      source: "included",
      semantic_key: "wave_hello",
      name: "Wave",
    },
    {
      item_id: "l1",
      source: "local",
      semantic_key: "wave_hello",
      name: "Wave Hello",
    },
  ];
  assert.deepEqual(planSaves(items, library), [
    { itemId: "l1", name: "Wave Hello" },
    null,
  ]);
  // A rename could change the Selector ID in the creator, so it is refused.
  assert.throws(
    () => planSaves(items, [{ ...library[1], name: "My Wave" }]),
    /saved as "My Wave": keep that name/,
  );
  assert.throws(
    () => planSaves(items, library.slice(0, 1)),
    /"wave_hello" belongs to an Included Gesture/,
  );
});
