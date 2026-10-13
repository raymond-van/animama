import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  AVATAR_EFFECT_TEMPLATE_GROUPS,
  AVATAR_EFFECT_TEMPLATES,
  EFFECT_TEMPLATE_KIND_INFO,
  EFFECT_TEMPLATE_KINDS,
  PARTICLE_EFFECT_TEMPLATE_GROUPS,
  PARTICLE_EFFECT_TEMPLATES,
  SCENE_EFFECT_TEMPLATE_GROUPS,
  SCENE_EFFECT_TEMPLATES,
  avatarEffectTemplate,
  effectTemplateGroups,
  effectTemplates,
  findParticleEffectTemplate,
  findSceneEffectTemplate,
  parseAvatarEffectTemplateSearch,
  parseParticleEffectTemplateSearch,
  parseSceneEffectTemplateSearch,
  type EffectTemplateKind,
} from "./effectTemplates";
import {
  effectTemplateThumbnailIds,
  loadEffectTemplateThumbnail,
} from "./effectTemplateThumbnails";

const includedVfxRoot = fileURLToPath(
  new URL("../../../../../../content/included/vfx/", import.meta.url),
);
const thumbnailRoot = fileURLToPath(
  new URL("../../assets/effect-templates/", import.meta.url),
);
/** Each kind's thumbnail folder; Avatar files sit at the top level. */
const THUMBNAIL_DIRS: Record<EffectTemplateKind, string> = {
  avatar: thumbnailRoot,
  particle: `${thumbnailRoot}particle/`,
  scene: `${thumbnailRoot}scene/`,
};

type IncludedDescriptor = {
  content_type: string;
  content_id: string;
  name: string;
  definition?: { kind?: string };
};

/** Included descriptors below `vfx/<folder>/`, by folder stem. */
async function includedDescriptors(
  folder: string,
): Promise<Map<string, IncludedDescriptor>> {
  const root = `${includedVfxRoot}${folder}/`;
  const folders = await readdir(root, { withFileTypes: true });
  const entries = await Promise.all(
    folders
      .filter((entry) => entry.isDirectory())
      .map(async ({ name }) => {
        const descriptor = JSON.parse(
          await readFile(`${root}${name}/${name}.json`, "utf8"),
        ) as IncludedDescriptor;
        return [name, descriptor] as const;
      }),
  );
  return new Map(entries);
}

/** Template names per group, in picker order. */
function namesByGroup(kind: EffectTemplateKind): Record<string, string[]> {
  return Object.fromEntries(
    effectTemplateGroups(kind).map((group) => [
      group.label,
      group.templates.map((template) => template.name),
    ]),
  );
}

