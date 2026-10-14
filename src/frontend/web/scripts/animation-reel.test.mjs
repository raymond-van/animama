import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULTS,
  audioMixGraph,
  chapterMetadata,
  compareReactions,
  describeItem,
  listReelItems,
  loadSoundCatalog,
  parseReelArgs,
} from "./animation-reel.mjs";

test("parses reel options and rejects invalid ones", () => {
  const options = parseReelArgs([
    "--reactions",
    "library:gesture/wave",
    "--out",
    "reel.mp4",
    "--avatar",
    "Caitlyn",
    "--size",
    "1280x720",
    "--fps",
    "24",
    "--talk",
    "2.5",
    "--sounds",
    "a",
    "--sounds",
    "b",
  ]);
  assert.equal(options.reactions, true);
  assert.equal(options.gestures, false);
  assert.deepEqual(options.sources, ["library:gesture/wave"]);
  assert.equal(options.avatar, "AvatarSample_Y_0");
  assert.deepEqual(options.size, { width: 1280, height: 720 });
  assert.equal(options.fps, 24);
  assert.equal(options.talk, 2.5);
  assert.deepEqual(options.soundRoots, ["a", "b"]);
  assert.equal(options.camera, DEFAULTS.camera);
  assert.deepEqual(parseReelArgs(["--help"]), { help: true });

  for (const [argv, message] of [
    [["--out", "a.mp4"], /--gestures, --reactions or name sources/],
    [["--gestures"], /--out is required/],
    [["--gestures", "--out", "a.webm"], /\.mp4/],
    [["--gestures", "--out", "a.mp4", "--size", "1921x1080"], /even/],
    [["--gestures", "--out", "a.mp4", "--fps", "0"], /--fps/],
    [["--gestures", "--out", "a.mp4", "--camera", "side"], /--camera/],
    [["--gestures", "--out", "a.mp4", "--avatar", "../x"], /--avatar/],
    [["--gestures", "--out"], /needs a value/],
    [["--gestures", "--loud"], /Unknown option/],
  ])
    assert.throws(() => parseReelArgs(argv), message);
});

test("orders Included Reactions by emotion, then intensity", async () => {
  const items = await listReelItems({
    gestures: false,
    reactions: true,
    sources: [],
    cwd: process.cwd(),
    localContent: null,
  });
  assert.deepEqual(
    items
      .slice(0, 4)
      .map(({ emotion, intensity }) => `${emotion}-${intensity}`),
    ["admiration-1", "admiration-2", "admiration-3", "amusement-1"],
  );
  assert.ok(items.every((item) => item.kind === "reaction" && item.clip));
  assert.deepEqual([...items].sort(compareReactions), items);
});

test("lists Included Gestures by stem, then named sources", async () => {
  const items = await listReelItems({
    gestures: true,
    reactions: false,
    sources: ["library:reaction/joy-2"],
    cwd: process.cwd(),
    localContent: null,
  });
  const gestures = items.slice(0, -1);
  assert.ok(gestures.length > 0);
  assert.ok(gestures.every((item) => item.kind === "gesture"));
  assert.deepEqual(
    gestures.map((item) => item.stem),
    gestures.map((item) => item.stem).sort((a, b) => a.localeCompare(b)),
  );
  assert.deepEqual(items.at(-1).stem, "joy-2");
  assert.equal(items.at(-1).name, "Joy Reaction 2");
  assert.equal(items.at(-1).intensity, 2);
});

