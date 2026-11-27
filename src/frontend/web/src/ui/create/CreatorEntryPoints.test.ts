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
const createCatalogSource = new URL(
  "../../locales/en/create.json",
  import.meta.url,
);

describe("Effect creator entry points", () => {
  it("retires sound creation links and explains the inline upload flow", async () => {
    const [hub, sidebar, catalog] = await Promise.all([
      readFile(hubSource, "utf8"),
      readFile(sidebarSource, "utf8"),
      readFile(createCatalogSource, "utf8"),
    ]);
    expect(hub).not.toContain("/sound-effects/new");
    expect(sidebar).not.toContain("/sound-effects/new");
    expect(hub).toContain('t("hub.effects.description")');
    expect(
      (JSON.parse(catalog) as { hub: { effects: { description: string } } }).hub
        .effects.description,
    ).toContain("Upload sounds");
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

    // The picker reaches every creator route, with templates where they exist.
    expect(picker).toContain('to="/avatar-effects/new"');
    expect(picker).toContain('to="/scene-effects/new"');
    expect(picker).toContain("search={{ template: template.id }}");
    expect(picker).toContain("search={{ template: id }}");
    expect(picker).toContain('t("picker.startFromScratch")');
  });

  it("renders the creator hub with the picker open at /effects/new", async () => {
    const route = await readFile(effectsRouteSource, "utf8");

    expect(route).toContain('createFileRoute("/_app/effects/new")');
    expect(route).toContain("<CreateHubPage effectPickerRoute />");
  });
});

describe("Generate entry points", () => {
  it("reaches the Generate page from the creator hub and the sidebar's Create menu", async () => {
    const [hub, sidebar, route] = await Promise.all([
      readFile(hubSource, "utf8"),
      readFile(sidebarSource, "utf8"),
      readFile(
        new URL("../../routes/_app/generate.tsx", import.meta.url),
        "utf8",
      ),
    ]);

    expect(hub).toContain('<Link to="/generate">');
    expect(hub).toContain('t("hub.actions.generate.title")');
    expect(sidebar).toContain('to: "/generate" as const');
    expect(sidebar).toContain('t("create.generate")');
    expect(route).toContain('createFileRoute("/_app/generate")');
    expect(route).toContain("component: GeneratePage");
  });

  it("offers both only while the runtime reports the content assistant", async () => {
    const [hub, sidebar] = await Promise.all([
      readFile(hubSource, "utf8"),
      readFile(sidebarSource, "utf8"),
    ]);

    expect(hub).toContain(
      '<RuntimeFeatureGate capability="content_generation">',
    );
    expect(sidebar).toContain('useRuntimeFeatureEnabled("content_generation")');
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
