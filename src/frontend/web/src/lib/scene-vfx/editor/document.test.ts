import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import allLayers from "@/lib/content/fixtures/scene-effect-all-layers.json";

import {
  addSceneEffectImage,
  applySceneEffectTemplate,
  buildSceneEffectEditorExport,
  canonicalSceneEffectImageName,
  createDefaultSceneEffectDocument,
  createSceneEffectDocumentFromDefinition,
  DEFAULT_SCENE_PATTERN_COLOR,
  DEFAULT_SCENE_SOLID_COLOR,
  normalizeSceneEffectDocument,
  parseSceneEffectEditorExport,
  sceneEffectDefinition,
  sceneEffectDependencies,
  sceneEffectDocumentFingerprint,
  sceneEffectImageMetadata,
  sceneEffectEditorReducer,
  sceneEffectRuntimeEntry,
  uniqueSceneEffectImageName,
  validateSceneEffectDocument,
} from ".";

/** A new document switched to Focus Lines (the bundled Dark preset). */
function focusLinesDocument() {
  return sceneEffectEditorReducer(createDefaultSceneEffectDocument(), {
    type: "set-kind",
    kind: "focus_lines",
  });
}

const image = {
  logicalName: "sparkle.webp",
  originalName: "Sparkle.PNG",
  contentType: "image/png",
  sizeBytes: 42,
  sha256: "a".repeat(64),
};

