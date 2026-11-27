import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  PROMOTE_PATHS,
  parsePromoteItems,
  planPromotion,
  workingTreeRepo,
} from "./animation-promote.mjs";

const licence = {
  creator: "Agent",
  provenance: "Agent-authored.",
  license_id: "LicenseRef-Animama-agent-authored",
  redistribution_review: "pending",
};
const sourceReview = {
  candidate_license: "AGPL-3.0-only",
  basis: "Agent-authored.",
  copyright: "2026 Owner",
  review: "prepared-not-release-approved",
};
const itemsFile = path.join("/work", "batch", "items.json");

function item(overrides = {}) {
  return {
    clip: "../drafts/wave-hello.clip.json",
    name: "Wave Hello",
    aiDescription: "A friendly wave.",
    selectorId: "wave_hello",
    mode: "add",
    licence,
    sourceReview,
    ...overrides,
  };
}

/** A clip validator stub: the real one is the motion CLI's compactClipFile. */
const compactClip = (clip) =>
  clip.invalid
    ? { ok: false, message: "Invalid animaPoseClip/2.0 (1 issue(s))" }
    : { ok: true, clip, saved: JSON.stringify(clip) };
const formatJson = async (value) => `${JSON.stringify(value)}\n`;
const maxClipBytes = 2 * 1024 * 1024;

const existingMeta = {
  schema_version: 1,
  content_type: "gesture",
  content_id: "builtin:gesture:arms-crossed",
  version: 1,
  semantic_key: "arms-crossed",
  name: "arms-crossed",
  ai_description: "Old.",
  implementation: { kind: "anima_clip", file_role: "sequence" },
  dependencies: [],
  files: [{ path: "arms-crossed.json", role: "sequence" }],
};

const bulbRef = "builtin:avatar-effect:idea_bulb_fingertip";
const bulbDependency = {
  ref: bulbRef,
  alias: "idea_bulb_fingertip",
  content_type: "avatar_effect",
};
const bulbEvent = {
  id: "bulb",
  time: 1,
  kind: "avatar_vfx",
  effectId: "idea_bulb_fingertip",
};

/**
 * An in-memory repository with one Included Gesture, one Avatar Effect and
 * one Scene Effect.
 */
function fakeRepo() {
  const files = {
    [PROMOTE_PATHS.inventory]: JSON.stringify({
      schema_version: 1,
      rules: [
        { glob: "poses/**/*.json" },
        { glob: "gestures/**/*.json" },
        { glob: "gestures/**/*.vrma" },
      ],
    }),
    [PROMOTE_PATHS.sourceReview]: JSON.stringify({
      files: [
        { path: "content/included/gestures/arms-crossed/arms-crossed.json" },
        { path: "z.txt" },
      ],
    }),
    "content/included/gestures/arms-crossed/arms-crossed.meta.json":
      JSON.stringify(existingMeta),
    "content/included/gestures/arms-crossed/arms-crossed.json": JSON.stringify({
      schema: "animaPoseClip/2.0",
      loop: true,
    }),
    "content/included/vfx/avatar/idea_bulb_fingertip/idea_bulb_fingertip.json":
      JSON.stringify({ content_type: "avatar_effect", content_id: bulbRef }),
    "content/included/vfx/scene/glitter/glitter.json": JSON.stringify({
      content_type: "scene_effect",
      content_id: "builtin:scene-effect:background:glitter",
    }),
  };
  return {
    files,
    read: (relative) => files[relative] ?? null,
    gestureSlugs: () => ["arms-crossed"],
    // Every Included descriptor, as the working-tree reader finds them.
    includedMetas: () =>
      Object.entries(files)
        .filter(([relative]) => /^content\/included\/.*\.json$/.test(relative))
        .map(([relative, text]) => ({
          path: relative,
          value: JSON.parse(text),
        }))
        .filter(({ value }) => typeof value.content_id === "string"),
  };
}

