import type { PyTypedContentPreview } from "@animama/runtime-contracts/api-types";
import { expect, test } from "../fixtures/animama";
import { authoredExpressionThresholds } from "../helpers/authored-expressions";
import { attachPlaybackCheckpoint } from "../helpers/checkpoints";
import { readPreviewClip } from "../helpers/imported-playback";
import {
  expectBottomRightDock,
  provePoseClipPlayback,
  proveReactionPlayback,
} from "../helpers/playback-assertions";
import {
  PreviewNetworkRecorder,
  ReadOnlyJourneyGuard,
} from "../helpers/preview-network";
import { openLibraryPreview } from "../helpers/preview-surfaces";

test("accountless Library smoke @smoke @read-only", async ({
  page,
  animamaEvidence,
}) => {
  const apiRequests: Array<{ url: string; authorization?: string }> = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/v1/")) {
      apiRequests.push({
        url: request.url(),
        authorization: request.headers()["authorization"],
      });
    }
  });
  const apiErrors: string[] = [];
  page.on("response", (response) => {
    if (
      new URL(response.url()).pathname.startsWith("/v1/") &&
      response.status() >= 400
    ) {
      apiErrors.push(
        `${response.status()} ${new URL(response.url()).pathname}`,
      );
    }
  });
  const avatarCatalogResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/v1/avatar-catalog",
  );
  const response = await test.step("Open the Library route", async () => {
    return page.goto("/library", {
      waitUntil: "domcontentloaded",
    });
  });

  await test.step("Assert the accountless Library is visible", async () => {
    expect(response?.ok()).toBe(true);
    await expect(page).toHaveURL(/\/library(?:[/?#]|$)/);
    await expect(
      page.getByRole("heading", { name: "Library", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Sign in to your account" }),
    ).toHaveCount(0);
    // Heading visibility alone can precede the catalog and leave every list loading.
    const catalog = await avatarCatalogResponse;
    expect(catalog.ok()).toBe(true);
    const avatar = page.getByRole("article", { name: "Annie", exact: true });
    await expect(avatar).toBeVisible();
    await expect(
      avatar.getByRole("button", { name: "Preview", exact: true }),
    ).toBeEnabled();
    await expect(
      avatar.getByRole("link", { name: "Create Anima", exact: true }),
    ).toBeVisible();
    expect(apiErrors).toEqual([]);
    expect(apiRequests.length).toBeGreaterThan(0);
    for (const request of apiRequests) {
      expect(new URL(request.url).origin).toBe(new URL(page.url()).origin);
      expect(request.authorization).toBeUndefined();
    }
    await animamaEvidence.attachBuffer(
      "accountless-library",
      await page.screenshot(),
      "image/png",
    );
    await animamaEvidence.attachJson("accountless-library-checkpoint", {
      path: new URL(page.url()).pathname,
      heading: "Library",
      accountless: true,
      mutationPerformed: false,
    });
  });
});

test("accountless Library keeps Included files between visits @surface-library @read-only", async ({
  page,
  animamaEvidence,
}) => {
  // Included files are named by digest URLs that the browser keeps as
  // immutable (ADR 0033), so a second visit reads them from its cache. The FX
  // section shows Included thumbnails, particle manifests read with fetch()
  // and the sidebar's presentation images. Chrome DevTools Protocol events
  // tell a cache hit from a request that reached the server; Playwright's own
  // request events do not.
  type ContentFileRead = {
    url: string;
    fromCache: boolean;
    finished: boolean;
    status?: number;
    cacheControl?: string;
  };
  const reads = new Map<string, ContentFileRead>();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    if (new URL(request.url).pathname.startsWith("/v1/content/files/")) {
      reads.set(requestId, {
        url: request.url,
        fromCache: false,
        finished: false,
      });
    }
  });
  cdp.on("Network.requestServedFromCache", ({ requestId }) => {
    const read = reads.get(requestId);
    if (read) read.fromCache = true;
  });
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    const read = reads.get(requestId);
    if (!read) return;
    read.status = response.status;
    read.fromCache ||= Boolean(response.fromDiskCache);
    read.cacheControl = response.headers["cache-control"];
  });
  for (const event of [
    "Network.loadingFinished",
    "Network.loadingFailed",
  ] as const) {
    cdp.on(event, ({ requestId }) => {
      const read = reads.get(requestId);
      if (read) read.finished = true;
    });
  }
  const isDigestUrl = (url: string) =>
    /^\/v1\/content\/files\/[^/]+\/sha256\/[0-9a-f]{64}$/.test(
      new URL(url).pathname,
    );
  // `/v1/content/files/{file_ref}[/sha256/{digest}]`: the registration a read names.
  const fileRef = (url: string) =>
    decodeURIComponent(new URL(url).pathname.split("/")[4] ?? "");

  /** Open the Library's FX in a new document and wait until its file reads settle. */
  async function visitLibrary(): Promise<ContentFileRead[]> {
    reads.clear();
    await page.goto("/library?section=fx", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Library", exact: true }),
    ).toBeVisible();
    let previous = -1;
    await expect
      .poll(
        () => {
          const all = [...reads.values()];
          const settled =
            all.length > 0 &&
            all.every((read) => read.finished) &&
            all.length === previous;
          previous = all.length;
          return settled;
        },
        { intervals: [750], timeout: 30_000 },
      )
      .toBe(true);
    return [...reads.values()];
  }

  const first = await test.step("Visit the Library", visitLibrary);
  // Every read of an Included file counts, whatever URL names it, so a reader
  // that still builds a URL from `file_ref` alone fails this journey.
  const includedRefs = await page.evaluate(async () => {
    const response = await fetch("/v1/content/catalog");
    const catalog = (await response.json()) as {
      items: Array<{ source: string; files: Array<{ file_ref: string }> }>;
    };
    return catalog.items
      .filter((item) => item.source === "included")
      .flatMap((item) => item.files.map((file) => file.file_ref));
  });
  const isIncluded = (read: ContentFileRead) =>
    includedRefs.includes(fileRef(read.url));
  const firstDigest = first.filter((read) => isDigestUrl(read.url));
  await test.step("Assert Included files are read at kept digest URLs", async () => {
    // An empty or misread catalog would make the guard below vacuous.
    expect(firstDigest.filter((read) => !isIncluded(read))).toEqual([]);
    expect(
      first.filter((read) => isIncluded(read) && !isDigestUrl(read.url)),
    ).toEqual([]);
    expect(
      firstDigest.filter(
        (read) => new URL(read.url).searchParams.get("variant") === "thumbnail",
      ).length,
    ).toBeGreaterThan(0);
    for (const read of firstDigest) {
      expect(read.status, read.url).toBe(200);
      expect(read.cacheControl, read.url).toBe(
        "private, max-age=31536000, immutable",
      );
    }
  });

  // Leave the origin so the second visit is a new document, not a reload.
  await page.goto("about:blank");
  const second = await test.step("Visit the Library again", visitLibrary);
  const secondDigest = second.filter((read) => isDigestUrl(read.url));
  await test.step("Assert the second visit sends no Included file request", async () => {
    expect(secondDigest.length).toBeGreaterThan(0);
    expect(
      second.filter(
        (read) =>
          (isIncluded(read) || isDigestUrl(read.url)) && !read.fromCache,
      ),
    ).toEqual([]);
  });
  await animamaEvidence.attachJson("accountless-library-kept-included-files", {
    firstVisit: {
      digestReads: firstDigest.length,
      otherReads: first.length - firstDigest.length,
    },
    secondVisit: {
      digestReads: secondDigest.length,
      digestReadsFromCache: secondDigest.filter((read) => read.fromCache)
        .length,
      otherReads: second.length - secondDigest.length,
    },
  });
});

