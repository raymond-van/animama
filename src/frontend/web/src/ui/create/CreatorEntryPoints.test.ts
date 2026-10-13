import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const hubSource = new URL("./CreateHubPage.tsx", import.meta.url);
const sidebarSource = new URL(
  "../sidebar/SidebarCreateMenu.tsx",
  import.meta.url,
);
const pickerSource = new URL(
  "./EffectTemplatePickerDialog.tsx",
  import.meta.url,
);
const effectsRouteSource = new URL(
  "../../routes/_app/effects.new.tsx",
  import.meta.url,
);

describe("Effect creator entry points", () => {
  it("retires sound creation links and explains the inline upload flow", async () => {
    const [hub, sidebar] = await Promise.all([
      readFile(hubSource, "utf8"),
      readFile(sidebarSource, "utf8"),
    ]);
    expect(hub).not.toContain("/sound-effects/new");
    expect(sidebar).not.toContain("/sound-effects/new");
    expect(hub).toContain("Upload sounds");
  });
  it("opens one Effects template picker from the sidebar and the creator hub", async () => {
    const [hub, sidebar, picker] = await Promise.all([
      readFile(hubSource, "utf8"),
      readFile(sidebarSource, "utf8"),
      readFile(pickerSource, "utf8"),
    ]);

    // The sidebar's three effect links became one Effects item.
    expect(sidebar).not.toContain("EFFECT_CREATE_LINKS");
    expect(sidebar).not.toContain("/particle-effects/new");
    expect(sidebar).not.toContain("/avatar-effects/new");
    expect(sidebar).not.toContain("/scene-effects/new");
    expect(sidebar).toContain("<EffectTemplatePickerDialog");
    expect(sidebar).toContain('aria-haspopup="dialog"');
    expect(sidebar).toContain("Effects");

    // Each Create page effect card opens the picker at its kind.
    expect(hub).toContain("<EffectTemplatePickerDialog");
    expect(hub).toContain("EFFECT_TEMPLATE_KINDS.map");
    expect(hub).not.toContain("/avatar-effects/new");

    // The picker reaches each kind's creator route from the registry, with
    // `?template=` for a template (links are checked in the picker's tests).
    expect(picker).toContain("EFFECT_TEMPLATE_KIND_INFO[kind].route");
    expect(picker).toContain("search={{ template: template.id }}");
    expect(picker).toContain("Start from scratch");
    // Every kind shows rendered thumbnails; the Scene CSS swatch is gone.
    expect(picker).toContain("loadEffectTemplateThumbnail(kind, templateId)");
    expect(picker).not.toContain("SceneTemplatePreview");
    expect(picker).not.toContain("no Particle FX templates");
  });

  it("validates ?template= on the Particle and Scene creator routes, keyed by template", async () => {
    const [particle, scene] = await Promise.all(
      ["particle-effects.new.tsx", "scene-effects.new.tsx"].map((file) =>
        readFile(new URL(`../../routes/_app/${file}`, import.meta.url), "utf8"),
      ),
    );

    expect(particle).toContain(
      "validateSearch: parseParticleEffectTemplateSearch",
    );
    expect(particle).toContain('key={`new:${template ?? ""}`}');
    expect(scene).toContain("validateSearch: parseSceneEffectTemplateSearch");
    expect(scene).toContain('key={`new:${template ?? ""}`}');
  });

  it("renders the creator hub with the picker open at /effects/new", async () => {
    const route = await readFile(effectsRouteSource, "utf8");

    expect(route).toContain('createFileRoute("/_app/effects/new")');
    expect(route).toContain("<CreateHubPage effectPickerRoute />");
  });
});

describe("direct Anima creation entry points", () => {
  it.each([
    ["creator hub", "./CreateHubPage.tsx"],
    ["sidebar Create menu", "../sidebar/SidebarCreateMenu.tsx"],
    ["management carousel callback", "../../routes/_app/animas/$animaId.tsx"],
    ["Library Avatar handoff", "../library/LibraryContentInventory.tsx"],
    [
      "Anima-required preview recovery",
      "../content-preview/ContentPreviewHost.tsx",
    ],
    ["empty owned-roster resolver", "../../routes/_app/animas/index.tsx"],
  ])(
    "keeps the %s pointed at the owner-scoped creator",
    async (_label, path) => {
      const source = await readFile(new URL(path, import.meta.url), "utf8");

      expect(source).toContain('"/animas/new"');
      expect(source).not.toContain("useCreateAnima");
      expect(source).not.toContain("createAnimaV1AnimasPost");
    },
  );

  it.each([
    "./CreateAnimaPage.tsx",
    "./CreateAnimaVoiceCloneSection.tsx",
    "../../query/mutations/useCreateAnima.ts",
  ])("removes the obsolete creation-only module %s", async (path) => {
    await expect(access(new URL(path, import.meta.url))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replaces the notice with the new feature without restoring old modules", async () => {
    const source = await readFile(
      new URL("../../routes/_app/animas.new.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("@/ui/create-anima/CreateAnimaPage");
    expect(source).toContain("parseCreateAnimaSearch");
    expect(source).not.toContain("AnimaCreationUnavailablePage");
  });

  it("preserves the local VRM preview owned by the portrait-debug route", async () => {
    const [route, preview] = await Promise.all([
      readFile(
        new URL("../../routes/_app/avatar-portrait-debug.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("./CreateAnimaAvatarPreview.tsx", import.meta.url),
        "utf8",
      ),
    ]);

    expect(route).toContain("<CreateAnimaAvatarPreview");
    expect(preview).toContain("@/ui/create/CreateAnimaAvatarPreviewScene");
    await expect(
      access(new URL("./CreateAnimaAvatarPreviewScene.tsx", import.meta.url)),
    ).resolves.toBeUndefined();
  });
});
