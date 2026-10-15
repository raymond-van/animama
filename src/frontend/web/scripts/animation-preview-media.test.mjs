import assert from "node:assert/strict";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  PreviewMediaFiles,
  createPreviewMediaAdapter,
  effectSpecFor,
  effectVersionForFile,
} from "./animation-preview-media.mjs";
import {
  INCLUDED_CONTENT_ROOT,
  INCLUDED_EFFECT_ROOT,
} from "./effect-render-sources.mjs";

let dir;

before(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "animama-media-")));
  await cp(path.join(INCLUDED_EFFECT_ROOT, "star3"), path.join(dir, "star3"), {
    recursive: true,
  });
  await writeFile(
    path.join(dir, "wave.clip.json"),
    JSON.stringify({ schema: "animaPoseClip/2.0", id: "wave" }),
  );
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const roots = () => ({
  cwd: dir,
  included: INCLUDED_CONTENT_ROOT,
  local: null,
});

test("tells effect sources from clips", async () => {
  assert.equal(await effectSpecFor("star3", dir), path.join(dir, "star3"));
  assert.equal(
    await effectSpecFor("star3/star3.json", dir),
    path.join(dir, "star3/star3.json"),
  );
  for (const spec of [
    "library:avatar-effect/included/star3",
    "library:particle-effect/hearts-v1",
    "library:scene-effect/included/scene-vfx-emotion-joy",
  ])
    assert.equal(await effectSpecFor(spec, dir), spec);
  assert.equal(await effectSpecFor("wave.clip.json", dir), null);
  assert.equal(await effectSpecFor("library:included/confusion-2", dir), null);
  assert.equal(await effectSpecFor("missing.json", dir), null);
});

test("serves only offered files, each inside its folder", async () => {
  const files = new PreviewMediaFiles();
  const folder = path.join(dir, "star3");
  const url = files.url(folder, path.join(folder, "star3-sheet.png"), "abc");
  assert.match(
    url,
    /^\/__preview\/media\/[a-f0-9]{16}\/star3-sheet\.png\?v=abc$/,
  );
  const route = url.slice("/__preview/media/".length).split("?")[0];
  assert.equal(await files.lookup(route), path.join(folder, "star3-sheet.png"));
  const token = route.split("/")[0];
  assert.equal(await files.lookup(`${token}/star3.json`), null);
  assert.equal(await files.lookup(`${token}/..%2Fwave.clip.json`), null);
  assert.equal(await files.lookup("unknown/star3-sheet.png"), null);
  assert.throws(() => files.url(folder, path.join(dir, "wave.clip.json")));
  // A file swapped for a link that leaves the folder is no longer served.
  const linked = path.join(dir, "linked");
  await mkdir(linked);
  await writeFile(path.join(linked, "art.png"), "png");
  const linkedRoute = files
    .url(linked, path.join(linked, "art.png"))
    .slice("/__preview/media/".length);
  await rm(path.join(linked, "art.png"));
  await symlink(path.join(dir, "wave.clip.json"), path.join(linked, "art.png"));
  assert.equal(await files.lookup(linkedRoute), null);
});

test("loads an effect source with served, versioned images and notes beside its folder", async () => {
  const files = new PreviewMediaFiles();
  const adapter = createPreviewMediaAdapter({ files, duration: 2 });
  const source = await adapter.resolve("star3", roots());
  assert.deepEqual(source, {
    spec: "star3",
    type: "effect",
    path: path.join(dir, "star3/star3.json"),
    name: "star3",
    kind: "file",
    label: "star3",
    notesDir: dir,
  });
  const loaded = await adapter.load(source, roots());
  assert.match(loaded.version, /^[a-f0-9]{12}$/);
  assert.deepEqual(loaded.files, [
    path.join(dir, "star3/star3.json"),
    path.join(dir, "star3/star3-sheet.png"),
  ]);
  assert.equal(loaded.effect.kind, "avatar_effect");
  assert.equal(loaded.effect.name, "Star3");
  assert.equal(loaded.effect.duration, 2);
  assert.ok(
    loaded.effect.imageUrl.endsWith(`star3-sheet.png?v=${loaded.version}`),
  );
  assert.equal(
    await effectVersionForFile(path.join(dir, "star3/star3.json")),
    loaded.version,
  );
  assert.equal(
    await effectVersionForFile(path.join(dir, "wave.clip.json")),
    null,
  );

  const library = await adapter.resolve(
    "library:avatar-effect/Eye Confused Swirl",
    roots(),
  );
  assert.equal(library.kind, "library");
  assert.equal(library.label, "Included · Eye Confused Swirl");
  assert.equal(await adapter.resolve("wave.clip.json", roots()), null);
});

