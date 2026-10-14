import type { Locator, Page } from "playwright/test";

import { expect, test } from "../fixtures/animama";
import {
  commitSharingPackage,
  downloadSharingPackage,
  reviewSharingExport,
  uploadSharingPackage,
} from "../helpers/content-sharing";
import {
  chooseCreatorMode,
  effectTemplatePicker,
  waitForStoredDraft,
} from "../helpers/creator-surfaces";
import {
  saveTrackedParticleEffect,
  waitForStoredParticleDraft,
} from "../helpers/particle-content";
import { ReadOnlyJourneyGuard } from "../helpers/preview-network";

/**
 * The Effects template picker: every entry point opens it, Back and close
 * behave, templates seed new unsaved drafts with the Included effect's
 * settings and art, and Start from scratch opens each blank creator. The
 * picker journeys save nothing; the last journey saves a template draft as
 * a Local item and reopens it.
 */

const KIND_CARDS = ["Particle FX", "Avatar FX", "Scene FX"] as const;

function kindCard(picker: Locator, label: string): Locator {
  return picker.getByRole("button", { name: new RegExp(`^${label}\\b`) });
}

async function expectKindStep(picker: Locator): Promise<void> {
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("heading", { name: "Create an effect", exact: true }),
  ).toBeVisible();
  for (const label of KIND_CARDS)
    await expect(kindCard(picker, label)).toBeVisible();
  await expect(
    picker.getByRole("button", { name: "Back", exact: true }),
  ).toHaveCount(0);
}

async function closePicker(page: Page): Promise<void> {
  const picker = effectTemplatePicker(page);
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  await expect(picker).toBeHidden();
}

/** Open `/effects/new` and choose a kind. */
async function openKindFromRoute(page: Page, label: string): Promise<Locator> {
  await page.goto("/effects/new");
  const picker = effectTemplatePicker(page);
  await expectKindStep(picker);
  await kindCard(picker, label).click();
  await expect(
    picker.getByRole("heading", { name: `New ${label}`, exact: true }),
  ).toBeVisible();
  return picker;
}

/**
 * Expect the picker's step to show `groups` as headings and `count` template
 * thumbnails, each loaded at full size.
 */
async function expectTemplateThumbnails(
  picker: Locator,
  groups: readonly string[],
  count: number,
): Promise<void> {
  for (const group of groups)
    await expect(
      picker.getByRole("heading", { name: group, exact: true }),
    ).toBeVisible();
  const images = picker.locator("img");
  await expect(images).toHaveCount(count);
  // Thumbnails load lazily, so bring each card into view before checking.
  for (let index = 0; index < count; index += 1)
    await images.nth(index).scrollIntoViewIfNeeded();
  await expect
    .poll(
      () =>
        images.evaluateAll((elements) =>
          elements.every(
            (element) =>
              (element as HTMLImageElement).complete &&
              (element as HTMLImageElement).naturalWidth >= 256,
          ),
        ),
      { message: "every template thumbnail loads", timeout: 20_000 },
    )
    .toBe(true);
}

/** Heart Burst's own textures, as its Included folder carries them. */
const HEART_BURST_TEXTURES = [
  "glossy-heart.png",
  "heart-glow.png",
  "heart-ring.png",
  "glint-star.png",
];

/** Expect the Particle creator to show Heart Burst's layers and textures. */
async function expectHeartBurstArt(page: Page): Promise<void> {
  await chooseCreatorMode(page, "Advanced");
  await expect(
    page
      .getByRole("region", { name: "Emitters", exact: true })
      .getByText("6 emitters", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  const textures = page.getByRole("region", { name: "This effect's textures" });
  for (const texture of HEART_BURST_TEXTURES)
    await expect(
      textures.getByRole("button", {
        name: new RegExp(`^${texture.replace(".", "\\.")} `),
      }),
    ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "is missing" }),
  ).toHaveCount(0);
}