describe("Scene Effect editor document", () => {
  it("reopens Included SVG artwork as a valid editable Local document", () => {
    const svg = {
      ...image,
      logicalName: "star.svg",
      originalName: "star.svg",
      contentType: "image/svg+xml",
    };
    const document = createDefaultSceneEffectDocument();
    document.background.marquee.items = [
      { id: "star", kind: "image", label: "Star", image: svg },
    ];
    const reopened = createSceneEffectDocumentFromDefinition({
      name: "Local stars",
      description: "",
      definition: sceneEffectDefinition(document),
      images: new Map([[svg.logicalName, svg]]),
      sound: null,
    });
    expect(
      validateSceneEffectDocument(reopened, [
        {
          logicalName: svg.logicalName,
          file: new File(
            ['<svg xmlns="http://www.w3.org/2000/svg"/>'],
            svg.originalName,
            { type: svg.contentType },
          ),
          sha256: svg.sha256,
        },
      ]),
    ).toEqual([]);
    expect(canonicalSceneEffectImageName("My Star.SVG")).toBe("My-Star.svg");
    expect(uniqueSceneEffectImageName("My Star.svg", ["My-Star.svg"])).toBe(
      "My-Star-2.svg",
    );
    expect(sceneEffectImageMetadata(reopened)).toEqual([svg]);
  });
  it("keeps new names empty and permits automatic naming on save", () => {
    const document = createDefaultSceneEffectDocument();
    expect(document.name).toBe("");
    expect(
      validateSceneEffectDocument(document, []).filter(
        (issue) => issue.field === "name",
      ),
    ).toEqual([]);
  });

  it("starts new documents with all background layers enabled and themed", () => {
    const document = createDefaultSceneEffectDocument();

    expect(document.kind).toBe("background_layers");
    expect(document.background).toMatchObject({
      solid: { enabled: true, color: DEFAULT_SCENE_SOLID_COLOR },
      pattern: {
        enabled: true,
        pattern: "polkadot",
        color: DEFAULT_SCENE_PATTERN_COLOR,
      },
      marquee: { enabled: true, items: [] },
    });
    expect(validateSceneEffectDocument(document, [])).toEqual([]);
  });

  it("serializes portable background layers and their private images", () => {
    const document = createDefaultSceneEffectDocument();
    document.name = "Sparkle Scene";
    document.background.marquee.items.push({
      id: "private-sparkle",
      kind: "image",
      label: "Sparkle",
      image,
    });
    const resource = {
      logicalName: image.logicalName,
      file: new File(["sparkle"], image.originalName, {
        type: image.contentType,
      }),
      sha256: image.sha256,
    };

    const definition = sceneEffectDefinition(document);
    expect(definition).toMatchObject({
      schema: "animama/scene-effect/1",
      kind: "background_layers",
      durationMs: 5000,
      dismissOnInput: true,
    });
    expect((definition.marquee as { items: unknown[] }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "private-sparkle",
          kind: "image",
          image: "sparkle.webp",
        }),
      ]),
    );
    expect(sceneEffectImageMetadata(document)).toEqual([image]);
    expect(validateSceneEffectDocument(document, [resource])).toEqual([]);
  });

  it("applies a template's effect but keeps the draft's name, description and sound", () => {
    const draft = createDefaultSceneEffectDocument();
    draft.name = "My scene";
    draft.description = "Mine";
    draft.sound = {
      alias: "on-apply",
      label: "Bright Idea",
      source: {
        type: "builtin",
        content_id: "sound_effect:bright-idea",
        version: 3,
      },
    };
    const love = includedScene("scene-vfx-emotion-love");
    const template = createSceneEffectDocumentFromDefinition({
      name: "Emotion Love 1",
      description: love.description,
      definition: love.definition,
      images: includedImages(love),
      sound: null,
    });

    const applied = applySceneEffectTemplate(draft, template);

    expect(applied).toEqual({
      ...template,
      name: "My scene",
      description: "Mine",
      sound: draft.sound,
    });
    expect(applied.durationMs).toBeNull();
    expect(applied.background.scatters.length).toBeGreaterThan(0);
    // The result is independent of the template it copied.
    applied.background.solid.color = "#123456";
    expect(template.background.solid.color).not.toBe("#123456");

    const focus = applySceneEffectTemplate(template, focusLinesDocument());
    expect(focus).toMatchObject({
      kind: "focus_lines",
      name: "Emotion Love 1",
    });
    expect(validateSceneEffectDocument(focus, [])).toEqual([]);
  });

  it("preserves marquee ordering through explicit editor actions", () => {
    const document = createDefaultSceneEffectDocument();
    const reversed = [...document.background.marquee.items].reverse();
    const changed = sceneEffectEditorReducer(document, {
      type: "set-marquee-items",
      items: reversed,
    });

    expect(changed.background.marquee.items.map((item) => item.id)).toEqual(
      reversed.map((item) => item.id),
    );
  });

  it("labels an added image item as asked, by default after its file", () => {
    const document = createDefaultSceneEffectDocument();
    const named = addSceneEffectImage(
      document,
      image,
      { kind: "marquee" },
      "Heart",
    );
    const unnamed = addSceneEffectImage(document, image, { kind: "marquee" });

    expect(named.background.marquee.items.at(-1)).toMatchObject({
      kind: "image",
      label: "Heart",
      image,
    });
    expect(unnamed.background.marquee.items.at(-1)).toMatchObject({
      kind: "image",
      label: "Sparkle",
      image,
    });
  });

  it("preserves front-of-avatar placement in the isolated runtime entry", () => {
    const document = focusLinesDocument();
    document.focus.renderPlacement = "front_of_avatar";

    expect(sceneEffectRuntimeEntry(document, new Map())).toMatchObject({
      kind: "focus_lines",
      renderPlacement: "front_of_avatar",
      dismissOnInput: false,
    });
  });

  it("rejects out-of-bounds manual targets and URL-shaped imported items", () => {
    const focus = focusLinesDocument();
    focus.focus.target = {
      kind: "manual_box",
      rect: { x: 0.9, y: 0.1, width: 0.2, height: 0.5 },
    };
    expect(validateSceneEffectDocument(focus, [])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "focus.target", severity: "error" }),
      ]),
    );

    const forged = buildSceneEffectEditorExport(
      createDefaultSceneEffectDocument(),
    ) as unknown as {
      document: { background: { marquee: { items: unknown[] } } };
    };
    forged.document.background.marquee.items = [
      {
        id: "remote",
        kind: "png",
        label: "Remote",
        src: "https://example.test/tracker.png",
      },
    ];
    expect(() => parseSceneEffectEditorExport(forged)).toThrow();
  });

  it("pins an optional Sound Effect to its exact source", () => {
    const document = createDefaultSceneEffectDocument();
    document.sound = {
      alias: "on-apply",
      label: "Bright Idea",
      source: {
        type: "builtin",
        content_id: "sound_effect:bright-idea",
        version: 3,
      },
    };

    expect(sceneEffectDependencies(document)).toEqual([
      {
        alias: "on-apply",
        content_type: "sound_effect",
        source: document.sound.source,
        config: {},
      },
    ]);
    expect(sceneEffectDefinition(document)).toMatchObject({
      soundAlias: "on-apply",
    });
  });

  it("round-trips editor JSON without browser-local capabilities", () => {
    const document = createDefaultSceneEffectDocument();
    const encoded = JSON.stringify(buildSceneEffectEditorExport(document));

    expect(parseSceneEffectEditorExport(JSON.parse(encoded))).toEqual(document);
    expect(encoded).not.toContain("blob:");
    expect(encoded).not.toContain("download_url");
  });

  it("hydrates an exact portable Focus Lines release", () => {
    const source = createSceneEffectDocumentFromDefinition({
      name: "Light Streak",
      description: "Exact release",
      definition: includedScene("light-streak").definition,
      images: new Map(),
      sound: null,
    });

    const hydrated = createSceneEffectDocumentFromDefinition({
      name: source.name,
      description: source.description,
      definition: sceneEffectDefinition(source),
      images: new Map(),
      sound: null,
    });

    expect(hydrated).toMatchObject({
      kind: "focus_lines",
      name: "Light Streak",
      focus: { renderPlacement: source.focus.renderPlacement },
    });
  });

  it("uses canonical fingerprints and collision-safe names that keep the format", () => {
    const left = createDefaultSceneEffectDocument();
    const right = structuredClone(left);

    expect(sceneEffectDocumentFingerprint(left)).toBe(
      sceneEffectDocumentFingerprint(right),
    );
    // A saved image's name says what its bytes are.
    expect(canonicalSceneEffectImageName("../My Sparkle.JPEG")).toBe(
      "My-Sparkle.jpg",
    );
    expect(canonicalSceneEffectImageName("tile.webp")).toBe("tile.webp");
    expect(
      uniqueSceneEffectImageName("My Sparkle.png", ["My-Sparkle.png"]),
    ).toBe("My-Sparkle-2.png");
  });
});