async function clipFile(name, clip) {
  const directory = await mkdtemp(path.join(tmpdir(), "promote-"));
  const file = path.join(directory, name);
  await writeFile(file, JSON.stringify(clip));
  return file;
}

const byPath = (writes) =>
  Object.fromEntries(writes.map((write) => [write.path, write]));

test("derives the slug from the clip file and requires mode and licence fields", async () => {
  const [parsed] = await parsePromoteItems([item()], itemsFile);
  assert.equal(parsed.slug, "wave-hello");
  assert.equal(
    parsed.clip,
    path.join("/work", "drafts", "wave-hello.clip.json"),
  );
  await assert.rejects(
    parsePromoteItems([item({ mode: undefined })], itemsFile),
    /"mode" must be "add" or "replace"/,
  );
  await assert.rejects(
    parsePromoteItems(
      [item({ licence: { ...licence, provenance: " " } })],
      itemsFile,
    ),
    /"licence".provenance must be a non-empty string/,
  );
  await assert.rejects(
    parsePromoteItems([item({ sourceReview: undefined })], itemsFile),
    /"sourceReview" must be an object/,
  );
  await assert.rejects(
    parsePromoteItems([item(), item({ selectorId: "other" })], itemsFile),
    /slug "wave-hello" repeats/,
  );
});

test("resolves Library sources to the saved item's file and folder name", async () => {
  const local = path.join("/stack", "content", "local", "gestures");
  const resolveClip = async (spec) => {
    if (spec === "library:local/wave_hello")
      return path.join(local, "wave-hello", "wave-hello.json");
    throw new Error(`No Library item matches ${spec}.`);
  };
  const [parsed] = await parsePromoteItems(
    [item({ clip: "library:local/wave_hello" })],
    itemsFile,
    resolveClip,
  );
  assert.equal(parsed.clip, path.join(local, "wave-hello", "wave-hello.json"));
  assert.equal(parsed.slug, "wave-hello");
  await assert.rejects(
    parsePromoteItems(
      [item({ clip: "library:local/missing" })],
      itemsFile,
      resolveClip,
    ),
    /item 1: No Library item matches library:local\/missing/,
  );
});

test("adds a new Gesture with metadata, licence rule and records", async () => {
  const repo = fakeRepo();
  const clip = await clipFile("wave-hello.clip.json", {
    schema: "animaPoseClip/2.0",
    id: "draft",
    name: "Draft",
  });
  const writes = byPath(
    await planPromotion(await parsePromoteItems([item({ clip })], itemsFile), {
      repo,
      compactClip,
      formatJson,
      maxClipBytes,
    }),
  );
  const included = "content/included/gestures/wave-hello/wave-hello.json";
  const metaPath = "content/included/gestures/wave-hello/wave-hello.meta.json";
  assert.equal(writes[included].action, "create");
  // The clip takes the Included id and name.
  assert.deepEqual(JSON.parse(writes[included].content), {
    schema: "animaPoseClip/2.0",
    id: "wave-hello",
    name: "Wave Hello",
  });
  assert.deepEqual(JSON.parse(writes[metaPath].content), {
    ...existingMeta,
    content_id: "builtin:gesture:wave-hello",
    semantic_key: "wave_hello",
    name: "Wave Hello",
    ai_description: "A friendly wave.",
    files: [{ path: "wave-hello.json", role: "sequence" }],
  });
  const rules = JSON.parse(writes[PROMOTE_PATHS.inventory].content).rules;
  assert.deepEqual(
    rules.map((rule) => rule.glob),
    [
      "poses/**/*.json",
      "gestures/wave-hello/*.json",
      "gestures/**/*.json",
      "gestures/**/*.vrma",
    ],
  );
  assert.deepEqual(rules[1], {
    glob: "gestures/wave-hello/*.json",
    ...licence,
  });
  const records = JSON.parse(writes[PROMOTE_PATHS.sourceReview].content).files;
  assert.deepEqual(
    records.map((record) => record.path),
    [
      "content/included/gestures/arms-crossed/arms-crossed.json",
      included,
      metaPath,
      "z.txt",
    ],
  );
  assert.deepEqual(records[1], { path: included, ...sourceReview });
  // Only Included content is written: no frontend copy.
  assert.deepEqual(
    Object.keys(writes).sort(),
    [
      included,
      metaPath,
      PROMOTE_PATHS.inventory,
      PROMOTE_PATHS.sourceReview,
    ].sort(),
  );
});