test("accountless built-in pose playback @surface-library @channel-pose-clip @read-only", async ({
  page,
  animamaEvidence,
}) => {
  const name = "accountless-have-an-idea";
  const network = new PreviewNetworkRecorder(page);
  const readOnly = new ReadOnlyJourneyGuard(page);
  const blockedMethods: string[] = [];
  // Preview preparation is the only permitted POST. In particular, navigating
  // this journey must not select an Anima by writing remembered settings.
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const preview =
      request.method() === "POST" &&
      /^\/v1\/gestures\/[^/]+:preview$/.test(new URL(request.url()).pathname);
    if (["GET", "HEAD", "OPTIONS"].includes(request.method()) || preview) {
      await route.continue();
    } else {
      blockedMethods.push(request.method());
      await route.abort("blockedbyclient");
    }
  });
  try {
    await page.goto("/library", { waitUntil: "domcontentloaded" });
    const surface = await openLibraryPreview({
      page,
      contentName: "Have an Idea",
      section: "gesture",
      selectAnnie: false,
    });
    await expect(surface.locator("canvas")).toBeVisible();
    const samples = await provePoseClipPlayback({
      evidence: animamaEvidence,
      evidenceName: name,
      expectedTarget: { kind: "anima_pose_clip", runtimeId: "have_idea" },
      // The bulb event starts 2.6 s into the clip and shows its effect for
      // 0.95 s; the proof keeps sampling through its observation window until
      // a sample inside that interval sees the effect. No Included Gesture
      // plays a Scene Effect; accountless-imported-playback covers that.
      expectedAvatarEffects: ["idea_bulb_fingertip"],
      expectedEventIds: ["idea-bulb"],
      maxMissingBones: 1,
      surface,
    });
    await network.waitForPreview("have_idea");
    await network.requireResources(["idea_bulb_fingertip_flipbook.png"]);
    await network.attach(animamaEvidence, `${name}-preview-network`);
    await attachPlaybackCheckpoint({
      evidence: animamaEvidence,
      locator: surface,
      name,
      samples,
    });
    await readOnly.assertNoMutations(animamaEvidence);
    await animamaEvidence.attachJson(`${name}-request-policy`, {
      blockedMethods,
    });
    expect(blockedMethods).toEqual([]);
  } finally {
    await network.dispose();
    await readOnly.dispose();
  }
});