const includedScene = (presetId: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../../../../../content/included/vfx/scene/${presetId}/${presetId}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    name: string;
    description: string;
    files?: Array<{ path: string; role: string }>;
    definition: Record<string, unknown> & {
      gradient: unknown;
      screen: unknown;
    };
  };

/** Image metadata for every file an Included Scene Effect registers. */
const includedImages = (descriptor: ReturnType<typeof includedScene>) =>
  new Map(
    (descriptor.files ?? []).map(({ path }) => [
      path,
      {
        logicalName: path,
        originalName: path,
        contentType: "image/png",
        sizeBytes: 1024,
        sha256: "0".repeat(64),
      },
    ]),
  );

it("hydrates a registered Included background with its image", () => {
  const descriptor = includedScene("scene-vfx-emotion-sadness");
  const drop = {
    logicalName: "drop.png",
    originalName: "drop.png",
    contentType: "image/png",
    sizeBytes: 1024,
    sha256: "0".repeat(64),
  };
  const document = createSceneEffectDocumentFromDefinition({
    name: descriptor.name,
    description: descriptor.description,
    definition: descriptor.definition,
    images: new Map([[drop.logicalName, drop]]),
    sound: null,
  });
  expect(document).toMatchObject({
    name: "Emotion Sadness",
    durationMs: null,
    dismissOnInput: false,
    background: {
      gradient: descriptor.definition.gradient,
      screen: descriptor.definition.screen,
      scatters: [
        { items: [{ kind: "image", label: "Raindrop", image: drop }] },
      ],
    },
  });
  const resources = [
    {
      logicalName: drop.logicalName,
      file: new File(["x"], drop.logicalName, { type: drop.contentType }),
      sha256: drop.sha256,
    },
  ];
  expect(validateSceneEffectDocument(document, resources)).toEqual([]);
});