test("replaces an Included Gesture in place, keeping its identity and kind", async () => {
  const repo = fakeRepo();
  const clip = await clipFile("arms-crossed.clip.json", {
    schema: "animaPoseClip/2.0",
    loop: true,
  });
  const replace = item({
    clip,
    name: "arms-crossed",
    selectorId: "arms-crossed",
    aiDescription: "New.",
    mode: "replace",
  });
  const writes = byPath(
    await planPromotion(await parsePromoteItems([replace], itemsFile), {
      repo,
      compactClip,
      formatJson,
      maxClipBytes,
    }),
  );
  const metaPath =
    "content/included/gestures/arms-crossed/arms-crossed.meta.json";
  assert.equal(writes[metaPath].action, "update");
  assert.deepEqual(JSON.parse(writes[metaPath].content), {
    ...existingMeta,
    ai_description: "New.",
  });
  // A legacy `description` copy of the old text is dropped, and none is accepted.
  repo.files[metaPath] = JSON.stringify({
    ...existingMeta,
    description: "Old.",
  });
  assert.equal(
    "description" in
      JSON.parse(
        byPath(
          await planPromotion(await parsePromoteItems([replace], itemsFile), {
            repo,
            compactClip,
            formatJson,
            maxClipBytes,
          }),
        )[metaPath].content,
      ),
    false,
  );
  await assert.rejects(
    parsePromoteItems([{ ...replace, description: "Old." }], itemsFile),
    /unknown field\(s\): description/,
  );
  const plan = async (overrides) =>
    planPromotion(
      await parsePromoteItems([{ ...replace, ...overrides }], itemsFile),
      { repo, compactClip, formatJson, maxClipBytes },
    );
  await assert.rejects(plan({ selectorId: "arms-crossed-v2" }), /keeps it/);
  await assert.rejects(plan({ name: "Arms Crossed" }), /keeps its name/);
  await assert.rejects(
    plan({
      clip: await clipFile("arms-crossed.clip.json", { loop: false }),
    }),
    /must stay a loop/,
  );
  await assert.rejects(plan({ mode: "add" }), /use mode "replace"/);
  await assert.rejects(
    plan({ slug: "something-new", selectorId: "arms-crossed" }),
    /belongs to Included Gesture "arms-crossed"/,
  );
});

test("refuses an invalid clip and plans nothing new for a repeated run", async () => {
  const repo = fakeRepo();
  const invalid = await clipFile("wave-hello.clip.json", { invalid: true });
  await assert.rejects(
    planPromotion(
      await parsePromoteItems([item({ clip: invalid })], itemsFile),
      {
        repo,
        compactClip,
        formatJson,
        maxClipBytes,
      },
    ),
    /wave-hello: Invalid animaPoseClip\/2.0/,
  );
  const clip = await clipFile("wave-hello.clip.json", { schema: "x" });
  const items = await parsePromoteItems([item({ clip })], itemsFile);
  for (const write of await planPromotion(items, {
    repo,
    compactClip,
    formatJson,
    maxClipBytes,
  }))
    repo.files[write.path] = write.content;
  // A second run would replace, not add; as a replacement it changes nothing.
  assert.deepEqual(
    await planPromotion(
      await parsePromoteItems([item({ clip, mode: "replace" })], itemsFile),
      {
        repo: { ...repo, gestureSlugs: () => ["arms-crossed", "wave-hello"] },
        compactClip,
        formatJson,
        maxClipBytes,
      },
    ),
    [],
  );
  // The limit applies to the file as written.
  await assert.rejects(
    planPromotion(items, { repo, compactClip, formatJson, maxClipBytes: 10 }),
    /would be \d+ bytes, over the 10 the app loads/,
  );
});

