import type { Page } from "playwright/test";

import { expect, test } from "../fixtures/animama";
import type { EvidenceAttachment } from "../fixtures/animama";
import { waitForCreatorStageReady } from "../helpers/creator-surfaces";
import {
  formatFindings,
  pseudoLocalize,
  PseudoLocaleAudit,
} from "../helpers/pseudo-locale";

/**
 * Pseudo-locale smoke (spec R17, AC3): every visible interface string on the
 * main surfaces must come from a catalog, which the pseudo-locale marks
 * `⟦…⟧`. Loaded data (content, Animas, chats, model and voice names) and a few
 * fixed words are excluded; see `helpers/pseudo-locale.ts`. Runs only through
 * `pnpm e2e:test:pseudo` on a development stack; ordinary journeys stay English.
 */

/** App Settings → About shows the build version, `VITE_APP_VERSION` in development Compose. */
const DEVELOPMENT_APP_VERSION = "local";

async function expectNoUntranslatedText(
  audit: PseudoLocaleAudit,
  evidence: EvidenceAttachment,
  name: string,
): Promise<void> {
  const review = await audit.review();
  await evidence.attachJson(name, review);
  expect(
    review.untranslated.length,
    `Visible text without pseudo markers:\n${formatFindings(review.untranslated)}`,
  ).toBe(0);
}

/**
 * Render first-run setup over the completed fixture installation: the runtime
 * context reports setup as pending, and every /v1 write is refused, so the
 * steps can be read without completing setup again.
 */
async function renderSetupReadOnly(page: Page): Promise<string[]> {
  const refusedWrites: string[] = [];
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      refusedWrites.push(`${request.method()} ${path}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (path !== "/v1/runtime-context") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const context = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: { ...context, first_run_complete: false },
    });
  });
  return refusedWrites;
}

test("pseudo-locale first-run setup @pseudo-locale @read-only", async ({
  page,
  animamaEvidence,
}) => {
  const audit = new PseudoLocaleAudit(page, animamaEvidence);
  const refusedWrites = await renderSetupReadOnly(page);
  const heading = page.getByRole("heading", { level: 1 });

  await test.step("Welcome", async () => {
    await audit.open("/setup");
    await expect(heading).toHaveText(
      pseudoLocalize("What should Animama call you?"),
    );
    await audit.check("Setup › Welcome");
  });

  await test.step("AI", async () => {
    await page.locator("#local-display-name").fill("Pseudo Fixture");
    await page.locator('form button[type="submit"]').click();
    await expect(heading).toHaveText(pseudoLocalize("Choose your AI"));
    await audit.check("Setup › AI");
  });

  await test.step("Voice", async () => {
    await page
      .getByRole("button", { name: pseudoLocalize("Continue"), exact: true })
      .click();
    // A stack without a provider key has no model that can reply, so
    // Continue asks first; with a key it goes straight to Voice.
    const noModel = page.getByRole("dialog", {
      name: pseudoLocalize("Continue without a chat model?"),
    });
    const voice = page.getByRole("heading", {
      level: 1,
      name: pseudoLocalize("Set up voice"),
    });
    await expect(noModel.or(voice)).toBeVisible();
    if (await noModel.isVisible()) {
      await audit.check("Setup › AI › No chat model");
      await page
        .getByRole("button", {
          name: pseudoLocalize("Continue without a model"),
          exact: true,
        })
        .click();
    }
    await expect(heading).toHaveText(pseudoLocalize("Set up voice"));
    await audit.check("Setup › Voice");
  });

  expect(refusedWrites, "Setup rendering attempted a write").toEqual([]);
  await expectNoUntranslatedText(audit, animamaEvidence, "pseudo-locale-setup");
});

test("pseudo-locale chat, App Settings, Library and creators @pseudo-locale", async ({
  page,
  animamaEvidence,
}) => {
  const audit = new PseudoLocaleAudit(page, animamaEvidence);

  await test.step("Chat", async () => {
    await audit.open("/");
    // The root opens the last visited Anima's chat, or Annie's.
    await page.waitForURL((url) => /^\/[^/]+$/.test(url.pathname));
    // The composer's placeholder changes from loading to ready with the runtime.
    await expect(
      page.getByPlaceholder(pseudoLocalize("What's on your mind?")),
    ).toBeEnabled({ timeout: 30_000 });
    await audit.check("Chat");
  });

  await test.step("App Settings", async () => {
    await page
      .locator('button[aria-haspopup="menu"]')
      .filter({ has: page.locator('[data-slot="avatar-fallback"]') })
      .click();
    await page
      .getByRole("menuitem", { name: pseudoLocalize("App Settings") })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const sections = dialog.locator("nav button");
    const count = await sections.count();
    expect(count, "App Settings shows no sections").toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const section = sections.nth(index);
      await section.click();
      await expect(section).toHaveAttribute("aria-current", "page");
      await audit.check(
        `App Settings › ${(await section.innerText()).trim()}`,
        { root: dialog, data: [DEVELOPMENT_APP_VERSION] },
      );
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  await test.step("Library", async () => {
    await audit.open("/library");
    await expect(page.getByRole("article").first()).toBeVisible({
      timeout: 30_000,
    });
    await audit.check("Library");
  });

  for (const [surface, path, expectedKind] of [
    ["Gesture creator", "/gestures/new", "anima_pose_clip"],
    ["Particle Effect creator", "/particle-effects/new", "particle_vfx"],
  ] as const) {
    await test.step(surface, async () => {
      await audit.open(path);
      const stage = page.locator('[data-playback-surface="creator-stage"]');
      await expect(
        stage.locator("output[data-playback-observation]"),
      ).toHaveCount(1, { timeout: 30_000 });
      await waitForCreatorStageReady({ expectedKind, surface: stage });
      await audit.check(surface);
    });
  }

  await expectNoUntranslatedText(
    audit,
    animamaEvidence,
    "pseudo-locale-surfaces",
  );
});
