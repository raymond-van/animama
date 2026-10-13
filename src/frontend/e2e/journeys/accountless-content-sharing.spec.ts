import { randomUUID } from "node:crypto";
import type { Page, Request } from "playwright/test";
import { expect, test, type CreatorContentFixture } from "../fixtures/animama";
import { saveTrackedPose } from "../helpers/pose-content";
import {
  captureSharingState,
  commitSharingPackage,
  downloadSharingPackage,
  reviewSharingExport,
  uploadSharingPackage,
} from "../helpers/content-sharing";

const includedPose = "Shy Finger Poke 1";

/** Create only generated fixture names through the existing tracked Save surface. */
async function createPose(
  page: Page,
  content: CreatorContentFixture,
  name: string,
) {
  await page.goto("/library?section=actions&action=poses");
  await page.getByPlaceholder("Search the Library").fill(includedPose);
  await page
    .getByRole("article", { name: includedPose, exact: true })
    .getByRole("link", { name: "Edit", exact: true })
    .click();
  const input = page.getByRole("textbox", { name: "Pose name", exact: true });
  // Included copies use the next numbered branch name before we assign our
  // unique fixture name. Save tracking below still forbids an existing ID.
  await expect(input).toHaveValue(/^Shy Finger Poke \d+$/, {
    timeout: 30_000,
  });
  await input.fill(name);
  return saveTrackedPose({ page, content, name });
}

async function openSharing(page: Page, action: "Import" | "Export") {
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await page.goto("/library");
  const trigger = page.getByRole("button", {
    name: action,
    exact: true,
  });
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return trigger;
}

/** Wait for the real completion acknowledgment before intentionally reloading. */
async function viewImportedLibrary(page: Page, stageId: string) {
  const discarded = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname ===
        `/v1/content/package-imports/${stageId}`,
  );
  await page
    .getByRole("link", { name: "View in Library", exact: true })
    .click();
  expect((await discarded).status()).toBe(204);
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