test("adds a Gesture with the Included dependencies its events play", async () => {
  const repo = fakeRepo();
  const clip = await clipFile("have-an-idea.clip.json", {
    schema: "animaPoseClip/2.0",
    events: [bulbEvent],
  });
  const add = item({
    clip,
    name: "Have an Idea",
    selectorId: "have_idea",
    dependencies: [bulbDependency],
  });
  const plan = async (overrides) =>
    planPromotion(
      await parsePromoteItems([{ ...add, ...overrides }], itemsFile),
      { repo, compactClip, formatJson, maxClipBytes },
    );
  const metaPath =
    "content/included/gestures/have-an-idea/have-an-idea.meta.json";
  const writes = byPath(await plan({}));
  assert.deepEqual(JSON.parse(writes[metaPath].content).dependencies, [
    { ...bulbDependency, config: {} },
  ]);
  assert.deepEqual(writes[metaPath].notes, [
    `depends on "idea_bulb_fingertip" (${bulbRef})`,
  ]);

  for (const [overrides, message] of [
    // Every event that plays content needs a declared alias of its type.
    [
      { dependencies: undefined },
      /event "bulb" plays "idea_bulb_fingertip", which no dependency declares/,
    ],
    [
      {
        dependencies: [
          {
            ...bulbDependency,
            ref: "builtin:scene-effect:background:glitter",
            content_type: "scene_effect",
          },
        ],
      },
      /event "bulb" .* no dependency declares as a avatar effect/,
    ],
    // Refs are Included content of the declared type.
    [
      {
        dependencies: [
          { ...bulbDependency, ref: "local:avatar-effect:idea_bulb-draft" },
        ],
      },
      /is not Included content after this promotion; promote it first with `pnpm -s effects promote`/,
    ],
    [
      { dependencies: [{ ...bulbDependency, content_type: "scene_effect" }] },
      /declared as a scene_effect, but builtin:avatar-effect:idea_bulb_fingertip is a avatar_effect/,
    ],
    [
      { dependencies: [bulbDependency, bulbDependency] },
      /alias "idea_bulb_fingertip" repeats/,
    ],
    [
      { dependencies: [{ ref: bulbRef, content_type: "avatar_effect" }] },
      /each dependency needs "alias", "ref" and "content_type"/,
    ],
    [
      { dependencies: [{ ...bulbDependency, config: [] }] },
      /"config" that is not an object/,
    ],
  ])
    await assert.rejects(plan(overrides), message);

  await assert.rejects(
    parsePromoteItems([{ ...add, dependencies: bulbDependency }], itemsFile),
    /"dependencies" must be an array/,
  );
  await assert.rejects(
    parsePromoteItems(
      [
        {
          ...add,
          mode: "replace",
          slug: "arms-crossed",
          selectorId: "arms-crossed",
        },
      ],
      itemsFile,
    ),
    /a replace keeps the Included Gesture's dependencies; change them with `pnpm -s effects promote`/,
  );
});

