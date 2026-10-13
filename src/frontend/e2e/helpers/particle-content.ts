import { expect, type Page, type Route } from "playwright/test";
import type {
  CreatorContentFixture,
  CreatorContentPlan,
} from "../fixtures/animama";

export type OwnedParticleEffect = {
  plan: CreatorContentPlan;
  itemId: string;
  revisionSha256: string;
};

/**
 * Save a new Particle Effect through the creator's Save button, fsyncing the
 * ownership plan before the real request and recording the saved item before
 * the test proceeds. Returns the texture paths the request carried.
 */
export async function saveTrackedParticleEffect(args: {
  page: Page;
  content: CreatorContentFixture;
  name: string;
}): Promise<OwnedParticleEffect & { texturePaths: string[] }> {
  const { page, content, name } = args;
  const url = new URL(
    `/v1/particle-effects/${encodeURIComponent(name)}`,
    page.url(),
  ).href;
  let resolve!: (
    value: OwnedParticleEffect & { texturePaths: string[] },
  ) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<OwnedParticleEffect & { texturePaths: string[] }>(
    (yes, no) => {
      resolve = yes;
      reject = no;
    },
  );
  void result.catch(() => undefined);
  const handler = async (route: Route) => {
    try {
      const request = route.request();
      expect(request.method()).toBe("PUT");
      const fields = await new Response(request.postData(), {
        headers: { "content-type": request.headers()["content-type"]! },
      }).formData();
      const descriptor = JSON.parse(String(fields.get("descriptor_json"))) as {
        name: string;
        content_type: string;
        id: string;
        files: Array<{ path: string; role: string }>;
      };
      expect(descriptor.name).toBe(name);
      expect(descriptor.content_type).toBe("particle_effect");
      expect(fields.get("catalog_item_id")).toBeNull();
      const logicalKey = String(descriptor.id);
      await content.preflightContentAbsence({
        logicalKey,
        expectedRelativePath: `vfx/particle/${name}`,
      });
      const plan = await content.planContent({
        journeyKey: `particle-content-${name}`,
        kind: "particle_effect",
        entryName: name,
        logicalKey,
      });
      const responsePending = page.waitForResponse(
        (candidate) => candidate.request() === request,
      );
      await route.continue();
      const response = await responsePending;
      expect(
        response.ok(),
        `Particle Effect save returned ${response.status()}: ${await response.text()}`,
      ).toBe(true);
      const body = (await response.json()) as Record<string, unknown>;
      const owned = {
        itemId: String(body.item_id),
        revisionSha256: String(body.revision_sha256),
      };
      await content.recordOwnedContent(plan, owned);
      resolve({
        plan,
        ...owned,
        texturePaths: descriptor.files
          .filter((file) => file.role === "texture")
          .map((file) => file.path),
      });
    } catch (error) {
      reject(error);
      await route.abort().catch(() => undefined);
    }
  };
  await page.route(url, handler, { times: 1 });
  try {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const saved = await result;
    await content.verifyOwnedContent(saved.plan, saved);
    await expect(page).toHaveURL(
      new RegExp(`/particle-effects/${saved.itemId}/edit`),
    );
    await expect(page.getByText("Particle Effect saved.")).toBeVisible();
    return saved;
  } finally {
    await page.unroute(url, handler);
  }
}

/**
 * Wait until browser recovery holds the named Particle draft together with
 * the bytes of the texture `reference`, rather than guessing the autosave
 * debounce.
 */
export async function waitForStoredParticleDraft(
  page: Page,
  name: string,
  reference: string,
) {
  await expect
    .poll(
      () =>
        page.evaluate(
          async (expected) => {
            const known = await indexedDB.databases();
            if (
              !known.some(
                (entry) => entry.name === "animama-content-creator-recovery",
              )
            )
              return false;
            return new Promise<boolean>((resolve) => {
              const opening = indexedDB.open(
                "animama-content-creator-recovery",
              );
              opening.onerror = () => resolve(false);
              opening.onsuccess = () => {
                const db = opening.result;
                if (!db.objectStoreNames.contains("particle-vfx")) {
                  db.close();
                  resolve(false);
                  return;
                }
                const request = db
                  .transaction("particle-vfx", "readonly")
                  .objectStore("particle-vfx")
                  .getAll();
                request.onsuccess = () => {
                  db.close();
                  resolve(
                    request.result.some(
                      (record: {
                        displayName?: string;
                        textures?: unknown[];
                      }) =>
                        record.displayName === expected.name &&
                        (record.textures ?? []).some(
                          (texture) =>
                            (texture as { reference?: string; blob?: Blob })
                              .reference === expected.reference &&
                            (texture as { blob?: Blob }).blob instanceof Blob,
                        ),
                    ),
                  );
                };
                request.onerror = () => {
                  db.close();
                  resolve(false);
                };
              };
            });
          },
          { name, reference },
        ),
      { message: "browser recovery stores the draft and its texture bytes" },
    )
    .toBe(true);
}