test("resolves a Reaction's dependencies to served effects", async () => {
  const files = new PreviewMediaFiles();
  const adapter = createPreviewMediaAdapter({ files });
  const media = await adapter.media(
    [
      {
        ref: "builtin:avatar-effect:eye_confused_swirl",
        alias: "swirl",
        content_type: "avatar_effect",
        config: {},
      },
      {
        ref: "builtin:particle-effect:question-orbit",
        alias: "question-orbit",
        content_type: "particle_effect",
        config: { duration_seconds: 3 },
      },
      {
        ref: "builtin:avatar-effect:missing",
        alias: "missing",
        content_type: "avatar_effect",
      },
      {
        ref: "builtin:scene-effect:background:scene-vfx-emotion-curiosity",
        alias: "scene-vfx-emotion-curiosity",
        content_type: "scene_effect",
      },
    ],
    roots(),
  );
  assert.deepEqual(
    media.avatarEffects.map(({ alias, effect }) => [alias, effect.name]),
    [["swirl", "Eye Confused Swirl"]],
  );
  const [particle] = media.particleEffects;
  assert.equal(particle.alias, "question-orbit");
  // The dependency's config overrides the stored defaults.
  assert.equal(particle.config.duration_seconds, 3);
  assert.equal(particle.config.anchor, "head");
  const manifest = particle.manifestUrl.slice("/__preview/media/".length);
  assert.ok(await files.lookup(manifest));
  // The manifest's relative texture URL resolves beside it.
  const texture = `${manifest.split("/")[0]}/textures/glossy-question.png`;
  assert.ok(await files.lookup(texture));
  // A Scene's images are served too.
  const [scene] = media.sceneEffects;
  assert.equal(scene.alias, "scene-vfx-emotion-curiosity");
  assert.equal(scene.definition.kind, "background_layers");
  assert.ok(Object.keys(scene.imageUrls).length > 0);
  for (const url of Object.values(scene.imageUrls))
    assert.ok(await files.lookup(url.slice("/__preview/media/".length)), url);
  assert.deepEqual(media.notices, [
    'missing (builtin:avatar-effect:missing) does not play: No avatar effect "builtin:avatar-effect:missing" in Included content.',
  ]);
});

test("offers Library Avatar Effects and named effect sources as choices", async () => {
  const adapter = createPreviewMediaAdapter({ files: new PreviewMediaFiles() });
  const choices = await adapter.choices(roots(), ["star3", "wave.clip.json"]);
  assert.deepEqual(choices[0], {
    spec: path.join(dir, "star3/star3.json"),
    label: "star3",
    group: "Effect sources",
    path: path.join(dir, "star3/star3.json"),
  });
  const included = choices.filter(
    ({ group }) => group === "Included Avatar Effects",
  );
  assert.equal(included.length, 100);
  assert.ok(
    included.some(
      ({ spec }) =>
        spec === "library:avatar-effect/included/eye_confused_swirl",
    ),
  );
});

test("offers the other effect folders beside a named one", async () => {
  const adapter = createPreviewMediaAdapter({ files: new PreviewMediaFiles() });
  const batch = path.join(dir, "batch");
  for (const name of ["one", "two"])
    await cp(path.join(dir, "star3"), path.join(batch, name), {
      recursive: true,
    });
  await mkdir(path.join(batch, "one-work"));
  await writeFile(path.join(batch, "one-work", "notes.md"), "brief");
  await writeFile(path.join(batch, "one-work", "items.json"), '{"x":1}');
  const sources = (await adapter.choices(roots(), ["batch/one"]))
    .filter(({ group }) => group === "Effect sources")
    .map(({ label }) => label);
  assert.deepEqual(sources, ["one", "two"]);
});

test("watches an effect whose image is missing until the image appears", async () => {
  const adapter = createPreviewMediaAdapter({ files: new PreviewMediaFiles() });
  const folder = path.join(dir, "late");
  await mkdir(folder);
  const descriptor = JSON.parse(
    await readFile(path.join(dir, "star3/star3.json"), "utf8"),
  );
  descriptor.definition.art.image = "new.png";
  await writeFile(path.join(folder, "late.json"), JSON.stringify(descriptor));
  // Resolving needs only the descriptor; loading reports the missing image.
  const source = await adapter.resolve("late", roots());
  assert.equal(source.path, path.join(folder, "late.json"));
  await assert.rejects(
    adapter.load(source, roots()),
    /"new.png" does not exist/,
  );
  await copyFile(
    path.join(dir, "star3/star3-sheet.png"),
    path.join(folder, "new.png"),
  );
  const loaded = await adapter.load(source, roots());
  assert.ok(loaded.effect.imageUrl.includes("/new.png?v="));
});

