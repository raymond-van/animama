import { test, expect } from "../fixtures/animama";

/** First run is installation state; no account or browser authentication state exists. */
test("complete accountless first-run setup on the isolated installation", async ({
  page,
  animamaEvidence,
}) => {
  await page.goto("/");
  await page.waitForURL((url) => url.pathname !== "/");
  const firstRunPerformed = new URL(page.url()).pathname === "/setup";
  if (firstRunPerformed) {
    await expect(
      page.getByRole("heading", { name: "What should Animama call you?" }),
    ).toBeVisible();
    const next = page.getByRole("button", { name: "Continue", exact: true });
    await expect(next).toBeDisabled();
    await page.getByLabel("Display name", { exact: true }).fill("   ");
    await expect(next).toBeDisabled();
    await page
      .getByLabel("Display name", { exact: true })
      .fill("Browser Fixture");
    await expect(next).toBeEnabled();
    await next.click();
    // AI and Voice are optional; the fixture keeps the system defaults.
    await expect(
      page.getByRole("heading", { name: "Choose your AI" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Skip for now", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Set up voice" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Skip for now", exact: true })
      .click();
    // The wizard hands off to the first Anima, where age confirmation gates chat.
    await expect(
      page.getByRole("dialog", { name: "Before you start" }),
    ).toBeVisible();
    // The real avatar renderer starts behind the dialog; interactive chat
    // stays unmounted until the explicit backend confirmation succeeds.
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    const loadedCanvas = await canvas.elementHandle();
    expect(loadedCanvas).not.toBeNull();
    await expect(page.locator("textarea")).toHaveCount(0);
    expect(
      await canvas.evaluate((element) => Boolean(element.closest("[inert]"))),
    ).toBe(true);
    await test.info().attach("avatar-loading-behind-age-confirmation", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page
      .getByRole("button", { name: "I am 18 or older", exact: true })
      .click();
    // The Anima URL is entered before confirmation; only a closed modal
    // proves the pending onboarding mutation has finished successfully.
    await expect(
      page.getByRole("dialog", { name: "Before you start" }),
    ).toBeHidden();
    expect(await loadedCanvas!.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    expect(
      await canvas.evaluate((element) => Boolean(element.closest("[inert]"))),
    ).toBe(false);
    await loadedCanvas!.dispose();
    await expect(
      page.getByRole("button", { name: /Browser Fixture/u }),
    ).toBeVisible();
  }
  await page.waitForURL(
    (url) => url.pathname !== "/" && url.pathname !== "/setup",
  );
  await expect(
    page.getByRole("heading", { name: "Sign in to your account" }),
  ).toHaveCount(0);
  const runtimeContext = await page.request.get("/v1/runtime-context");
  expect(runtimeContext.ok()).toBe(true);
  expect((await runtimeContext.json()).first_run_complete).toBe(true);
  await animamaEvidence.attachJson("installation-setup-mode", {
    firstRunPerformed,
    existingInstallation: !firstRunPerformed,
  });
});
