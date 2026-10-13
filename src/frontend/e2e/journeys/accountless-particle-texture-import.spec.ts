import { writeFile } from "node:fs/promises";
import type { Page } from "playwright/test";
import sharp from "sharp";

import { expect, test } from "../fixtures/animama";
import {
  captureSharingState,
  commitSharingPackage,
  downloadSharingPackage,
  reviewSharingExport,
  uploadSharingPackage,
} from "../helpers/content-sharing";
import {
  saveTrackedParticleEffect,
  waitForStoredParticleDraft,
} from "../helpers/particle-content";

/**
 * Particle texture import (R1): refused files leave the draft unchanged; an
 * imported PNG and a sprite sheet survive draft recovery, Save and reopen,
 * and a Portable package round trip; a texture that imported JSON refers to
 * can be supplied afterwards.
 */

/** A coloured disc on transparency, `size` pixels square. */
function disc(size: number, colour: string): Promise<Buffer> {
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.4}" fill="${colour}"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
}

async function writeTextures(dir: (name: string) => string) {
  const cells = await Promise.all(
    Array.from({ length: 16 }, async (_, index) => ({
      input: await disc(64, `hsl(${index * 22}, 90%, 55%)`),
      left: (index % 4) * 64,
      top: Math.floor(index / 4) * 64,
    })),
  );
  const files = {
    glyph: dir("glyph.png"),
    sheet: dir("sheet-4x4.png"),
    wide: dir("too-wide.png"),
    jpeg: dir("not-png.jpg"),
  };
  await writeFile(files.glyph, await disc(128, "#ff3d7f"));
  await writeFile(
    files.sheet,
    await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(cells)
      .png()
      .toBuffer(),
  );
  await writeFile(
    files.wide,
    await sharp({
      create: {
        width: 2100,
        height: 16,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer(),
  );
  await writeFile(
    files.jpeg,
    await sharp(await disc(64, "#00ff00"))
      .jpeg()
      .toBuffer(),
  );
  return files;
}

function textureCard(page: Page, fileName: string) {
  return page
    .getByRole("region", { name: "This effect's textures" })
    .getByRole("button", { name: new RegExp(fileName.replace(".", "\\.")) });
}

async function openAppearance(page: Page) {
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "This effect's textures" }),
  ).toBeVisible();
}

test("accountless Particle texture import survives recovery, Save, reopen and packages", async ({
  page,
  creatorContent,
  animamaEvidence,
}, testInfo) => {
  test.setTimeout(240_000);
  const runId = process.env.ANIMAMA_E2E_RUN_ID;
  if (!runId)
    throw new Error("The isolated E2E runner environment is required.");
  const name = `particle-textures-${runId}`;
  const files = await writeTextures((file) => testInfo.outputPath(file));
  const catalogBefore = await creatorContent.snapshotLocalCatalog();

  await test.step("refused files leave the draft unchanged", async () => {
    await page.goto("/particle-effects/new");
    await openAppearance(page);
    const importInput = page.getByLabel("Import PNG texture", { exact: true });
    await importInput.setInputFiles(files.wide);
    await expect(
      page.getByRole("alert").filter({ hasText: "2048 px" }),
    ).toBeVisible();
    await importInput.setInputFiles(files.jpeg);
    await expect(
      page.getByRole("alert").filter({ hasText: "must be PNG" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "This effect's textures" })
        .getByRole("button", { name: /\.png/ }),
    ).toHaveCount(0);
  });

  await test.step("import a PNG and a sprite sheet into two emitters", async () => {
    await page
      .getByLabel("Import PNG texture", { exact: true })
      .setInputFiles(files.glyph);
    await expect(textureCard(page, "glyph-1.png")).toBeVisible();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page
      .getByLabel("Import PNG texture", { exact: true })
      .setInputFiles(files.sheet);
    await expect(textureCard(page, "sheet-4x4-1.png")).toBeVisible();
    for (const axis of ["U tiles", "V tiles"]) {
      await page.getByLabel(axis, { exact: true }).fill("4");
      await page.getByLabel(axis, { exact: true }).press("Tab");
    }
    await page.getByLabel("Animate frames", { exact: true }).check();
    await page
      .getByRole("textbox", { name: "Particle FX name", exact: true })
      .fill(name);
    await animamaEvidence.attachBuffer(
      "particle-textures-imported",
      await page.screenshot(),
      "image/png",
    );
  });

  await test.step("draft recovery keeps the imported textures", async () => {
    await waitForStoredParticleDraft(page, name, "textures/sheet-4x4-1.png");
    await page.reload();
    await openAppearance(page);
    await expect(textureCard(page, "glyph-1.png")).toBeVisible();
    await expect(textureCard(page, "sheet-4x4-1.png")).toBeVisible();
  });

  const saved = await test.step("save as Local content", () =>
    saveTrackedParticleEffect({ page, content: creatorContent, name }));
  expect(saved.texturePaths.sort()).toEqual([
    "textures/glyph-1.png",
    "textures/sheet-4x4-1.png",
  ]);

  await test.step("reopen restores the textures from the saved item", async () => {
    await page.goto(`/particle-effects/${saved.itemId}/edit`);
    await openAppearance(page);
    await expect(textureCard(page, "glyph-1.png")).toBeVisible();
    await expect(textureCard(page, "sheet-4x4-1.png")).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "is missing" }),
    ).toHaveCount(0);
    for (const [label, width] of [
      ["reopened-desktop", 1440],
      ["reopened-narrow", 900],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await animamaEvidence.attachBuffer(
        `particle-textures-${label}`,
        await page.screenshot(),
        "image/png",
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await test.step("a Portable package round trip keeps the textures", async () => {
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
    await captureSharingState(
      page,
      animamaEvidence,
      "particle-textures-import-review",
    );
    const [imported] = await commitSharingPackage({
      page,
      content: creatorContent,
      review,
      journeyKey: `particle-textures-import-${runId}`,
    });
    await page.goto(`/particle-effects/${imported!.itemId}/edit`);
    await openAppearance(page);
    await expect(textureCard(page, "glyph-1.png")).toBeVisible();
    await expect(textureCard(page, "sheet-4x4-1.png")).toBeVisible();
  });

  await test.step("a texture that imported JSON refers to can be supplied", async () => {
    await page.goto("/particle-effects/new");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const json = page.getByRole("textbox", { name: "Particle VFX JSON" });
    const text = await json.inputValue();
    await json.fill(
      text.replaceAll("textures/soft-dot.png", "textures/custom-heart.png"),
    );
    await page
      .getByRole("button", { name: "Import effect", exact: true })
      .click();
    await openAppearance(page);
    const missing = page
      .getByRole("alert")
      .filter({ hasText: "custom-heart.png is missing" });
    await expect(missing).toBeVisible();
    await page
      .getByLabel("Choose file for custom-heart.png", { exact: true })
      .setInputFiles(files.glyph);
    await expect(missing).toHaveCount(0);
    await expect(textureCard(page, "custom-heart.png")).toBeVisible();
  });

  await creatorContent.cleanupOwnedContent();
  await creatorContent.assertLocalCatalogUnchanged(
    catalogBefore,
    animamaEvidence,
    "particle-textures",
  );
});