test("a replace renames or changes kind only when the item says so", async () => {
  const repo = fakeRepo();
  const loop = await clipFile("arms-crossed.clip.json", {
    schema: "animaPoseClip/2.0",
    loop: true,
  });
  const oneShot = await clipFile("arms-crossed.clip.json", {
    schema: "animaPoseClip/2.0",
  });
  const replace = item({
    clip: loop,
    name: "Arms Crossed",
    selectorId: "arms-crossed",
    aiDescription: "New.",
    mode: "replace",
    rename: true,
  });
  const plan = async (overrides, target = repo) =>
    planPromotion(
      await parsePromoteItems([{ ...replace, ...overrides }], itemsFile),
      { repo: target, compactClip, formatJson, maxClipBytes },
    );
  const clipPath = "content/included/gestures/arms-crossed/arms-crossed.json";
  const metaPath =
    "content/included/gestures/arms-crossed/arms-crossed.meta.json";

  // A rename changes the display name in the meta and the clip; the folder,
  // content ID and Selector ID stay.
  const renamed = byPath(await plan({}));
  assert.deepEqual(JSON.parse(renamed[metaPath].content), {
    ...existingMeta,
    name: "Arms Crossed",
    ai_description: "New.",
  });
  assert.equal(JSON.parse(renamed[clipPath].content).name, "Arms Crossed");
  assert.equal(JSON.parse(renamed[clipPath].content).id, "arms-crossed");
  assert.deepEqual(renamed[metaPath].notes, [
    'name "arms-crossed" → "Arms Crossed"',
  ]);
  assert.equal(renamed[clipPath].notes, undefined);
  // Applied, the same item changes nothing on a second run once "rename"
  // is dropped; with it, the item claims a rename that is no longer there.
  const after = fakeRepo();
  for (const write of Object.values(renamed))
    after.files[write.path] = write.content;
  assert.deepEqual(await plan({ rename: undefined }, after), []);
  await assert.rejects(
    plan({}, after),
    /"rename": true, but the Included Gesture is already named "Arms Crossed"/,
  );

  // A loop becomes a one-shot only with loopChange.
  await assert.rejects(
    plan({ clip: oneShot }),
    /must stay a loop unless the item sets "loopChange": true/,
  );
  const changed = byPath(
    await plan({
      clip: oneShot,
      name: "arms-crossed",
      rename: undefined,
      loopChange: true,
    }),
  );
  assert.deepEqual(changed[clipPath].notes, ["a loop → a one-shot"]);
  assert.equal(JSON.parse(changed[clipPath].content).loop, undefined);
  assert.equal(JSON.parse(changed[metaPath].content).name, "arms-crossed");
  // An approved change the clip does not make is caught.
  await assert.rejects(
    plan({ name: "arms-crossed", rename: undefined, loopChange: true }),
    /"loopChange": true, but the replacement stays a loop/,
  );

  // Neither permission changes the Selector ID, and each is a replace-only
  // boolean; unknown fields (such as a misspelt permission) are refused.
  await assert.rejects(
    plan({ selectorId: "arms_crossed", loopChange: true }),
    /Selector ID is "arms-crossed"; a replacement keeps it/,
  );
  await assert.rejects(
    plan({ rename: undefined }),
    /keeps its name unless the item sets "rename": true/,
  );
  await assert.rejects(
    plan({ rename: "yes" }),
    /"rename" must be true or false/,
  );
  await assert.rejects(
    plan({
      mode: "add",
      slug: "arms-crossed-2",
      selectorId: "x",
      rename: undefined,
      loopChange: true,
    }),
    /"loopChange" applies to a replace/,
  );
  await assert.rejects(plan({ renmae: true }), /unknown field\(s\): renmae/);
  // The kept dependencies must still cover the new clip's events.
  await assert.rejects(
    plan({
      clip: await clipFile("arms-crossed.clip.json", {
        schema: "animaPoseClip/2.0",
        loop: true,
        events: [bulbEvent],
      }),
    }),
    /no dependency declares/,
  );
});

/** `repo` with another Included loop Gesture `slug` named `name`. */
function withGesture(repo, slug, name) {
  const folder = `content/included/gestures/${slug}`;
  repo.files[`${folder}/${slug}.meta.json`] = JSON.stringify({
    ...existingMeta,
    content_id: `builtin:gesture:${slug}`,
    semantic_key: slug,
    name,
    files: [{ path: `${slug}.json`, role: "sequence" }],
  });
  repo.files[`${folder}/${slug}.json`] = JSON.stringify({
    schema: "animaPoseClip/2.0",
    loop: true,
  });
  const slugs = repo.gestureSlugs();
  repo.gestureSlugs = () => [...slugs, slug].sort();
  return repo;
}