/**
 * Heart Burst's layers as the Emitters list summarises their emission: three
 * single-particle layers (Amount leaves them single) and three it scales.
 */
const HEART_BURST_EMISSION = [
  ["heart-halo", "Point · 0/s · burst 1", "Point · 0/s · burst 1"],
  ["pop-ring", "Point · 0/s · burst 1", "Point · 0/s · burst 1"],
  ["heart-hero", "Point · 0/s · burst 1", "Point · 0/s · burst 1"],
  ["small-hearts", "Sphere · 0/s · burst 7", "Sphere · 0/s · burst 14"],
  ["twinkles", "Sphere · 7/s", "Sphere · 14/s"],
  ["burst-sparkles", "Sphere · 0/s · burst 12", "Sphere · 0/s · burst 24"],
] as const;

/** Expect Heart Burst's emission at Amount 100 % or 200 %, in Advanced. */
async function expectHeartBurstEmission(
  page: Page,
  amount: 100 | 200,
): Promise<void> {
  await chooseCreatorMode(page, "Advanced");
  const emitters = page.getByRole("region", { name: "Emitters", exact: true });
  for (const [name, original, doubled] of HEART_BURST_EMISSION) {
    const emitter = emitters.getByRole("button").filter({ hasText: name });
    await expect(emitter).toHaveCount(1);
    await expect(emitter).toContainText(amount === 100 ? original : doubled);
  }
}

