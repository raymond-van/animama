import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  INCLUDED_CONTENT_ROOT,
  INCLUDED_EFFECT_ROOT,
  effectSourceFiles,
  effectSourceVersion,
  listIncludedEffects,
  parseLibrarySpec,
  resolveAnyEffectSource,
  resolveClipSource,
  resolveDependencies,
  resolveEffectRef,
  resolveEffectSource,
  resolveParticleRef,
} from "./effect-render-sources.mjs";
import { MAX_TIME_SEC, parseTimes } from "./effect-render.mjs";

let localContent;
let outsideDir;

async function writeEffect(root, stem, { name = stem, image = `${stem}.png` }) {
  const folder = path.join(root, "vfx/avatar", stem);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${stem}.png`), "png");
  await writeFile(
    path.join(folder, `${stem}.json`),
    JSON.stringify({
      content_type: "avatar_effect",
      // Local descriptors carry `id`, as the app writes them.
      id: `local:avatar-effect:${stem}`,
      name,
      definition: {
        schema: "animama/avatar-effect/2",
        region: "full_face",
        attachment: { kind: "face_surface", part: "face_skin", area: "full" },
        art: { image },
      },
    }),
  );
  return folder;
}

before(async () => {
  localContent = await realpath(
    await mkdtemp(path.join(tmpdir(), "animama-effect-sources-")),
  );
  await writeEffect(localContent, "sparkle", { name: "Sparkle Burst" });
  // Same stem as an Included effect, to exercise ambiguity.
  await writeEffect(localContent, "eye", { name: "Local Eye" });
  await writeEffect(localContent, "escape", { image: "../outside.png" });
  // Files outside the content root, reached only through symlinks.
  outsideDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "animama-effect-outside-")),
  );
  await writeFile(path.join(outsideDir, "secret.png"), "secret");
  await writeFile(path.join(outsideDir, "secret.json"), "{}");
  const linked = await writeEffect(localContent, "linked", {
    image: "linked-image.png",
  });
  await symlink(
    path.join(outsideDir, "secret.png"),
    path.join(linked, "linked-image.png"),
  );
  const gesture = path.join(localContent, "gestures/wave");
  await mkdir(gesture, { recursive: true });
  await writeFile(
    path.join(gesture, "wave.meta.json"),
    JSON.stringify({
      content_type: "gesture",
      id: "local:gesture:wave",
      name: "Wave",
      implementation: { kind: "anima_clip", file_role: "sequence" },
      files: [{ path: "wave.json", role: "sequence" }],
    }),
  );
  await writeFile(
    path.join(gesture, "wave.json"),
    JSON.stringify({ schema: "animaPoseClip/2.0", id: "wave" }),
  );
});

after(async () => {
  await rm(localContent, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

test("lists every Included effect descriptor and skips asset folders", async () => {
  const effects = await listIncludedEffects();
  assert.equal(effects.length, 100);
  assert.ok(!effects.some((effect) => effect.stem === "face"));
  for (const effect of effects) {
    assert.ok(effect.imagePath.startsWith(INCLUDED_EFFECT_ROOT));
  }
});

test("resolves Included effects by stem, content id, name and path", async () => {
  const byStem = await resolveEffectSource("library:heart_eyes");
  assert.equal(byStem.stem, "heart_eyes");
  assert.equal(
    byStem.imagePath,
    path.join(INCLUDED_EFFECT_ROOT, "heart_eyes/heart_eyes-sheet.png"),
  );
  const byId = await resolveEffectSource(
    "library:included/builtin:avatar-effect:angry",
  );
  assert.equal(byId.stem, "angry");
  const byName = await resolveEffectSource("library:heart EYES");
  assert.equal(byName.stem, "heart_eyes");
  const byFolder = await resolveEffectSource(
    path.join(INCLUDED_EFFECT_ROOT, "star3"),
  );
  assert.equal(byFolder.name, "Star3");
  const byFile = await resolveEffectSource("star3/star3.json", {
    cwd: INCLUDED_EFFECT_ROOT,
  });
  assert.equal(
    byFile.descriptorPath,
    path.join(INCLUDED_EFFECT_ROOT, "star3/star3.json"),
  );
});

test("resolves local effects only with a local content root", async () => {
  await assert.rejects(
    resolveEffectSource("library:local/sparkle"),
    /--local-content/,
  );
  const local = await resolveEffectSource("library:local/Sparkle Burst", {
    localContent,
  });
  assert.equal(local.stem, "sparkle");
  assert.ok(local.imagePath.startsWith(localContent));
  // Unscoped search covers both roots.
  const unscoped = await resolveEffectSource("library:sparkle", {
    localContent,
  });
  assert.equal(unscoped.contentId, "local:avatar-effect:sparkle");
});

test("rejects ambiguous, missing and escaping sources", async () => {
  await assert.rejects(
    resolveEffectSource("library:eye", { localContent }),
    /ambiguous \(included\/eye, local\/eye\)/,
  );
  const scoped = await resolveEffectSource("library:included/eye", {
    localContent,
  });
  assert.equal(scoped.contentId, "builtin:avatar-effect:eye");
  await assert.rejects(resolveEffectSource("library:nope"), /No effect/);
  await assert.rejects(
    resolveEffectSource("library:local/escape", { localContent }),
    /Effect image "..\/outside.png" leaves/,
  );
  await assert.rejects(
    resolveEffectSource(path.join(localContent, "missing")),
    /does not exist/,
  );
});

test("resolves Gesture clips from the library and from paths", async () => {
  const included = await resolveClipSource("library:arms-crossed");
  assert.equal(included.clip.schema, "animaPoseClip/2.0");
  assert.equal(included.clip.id, "arms-crossed");
  const local = await resolveClipSource("library:local/local:gesture:wave", {
    localContent,
  });
  assert.equal(local.clip.id, "wave");
  const byMeta = await resolveClipSource(
    path.join(localContent, "gestures/wave/wave.meta.json"),
  );
  assert.equal(
    byMeta.clipPath,
    path.join(localContent, "gestures/wave/wave.json"),
  );
  const raw = await resolveClipSource(byMeta.clipPath);
  assert.equal(raw.clip.id, "wave");
});

test("rejects symlinks that resolve outside their folder", async () => {
  await assert.rejects(
    resolveEffectSource("library:local/linked", { localContent }),
    /Effect image "linked-image.png" leaves/,
  );
  const gesture = path.join(localContent, "gestures/linked");
  await mkdir(gesture, { recursive: true });
  await writeFile(
    path.join(gesture, "linked.meta.json"),
    JSON.stringify({
      content_type: "gesture",
      name: "Linked",
      implementation: { kind: "anima_clip", file_role: "sequence" },
      files: [{ path: "linked.json", role: "sequence" }],
    }),
  );
  await symlink(
    path.join(outsideDir, "secret.json"),
    path.join(gesture, "linked.json"),
  );
  await assert.rejects(
    resolveClipSource("library:local/linked", { localContent }),
    /Gesture clip "linked.json" leaves/,
  );
  // A descriptor linked in from outside poisons the library scan.
  const effectRoot = path.join(localContent, "vfx/avatar");
  await mkdir(path.join(effectRoot, "foreign"));
  await symlink(
    path.join(outsideDir, "secret.json"),
    path.join(effectRoot, "foreign/foreign.json"),
  );
  try {
    await assert.rejects(
      resolveEffectSource("library:local/sparkle", { localContent }),
      /Descriptor "foreign\/foreign.json" leaves/,
    );
  } finally {
    await rm(path.join(effectRoot, "foreign"), { recursive: true });
  }
});

test("versions an effect by its descriptor and image bytes", async () => {
  const effect = await resolveEffectSource("library:local/sparkle", {
    localContent,
  });
  assert.deepEqual(effectSourceFiles(effect), [
    effect.descriptorPath,
    effect.imagePath,
  ]);
  const first = await effectSourceVersion(effect);
  assert.match(first, /^[a-f0-9]{12}$/);
  assert.equal(await effectSourceVersion(effect), first);
  await writeFile(effect.imagePath, "png, repainted");
  try {
    assert.notEqual(await effectSourceVersion(effect), first);
  } finally {
    await writeFile(effect.imagePath, "png");
  }
});

test("resolves Avatar and Particle Effect dependencies by content id", async () => {
  const swirl = await resolveEffectRef(
    "builtin:avatar-effect:eye_confused_swirl",
  );
  assert.equal(swirl.stem, "eye_confused_swirl");
  const local = await resolveEffectRef("local:avatar-effect:sparkle", {
    localContent,
  });
  assert.equal(local.name, "Sparkle Burst");
  // Included particles nest one folder deeper.
  const particle = await resolveParticleRef(
    "builtin:particle-effect:question-orbit",
  );
  const folder = path.join(
    INCLUDED_CONTENT_ROOT,
    "vfx/particle/quark/question-orbit",
  );
  assert.equal(particle.folder, folder);
  assert.equal(particle.manifestPath, path.join(folder, "particle.json"));
  assert.deepEqual(particle.texturePaths, [
    path.join(folder, "textures/orbit-dot.png"),
    path.join(folder, "textures/glossy-question.png"),
  ]);
  assert.equal(particle.defaults.anchor, "head");
  await assert.rejects(
    resolveEffectRef("builtin:avatar-effect:nope"),
    /No avatar effect "builtin:avatar-effect:nope" in Included content/,
  );
});

test("skips a linked-in descriptor instead of failing every dependency", async () => {
  const effectRoot = path.join(localContent, "vfx/avatar");
  await mkdir(path.join(effectRoot, "aaa-foreign"));
  await symlink(
    path.join(outsideDir, "secret.json"),
    path.join(effectRoot, "aaa-foreign/aaa-foreign.json"),
  );
  const skipped = [];
  try {
    const effect = await resolveEffectRef("local:avatar-effect:sparkle", {
      localContent,
      onSkip: (message) => skipped.push(message),
    });
    assert.equal(effect.stem, "sparkle");
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /aaa-foreign\.json.*leaves/);
  } finally {
    await rm(path.join(effectRoot, "aaa-foreign"), { recursive: true });
  }
});

test("keeps a Particle Effect's files inside its folder", async () => {
  const folder = path.join(localContent, "vfx/particle/pack/glow");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "particle.json"), "{}");
  await symlink(
    path.join(outsideDir, "secret.png"),
    path.join(folder, "t.png"),
  );
  await writeFile(
    path.join(folder, "glow.json"),
    JSON.stringify({
      content_type: "particle_effect",
      id: "local:particle-effect:glow",
      files: [
        { path: "particle.json", role: "manifest" },
        { path: "t.png", role: "texture" },
      ],
    }),
  );
  await assert.rejects(
    resolveParticleRef("local:particle-effect:glow", { localContent }),
    /Particle texture "t.png" leaves/,
  );
});

test("names an effect kind in library specs; none means an Avatar Effect", () => {
  assert.deepEqual(parseLibrarySpec("library:star3"), {
    kind: null,
    scope: null,
    key: "star3",
  });
  assert.deepEqual(
    parseLibrarySpec("library:particle-effect/included/hearts-v1"),
    {
      kind: "particle",
      scope: "included",
      key: "hearts-v1",
    },
  );
  assert.deepEqual(parseLibrarySpec("library:scene-effect/joy"), {
    kind: "scene",
    scope: null,
    key: "joy",
  });
  assert.deepEqual(parseLibrarySpec("library:reaction/joy-3"), {
    kind: "reaction",
    scope: null,
    key: "joy-3",
  });
  assert.equal(parseLibrarySpec("./folder"), null);
});

test("resolves Particle and Scene Effect sources by library spec and folder", async () => {
  const stream = await resolveAnyEffectSource(
    "library:particle-effect/hearts-v1",
  );
  const folder = path.join(
    INCLUDED_CONTENT_ROOT,
    "vfx/particle/quark/hearts-v1",
  );
  assert.equal(stream.kind, "particle");
  assert.equal(stream.stem, "hearts-v1");
  assert.equal(stream.contentId, "builtin:particle-effect:hearts-v1");
  assert.equal(stream.manifestPath, path.join(folder, "particle.json"));
  assert.deepEqual(stream.texturePaths, [
    path.join(folder, "textures/pearl-heart.png"),
    path.join(folder, "textures/soft-haze.png"),
    path.join(folder, "textures/star-glint.png"),
  ]);
  assert.equal(stream.defaults.anchor, "head");
  const byFolder = await resolveAnyEffectSource(folder);
  assert.equal(byFolder.kind, "particle");
  assert.deepEqual(effectSourceFiles(byFolder), [
    path.join(folder, "hearts-v1.json"),
    path.join(folder, "particle.json"),
    path.join(folder, "textures/pearl-heart.png"),
    path.join(folder, "textures/soft-haze.png"),
    path.join(folder, "textures/star-glint.png"),
  ]);

  const joy = await resolveAnyEffectSource(
    "library:scene-effect/scene-vfx-emotion-joy",
  );
  const sceneFolder = path.join(
    INCLUDED_CONTENT_ROOT,
    "vfx/scene/scene-vfx-emotion-joy",
  );
  assert.equal(joy.kind, "scene");
  assert.equal(joy.definition.kind, "background_layers");
  assert.deepEqual(
    joy.imagePaths,
    Object.fromEntries(
      [
        "pop-star-yellow.png",
        "confetti-curl-pink.png",
        "confetti-chip-teal.png",
        "confetti-chip-violet.png",
      ].map((name) => [name, path.join(sceneFolder, name)]),
    ),
  );
  assert.match(await effectSourceVersion(joy), /^[0-9a-f]{12}$/);

  const avatar = await resolveAnyEffectSource("library:star3");
  assert.equal(avatar.kind, "avatar");
  assert.equal(avatar.stem, "star3");
  await assert.rejects(
    resolveAnyEffectSource("library:scene-effect/hearts-v1"),
    /No scene matches/,
  );
});

test("keeps a Scene Effect's images inside its folder", async () => {
  const folder = path.join(localContent, "vfx/scene/leaky");
  await mkdir(folder, { recursive: true });
  await symlink(
    path.join(outsideDir, "secret.png"),
    path.join(folder, "art.png"),
  );
  await writeFile(
    path.join(folder, "leaky.json"),
    JSON.stringify({
      content_type: "scene_effect",
      id: "local:scene-effect:leaky",
      definition: {
        schema: "animama/scene-effect/1",
        kind: "background_layers",
        marquee: { items: [{ id: "a", kind: "image", image: "art.png" }] },
      },
      files: [{ path: "art.png", role: "image" }],
    }),
  );
  await assert.rejects(
    resolveAnyEffectSource("library:scene-effect/local/leaky", {
      localContent,
    }),
    /Scene image "art.png" leaves/,
  );
});

test("resolves a Reaction clip and every kind of effect it depends on", async () => {
  const reaction = await resolveClipSource("library:reaction/joy-4");
  assert.equal(reaction.clip.id, "joy-4");
  const media = await resolveDependencies(reaction.dependencies);
  assert.deepEqual(
    media.avatarEffects.map(({ alias, effect }) => [alias, effect.stem]),
    [["star3", "star3"]],
  );
  assert.deepEqual(
    media.particleEffects.map(({ alias, particle }) => [alias, particle.stem]),
    [
      ["confetti", "confetti"],
      ["star-burst", "star-burst"],
    ],
  );
  assert.deepEqual(
    media.sceneEffects.map(({ alias, scene }) => [alias, scene.stem]),
    [["scene-vfx-emotion-joy", "scene-vfx-emotion-joy"]],
  );
  assert.deepEqual(media.notices, []);
});

test("parses --times as bounded ascending seconds", () => {
  assert.deepEqual(parseTimes(undefined, [1]), [1]);
  assert.deepEqual(parseTimes("2, 0.5,0.5,0"), [0, 0.5, 2]);
  assert.deepEqual(parseTimes(String(MAX_TIME_SEC), []), [MAX_TIME_SEC]);
  for (const value of ["", "1,,2", "1,", "-1", "abc", "Infinity", "31"]) {
    assert.throws(() => parseTimes(value, []), /Invalid --times/, value);
  }
});