describe("optional background layers (C1–C6)", () => {
  const image = (logicalName: string) => ({
    logicalName,
    originalName: logicalName,
    contentType: "image/png",
    sizeBytes: 1024,
    sha256: "0".repeat(64),
  });
  const images = new Map(
    ["petal.png", "bokeh.png"].map((name) => [name, image(name)]),
  );

  it("reopens a saved definition with every layer and saves it unchanged", () => {
    const document = createSceneEffectDocumentFromDefinition({
      name: "Affection",
      description: "",
      definition: structuredClone(allLayers),
      images,
      sound: null,
    });
    expect(document.background.tile.image?.logicalName).toBe("bokeh.png");
    expect(document.background.scatters).toHaveLength(2);
    expect(sceneEffectDefinition(document)).toEqual(allLayers);
    expect(
      sceneEffectImageMetadata(document)
        .map(({ logicalName }) => logicalName)
        .sort(),
    ).toEqual(["bokeh.png", "petal.png"]);
    const resources = [...images.keys()].map((logicalName) => ({
      logicalName,
      file: new File(["x"], logicalName, { type: "image/png" }),
      sha256: "0".repeat(64),
    }));
    expect(
      validateSceneEffectDocument(document, resources).filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);
  });

  it("reports layer limits by field, as the backend would refuse them", () => {
    const document = createSceneEffectDocumentFromDefinition({
      name: "Affection",
      description: "",
      definition: structuredClone(allLayers),
      images,
      sound: null,
    });
    document.background.scatters[0].count = 49;
    document.background.tile = { ...document.background.tile, image: null };
    const fields = validateSceneEffectDocument(document, []).map(
      (issue) => issue.field,
    );
    expect(fields).toContain("scatters.0.count");
    expect(fields).toContain("tile.image");
  });

  it("gives an older draft the optional layers switched off", () => {
    const document = createDefaultSceneEffectDocument();
    const older = structuredClone(document) as unknown as {
      background: Record<string, unknown>;
    };
    for (const key of ["gradient", "tile", "screen", "scatters", "flash"])
      delete older.background[key];
    const normalized = normalizeSceneEffectDocument(
      older as unknown as typeof document,
    );
    expect(normalized.background.gradient.enabled).toBe(false);
    expect(normalized.background.scatters).toEqual([]);
    expect(sceneEffectDefinition(normalized)).not.toHaveProperty("tile");
  });

  it("leaves a current document's JSON unchanged", () => {
    // Restored recovery is compared with the pre-reload export text, so
    // normalizing must not reorder the layers.
    const document = createSceneEffectDocumentFromDefinition({
      name: "Default background",
      description: "",
      definition: sceneEffectDefinition(createDefaultSceneEffectDocument()),
      images: new Map(),
      sound: null,
    });
    expect(JSON.stringify(normalizeSceneEffectDocument(document))).toBe(
      JSON.stringify(document),
    );
  });
});

describe("a Scene saved with Twemoji items", () => {
  // Animama no longer provides Twemoji. The creator opens such a Scene with
  // each emoji item marked missing and refuses Save until it is replaced or
  // removed; there is no conversion.
  const petal = {
    logicalName: "petal.png",
    originalName: "petal.png",
    contentType: "image/png",
    sizeBytes: 1024,
    sha256: "0".repeat(64),
  };
  const emoji = (id: string) => ({
    id,
    kind: "emoji",
    label: "Sparkles",
    emoji: "✨",
    provider: "twemoji",
  });
  const definition = () => {
    const value = sceneEffectDefinition(createDefaultSceneEffectDocument());
    const marquee = value.marquee as { items: unknown[] };
    marquee.items = [
      emoji("old-a"),
      { id: "petal", kind: "image", label: "Petal", image: "petal.png" },
    ];
    value.scatters = [
      { ...structuredClone(allLayers.scatters[1]), items: [emoji("old-b")] },
    ];
    return value;
  };
  const open = () =>
    createSceneEffectDocumentFromDefinition({
      name: "Old sparkles",
      description: "",
      definition: definition(),
      images: new Map([[petal.logicalName, petal]]),
      sound: null,
    });
  const resources = [
    {
      logicalName: petal.logicalName,
      file: new File(["x"], petal.logicalName, { type: "image/png" }),
      sha256: petal.sha256,
    },
  ];

  it("opens with each emoji item marked missing and names it", () => {
    const document = open();
    expect(document.background.marquee.items[0]).toEqual({
      id: "old-a",
      kind: "emoji",
      label: "Sparkles",
      emoji: "✨",
    });
    const missing = validateSceneEffectDocument(document, resources).filter(
      (issue) => issue.message.includes("no longer provides"),
    );
    expect(missing).toEqual([
      expect.objectContaining({ field: "marquee.items.0", severity: "error" }),
      expect.objectContaining({
        field: "scatters.0.items.0",
        severity: "error",
      }),
    ]);
    expect(missing[0].message).toContain("Replace it with a sticker");
  });

  it("previews without the emoji items", () => {
    const entry = sceneEffectRuntimeEntry(
      open(),
      new Map([[petal.logicalName, "blob:petal"]]),
    );
    expect(
      entry.kind === "background_layers" &&
        entry.marquee.items.map((item) => item.id),
    ).toEqual(["petal"]);
  });

  it("saves once the emoji items are removed", () => {
    const document = open();
    document.background.marquee.items =
      document.background.marquee.items.slice(1);
    document.background.scatters = [];
    expect(
      validateSceneEffectDocument(document, resources).filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);
  });

  it("refuses an item of an unknown kind", () => {
    const value = definition();
    (value.marquee as { items: unknown[] }).items = [
      { id: "x", kind: "gif", label: "X" },
    ];
    expect(() =>
      createSceneEffectDocumentFromDefinition({
        name: "Odd",
        description: "",
        definition: value,
        images: new Map(),
        sound: null,
      }),
    ).toThrow();
  });
});