test("forgets the least recently used folders and re-checks sizes on serve", async () => {
  const files = new PreviewMediaFiles({ maxFolders: 2 });
  const folders = ["a", "b", "c"].map((name) => path.join(dir, `cap-${name}`));
  const routes = [];
  for (const folder of folders) {
    await mkdir(folder);
    await writeFile(path.join(folder, "art.png"), "png");
    routes.push(
      files
        .url(folder, path.join(folder, "art.png"), null, 8)
        .slice("/__preview/media/".length),
    );
  }
  assert.equal(await files.lookup(routes[0]), null);
  assert.ok(await files.lookup(routes[1]));
  assert.ok(await files.lookup(routes[2]));
  // A file grown past its limit after it was offered is refused.
  await writeFile(path.join(folders[2], "art.png"), "much more than 8 bytes");
  assert.equal(await files.lookup(routes[2]), null);
});

test("loads Particle and Scene Effect sources with their files served", async () => {
  await cp(
    path.join(INCLUDED_CONTENT_ROOT, "vfx/particle/quark/hearts-v1"),
    path.join(dir, "kinds/hearts-v1"),
    { recursive: true },
  );
  await cp(
    path.join(INCLUDED_CONTENT_ROOT, "vfx/scene/scene-vfx-emotion-joy"),
    path.join(dir, "kinds/scene-vfx-emotion-joy"),
    { recursive: true },
  );
  const files = new PreviewMediaFiles();
  const adapter = createPreviewMediaAdapter({ files });
  const particle = await adapter.load(
    await adapter.resolve("kinds/hearts-v1", roots()),
    roots(),
  );
  assert.equal(particle.effect.kind, "particle_effect");
  // The version covers the manifest and textures, which are watched.
  assert.ok(
    particle.files.some((file) => file.endsWith("textures/pearl-heart.png")),
    particle.files,
  );
  const manifest = particle.effect.manifestUrl
    .slice("/__preview/media/".length)
    .split("?")[0];
  assert.ok(await files.lookup(manifest));
  assert.ok(
    await files.lookup(`${manifest.split("/")[0]}/textures/pearl-heart.png`),
  );

  const scene = await adapter.load(
    await adapter.resolve("kinds/scene-vfx-emotion-joy", roots()),
    roots(),
  );
  assert.equal(scene.effect.kind, "scene_effect");
  assert.equal(scene.effect.definition.kind, "background_layers");
  for (const url of Object.values(scene.effect.imageUrls))
    assert.ok(
      await files.lookup(url.slice("/__preview/media/".length).split("?")[0]),
      url,
    );
  assert.equal(PreviewMediaFiles.contentType("star.svg"), "image/svg+xml");

  // Changing a texture or an image gives a new version, so the page reloads.
  const textureFile = path.join(
    dir,
    "kinds/hearts-v1/textures/pearl-heart.png",
  );
  await writeFile(
    textureFile,
    Buffer.concat([await readFile(textureFile), Buffer.from([0])]),
  );
  const reloaded = await adapter.load(
    await adapter.resolve("kinds/hearts-v1", roots()),
    roots(),
  );
  assert.notEqual(reloaded.version, particle.version);
  const imageFile = path.join(
    dir,
    "kinds/scene-vfx-emotion-joy",
    Object.keys(scene.effect.imageUrls)[0],
  );
  await writeFile(
    imageFile,
    Buffer.concat([await readFile(imageFile), Buffer.from([0])]),
  );
  const redrawn = await adapter.load(
    await adapter.resolve("kinds/scene-vfx-emotion-joy", roots()),
    roots(),
  );
  assert.notEqual(redrawn.version, scene.version);

  // Both kinds are offered beside a named folder and from the Library.
  const choices = await adapter.choices(roots(), ["kinds/hearts-v1"]);
  assert.deepEqual(
    choices
      .filter(({ group }) => group === "Effect sources")
      .map(({ label }) => label),
    ["hearts-v1", "scene-vfx-emotion-joy"],
  );
  for (const group of ["Included Particle Effects", "Included Scene Effects"])
    assert.ok(
      choices.some((choice) => choice.group === group),
      group,
    );
});
