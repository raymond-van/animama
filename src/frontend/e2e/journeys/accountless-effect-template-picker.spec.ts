import type { Locator, Page } from "playwright/test";

import { expect, test } from "../fixtures/animama";
import {
  effectTemplatePicker,
  waitForStoredDraft,
} from "../helpers/creator-surfaces";
import { ReadOnlyJourneyGuard } from "../helpers/preview-network";

/**
 * The Effects template picker: every entry point opens it, Back and close
 * behave, templates seed new unsaved drafts and Start from scratch opens each
 * blank creator. Nothing is saved, so the journey makes no content mutations.
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
    await test.step("Avatar FX templates show loaded Annie thumbnails", async () => {
      const picker = await openKindFromRoute(page, "Avatar FX");
      for (const group of [
        "Eyes",
        "Cheeks",
        "Whole face",
        "Around the head",
        "Mouth",
        "Body",
      ])
        await expect(
          picker.getByRole("heading", { name: group, exact: true }),
        ).toBeVisible();
      const images = picker.locator("img");
      await expect(images).toHaveCount(100);
      // Thumbnails load lazily, so bring each card into view before checking.
      for (let index = 0; index < (await images.count()); index += 1)
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

    await test.step("A Scene template opens a seeded, unsaved draft", async () => {
      const picker = await openKindFromRoute(page, "Scene FX");
      await picker
        .getByRole("link", { name: "Dark Focus", exact: true })
        .click();
      await expect(page).toHaveURL(/\/scene-effects\/new\?template=dark$/);
      await expect(
        page.locator('[data-testid="scene-effect-creator-canvas"]:visible'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("textbox", { name: "Scene FX name", exact: true }),
      ).toHaveValue(/^Dark Focus(?: \d+)?$/);
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
        if (label === "Particle FX")
          await expect(
            picker.getByText("There are no Particle FX templates yet.", {
              exact: false,
            }),
          ).toBeVisible();
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