test("accountless built-in Reaction playback @surface-library @channel-reaction @read-only", async ({
  page,
  animamaEvidence,
}) => {
  const name = "accountless-admiration-4";
  const network = new PreviewNetworkRecorder(page);
  const readOnly = new ReadOnlyJourneyGuard(page);
  try {
    await page.goto("/library", { waitUntil: "domcontentloaded" });
    const prepared = page
      .waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /^\/v1\/reactions\/[^/]+:preview$/.test(
            new URL(response.url()).pathname,
          ),
      )
      .then(async (response) => {
        expect(response.ok(), await response.text()).toBe(true);
        return (await response.json()) as PyTypedContentPreview;
      });
    const surface = await openLibraryPreview({
      page,
      contentName: "Admiration Reaction 4",
      section: "reaction",
      selectAnnie: false,
    });
    await expectBottomRightDock(surface);
    const preview = await prepared;
    expect(preview.item.name).toBe("Admiration Reaction 4");
    // Included Reactions key VRoid face parts rather than whole-face presets,
    // so the proof follows the expressions the previewed clip authors.
    const expressionThresholds = authoredExpressionThresholds(
      await readPreviewClip(page, preview),
    );
    const samples = await proveReactionPlayback({
      evidence: animamaEvidence,
      evidenceName: name,
      expectedTarget: { kind: "anima_pose_clip", runtimeId: "admiration-4" },
      expectedAvatarEffects: ["star3"],
      expectedEventIds: [
        "scene-emotion-background",
        "avatar-star3",
        "particle-twinkle-shimmer",
      ],
      expectedParticleEffects: ["twinkle-shimmer"],
      expectedSceneEffects: ["scene-vfx-emotion-admiration"],
      expressionThresholds,
      surface,
    });
    await network.waitForPreview("admiration-4");
    await network.requireResources([
      "shimmer-glint.png",
      "star3-sheet.png",
      "twinkle-star-gold.png",
      "bokeh-tile.png",
    ]);
    await network.attach(animamaEvidence, `${name}-preview-network`);
    await attachPlaybackCheckpoint({
      evidence: animamaEvidence,
      locator: surface,
      name,
      samples,
    });
    await readOnly.assertNoMutations(animamaEvidence);
  } finally {
    await network.dispose();
    await readOnly.dispose();
  }
});