/** Expect the Particle creator in Simple, showing `label` and Amount. */
async function expectParticleSimple(
  page: Page,
  { label, amount }: { label: RegExp; amount: string },
): Promise<void> {
  await expect(
    page
      .getByRole("tablist", { name: "Creator mode", exact: true })
      .getByRole("tab", { name: "Simple", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("region", { name: "Effect", exact: true }),
  ).toContainText(label);
  await expect(
    page.getByRole("slider", { name: "Amount", exact: true }),
  ).toHaveAttribute("aria-valuetext", amount);
}

/** Drag a Simple slider to `percent` in one pointer gesture. */
async function dragSlider(
  page: Page,
  name: string,
  percent: number,
): Promise<void> {
  const thumb = page.getByRole("slider", { name, exact: true });
  const track = thumb.locator("xpath=ancestor::*[@data-slot='slider'][1]");
  const [min, max] = await Promise.all([
    thumb.getAttribute("aria-valuemin").then(Number),
    thumb.getAttribute("aria-valuemax").then(Number),
  ]);
  const from = (await thumb.boundingBox())!;
  const area = (await track.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    area.x + (area.width * (percent - min)) / (max - min),
    area.y + area.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
}

/** The colour theme swatch `name` in Simple's Adjust panel. */
function themeSwatch(page: Page, name: string): Locator {
  return page
    .getByRole("radiogroup", { name: "Colour theme", exact: true })
    .getByRole("radio", { name, exact: true });
}

/** Choose a colour theme in Simple and wait until it is applied. */
async function chooseTheme(page: Page, name: string): Promise<void> {
  await chooseCreatorMode(page, "Simple");
  await themeSwatch(page, name).click();
  await expect(themeSwatch(page, name)).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("radiogroup", { name: "Colour theme", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
}

/** Hue (degrees) of a `#rrggbb` colour, or null when it is grey. */
function hexHue(hex: string): number | null {
  const [r, g, b] = [1, 3, 5].map(
    (offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255,
  ) as [number, number, number];
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma < 0.02) return null;
  const sextant =
    max === r
      ? ((((g - b) / chroma) % 6) + 6) % 6
      : max === g
        ? (b - r) / chroma + 2
        : (r - g) / chroma + 4;
  return sextant * 60;
}

function hueDistance(from: number, to: number): number {
  return Math.abs(((to - from + 540) % 360) - 180);
}

/**
 * Expect Heart Burst's art in `theme` (Advanced): the halo's Color Over Life
 * hues near the theme's, and the hero heart drawing the matching texture.
 */
async function expectHeartBurstTheme(
  page: Page,
  theme: { hue: number; heart: string },
): Promise<void> {
  await chooseCreatorMode(page, "Advanced");
  await page
    .getByRole("region", { name: "Emitters", exact: true })
    .getByRole("button")
    .filter({ hasText: "heart-halo" })
    .click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  const hues = (
    await page
      .locator('input[type="color"]')
      .evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value),
      )
  ).flatMap((hex) => {
    const hue = hexHue(hex);
    return hue === null ? [] : [hue];
  });
  expect(hues.length).toBeGreaterThan(0);
  for (const hue of hues) expect(hueDistance(hue, theme.hue)).toBeLessThan(40);
  await page
    .getByRole("region", { name: "Emitters", exact: true })
    .getByRole("button")
    .filter({ hasText: "heart-hero" })
    .click();
  await expect(
    page
      .getByRole("region", { name: "This effect's textures" })
      .getByRole("button", {
        name: new RegExp(`^${theme.heart.replace(".", "\\.")} `),
      }),
  ).toHaveClass(/border-primary/);
}

/** Heart Burst as authored (pink) and in Sky, with its recoloured copies. */
const HEART_BURST_ORIGINAL = { hue: 327, heart: "glossy-heart.png" };
const HEART_BURST_SKY = { hue: 200, heart: "glossy-heart-sky.png" };

/** A layer card in the Scene Setup panel, by its title. */
function sceneLayerCard(page: Page, title: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${title} `) });
}

/** Whether the preview draws scatter items, each from the draft's own image. */
function scatterDrawsOwnImages(page: Page): Promise<boolean> {
  return page
    .locator('[data-scene-vfx-layer="scatter"] [data-scene-vfx-item-id]')
    .evaluateAll(
      (items) =>
        items.length > 0 &&
        items.every((item) =>
          (item as HTMLElement).style.backgroundImage.includes("blob:"),
        ),
    );
}

/** Leave a dirty creator through its blocker, discarding the draft. */
async function discardToLibrary(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Library", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Discard authoring changes?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Discard and continue", exact: true })
    .click();
  await expect(page).toHaveURL(/\/library(?:[/?#]|$)/);
}

test("accountless effect template picker opens from every entry point", async ({
  page,
  creatorContent,
  animamaEvidence,
}) => {
  const catalogBefore = await creatorContent.snapshotLocalCatalog();
  const guard = new ReadOnlyJourneyGuard(page);
  try {
    await test.step("Sidebar Effects opens the picker in place", async () => {
      await page.goto("/library");
      await page.getByRole("link", { name: "Create", exact: true }).focus();
      await page
        .getByRole("menuitem", { name: "Effects", exact: true })
        .click();
      const picker = effectTemplatePicker(page);
      await expectKindStep(picker);
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();
      await expect(page).toHaveURL(/\/library(?:[/?#]|$)/);
      // The Effects item closed with its menu; focus returns to Create
      // without reopening the menu.
      await expect(
        page.getByRole("link", { name: "Create", exact: true }),
      ).toBeFocused();
      await expect(
        page.getByRole("menuitem", { name: "Effects", exact: true }),
      ).toHaveCount(0);
    });

    await test.step("A Create page card opens its kind; Back and close", async () => {
      await page.getByRole("link", { name: "Create", exact: true }).click();
      await expect(page).toHaveURL(/\/create(?:[/?#]|$)/);
      const avatarCard = page.getByRole("button", {
        name: /^Avatar FX\b.*\bCreate Avatar FX$/,
      });
      await avatarCard.click();
      const picker = effectTemplatePicker(page);
      await expect(
        picker.getByRole("heading", { name: "New Avatar FX", exact: true }),
      ).toBeVisible();
      await expect(
        picker.getByRole("button", { name: "Back", exact: true }),
      ).toBeFocused();
      await picker.getByRole("button", { name: "Back", exact: true }).click();
      await expectKindStep(picker);
      await expect(kindCard(picker, "Avatar FX")).toBeFocused();
      await closePicker(page);
      await expect(page).toHaveURL(/\/create(?:[/?#]|$)/);
      await expect(avatarCard).toBeFocused();

      const sceneCard = page.getByRole("button", {
        name: /^Scene FX\b.*\bCreate Scene FX$/,
      });
      await sceneCard.click();
      await expect(
        picker.getByRole("heading", { name: "New Scene FX", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();
      await expect(sceneCard).toBeFocused();
    });

    await test.step("/effects/new opens the picker; closing returns to Create", async () => {
      await page.goto("/effects/new");
      await expectKindStep(effectTemplatePicker(page));
      await closePicker(page);
      await expect(page).toHaveURL(/\/create(?:[/?#]|$)/);
      await expect(
        page.getByRole("heading", { name: "Create", exact: true }),
      ).toBeVisible();
      // Closing replaced the picker route, so Back does not reopen it.
      await page.goBack();
      await expect(page).not.toHaveURL(/\/effects\/new/);
      await expect(effectTemplatePicker(page)).toBeHidden();
    });
  } finally {
    try {
      await guard.assertNoMutations(animamaEvidence);
      await creatorContent.assertLocalCatalogUnchanged(
        catalogBefore,
        animamaEvidence,
        "effect-template-picker-entry-points",
      );
    } finally {
      await guard.dispose();
    }
  }
});

test("accountless effect templates seed unsaved drafts and Start from scratch opens each creator", async ({
  page,
  creatorContent,
  animamaEvidence,
}) => {
  const catalogBefore = await creatorContent.snapshotLocalCatalog();
  const guard = new ReadOnlyJourneyGuard(page);
  try {
    await test.step("Particle FX templates show loaded thumbnails by mechanic", async () => {
      const picker = await openKindFromRoute(page, "Particle FX");
      await expectTemplateThumbnails(
        picker,
        [
          "Bursts",
          "Streams and auras",
          "Orbits and drifts",
          "Fireworks",
          "Weather",
        ],
        16,
      );
      await expect(
        picker.getByRole("link", { name: "Heart Burst", exact: true }),
      ).toHaveAttribute(
        "href",
        /\/particle-effects\/new\?template=heart-burst$/,
      );
      await animamaEvidence.attachBuffer(
        "particle-templates.png",
        await picker.screenshot(),
        "image/png",
      );
      await closePicker(page);
    });

    await test.step("Scene FX templates show loaded thumbnails by family", async () => {
      const picker = await openKindFromRoute(page, "Scene FX");
      await expectTemplateThumbnails(
        picker,
        [
          "Affection",
          "Esteem",
          "Delight",
          "Drive",
          "Alarm",
          "Rejection",
          "Revulsion",
          "Gloom",
          "Focus lines",
        ],
        26,
      );
      await animamaEvidence.attachBuffer(
        "scene-templates.png",
        await picker.screenshot(),
        "image/png",
      );
      await closePicker(page);
    });

    await test.step("Avatar FX templates show loaded Annie thumbnails", async () => {
      const picker = await openKindFromRoute(page, "Avatar FX");
      await expectTemplateThumbnails(
        picker,
        ["Eyes", "Cheeks", "Whole face", "Around the head", "Mouth", "Body"],
        75,
      );
      await animamaEvidence.attachBuffer(
        "avatar-templates.png",
        await picker.screenshot(),
        "image/png",
      );
    });

    await test.step("An Avatar template opens a seeded, unsaved draft", async () => {
      const picker = effectTemplatePicker(page);
      await picker.getByRole("link", { name: "Eye VV", exact: true }).click();
      await expect(picker).toBeHidden();
      await expect(page).toHaveURL(/\/avatar-effects\/new\?template=eye_vv$/);
      await expect(
        page.locator('[data-testid="avatar-effect-creator-canvas"]:visible'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("textbox", { name: "Avatar FX name", exact: true }),
      ).toHaveValue(/^Eye VV \d+$/);
      await expect(
        page.getByText("eye_vv_r.png", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Unsaved", exact: true }),
      ).toBeVisible();
    });

    await test.step("An edited template draft is offered again before the template", async () => {
      const name = page.getByRole("textbox", {
        name: "Avatar FX name",
        exact: true,
      });
      await name.fill("Edited template draft");
      await waitForStoredDraft(page, {
        database: "animama-avatar-effect-creator-recovery",
        name: "Edited template draft",
        setting: null,
      });
      page.once("dialog", (dialog) => dialog.accept());
      await page.reload();
      const choice = page.getByRole("dialog", {
        name: "Continue your unsaved draft?",
        exact: true,
      });
      await expect(choice).toBeVisible({ timeout: 30_000 });
      await choice
        .getByRole("button", { name: "Continue draft", exact: true })
        .click();
      await expect(name).toHaveValue("Edited template draft");

      page.once("dialog", (dialog) => dialog.accept());
      await page.reload();
      await expect(choice).toBeVisible({ timeout: 30_000 });
      await choice
        .getByRole("button", { name: "Discard and use template", exact: true })
        .click();
      await expect(choice).toBeHidden();
      await expect(name).toHaveValue(/^Eye VV \d+$/);
      await discardToLibrary(page);
    });

    await test.step("A Particle template opens with its layers and textures", async () => {
      const picker = await openKindFromRoute(page, "Particle FX");
      await picker
        .getByRole("link", { name: "Heart Burst", exact: true })
        .click();
      await expect(picker).toBeHidden();
      await expect(page).toHaveURL(
        /\/particle-effects\/new\?template=heart-burst$/,
      );
      await expect(
        page.locator('[data-testid="particle-vfx-creator-canvas"]:visible'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("textbox", { name: "Particle FX name", exact: true }),
      ).toHaveValue(/^Heart Burst(?: \d+)?$/);
      await expectParticleSimple(page, {
        label: /From template\s*Heart Burst/,
        amount: "100 %",
      });
      await expectHeartBurstArt(page);
      await expect(
        page.getByRole("button", { name: "Unsaved", exact: true }),
      ).toBeVisible();
      await animamaEvidence.attachBuffer(
        "particle-template-draft.png",
        await page.screenshot(),
        "image/png",
      );
      await discardToLibrary(page);
    });

    await test.step("A Scene background template opens with its layers and images", async () => {
      const picker = await openKindFromRoute(page, "Scene FX");
      await picker
        .getByRole("link", { name: "Emotion Love", exact: true })
        .click();
      await expect(page).toHaveURL(
        /\/scene-effects\/new\?template=scene-vfx-emotion-love$/,
      );
      await expect(
        page.locator('[data-testid="scene-effect-creator-canvas"]:visible'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("textbox", { name: "Scene FX name", exact: true }),
      ).toHaveValue(/^Emotion Love(?: \d+)?$/);
      await expect(sceneLayerCard(page, "Scatter 1")).toContainText("1 items");
      await expect(sceneLayerCard(page, "Scatter 2")).toContainText("1 items");
      await expect(sceneLayerCard(page, "Tile")).toContainText(
        "bokeh-tile.png",
      );
      await expect
        .poll(() => scatterDrawsOwnImages(page), {
          message: "the scatter stickers draw from the draft's images",
        })
        .toBe(true);
      await expect(
        page.getByRole("button", { name: "Unsaved", exact: true }),
      ).toBeVisible();
      await animamaEvidence.attachBuffer(
        "scene-template-draft.png",
        await page.screenshot({ animations: "allow" }),
        "image/png",
      );
    });

    await test.step("A Starting template replaces the layers and art in one undoable step", async () => {
      const startingTemplate = page.getByRole("combobox", {
        name: "Starting template",
        exact: true,
      });
      await expect(startingTemplate).toHaveText("Emotion Love");
      await startingTemplate.click();
      await page
        .getByRole("option", { name: "Emotion Joy", exact: true })
        .click();
      await expect(startingTemplate).toHaveText("Emotion Joy");
      await expect(sceneLayerCard(page, "Scatter 2")).toContainText("3 items");
      await expect(sceneLayerCard(page, "Tile")).toContainText("No image");
      await expect.poll(() => scatterDrawsOwnImages(page)).toBe(true);
      // The draft keeps its own name.
      await expect(
        page.getByRole("textbox", { name: "Scene FX name", exact: true }),
      ).toHaveValue(/^Emotion Love(?: \d+)?$/);

      await page.getByRole("button", { name: /^Undo ·/ }).click();
      await expect(sceneLayerCard(page, "Scatter 2")).toContainText("1 items");
      await expect(sceneLayerCard(page, "Tile")).toContainText(
        "bokeh-tile.png",
      );
      await expect.poll(() => scatterDrawsOwnImages(page)).toBe(true);
      await discardToLibrary(page);
    });

    await test.step("A Scene focus template opens a seeded, unsaved draft", async () => {
      const picker = await openKindFromRoute(page, "Scene FX");
      await picker
        .getByRole("link", { name: "Focus Lines Dark", exact: true })
        .click();
      await expect(page).toHaveURL(/\/scene-effects\/new\?template=dark$/);
      await expect(
        page.locator('[data-testid="scene-effect-creator-canvas"]:visible'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("textbox", { name: "Scene FX name", exact: true }),
      ).toHaveValue(/^Focus Lines Dark(?: \d+)?$/);
      await expect(
        page.getByRole("tab", { name: "Focus Lines", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("button", { name: "Unsaved", exact: true }),
      ).toBeVisible();
      await discardToLibrary(page);
    });

    for (const [label, path, canvas] of [
      ["Particle FX", "/particle-effects/new", "particle-vfx-creator-canvas"],
      ["Avatar FX", "/avatar-effects/new", "avatar-effect-creator-canvas"],
      ["Scene FX", "/scene-effects/new", "scene-effect-creator-canvas"],
    ] as const) {
      await test.step(`${label} Start from scratch opens the blank creator`, async () => {
        const picker = await openKindFromRoute(page, label);
        await picker
          .getByRole("link", { name: "Start from scratch", exact: true })
          .click();
        await expect(picker).toBeHidden();
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        await expect(
          page.locator(`[data-testid="${canvas}"]:visible`),
        ).toBeVisible({ timeout: 30_000 });
      });
    }
  } finally {
    try {
      await guard.assertNoMutations(animamaEvidence);
      await creatorContent.assertLocalCatalogUnchanged(
        catalogBefore,
        animamaEvidence,
        "effect-template-picker-seeding",
      );
    } finally {
      await guard.dispose();
    }
  }
});

test("accountless Particle template draft adjusts in Simple, recovers, saves as a Local item and reopens with its art", async ({
  page,
  creatorContent,
  animamaEvidence,
}) => {
  test.setTimeout(240_000);
  const runId = process.env.ANIMAMA_E2E_RUN_ID;
  if (!runId)
    throw new Error("The isolated E2E runner environment is required.");
  const name = `particle-template-${runId}`;
  const catalogBefore = await creatorContent.snapshotLocalCatalog();
  const nameField = page.getByRole("textbox", {
    name: "Particle FX name",
    exact: true,
  });

  await test.step("Simple Amount scales the multi-particle layers as one undo step", async () => {
    await page.goto("/particle-effects/new?template=heart-burst");
    await expect(nameField).toHaveValue(/^Heart Burst(?: \d+)?$/, {
      timeout: 30_000,
    });
    await expectParticleSimple(page, {
      label: /From template\s*Heart Burst/,
      amount: "100 %",
    });
    await dragSlider(page, "Amount", 200);
    await expect(
      page.getByRole("slider", { name: "Amount", exact: true }),
    ).toHaveAttribute("aria-valuetext", "200 %");
    await animamaEvidence.attachBuffer(
      "particle-simple-amount-200.png",
      await page.screenshot(),
      "image/png",
    );
    await expectHeartBurstEmission(page, 200);
    // The whole drag is one step.
    await page.getByRole("button", { name: /^Undo ·/ }).click();
    await expectHeartBurstEmission(page, 100);
    await page.getByRole("button", { name: /^Redo ·/ }).click();
    await expectHeartBurstEmission(page, 200);
    await chooseCreatorMode(page, "Simple");
    await expect(
      page.getByRole("slider", { name: "Amount", exact: true }),
    ).toHaveAttribute("aria-valuetext", "200 %");
  });

  await test.step("a renamed template draft is offered again after reload", async () => {
    // Naming keeps the Simple positions.
    await nameField.fill(name);
    await waitForStoredParticleDraft(page, name, "textures/glossy-heart.png");
    page.once("dialog", (dialog) => dialog.accept());
    await page.reload();
    const choice = page.getByRole("dialog", {
      name: "Continue your unsaved draft?",
      exact: true,
    });
    await expect(choice).toBeVisible({ timeout: 30_000 });
    await choice
      .getByRole("button", { name: "Continue draft", exact: true })
      .click();
    await expect(nameField).toHaveValue(name);
    // Recovery keeps Simple's positions with the scaled effect.
    await expectParticleSimple(page, {
      label: /From template\s*Heart Burst/,
      amount: "200 %",
    });
    await expectHeartBurstArt(page);
    await expectHeartBurstEmission(page, 200);
  });

  // Save sends no catalog item ID, so the Included item is never updated.
  const saved = await test.step("save as a new Local item", () =>
    saveTrackedParticleEffect({ page, content: creatorContent, name }));
  expect(saved.texturePaths.sort()).toEqual(
    HEART_BURST_TEXTURES.map((texture) => `textures/${texture}`).sort(),
  );

  await test.step("reopen the saved item with its art and Simple at 100 %", async () => {
    await page.goto(`/particle-effects/${saved.itemId}/edit`);
    await expect(nameField).toHaveValue(name, { timeout: 30_000 });
    await expectParticleSimple(page, {
      label: new RegExp(`Effect\\s*${name}`),
      amount: "100 %",
    });
    await expectHeartBurstArt(page);
    await expectHeartBurstEmission(page, 200);
    await expect(
      page.getByRole("button", { name: "Saved", exact: true }),
    ).toBeVisible();
    await animamaEvidence.attachBuffer(
      "particle-template-reopened.png",
      await page.screenshot(),
      "image/png",
    );
  });

  await creatorContent.cleanupOwnedContent();
  await creatorContent.assertLocalCatalogUnchanged(
    catalogBefore,
    animamaEvidence,
    "particle-template-save",
  );
});

test("accountless Particle colour theme recolours a template's art, recovers, saves and packages its own textures", async ({
  page,
  creatorContent,
  animamaEvidence,
}, testInfo) => {
  test.setTimeout(300_000);
  const runId = process.env.ANIMAMA_E2E_RUN_ID;
  if (!runId)
    throw new Error("The isolated E2E runner environment is required.");
  const name = `particle-theme-${runId}`;
  const catalogBefore = await creatorContent.snapshotLocalCatalog();
  const nameField = page.getByRole("textbox", {
    name: "Particle FX name",
    exact: true,
  });

  await test.step("Sky recolours the art and the colours as one undo step", async () => {
    await page.goto("/particle-effects/new?template=heart-burst");
    await expect(nameField).toHaveValue(/^Heart Burst(?: \d+)?$/, {
      timeout: 30_000,
    });
    await expect(themeSwatch(page, "Original")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await chooseTheme(page, "Sky");
    await animamaEvidence.attachBuffer(
      "particle-theme-sky.png",
      await page.screenshot(),
      "image/png",
    );
    await expectHeartBurstTheme(page, HEART_BURST_SKY);

    await page.getByRole("button", { name: /^Undo ·/ }).click();
    await expectHeartBurstTheme(page, HEART_BURST_ORIGINAL);
    await chooseCreatorMode(page, "Simple");
    await expect(themeSwatch(page, "Original")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("button", { name: /^Redo ·/ }).click();
    await expect(themeSwatch(page, "Sky")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expectHeartBurstTheme(page, HEART_BURST_SKY);
  });

  await test.step("recovery keeps the theme with the original textures, so Original still works", async () => {
    await nameField.fill(name);
    await waitForStoredParticleDraft(
      page,
      name,
      "textures/glossy-heart-sky.png",
    );
    await waitForStoredParticleDraft(page, name, "textures/glossy-heart.png");
    page.once("dialog", (dialog) => dialog.accept());
    await page.reload();
    const choice = page.getByRole("dialog", {
      name: "Continue your unsaved draft?",
      exact: true,
    });
    await expect(choice).toBeVisible({ timeout: 30_000 });
    await choice
      .getByRole("button", { name: "Continue draft", exact: true })
      .click();
    await expect(nameField).toHaveValue(name);
    await expect(themeSwatch(page, "Sky")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await chooseTheme(page, "Original");
    await expectHeartBurstTheme(page, HEART_BURST_ORIGINAL);
    await chooseTheme(page, "Sky");
    await expectHeartBurstTheme(page, HEART_BURST_SKY);
  });

  const saved =
    await test.step("save the themed effect as a new Local item", () =>
      saveTrackedParticleEffect({ page, content: creatorContent, name }));
  expect(saved.texturePaths.sort()).toEqual(
    HEART_BURST_TEXTURES.map(
      (texture) => `textures/${texture.replace(".png", "-sky.png")}`,
    ).sort(),
  );

  await test.step("reopen it at Original, with its recoloured textures as its own", async () => {
    await page.goto(`/particle-effects/${saved.itemId}/edit`);
    await expect(nameField).toHaveValue(name, { timeout: 30_000 });
    await expect(themeSwatch(page, "Original")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expectHeartBurstTheme(page, HEART_BURST_SKY);
    await expect(
      page.getByRole("button", { name: "Saved", exact: true }),
    ).toBeVisible();
    await animamaEvidence.attachBuffer(
      "particle-theme-reopened.png",
      await page.screenshot(),
      "image/png",
    );
  });

  await test.step("a Portable package round trip keeps the recoloured textures", async () => {
    await page.goto("/library");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Search content", exact: true })
      .fill(name);
    await page.getByRole("checkbox", { name, exact: true }).check();
    await reviewSharingExport(page);
    const archive = await downloadSharingPackage(
      page,
      testInfo,
      page.getByRole("button", { name: "Download package", exact: true }),
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const review = await uploadSharingPackage(page, archive);
    expect(review.items.map((item) => item.name)).toEqual([`${name}-2`]);
    const [imported] = await commitSharingPackage({
      page,
      content: creatorContent,
      review,
      journeyKey: `particle-theme-import-${runId}`,
    });
    await page.goto(`/particle-effects/${imported!.itemId}/edit`);
    await expect(nameField).toHaveValue(`${name}-2`, { timeout: 30_000 });
    await expectHeartBurstTheme(page, HEART_BURST_SKY);
  });

  await creatorContent.cleanupOwnedContent();
  await creatorContent.assertLocalCatalogUnchanged(
    catalogBefore,
    animamaEvidence,
    "particle-theme",
  );
});