describe("effect template registry", () => {
  it("offers the three kinds with their creator routes", () => {
    expect(EFFECT_TEMPLATE_KINDS).toEqual(["particle", "avatar", "scene"]);
    expect(
      EFFECT_TEMPLATE_KINDS.map((kind) => EFFECT_TEMPLATE_KIND_INFO[kind]),
    ).toMatchObject([
      { label: "Particle FX", route: "/particle-effects/new" },
      { label: "Avatar FX", route: "/avatar-effects/new" },
      { label: "Scene FX", route: "/scene-effects/new" },
    ]);
  });

  it("names every Included Avatar Effect exactly once, by its content ID and name", async () => {
    const descriptors = await includedDescriptors("avatar");
    const ids = AVATAR_EFFECT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...descriptors.keys()].sort());
    for (const template of AVATAR_EFFECT_TEMPLATES) {
      const descriptor = descriptors.get(template.id);
      expect(descriptor?.content_id).toBe(template.contentId);
      expect(descriptor?.name).toBe(template.name);
    }
  });

  it("names every Included Particle Effect exactly once, by its content ID, name and kind", async () => {
    const descriptors = await includedDescriptors("particle/quark");
    const ids = PARTICLE_EFFECT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...descriptors.keys()].sort());
    for (const template of PARTICLE_EFFECT_TEMPLATES) {
      const descriptor = descriptors.get(template.id);
      expect(descriptor?.content_type, template.id).toBe("particle_effect");
      expect(descriptor?.content_id).toBe(template.contentId);
      expect(descriptor?.name).toBe(template.name);
    }
  });

  it("names every Included Scene Effect exactly once, by its content ID, name and kind", async () => {
    const descriptors = await includedDescriptors("scene");
    const ids = SCENE_EFFECT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...descriptors.keys()].sort());
    for (const template of SCENE_EFFECT_TEMPLATES) {
      const descriptor = descriptors.get(template.id);
      expect(descriptor?.content_type, template.id).toBe("scene_effect");
      expect(descriptor?.content_id).toBe(template.contentId);
      expect(descriptor?.name).toBe(template.name);
      // Focus presets form their own group; every other item is a background.
      expect(descriptor?.definition?.kind, template.id).toBe(
        template.group === "focus-lines" ? "focus_lines" : "background_layers",
      );
    }
  });

  it("groups every template under a known group, with no empty group", () => {
    for (const kind of EFFECT_TEMPLATE_KINDS) {
      const groups = {
        avatar: AVATAR_EFFECT_TEMPLATE_GROUPS,
        particle: PARTICLE_EFFECT_TEMPLATE_GROUPS,
        scene: SCENE_EFFECT_TEMPLATE_GROUPS,
      }[kind].map((group) => group.id);
      const templates = effectTemplates(kind);
      for (const template of templates)
        expect(groups, template.id).toContain(template.group);
      expect(effectTemplateGroups(kind).map((group) => group.id)).toEqual(
        groups,
      );
      expect(
        effectTemplateGroups(kind).flatMap((group) => group.templates),
      ).toHaveLength(templates.length);
    }
  });

  it("groups the Particle templates by mechanic", () => {
    expect(namesByGroup("particle")).toEqual({
      Bursts: ["Heart Burst", "Star Burst"],
      "Streams and auras": [
        "Heart Stream",
        "Fume Puffs",
        "Halo Rays",
        "Rage Aura",
        "Stink Miasma",
      ],
      "Orbits and drifts": [
        "Question Orbit",
        "Gloom Wisps",
        "Sparkle Hearts",
        "Twinkle Shimmer",
      ],
      Fireworks: ["Fireworks Show", "Heart Fireworks", "Golden Willow"],
      Weather: ["Rain Cloud", "Confetti"],
    });
    expect(findParticleEffectTemplate("hearts-v1")?.name).toBe("Heart Stream");
  });

  it("groups the Scene backgrounds by family, then the focus presets", () => {
    const emotions = (...names: string[]) =>
      names.map((name) => `Emotion ${name}`);
    expect(namesByGroup("scene")).toEqual({
      Affection: emotions("Admiration", "Caring", "Love", "Embarrassment"),
      Esteem: emotions("Respect", "Confidence", "Gratitude"),
      Delight: emotions("Amusement", "Excitement", "Joy"),
      Drive: emotions("Desire", "Curiosity", "Optimism"),
      Alarm: emotions("Fear", "Nervousness", "Confusion"),
      Rejection: emotions("Anger", "Annoyance", "Disapproval"),
      Revulsion: emotions("Disgust", "Remorse"),
      Gloom: emotions("Disappointment", "Grief", "Sadness"),
      "Focus lines": ["Focus Lines Dark", "Focus Lines Light Streak"],
    });
  });

  it("accepts only known template IDs of each kind from the route search", () => {
    expect(parseAvatarEffectTemplateSearch({ template: "eye_vv" })).toEqual({
      template: "eye_vv",
    });
    expect(parseAvatarEffectTemplateSearch({ template: "../eye" })).toEqual({});
    expect(parseAvatarEffectTemplateSearch({ template: 3 })).toEqual({});
    expect(parseAvatarEffectTemplateSearch({})).toEqual({});
    expect(
      parseParticleEffectTemplateSearch({ template: "heart-burst" }),
    ).toEqual({ template: "heart-burst" });
    expect(parseParticleEffectTemplateSearch({ template: "eye_vv" })).toEqual(
      {},
    );
    expect(parseParticleEffectTemplateSearch({})).toEqual({});
    expect(parseSceneEffectTemplateSearch({ template: "dark" })).toEqual({
      template: "dark",
    });
    expect(
      parseSceneEffectTemplateSearch({ template: "scene-vfx-emotion-love" }),
    ).toEqual({ template: "scene-vfx-emotion-love" });
    // The retired code-template IDs are no longer templates.
    expect(parseSceneEffectTemplateSearch({ template: "shock" })).toEqual({});
    expect(parseSceneEffectTemplateSearch({ template: "eye_vv" })).toEqual({});
    expect(avatarEffectTemplate("star3")?.contentId).toBe(
      "builtin:avatar-effect:star3",
    );
    expect(avatarEffectTemplate(undefined)).toBeNull();
    expect(findParticleEffectTemplate("star-burst")?.contentId).toBe(
      "builtin:particle-effect:star-burst",
    );
    expect(findSceneEffectTemplate("light-streak")?.contentId).toBe(
      "builtin:scene-effect:focus:light-streak",
    );
    expect(findSceneEffectTemplate(undefined)).toBeNull();
  });
});

describe("effect template thumbnails", () => {
  it.each(EFFECT_TEMPLATE_KINDS)(
    "has a %s thumbnail for every template and a template for every thumbnail",
    async (kind) => {
      const files = (await readdir(THUMBNAIL_DIRS[kind])).filter((name) =>
        name.endsWith(".webp"),
      );
      const ids = effectTemplates(kind)
        .map((template) => template.id)
        .sort();
      expect(files.map((name) => name.replace(/\.webp$/, "")).sort()).toEqual(
        ids,
      );
      expect(effectTemplateThumbnailIds(kind)).toEqual(ids);
    },
  );

  it.each(EFFECT_TEMPLATE_KINDS)(
    "stores %s thumbnails as square WebP images of 320 px",
    async (kind) => {
      for (const { id } of effectTemplates(kind)) {
        const metadata = await sharp(
          `${THUMBNAIL_DIRS[kind]}${id}.webp`,
        ).metadata();
        expect(metadata.format, id).toBe("webp");
        expect(metadata.width, id).toBe(320);
        expect(metadata.height, id).toBe(320);
      }
    },
  );

  it("loads thumbnails lazily per kind and reports a missing one as absent", async () => {
    await expect(
      loadEffectTemplateThumbnail("avatar", "eye_vv"),
    ).resolves.toMatch(/effect-templates\/eye_vv\.webp/);
    await expect(
      loadEffectTemplateThumbnail("particle", "heart-burst"),
    ).resolves.toMatch(/effect-templates\/particle\/heart-burst\.webp/);
    await expect(loadEffectTemplateThumbnail("scene", "dark")).resolves.toMatch(
      /effect-templates\/scene\/dark\.webp/,
    );
    // A template of another kind has no thumbnail in this kind's folder.
    expect(loadEffectTemplateThumbnail("avatar", "heart-burst")).toBeNull();
    expect(loadEffectTemplateThumbnail("particle", "missing")).toBeNull();
  });
});