test("local content sharing single and multiple content export, suffix import and persistence", async ({
  page,
  creatorContent,
  animamaEvidence,
}, testInfo) => {
  test.setTimeout(240_000);
  const before = await creatorContent.snapshotLocalCatalog();
  const token = randomUUID().slice(0, 8);
  const names = [`sharing-${token}-one`, `sharing-${token}-two`];
  const sources = [];
  for (const name of names)
    sources.push(await createPose(page, creatorContent, name));
  const trigger = await openSharing(page, "Import");
  await page.keyboard.press("Tab");
  expect(
    await page
      .getByRole("dialog")
      .evaluate((dialog) => dialog.contains(document.activeElement)),
  ).toBe(true);
  await captureSharingState(page, animamaEvidence, "sharing-01-import-entry");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Choose file", exact: true }),
  ).toBeVisible();
  await openSharing(page, "Export");
  const reviewButton = page.getByRole("button", {
    name: "Review export",
    exact: true,
  });
  await expect(reviewButton).toBeDisabled();
  const search = page.getByRole("textbox", {
    name: "Search content",
    exact: true,
  });
  await search.fill(names[0]!);
  await page.getByRole("checkbox", { name: names[0], exact: true }).check();
  await expect(reviewButton).toBeEnabled();
  // A separate, undownloaded cache can expire or be reclaimed while its review
  // is open. Back must preserve selection even when cleanup confirms absence.
  const expiredReview = await reviewSharingExport(page);
  const removed = await page.request.delete(
    `/v1/content/package-exports/${expiredReview.export_id}`,
    {
      headers: {
        Origin: new URL(page.url()).origin,
        "Sec-Fetch-Site": "same-origin",
        "X-Animama-CSRF": "1",
      },
    },
  );
  expect(removed.status()).toBe(204);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Back", exact: true })
    .first()
    .click();
  await expect(reviewButton).toBeEnabled();
  await search.fill(names[0]!);
  await expect(
    page.getByRole("checkbox", { name: names[0], exact: true }),
  ).toBeChecked();
  await animamaEvidence.attachJson("sharing-missing-cache-back", {
    expiredExportId: expiredReview.export_id,
    selectedItemId: sources[0]!.itemId,
    exactUndownloadedCacheRemoved: true,
    selectionPreserved: true,
    reviewEnabled: true,
  });
  const single = await reviewSharingExport(page);
  expect(single.manifest.kind).toBe("content");
  expect(single.selected_count).toBe(1);
  const singleArchive = await downloadSharingPackage(
    page,
    testInfo,
    page.getByRole("button", { name: "Download package", exact: true }),
  );

  await openSharing(page, "Import");
  const singleImport = await uploadSharingPackage(page, singleArchive);
  expect(singleImport.items).toHaveLength(1);
  expect(singleImport.items[0]!.name).toBe(`${names[0]}-2`);
  await captureSharingState(page, animamaEvidence, "sharing-02-import-review");
  const commits: string[] = [];
  let newStages = 0;
  const recordRecovery = (request: Request) => {
    if (request.method() !== "POST") return;
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/content/package-imports") newStages += 1;
    if (/\/package-imports\/[^/]+\/commit$/.test(pathname))
      commits.push(String(request.postDataJSON().operation_id));
  };
  page.on("request", recordRecovery);
  const singleOwned = await commitSharingPackage({
    page,
    content: creatorContent,
    review: singleImport,
    journeyKey: `sharing-single-${token}`,
    loseCommitReply: true,
  });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  const recoveredResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/v1/content/package-operations/${singleImport.operation_id}` &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const recovered = await (await recoveredResponse).json();
  await expect(
    page.getByRole("heading", { name: "Import complete", exact: true }),
  ).toBeVisible();
  expect(recovered.result.items[0].item_id).toBe(singleOwned[0]!.itemId);
  expect(recovered.operation_id).toBe(singleImport.operation_id);
  expect(commits).toEqual([singleImport.operation_id]);
  expect(newStages).toBe(0);
  page.off("request", recordRecovery);
  await animamaEvidence.attachJson("sharing-lost-commit-response", {
    operationId: singleImport.operation_id,
    originalItemId: singleOwned[0]!.itemId,
    commitRequests: commits.length,
    additionalStageAllocations: newStages,
    serverCompletedBeforeReplyWasAborted: true,
    recoveredAfterReload: true,
  });
  expect(singleOwned[0]!.itemId).not.toBe(sources[0]!.itemId);
  await viewImportedLibrary(page, singleImport.stage_id);
  await page.reload();
  await page.getByPlaceholder("Search the Library").fill(`${names[0]}-2`);
  await expect(
    page.getByRole("article", { name: `${names[0]}-2`, exact: true }),
  ).toBeVisible();

  await openSharing(page, "Export");
  await search.fill(names[0]!);
  const first = page.getByRole("checkbox", { name: names[0], exact: true });
  if (!(await first.isChecked())) await first.check();
  await search.fill(names[1]!);
  await page.getByRole("checkbox", { name: names[1], exact: true }).check();
  await page.getByRole("button", { name: "FX", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Your package", exact: true }),
  ).toContainText("2 selected items");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await search.fill(names[0]!);
  await expect(first).toBeChecked();
  await search.fill(`sharing-${token}`);
  await first.focus();
  await expect(first).toBeFocused();
  await captureSharingState(
    page,
    animamaEvidence,
    "sharing-03-export-selection",
  );
  await expect(reviewButton).toBeEnabled();
  const multiple = await reviewSharingExport(page);
  expect(multiple.selected_count).toBe(2);
  expect(multiple.manifest.root_entry_ids).toHaveLength(2);
  const multipleArchive = await downloadSharingPackage(
    page,
    testInfo,
    page.getByRole("button", { name: "Download package", exact: true }),
  );
  await openSharing(page, "Import");
  const multipleImport = await uploadSharingPackage(page, multipleArchive);
  expect(multipleImport.items.map((item) => item.name).sort()).toEqual(
    [`${names[0]}-3`, `${names[1]}-2`].sort(),
  );
  const imported = await commitSharingPackage({
    page,
    content: creatorContent,
    review: multipleImport,
    journeyKey: `sharing-multiple-${token}`,
  });
  expect(new Set(imported.map((item) => item.itemId)).size).toBe(2);
  await viewImportedLibrary(page, multipleImport.stage_id);
  await page.reload();
  for (const item of imported) {
    await page.getByPlaceholder("Search the Library").fill(item.plan.entryName);
    await expect(
      page.getByRole("article", { name: item.plan.entryName, exact: true }),
    ).toBeVisible();
  }
  await creatorContent.cleanupOwnedContent();
  await creatorContent.assertLocalCatalogUnchanged(
    before,
    animamaEvidence,
    "sharing-content-cleanup",
  );
});

test("local content sharing complete Anima export, reviewed install and persistence @complete-anima", async ({
  page,
  creatorContent,
  animamaEvidence,
}, testInfo) => {
  // The expanded starter closure has hundreds of entries; serial verification
  // and exact receipt cleanup must both finish within this bounded journey.
  test.setTimeout(2_400_000);
  const before = await creatorContent.snapshotLocalCatalog();
  await openSharing(page, "Export");
  await page.getByRole("tab", { name: "Anima", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Choose an Anima", exact: true })
    .selectOption({ label: "Annie" });
  await expect(
    page.getByRole("button", { name: "Review export", exact: true }),
  ).toBeEnabled();
  await captureSharingState(page, animamaEvidence, "sharing-04-anima-export");
  const exported = await reviewSharingExport(page);
  expect(exported.manifest.kind).toBe("anima");
  expect(exported.manifest.anima?.display_name).toBe("Annie");
  const archive = await downloadSharingPackage(
    page,
    testInfo,
    page.getByRole("button", { name: "Export Anima", exact: true }),
  );
  await openSharing(page, "Import");
  const reviewed = await uploadSharingPackage(page, archive);
  expect(reviewed.anima).not.toBeNull();
  expect(reviewed.anima!.identity_markdown).toBe(
    exported.manifest.anima!.identity_markdown,
  );
  expect(reviewed.anima!.display_name).toMatch(/^Annie-\d+$/);
  const owned = await commitSharingPackage({
    page,
    content: creatorContent,
    review: reviewed,
    journeyKey: `sharing-anima-${randomUUID().slice(0, 8)}`,
  });
  const anima = owned.find((item) => item.plan.kind === "anima")!;
  expect(anima).toBeDefined();
  await page.getByRole("button", { name: "Open Anima", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${anima.itemId}(?:[/?#]|$)`));
  await page.reload();
  await expect(
    page
      .locator("#sidebar-animas-list")
      .getByRole("link", { name: reviewed.anima!.display_name, exact: true }),
  ).toBeVisible();
  // Leave the runtime before exact receipt cleanup so its refresh cannot race deletion.
  await page.goto("/library");
  await creatorContent.cleanupOwnedContent();
  await creatorContent.assertLocalCatalogUnchanged(
    before,
    animamaEvidence,
    "sharing-anima-cleanup",
  );
});