test("no two Included Gestures share a display name after the run", async () => {
  const plan = async (entries, repo) =>
    planPromotion(await parsePromoteItems(entries, itemsFile), {
      repo,
      compactClip,
      formatJson,
      maxClipBytes,
    });
  const clip = async (slug, loop) =>
    clipFile(`${slug}.clip.json`, {
      schema: "animaPoseClip/2.0",
      ...(loop ? { loop } : {}),
    });
  const rename = async (slug, name) =>
    item({
      clip: await clip(slug, true),
      name,
      selectorId: slug,
      mode: "replace",
      rename: true,
    });
  const add = async (slug, name) =>
    item({ clip: await clip(slug), name, selectorId: slug.replace("-", "_") });

  // An existing name, case-insensitively.
  await assert.rejects(
    plan([await add("wave-hello", "Arms-Crossed")], fakeRepo()),
    /wave-hello: after this run the name "Arms-Crossed" would also belong to Included Gesture "arms-crossed"/,
  );
  // Two adds in one run.
  await assert.rejects(
    plan(
      [await add("same-a", "Same Name"), await add("same-b", "same name")],
      fakeRepo(),
    ),
    /same-a: after this run the name "Same Name" would also belong to Included Gesture "same-b"/,
  );
  // An add and a rename in one run.
  await assert.rejects(
    plan(
      [await add("gamma", "Gamma"), await rename("beta", "Gamma")],
      withGesture(fakeRepo(), "beta", "Beta"),
    ),
    /gamma: after this run the name "Gamma" would also belong to Included Gesture "beta"/,
  );
  // Two renames that swap names end with distinct names.
  const swapped = byPath(
    await plan(
      [
        await rename("arms-crossed", "Beta"),
        await rename("beta", "arms-crossed"),
      ],
      withGesture(fakeRepo(), "beta", "Beta"),
    ),
  );
  assert.deepEqual(
    [
      "content/included/gestures/arms-crossed/arms-crossed.meta.json",
      "content/included/gestures/beta/beta.meta.json",
    ].map((metaPath) => JSON.parse(swapped[metaPath].content).name),
    ["Beta", "arms-crossed"],
  );
});

test("the working-tree reader finds Included descriptors through the given fs", () => {
  const files = {
    "/repo/content/included/vfx/avatar/bulb/bulb.json": JSON.stringify({
      content_type: "avatar_effect",
      content_id: bulbRef,
    }),
    "/repo/content/included/vfx/avatar/bulb/bulb.png": "not json",
    "/repo/content/included/gestures/wave/wave.json": JSON.stringify({
      schema: "animaPoseClip/2.0",
    }),
    "/repo/content/included/gestures/wave/wave.review.json": JSON.stringify({
      content_id: "not a descriptor",
    }),
  };
  const fs = {
    readFileSync: (file) => {
      if (file in files) return files[file];
      throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
    },
    readdirSync: (directory) => {
      const prefix = `${directory}/`;
      const names = new Set(
        Object.keys(files)
          .filter((file) => file.startsWith(prefix))
          .map((file) => file.slice(prefix.length).split("/")[0]),
      );
      return [...names].map((name) => ({
        name,
        isDirectory: () => !(`${prefix}${name}` in files),
        isFile: () => `${prefix}${name}` in files,
      }));
    },
  };
  assert.deepEqual(workingTreeRepo("/repo", fs).includedMetas(), [
    {
      path: "content/included/vfx/avatar/bulb/bulb.json",
      value: { content_type: "avatar_effect", content_id: bulbRef },
    },
  ]);
});