test("finds sound effects by content id beside or listed by their sidecar", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "animama-reel-sounds-"));
  try {
    const first = path.join(dir, "first");
    const second = path.join(dir, "second/nested");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const sidecar = (folder, stem, meta) =>
      writeFile(
        path.join(folder, `${stem}.meta.json`),
        JSON.stringify({ content_type: "sound_effect", ...meta }),
      );
    await sidecar(first, "pop", {
      content_id: "builtin:sound-effect:pop",
      name: "Pop",
      duration_seconds: 0.4,
    });
    await writeFile(path.join(first, "pop.ogg"), "audio");
    await sidecar(second, "listed", {
      content_id: "local:sound:listed",
      files: [{ path: "audio/listed-file.wav", role: "audio" }],
    });
    await mkdir(path.join(second, "audio"));
    await writeFile(path.join(second, "audio/listed-file.wav"), "audio");
    // The first root wins; a sidecar without audio or of another type is skipped.
    await sidecar(second, "pop", { content_id: "builtin:sound-effect:pop" });
    await writeFile(path.join(second, "pop.wav"), "audio");
    await sidecar(second, "silent", { content_id: "builtin:sound-effect:x" });
    await writeFile(
      path.join(second, "other.meta.json"),
      JSON.stringify({ content_type: "gesture", content_id: "g" }),
    );

    const catalog = await loadSoundCatalog([first, path.join(dir, "second")]);
    assert.deepEqual([...catalog.keys()].sort(), [
      "builtin:sound-effect:pop",
      "local:sound:listed",
    ]);
    const pop = catalog.get("builtin:sound-effect:pop");
    assert.equal(path.basename(pop.file), "pop.ogg");
    assert.equal(pop.name, "Pop");
    assert.equal(pop.duration, 0.4);
    assert.equal(
      path.basename(catalog.get("local:sound:listed").file),
      "listed-file.wav",
    );
    assert.equal(catalog.get("local:sound:listed").duration, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("labels an item with its effects and the sounds they play", () => {
  const catalog = new Map([
    [
      "builtin:sound-effect:pop",
      { file: "/sounds/pop.ogg", name: "Pop", duration: 0.4 },
    ],
  ]);
  const { label, cues } = describeItem(
    {
      kind: "reaction",
      name: "Joy Reaction 2",
      emotion: "joy",
      intensity: 2,
      clip: {
        events: [
          { kind: "sfx", cueId: "ding" },
          { kind: "avatar_vfx", effectId: "star" },
        ],
      },
      dependencies: [
        {
          alias: "ding",
          ref: "builtin:sound-effect:ding",
          content_type: "sound_effect",
        },
      ],
    },
    {
      index: 2,
      total: 72,
      media: {
        avatarEffects: [
          {
            alias: "star",
            effect: { name: "Star", soundRef: "builtin:sound-effect:pop" },
          },
        ],
        particleEffects: [
          { alias: "confetti", particle: { name: "Confetti" } },
        ],
        sceneEffects: [{ alias: "bg", scene: { name: "Joy Background" } }],
      },
      catalog,
    },
  );
  assert.deepEqual(label, {
    kicker: "Reaction · 3 / 72",
    title: "Joy Reaction 2",
    detail: "Joy · intensity 2",
    effects: [
      {
        alias: "star",
        kind: "Avatar Effect",
        name: "Star",
        soundCueId: "builtin:sound-effect:pop",
      },
      {
        alias: "confetti",
        kind: "Particle Effect",
        name: "Confetti",
        soundCueId: null,
      },
      {
        alias: "bg",
        kind: "Scene Effect",
        name: "Joy Background",
        soundCueId: null,
      },
    ],
    sounds: ["ding"],
  });
  assert.deepEqual(cues, {
    "builtin:sound-effect:pop": {
      ref: "builtin:sound-effect:pop",
      name: "Pop",
      duration: 0.4,
    },
    // A sound event names its dependency alias; this one has no file.
    ding: {
      ref: "builtin:sound-effect:ding",
      name: "ding (no file)",
      duration: 0,
    },
  });
});

test("writes chapters and an audio mix graph for ffmpeg", () => {
  assert.equal(
    chapterMetadata([
      { start: 0, end: 1.5, title: "Gesture · 1 / 2 · A=B; #1" },
      { start: 1.5, end: 3.25, title: "Reaction" },
    ]),
    [
      ";FFMETADATA1",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      "START=0",
      "END=1500",
      "title=Gesture · 1 / 2 · A\\=B\\; \\#1",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      "START=1500",
      "END=3250",
      "title=Reaction",
      "",
    ].join("\n"),
  );

  const { files, graph } = audioMixGraph(
    [
      { file: "/a.ogg", time: 1.2345, volume: 1 },
      { file: "/b.ogg", time: 2, volume: 0.5 },
      { file: "/a.ogg", time: 3, volume: 1 },
    ],
    1,
  );
  assert.deepEqual(files, ["/a.ogg", "/b.ogg"]);
  assert.equal(
    graph,
    [
      "[2:a]asplit=2[s0][s2]",
      "[s0]aformat=sample_rates=48000:channel_layouts=stereo,adelay=1235:all=1,volume=1[e0]",
      "[s2]aformat=sample_rates=48000:channel_layouts=stereo,adelay=3000:all=1,volume=1[e2]",
      "[3:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=2000:all=1,volume=0.5[e1]",
      "[1:a][e0][e2][e1]amix=inputs=4:duration=first:normalize=0[aout]",
    ].join(";"),
  );
  assert.deepEqual(audioMixGraph([], 1), {
    files: [],
    graph: "[1:a]amix=inputs=1:duration=first:normalize=0[aout]",
  });
});
