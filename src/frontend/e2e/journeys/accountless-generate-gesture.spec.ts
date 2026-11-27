import type {
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";
import type { Locator, Page, Response } from "playwright/test";

import {
  expect,
  test,
  type AnimaLoadoutSnapshot,
  type CreatorContentFixture,
  type CreatorContentPlan,
  type EvidenceAttachment,
  type LocalCatalogSnapshot,
} from "../fixtures/animama";
import { authoredExpressionThresholds } from "../helpers/authored-expressions";
import { attachPlaybackCheckpoint } from "../helpers/checkpoints";
import { waitForCreatorStageReady } from "../helpers/creator-surfaces";
import {
  observePlaybackWindow,
  readPlaybackObservation,
  type PlaybackObservation,
} from "../helpers/playback-observation";
import { selectAnnieFromSidebar } from "../helpers/preview-surfaces";

/**
 * The Generate page from a request to the Library, in three journeys:
 *
 * - `generate-gesture-conversation`: ask the content assistant for a Gesture,
 *   watch the draft settle and play on the chosen Avatar and on each Included
 *   Avatar, revise it, save it and open the saved item in the Gesture
 *   creator; then stop a run, reload, and discard the unsaved draft and the
 *   conversation.
 * - `generate-batch-partial-save`: ask for a batch of three of which one item
 *   fails, and save the others with Save all.
 * - `generate-gesture-effect-save`: ask for a Gesture that plays an existing
 *   Avatar Effect, and save it with its dependency.
 *
 * Needs a stack started with `ANIMAMA_LLM_SKIP`: the backend's deterministic
 * author stands in for the model. It names a draft after its request, writes
 * the packaged example Gesture, lengthens the ending on a revision and accepts
 * on review. A request that says `batch of N` is planned as N items, `item K
 * fails` makes item K fail, and `with an effect` places the first Avatar
 * Effect the Library lists. The page's validation, motion checks and review
 * sheets are real.
 */
const JOURNEY_KEY = "generate-gesture-conversation";
const BATCH_JOURNEY_KEY = "generate-batch-partial-save";
const EFFECT_JOURNEY_KEY = "generate-gesture-effect-save";

const RUN_PATH = /^\/v1\/generation\/conversations\/([^/]+)\/runs:sse$/;
const CHECK_REPORT_ROUTE = "**/v1/generation/drafts/*/check-report";
const REVIEW_FRAMES_PATH = /^\/v1\/generation\/drafts\/[^/]+\/review-frames$/;
/** Where a run leaves a draft that loads; `failed` is not expected here. */
const SETTLED = /^(?:ready|warnings)$/;
/**
 * A run waits two minutes for the page's check report before it leaves the
 * draft unchecked, with a warning. A draft that settles sooner was checked.
 */
const SETTLE_TIMEOUT_MS = 90_000;
/**
 * A batch works on two items at a time, each with its own checks and review
 * sheets, so the last item settles later than a single draft does.
 */
const BATCH_SETTLE_TIMEOUT_MS = 180_000;
/** The names the Library saves an item under: its own rule for an entry's name. */
const LIBRARY_ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/;
/** The deterministic author's account of a draft it wrote. */
const AUTHOR_NOTE = "This is the packaged example Gesture: no model was asked.";
const STOPPED_TEXT = "Stopped. Drafts finished so far are kept.";
const REVISION_TEXT = "Hold the ending a little longer";

type OwnedGesture = { itemId: string; revisionSha256: string };
type DraftBeat = { id: string; label: string; time: number };
type DraftEvent = {
  id: string;
  kind: string;
  time: number;
  duration?: number;
  effectId?: string;
};
type DraftClip = {
  id: string;
  duration: number;
  beats: DraftBeat[];
  events?: DraftEvent[];
};
/** An effect a draft's project pins, in the creator's dependency shape. */
type DraftDependency = {
  alias: string;
  content_type: string;
  source: {
    type: string;
    catalog_item_id?: string;
    logical_key?: string | null;
  };
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Generate journeys.`);
  return value;
}

/** The run's ten-digit timestamp, which makes this run's names unique. */
function runDigits(runId: string): string {
  const match = /(\d{10})$/.exec(runId);
  if (!match?.[1])
    throw new Error(
      `The Generate journeys require a timestamped run; got ${runId}.`,
    );
  return match[1];
}

/**
 * The logical key the page gives a new Local Gesture saved under `name`:
 * the name in lower case, with every run of other characters as one hyphen.
 */
function gestureLogicalKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `local:gesture:${slug}`;
}

/**
 * Where the Library keeps a Gesture saved under `name`, below its Local
 * root: spaces and underscores become hyphens, in lower case.
 */
function gestureRelativePath(name: string): string {
  const entry = name
    .trim()
    .replace(/[ _]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
  return `gestures/${entry}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function draftCard(page: Page, draftId: string): Locator {
  return page.locator(
    `[data-testid="generate-draft-card"][data-draft-id="${draftId}"]`,
  );
}

function draftStatus(card: Locator): Locator {
  return card.getByTestId("generate-draft-status");
}

/** A draft project's clip, as the backend stores it. */
function draftClip(draft: PyGenerationDraft | undefined): DraftClip {
  const sequence = (
    draft?.project as unknown as { sequence?: DraftClip } | null | undefined
  )?.sequence;
  if (!sequence || !Array.isArray(sequence.beats))
    throw new Error("The draft holds no clip with beats.");
  return sequence;
}

/** A draft's name, as its project holds it. */
function draftProjectName(draft: PyGenerationDraft | undefined): string {
  const name = (draft?.project as { name?: unknown } | null | undefined)?.name;
  if (typeof name !== "string" || !name.trim())
    throw new Error("The draft has no name.");
  return name;
}

/** The effects a draft's project pins, by the aliases its events name. */
function draftDependencies(
  draft: PyGenerationDraft | undefined,
): DraftDependency[] {
  const dependencies = (
    draft?.project as { dependencies?: unknown } | null | undefined
  )?.dependencies;
  return Array.isArray(dependencies) ? (dependencies as DraftDependency[]) : [];
}

/** A clip's beats as the creator keeps them through import and Save. */
function beatFacts(clip: DraftClip) {
  return clip.beats.map(({ id, label, time }) => ({
    id,
    label,
    time: Number(time.toFixed(3)),
  }));
}

/** The creator's timeline marker for a beat: its label and time. */
function beatMarkerName(beat: DraftBeat): RegExp {
  return new RegExp(
    `^${escapeRegExp(`${beat.label} keyframe at ${beat.time.toFixed(2)}s`)}`,
  );
}

async function readConversation(
  page: Page,
  conversationId: string,
): Promise<PyGenerationConversationSnapshot> {
  const response = await page.request.get(
    `/v1/generation/conversations/${encodeURIComponent(conversationId)}`,
  );
  if (!response.ok())
    throw new Error(
      `The conversation read failed with HTTP ${response.status()}.`,
    );
  return (await response.json()) as PyGenerationConversationSnapshot;
}

/**
 * Delete an assistant conversation with its messages and drafts, and return
 * the HTTP status. A request made outside the page needs the headers the
 * page's own requests carry, or admission refuses it.
 */
async function deleteConversation(
  page: Page,
  conversationId: string,
): Promise<number> {
  const response = await page.request.delete(
    `/v1/generation/conversations/${encodeURIComponent(conversationId)}`,
    {
      headers: {
        Origin: new URL(page.url()).origin,
        "Sec-Fetch-Site": "same-origin",
        "X-Animama-CSRF": "1",
      },
    },
  );
  return response.status();
}

/** The names the Avatar picker lists for the Included Avatars. */
async function includedAvatarNames(page: Page): Promise<string[]> {
  const response = await page.request.get(
    "/v1/avatar-catalog?origin=included&sort=name&limit=30",
  );
  if (!response.ok())
    throw new Error(
      `The Included Avatar list failed with HTTP ${response.status()}.`,
    );
  const body = (await response.json()) as {
    items?: Array<{ catalog_item_id?: string | null; name?: string }>;
  };
  return (body.items ?? []).flatMap((item) =>
    item.catalog_item_id && item.name ? [item.name] : [],
  );
}

/** Type a request, send it, and return the run request the page made. */
async function sendRequest(
  page: Page,
  message: string,
): Promise<{ conversationId: string; body: Record<string, unknown> }> {
  const started = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      RUN_PATH.test(new URL(request.url()).pathname),
  );
  await page.getByTestId("generate-request").fill(message);
  await page.getByTestId("generate-send").click();
  const request = await started;
  const conversationId = RUN_PATH.exec(new URL(request.url()).pathname)?.[1];
  if (!conversationId)
    throw new Error("The run request names no conversation.");
  return {
    conversationId: decodeURIComponent(conversationId),
    body: request.postDataJSON() as Record<string, unknown>,
  };
}

/** Follow the Create page's entry, offered only with `content_generation`. */
async function openGenerate(page: Page): Promise<void> {
  const createLink = page.getByRole("link", { name: "Create", exact: true });
  await expect(createLink).toHaveCount(1);
  await createLink.click();
  await expect(page).toHaveURL(/\/create(?:[/?#]|$)/);
  const entry = page.getByRole("link", { name: "Open Generate", exact: true });
  await expect(
    entry,
    "the local runtime offers the content assistant",
  ).toHaveCount(1);
  await entry.click();
  await expect(page).toHaveURL(/\/generate(?:[/?#]|$)/);
}

/**
 * Open Generate, choose the assistant's model if none is chosen yet, and
 * start from an empty conversation with the preview Avatar on stage. Returns
 * the chosen model's id.
 */
async function openEmptyConversation(
  page: Page,
  evidence: EvidenceAttachment,
  journeyKey: string,
): Promise<string> {
  const conversation = page.getByTestId("generate-conversation");
  const modelControl = page.getByTestId("generate-model-control");
  await openGenerate(page);
  const setup = page.getByTestId("generate-setup");
  await expect(setup.or(conversation)).toBeVisible({ timeout: 30_000 });
  // A fresh installation has no saved choice and shows setup; a stack an
  // earlier run used opens on the model chosen then.
  let chosenInSetup: string | null = null;
  if (await setup.isVisible()) {
    const option = setup.getByTestId("generate-model-option").first();
    await expect(
      option,
      "the stack lists a visible chat model that calls tools",
    ).toBeVisible();
    chosenInSetup = await option.getAttribute("data-model-id");
    await option.click();
  }
  await expect(conversation).toBeVisible({ timeout: 30_000 });
  await expect(modelControl).toHaveAttribute(
    "data-model-id",
    chosenInSetup ?? /.+/,
  );
  const chosen = await modelControl.getAttribute("data-model-id");
  if (!chosen) throw new Error("The assistant has no model.");
  await evidence.attachJson(`${journeyKey}-model`, {
    modelProviderId: chosen,
    chosenInSetup: chosenInSetup !== null,
  });

  // Start from an empty conversation, whatever an earlier run left.
  const draftsEmpty = page.getByTestId("generate-drafts-empty");
  await expect(draftsEmpty.or(page.getByTestId("generate-drafts"))).toBeVisible(
    { timeout: 30_000 },
  );
  const newConversation = page.getByTestId("generate-new-conversation");
  if (await newConversation.isEnabled()) {
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/v1/generation/conversations" &&
        response.ok(),
    );
    await newConversation.click();
    await created;
  }
  await expect(
    conversation.getByText("Describe a Gesture", { exact: true }),
  ).toBeVisible();
  await expect(draftsEmpty).toBeVisible();
  await expect(page.getByTestId("generate-draft-card")).toHaveCount(0);
  // Stop takes Send's place only while a run is in flight.
  await expect(page.getByTestId("generate-send")).toBeVisible();
  await expect(page.getByTestId("generate-stop")).toHaveCount(0);
  // With the Avatar on stage, the run's checks and review sheets do not
  // wait for it.
  await waitForPreviewAvatar(page.getByTestId("generate-preview"));
  return chosen;
}

/** A save response's item, as the ledger records one. */
async function savedGesture(response: Response): Promise<OwnedGesture> {
  const body = (await response.json()) as Record<string, unknown>;
  return {
    itemId: String(body.item_id ?? ""),
    revisionSha256: String(body.revision_sha256 ?? ""),
  };
}

/** The clip file among a verified item's registered files. */
function savedClip(verified: { files: Record<string, unknown> }): DraftClip {
  const files = verified.files as unknown as {
    parsedJson: Record<string, unknown>;
  };
  const clip = Object.entries(files.parsedJson).find(
    ([path]) => path.endsWith(".json") && !path.endsWith(".meta.json"),
  )?.[1] as DraftClip | undefined;
  if (!clip) throw new Error("The saved Gesture has no clip file.");
  return clip;
}

/** Send is back in place of Stop, and the run left no failure. */
async function expectRunEnded(page: Page): Promise<void> {
  await expect(page.getByTestId("generate-send")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("generate-stop")).toHaveCount(0);
  await expect(page.getByTestId("generate-failure")).toHaveCount(0);
}

/** Wait until the preview's Avatar is on stage, with or without a draft. */
async function waitForPreviewAvatar(stage: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        const observation = await readPlaybackObservation(stage);
        if (observation.target.status === "error")
          throw new Error("The Generate preview could not load its Avatar.");
        return (
          observation.target.status !== "loading" &&
          !observation.diagnostics.some(
            (entry) => entry.code === "avatar_not_ready",
          )
        );
      },
      { message: "the preview Avatar loads", timeout: 45_000 },
    )
    .toBe(true);
}

/**
 * Prove the selected draft plays on the Avatar now on stage: the stage's clock
 * advances on the draft's clip while the Avatar's own expression weights reach
 * what the clip keys.
 */
async function proveDraftPlays(args: {
  clipId: string;
  evidence: EvidenceAttachment;
  name: string;
  page: Page;
  stage: Locator;
  thresholds: Readonly<Record<string, number>>;
}): Promise<PlaybackObservation[]> {
  const { clipId, evidence, name, page, stage, thresholds } = args;
  // Ready means a loaded Avatar: choosing another one clears the stage first.
  const ready = await waitForCreatorStageReady({
    expectedKind: "anima_pose_clip",
    surface: stage,
    timeoutMs: 45_000,
  });
  expect(ready.target.runtimeId).toBe(clipId);
  const playing = observePlaybackWindow({
    surface: stage,
    expectedTarget: { kind: "anima_pose_clip", runtimeId: clipId },
    evidence,
    evidenceName: name,
    until: (samples) => {
      const played = samples.filter(
        (sample) =>
          sample.target.status === "playing" &&
          sample.motion.poseClip?.active === true,
      );
      const times = played.map(
        (sample) => sample.motion.poseClip?.playheadSec ?? 0,
      );
      return (
        times.length >= 2 &&
        Math.max(...times) - Math.min(...times) > 0.04 &&
        Object.entries(thresholds).every(([expression, threshold]) =>
          played.some(
            (sample) => (sample.expressions[expression] ?? 0) >= threshold,
          ),
        ) &&
        !samples.some((sample) =>
          sample.diagnostics.some((entry) => entry.code === "avatar_not_ready"),
        )
      );
    },
  });
  const [, samples] = await Promise.all([
    page.getByRole("button", { name: "Restart draft", exact: true }).click(),
    playing,
  ]);
  await attachPlaybackCheckpoint({ evidence, locator: stage, name, samples });
  return samples;
}

async function choosePreviewAvatar(page: Page, name: string): Promise<void> {
  const picker = page.getByTestId("generate-avatar-picker");
  await picker.click();
  const option = page.getByRole("option", { name, exact: true });
  await expect(option, `one preview Avatar is named ${name}`).toHaveCount(1);
  await option.click();
  await expect(picker).toHaveText(name);
}

/**
 * The saved Gesture open in the creator: each beat of the clip on the
 * timeline, and a selected beat's time ready to edit. Nothing is edited, so
 * the creator still reports the document as saved.
 */
async function expectEditableBeats(
  page: Page,
  args: { clip: DraftClip; name: string },
): Promise<void> {
  await expect(
    page.getByRole("textbox", { name: "gesture name", exact: true }),
  ).toHaveValue(args.name, { timeout: 30_000 });
  const clipTab = page.getByRole("tab", { name: "Clip", exact: true });
  await expect(clipTab).toBeVisible({ timeout: 30_000 });
  await clipTab.click();
  for (const beat of args.clip.beats)
    await expect(
      page.getByRole("button", { name: beatMarkerName(beat) }),
    ).toBeVisible({ timeout: 30_000 });
  const beat = args.clip.beats[1];
  if (!beat) throw new Error("The saved clip has fewer than two beats.");
  await page.getByRole("button", { name: beatMarkerName(beat) }).click();
  const time = page.getByLabel("Selected keyframe time", { exact: true });
  await expect(time).toBeEditable();
  expect(Number(await time.inputValue())).toBeCloseTo(beat.time, 2);
  await expect(
    page.getByRole("status", { name: "Saved", exact: true }),
  ).toBeVisible();
}

function isGestureSave(
  response: Response,
  apiOrigin: string,
  entryName: string,
): boolean {
  if (response.request().method() !== "PUT") return false;
  const url = new URL(response.url());
  const entry = /^\/v1\/gestures\/([^/:]+)$/.exec(url.pathname)?.[1];
  if (url.origin !== apiOrigin || !entry) return false;
  try {
    return decodeURIComponent(entry) === entryName;
  } catch {
    return false;
  }
}

/**
 * Hold the page's next check report in the browser until released. A run
 * waits for that report, so while it is held the run is certainly in flight.
 */
async function holdNextCheckReport(page: Page) {
  let held = false;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let passed!: () => void;
  const sent = new Promise<void>((resolve) => {
    passed = resolve;
  });
  await page.route(
    CHECK_REPORT_ROUTE,
    async (route) => {
      held = true;
      await gate;
      // A page that has left no longer waits for its report.
      await route.continue().catch(() => undefined);
      passed();
    },
    { times: 1 },
  );
  return {
    isHeld: () => held,
    /** Let a held report reach the backend, and stop holding reports. */
    async release() {
      open();
      if (held) await sent;
      await page.unroute(CHECK_REPORT_ROUTE);
    },
  };
}

test(`${JOURNEY_KEY} @generate @surface-generate @channel-gesture @writes-local`, async ({
  animamaEvidence,
  creatorContent,
  page,
}) => {
  // Three runs with the page's checks, three Avatar loads, the creator and
  // three reloads do not fit the 90 s default.
  test.setTimeout(480_000);
  const digits = runDigits(requiredEnvironment("ANIMAMA_E2E_RUN_ID"));
  const apiOrigin = new URL(requiredEnvironment("ANIMAMA_E2E_API_URL")).origin;
  // The deterministic author names a draft after its request.
  const name = `Nod-${digits}`;
  const stoppedName = `Bow-${digits}`;
  // The clip id and the saved item's logical key are the name in kebab-case.
  const slug = name.toLowerCase();
  const logicalKey = `local:gesture:${slug}`;
  const catalogBefore = await creatorContent.snapshotLocalCatalog();
  const preflight = await creatorContent.preflightContentAbsence({
    logicalKey,
    expectedRelativePath: `gestures/${slug}`,
  });
  await animamaEvidence.attachJson(`${JOURNEY_KEY}-preflight`, preflight);
  const animaId = await selectAnnieFromSidebar(page);
  const loadoutBefore = await creatorContent.snapshotAnimaLoadout(animaId);
  const plan: CreatorContentPlan = await creatorContent.planContent({
    journeyKey: JOURNEY_KEY,
    kind: "gesture",
    entryName: name,
    logicalKey,
  });
  let owned: OwnedGesture | null = null;
  let failure: unknown = null;

  const conversation = page.getByTestId("generate-conversation");
  const cards = page.getByTestId("generate-draft-card");
  const stage = page.getByTestId("generate-preview");
  const send = page.getByTestId("generate-send");
  const stop = page.getByTestId("generate-stop");
  const modelControl = page.getByTestId("generate-model-control");

  try {
    const modelId =
      await test.step("Open Generate from the Create page and choose a model", () =>
        openEmptyConversation(page, animamaEvidence, JOURNEY_KEY));

    const first =
      await test.step("Ask for a Gesture and watch the draft settle", async () => {
        // Kept as evidence, not asserted: a run skips its frame review when
        // the sheets take longer to draw than it waits, which depends on the
        // host's WebGL.
        const sheetUploads: number[] = [];
        const recordSheetUpload = (response: Response) => {
          if (
            response.request().method() === "PUT" &&
            REVIEW_FRAMES_PATH.test(new URL(response.url()).pathname)
          )
            sheetUploads.push(response.status());
        };
        page.on("response", recordSheetUpload);
        const run = await sendRequest(page, name);
        expect(run.body).toMatchObject({
          message: name,
          model_provider_id: modelId,
          intent: "gesture",
        });
        expect(run.body).not.toHaveProperty("draft_id");

        await expect(cards).toHaveCount(1, { timeout: 30_000 });
        const draftId = await cards.getAttribute("data-draft-id");
        if (!draftId) throw new Error("The draft card names no draft.");
        const card = draftCard(page, draftId);
        // A draft the assistant has just written is selected as it appears.
        await expect(card).toHaveAttribute("data-selected", "true");
        await expect(
          card.getByRole("button", {
            name: `Select draft ${name}`,
            exact: true,
          }),
        ).toBeVisible();
        await expect(draftStatus(card)).toHaveAttribute(
          "data-status",
          SETTLED,
          { timeout: SETTLE_TIMEOUT_MS },
        );
        await expectRunEnded(page);
        page.off("response", recordSheetUpload);
        // The page's checks reached the backend.
        await expect(
          card.getByTestId("generate-draft-retry-check"),
        ).toHaveCount(0);
        await expect(card.getByTestId("generate-draft-saved")).toHaveCount(0);
        await expect(
          conversation.getByText(name, { exact: true }),
        ).toBeVisible();
        await expect(conversation.getByText(AUTHOR_NOTE)).toBeVisible();

        const snapshot = await readConversation(page, run.conversationId);
        const draft = snapshot.drafts.find((entry) => entry.id === draftId);
        expect(draft).toMatchObject({
          checked_version: draft?.version,
          check_report: { loadable: true },
          saved_item_id: null,
        });
        const clip = draftClip(draft);
        expect(clip.id).toBe(slug);
        await expect(card).toHaveAttribute(
          "data-version",
          String(draft?.version),
        );
        await animamaEvidence.attachJson(`${JOURNEY_KEY}-first-draft`, {
          conversationId: run.conversationId,
          draftId,
          version: draft?.version,
          status: draft?.status,
          checkReport: draft?.check_report,
          reviewSheetUploadStatuses: sheetUploads,
        });
        return {
          conversationId: run.conversationId,
          draftId,
          card,
          version: Number(draft?.version),
          // Read from the clip, so the proof follows the example if it changes.
          thresholds: authoredExpressionThresholds(clip, 0.25),
        };
      });
    const { conversationId, draftId, card } = first;

    await test.step("Play the draft on the chosen Avatar and each Included Avatar", async () => {
      await expect(stage).toHaveAttribute("data-draft-id", draftId);
      const picker = page.getByTestId("generate-avatar-picker");
      // The preview starts on the last active Anima's Avatar.
      await expect(picker).toHaveText("Annie (Anima)");
      // The example plays once in under two seconds; a loop stays observable.
      const loop = page.getByTestId("generate-preview-loop");
      await loop.click();
      await expect(loop).toBeChecked();
      await proveDraftPlays({
        clipId: slug,
        evidence: animamaEvidence,
        name: `${JOURNEY_KEY}-anima-avatar`,
        page,
        stage,
        thresholds: first.thresholds,
      });

      const included = await includedAvatarNames(page);
      expect(
        included.length,
        "the installation offers its Included Avatars",
      ).toBeGreaterThanOrEqual(2);
      for (const avatar of included) {
        await choosePreviewAvatar(page, avatar);
        await proveDraftPlays({
          clipId: slug,
          evidence: animamaEvidence,
          name: `${JOURNEY_KEY}-included-${avatar.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          page,
          stage,
          thresholds: first.thresholds,
        });
      }
    });

    const revised =
      await test.step("Revise the selected draft with a second message", async () => {
        await expect(card).toHaveAttribute("data-selected", "true");
        await expect(
          page.getByTestId("generate-revision-target"),
        ).toContainText(name);
        const run = await sendRequest(page, REVISION_TEXT);
        expect(run.conversationId).toBe(conversationId);
        expect(run.body).toMatchObject({
          message: REVISION_TEXT,
          model_provider_id: modelId,
          draft_id: draftId,
        });

        await expect
          .poll(async () => Number(await card.getAttribute("data-version")), {
            message: "the revision is stored as a new version",
            timeout: 30_000,
          })
          .toBeGreaterThan(first.version);
        await expect(draftStatus(card)).toHaveAttribute(
          "data-status",
          SETTLED,
          { timeout: SETTLE_TIMEOUT_MS },
        );
        await expectRunEnded(page);
        // A revision changes its draft; it does not add one.
        await expect(cards).toHaveCount(1);
        const restore = card.getByTestId("generate-draft-restore");
        await expect(restore).toBeVisible();
        await expect(restore).toBeEnabled();
        await expect(
          conversation.getByText(REVISION_TEXT, { exact: true }),
        ).toBeVisible();

        const snapshot = await readConversation(page, conversationId);
        const draft = snapshot.drafts.find((entry) => entry.id === draftId);
        expect(draft).toMatchObject({
          checked_version: draft?.version,
          has_previous_version: true,
        });
        expect(draft?.version).toBeGreaterThan(first.version);
        const clip = draftClip(draft);
        // The preview plays the new version: its clip is the longer one.
        await expect
          .poll(
            async () =>
              (await readPlaybackObservation(stage)).motion.poseClip
                ?.durationSec ?? 0,
          )
          .toBeCloseTo(clip.duration, 2);
        return clip;
      });

    const item = await test.step("Save the draft to the Library", async () => {
      // Nothing the assistant did wrote to the Library: saving is the
      // person's own action.
      await creatorContent.assertLocalCatalogUnchanged(
        catalogBefore,
        animamaEvidence,
        `${JOURNEY_KEY}-before-save`,
      );
      const saved = page.waitForResponse(
        (response) => isGestureSave(response, apiOrigin, name),
        { timeout: 30_000 },
      );
      await card.getByTestId("generate-draft-save").click();
      const response = await saved;
      expect(
        response.ok(),
        `the Gesture save answered HTTP ${response.status()}`,
      ).toBe(true);
      const identity = await savedGesture(response);
      // Recorded before anything else can fail, so cleanup owns the item.
      await creatorContent.recordOwnedContent(plan, identity);
      return identity;
    });
    owned = item;

    await test.step("Open the saved item in the Gesture creator", async () => {
      const savedLink = card.getByTestId("generate-draft-saved-link");
      await expect(savedLink).toBeVisible({ timeout: 15_000 });
      await expect(card.getByTestId("generate-draft-save")).toHaveText(
        "Save again",
      );
      await savedLink.click();
      await expect(page).toHaveURL(
        new RegExp(
          `/gestures/${escapeRegExp(encodeURIComponent(item.itemId))}/edit(?:[?#]|$)`,
        ),
      );
      await expectEditableBeats(page, { clip: revised, name });
      await page.reload();
      await expectEditableBeats(page, { clip: revised, name });
    });

    const stoppedDraftId =
      await test.step("Back on Generate, stop a run in flight", async () => {
        // Nothing was edited, so the creator lets go without a discard prompt.
        await openGenerate(page);
        await expect(card).toBeVisible({ timeout: 45_000 });
        // Opening a conversation selects its latest draft; the next request
        // is for a new one.
        await expect(card).toHaveAttribute("data-selected", "true");
        await page.getByTestId("generate-new-draft").click();
        await expect(card).toHaveAttribute("data-selected", "false");
        await expect(page.getByTestId("generate-new-draft")).toHaveCount(0);

        const report = await holdNextCheckReport(page);
        let stoppedId: string;
        try {
          const run = await sendRequest(page, stoppedName);
          expect(run.conversationId).toBe(conversationId);
          expect(run.body).not.toHaveProperty("draft_id");
          const added = page.locator(
            `[data-testid="generate-draft-card"]:not([data-draft-id="${draftId}"])`,
          );
          await expect(added).toHaveCount(1, { timeout: 30_000 });
          const addedId = await added.getAttribute("data-draft-id");
          if (!addedId) throw new Error("The new draft card names no draft.");
          stoppedId = addedId;
          const stoppedCard = draftCard(page, stoppedId);
          await expect
            .poll(() => report.isHeld(), {
              message: "the page sends its check report while the run waits",
              timeout: 60_000,
            })
            .toBe(true);
          await expect(stop).toBeVisible();
          await expect(send).toHaveCount(0);
          await expect(page.getByTestId("generate-progress")).toHaveAttribute(
            "data-phase",
            "checking",
          );
          await expect(draftStatus(stoppedCard)).toHaveAttribute(
            "data-status",
            "checking",
          );
          // A run in flight holds Save and the model, and Discard on the draft
          // it is working on; another draft can still be discarded.
          await expect(card.getByTestId("generate-draft-save")).toBeDisabled();
          await expect(modelControl).toBeDisabled();
          await expect(
            stoppedCard.getByTestId("generate-draft-discard"),
          ).toBeDisabled();
          await expect(
            card.getByTestId("generate-draft-discard"),
          ).toBeEnabled();

          await stop.click();
          await expect(stop).toHaveCount(0);
          await expect(send).toBeVisible();
          await expect(page.getByTestId("generate-failure")).toHaveCount(0);
          await expect(conversation.getByText(STOPPED_TEXT)).toBeVisible();
          // The backend has settled the stopped run and stored its turn.
          await expect
            .poll(
              async () => {
                const last = (
                  await readConversation(page, conversationId)
                ).messages.at(-1);
                return last?.role === "assistant" ? last.data.outcome : null;
              },
              { message: "the stopped run's turn is stored", timeout: 20_000 },
            )
            .toBe("stopped");
        } finally {
          await report.release();
        }
        // Released with no run in flight, the report itself settles the draft.
        await expect(draftStatus(draftCard(page, stoppedId))).toHaveAttribute(
          "data-status",
          SETTLED,
          { timeout: 30_000 },
        );
        return stoppedId;
      });
    const stoppedCard = draftCard(page, stoppedDraftId);

    await test.step("Reload and find the conversation and its unsaved draft", async () => {
      await page.reload();
      await expect(card).toBeVisible({ timeout: 45_000 });
      await expect(cards).toHaveCount(2);
      for (const text of [name, REVISION_TEXT, stoppedName])
        await expect(
          conversation.getByText(text, { exact: true }),
        ).toBeVisible();
      // The stored turn says how its run ended; no run state survives a reload.
      await expect(conversation.getByText(STOPPED_TEXT)).toBeVisible();
      await expect(page.getByTestId("generate-stopped")).toHaveCount(0);
      await expect(send).toBeVisible();
      await expect(stop).toHaveCount(0);

      await expect(draftStatus(stoppedCard)).toHaveAttribute(
        "data-status",
        SETTLED,
      );
      await expect(stoppedCard.getByTestId("generate-draft-saved")).toHaveCount(
        0,
      );
      await expect(stoppedCard.getByTestId("generate-draft-save")).toHaveText(
        "Save",
      );
      await expect(stoppedCard).toHaveAttribute("data-selected", "true");
      await expect(stage).toHaveAttribute("data-draft-id", stoppedDraftId, {
        timeout: 30_000,
      });
      await expect(card.getByTestId("generate-draft-saved-link")).toBeVisible();
    });

    await test.step("Discard the unsaved draft, then the conversation", async () => {
      await stoppedCard.getByTestId("generate-draft-discard").click();
      const draftDialog = page.getByTestId("generate-draft-discard-dialog");
      await expect(draftDialog).toBeVisible();
      await expect(draftDialog).toContainText(stoppedName);
      await page.getByTestId("generate-draft-discard-confirm").click();
      await expect(draftDialog).toBeHidden();
      await expect(stoppedCard).toHaveCount(0);
      await expect(cards).toHaveCount(1);
      expect(
        (await readConversation(page, conversationId)).drafts.map(
          (draft) => draft.id,
        ),
      ).toEqual([draftId]);

      await page.getByTestId("generate-conversations-menu").click();
      await expect(
        page.locator(
          `[data-testid="generate-conversation-item"][data-conversation-id="${conversationId}"]`,
        ),
      ).toHaveAttribute("aria-checked", "true");
      await page.getByTestId("generate-conversation-discard").click();
      const conversationDialog = page.getByTestId(
        "generate-conversation-discard-dialog",
      );
      await expect(conversationDialog).toBeVisible();
      await page.getByTestId("generate-conversation-discard-confirm").click();
      await expect(conversationDialog).toBeHidden();
      await expect(card).toHaveCount(0);
      await expect(conversation.getByText(name, { exact: true })).toHaveCount(
        0,
      );
      await expect
        .poll(
          async () =>
            (
              await page.request.get(
                `/v1/generation/conversations/${encodeURIComponent(conversationId)}`,
              )
            ).status(),
          { message: "the conversation is deleted" },
        )
        .toBe(404);
    });

    await test.step("Find the saved Gesture still in the Library", async () => {
      // Discarding a conversation removes its drafts, never a saved item.
      const saved = savedClip(
        await creatorContent.verifyOwnedContent(plan, item),
      );
      // What was saved is the revised draft.
      expect(beatFacts(saved)).toEqual(beatFacts(revised));
      expect(saved.duration).toBeCloseTo(revised.duration, 3);
    });
  } catch (error) {
    // Report the journey's own failure ahead of any cleanup failure.
    failure = error;
  } finally {
    try {
      const cleanup = await creatorContent.cleanupOwnedContent();
      if (owned) {
        expect(cleanup).toMatchObject({ attempted: 1, deleted: 1, failed: 0 });
        await creatorContent.assertDeletedContent(plan, owned);
      }
      await creatorContent.assertLocalCatalogUnchanged(
        catalogBefore,
        animamaEvidence,
        JOURNEY_KEY,
      );
      await creatorContent.assertAnimaLoadoutUnchanged(
        loadoutBefore,
        animamaEvidence,
      );
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
});

/**
 * A Gesture this journey means to save: the draft it comes from, and the
 * ledger's plan for the Local item its Save creates.
 */
type PlannedSave = {
  draftId: string;
  name: string;
  plan: CreatorContentPlan;
};

/**
 * Plan the Local Gesture a draft's Save creates, before anything is saved:
 * the name must be one the Library saves under, and nothing may hold its
 * logical key or its place below the Local root yet.
 */
async function planDraftSave(args: {
  creatorContent: CreatorContentFixture;
  draft: PyGenerationDraft | undefined;
  evidence: EvidenceAttachment;
  journeyKey: string;
}): Promise<PlannedSave> {
  const { creatorContent, draft, evidence, journeyKey } = args;
  if (!draft) throw new Error(`${journeyKey} found no draft to save.`);
  const name = draftProjectName(draft);
  // Checked here, where it reads plainly, and not left to a refused save.
  expect(
    name,
    "the Library can save an item under the name the draft was given",
  ).toMatch(LIBRARY_ENTRY_NAME);
  const logicalKey = gestureLogicalKey(name);
  const preflight = await creatorContent.preflightContentAbsence({
    logicalKey,
    expectedRelativePath: gestureRelativePath(name),
  });
  await evidence.attachJson(`${journeyKey}-preflight`, preflight);
  const plan = await creatorContent.planContent({
    journeyKey,
    kind: "gesture",
    entryName: name,
    logicalKey,
  });
  return { draftId: draft.id, name, plan };
}

/**
 * What every journey here leaves behind is removed: the Local items the
 * ledger owns, exactly, then the conversation with its drafts. Returns the
 * first failure, so the journey's own failure can be reported ahead of it.
 */
async function cleanUpJourney(args: {
  animamaEvidence: EvidenceAttachment;
  catalogBefore: LocalCatalogSnapshot;
  conversationId: string | null;
  creatorContent: CreatorContentFixture;
  journeyKey: string;
  loadoutBefore: AnimaLoadoutSnapshot;
  owned: ReadonlyArray<{ plan: CreatorContentPlan; identity: OwnedGesture }>;
  page: Page;
}): Promise<unknown> {
  const { animamaEvidence, creatorContent, journeyKey, owned, page } = args;
  let failure: unknown = null;
  try {
    const cleanup = await creatorContent.cleanupOwnedContent();
    if (owned.length > 0) {
      expect(cleanup).toMatchObject({
        attempted: owned.length,
        deleted: owned.length,
        failed: 0,
      });
      for (const { plan, identity } of owned)
        await creatorContent.assertDeletedContent(plan, identity);
    }
    await creatorContent.assertLocalCatalogUnchanged(
      args.catalogBefore,
      animamaEvidence,
      journeyKey,
    );
    await creatorContent.assertAnimaLoadoutUnchanged(
      args.loadoutBefore,
      animamaEvidence,
    );
  } catch (error) {
    failure = error;
  }
  // After the Library items, and on its own: a conversation that cannot be
  // removed must not keep the items from being cleaned up.
  try {
    if (args.conversationId) {
      const status = await deleteConversation(page, args.conversationId);
      await animamaEvidence.attachJson(`${journeyKey}-conversation-removed`, {
        conversationId: args.conversationId,
        status,
      });
      expect([204, 404]).toContain(status);
    }
  } catch (error) {
    failure ??= error;
  }
  return failure;
}

test(`${BATCH_JOURNEY_KEY} @generate @surface-generate @channel-gesture @writes-local`, async ({
  animamaEvidence,
  creatorContent,
  page,
}) => {
  // Three items, two at a time, each with the page's checks and review
  // sheets, then two saves.
  test.setTimeout(480_000);
  const digits = runDigits(requiredEnvironment("ANIMAMA_E2E_RUN_ID"));
  const apiOrigin = new URL(requiredEnvironment("ANIMAMA_E2E_API_URL")).origin;
  // The deterministic author plans the three items and fails the second.
  const request = `Waves-${digits} batch of 3 and item 2 fails`;
  const catalogBefore = await creatorContent.snapshotLocalCatalog();
  const animaId = await selectAnnieFromSidebar(page);
  const loadoutBefore = await creatorContent.snapshotAnimaLoadout(animaId);
  const owned: Array<{ plan: CreatorContentPlan; identity: OwnedGesture }> = [];
  let conversationId: string | null = null;
  let failure: unknown = null;

  const cards = page.getByTestId("generate-draft-card");
  const send = page.getByTestId("generate-send");
  const stop = page.getByTestId("generate-stop");

  try {
    const modelId =
      await test.step("Open Generate on an empty conversation", () =>
        openEmptyConversation(page, animamaEvidence, BATCH_JOURNEY_KEY));

    const draftIds =
      await test.step("Ask for a batch of three and watch each item", async () => {
        const run = await sendRequest(page, request);
        conversationId = run.conversationId;
        expect(run.body).toMatchObject({
          message: request,
          model_provider_id: modelId,
          intent: "gesture",
        });
        expect(run.body).not.toHaveProperty("draft_id");

        // Every planned item is listed at once, with its own brief.
        await expect(cards).toHaveCount(3, { timeout: 30_000 });
        const ids: string[] = [];
        for (const index of [0, 1, 2]) {
          const card = cards.nth(index);
          await expect(card.getByTestId("generate-draft-brief")).toContainText(
            `Item ${index + 1}`,
          );
          const id = await card.getAttribute("data-draft-id");
          if (!id) throw new Error("A planned draft card names no draft.");
          ids.push(id);
        }
        expect(new Set(ids).size).toBe(3);

        // The second item fails; the others go on and settle.
        await expect(draftStatus(draftCard(page, ids[1]!))).toHaveAttribute(
          "data-status",
          "failed",
          { timeout: BATCH_SETTLE_TIMEOUT_MS },
        );
        for (const id of [ids[0]!, ids[2]!])
          await expect(draftStatus(draftCard(page, id))).toHaveAttribute(
            "data-status",
            SETTLED,
            { timeout: BATCH_SETTLE_TIMEOUT_MS },
          );
        // One run for the whole batch: it has ended.
        await expect(send).toBeVisible({ timeout: 30_000 });
        await expect(stop).toHaveCount(0);
        return ids;
      });
    const failedCard = draftCard(page, draftIds[1]!);
    const writtenIds = [draftIds[0]!, draftIds[2]!];

    const planned =
      await test.step("Find two drafts that load and one that failed", async () => {
        if (!conversationId) throw new Error("No conversation was opened.");
        const snapshot = await readConversation(page, conversationId);
        expect(snapshot.drafts).toHaveLength(3);
        const byId = new Map(snapshot.drafts.map((draft) => [draft.id, draft]));
        // The failed item never had a clip: nothing of it can be saved.
        expect(byId.get(draftIds[1]!)).toMatchObject({
          status: "failed",
          project: null,
          failure_reason: "generation_no_valid_draft",
          saved_item_id: null,
        });
        await expect(
          failedCard.getByTestId("generate-draft-failure"),
        ).toBeVisible();
        await expect(failedCard.getByTestId("generate-draft-save")).toHaveCount(
          0,
        );
        await expect(failedCard.getByTestId("generate-draft-mark")).toHaveCount(
          0,
        );
        for (const id of writtenIds) {
          const draft = byId.get(id);
          expect(draft).toMatchObject({
            checked_version: draft?.version,
            check_report: { loadable: true },
            saved_item_id: null,
          });
          await expect(
            draftCard(page, id).getByTestId("generate-draft-save"),
          ).toBeEnabled();
        }
        await animamaEvidence.attachJson(`${BATCH_JOURNEY_KEY}-drafts`, {
          conversationId,
          drafts: snapshot.drafts.map((draft) => ({
            id: draft.id,
            status: draft.status,
            failureReason: draft.failure_reason,
            version: draft.version,
          })),
        });
        // Each saved draft is its own Local item, planned on its own.
        const plans: PlannedSave[] = [];
        for (const [index, id] of writtenIds.entries())
          plans.push(
            await planDraftSave({
              creatorContent,
              draft: byId.get(id),
              evidence: animamaEvidence,
              journeyKey: `${BATCH_JOURNEY_KEY}-item-${index === 0 ? 1 : 3}`,
            }),
          );
        expect(new Set(plans.map(({ plan }) => plan.logicalKey)).size).toBe(2);
        return plans;
      });

    await test.step("Save all: the two drafts are saved and the failed item is skipped", async () => {
      // Nothing the assistant did wrote to the Library.
      await creatorContent.assertLocalCatalogUnchanged(
        catalogBefore,
        animamaEvidence,
        `${BATCH_JOURNEY_KEY}-before-save`,
      );
      const saves = planned.map(({ name }) =>
        page.waitForResponse(
          (response) => isGestureSave(response, apiOrigin, name),
          { timeout: 60_000 },
        ),
      );
      await page.getByTestId("generate-drafts-save-all").click();
      const answers = await Promise.allSettled(saves);
      // Every item the Library took is recorded before anything is asserted,
      // so cleanup owns it whatever fails next.
      const refused: string[] = [];
      for (const [index, answer] of answers.entries()) {
        const { name, plan } = planned[index]!;
        if (answer.status !== "fulfilled" || !answer.value.ok()) {
          refused.push(
            answer.status === "fulfilled"
              ? `${name}: HTTP ${answer.value.status()}`
              : `${name}: no save request`,
          );
          continue;
        }
        const identity = await savedGesture(answer.value);
        await creatorContent.recordOwnedContent(plan, identity);
        owned.push({ plan, identity });
      }
      expect(refused, "the Library saved both drafts").toEqual([]);

      const summary = page.getByTestId("generate-drafts-save-summary");
      await expect(summary).toBeVisible({ timeout: 60_000 });
      await expect(summary).toHaveAttribute("data-saved", "2");
      await expect(summary).toHaveAttribute("data-failed", "0");
      // The failed item is the one draft that cannot be saved as it stands.
      await expect(summary).toHaveAttribute("data-skipped", "1");
      for (const id of writtenIds)
        await expect(
          draftCard(page, id).getByTestId("generate-draft-saved-link"),
        ).toBeVisible({ timeout: 15_000 });
      await expect(failedCard.getByTestId("generate-draft-saved")).toHaveCount(
        0,
      );
      await expect(
        failedCard.getByTestId("generate-draft-save-failed"),
      ).toHaveCount(0);
      await expect(
        failedCard.getByTestId("generate-draft-failure"),
      ).toBeVisible();
    });

    await test.step("Find exactly the two Gestures in the Library", async () => {
      if (!conversationId) throw new Error("No conversation was opened.");
      for (const { plan, identity } of owned)
        await creatorContent.verifyOwnedContent(plan, identity);
      const catalogAfter = await creatorContent.snapshotLocalCatalog();
      const before = new Set(catalogBefore.items.map(({ itemId }) => itemId));
      const added = catalogAfter.items.filter(
        ({ itemId }) => !before.has(itemId),
      );
      // Two Local Gestures, and nothing for the item that failed.
      expect(added.map(({ kind }) => kind)).toEqual(["gesture", "gesture"]);
      expect(added.map(({ itemId }) => itemId).sort()).toEqual(
        owned.map(({ identity }) => identity.itemId).sort(),
      );
      expect(catalogAfter.itemCount).toBe(catalogBefore.itemCount + 2);
      // Each draft records the item it was saved as; the failed one none.
      const snapshot = await readConversation(page, conversationId);
      const savedAs = new Map(
        snapshot.drafts.map((draft) => [draft.id, draft.saved_item_id]),
      );
      for (const [index, { draftId }] of planned.entries())
        expect(savedAs.get(draftId)).toBe(owned[index]!.identity.itemId);
      expect(savedAs.get(draftIds[1]!)).toBeNull();
    });
  } catch (error) {
    // Report the journey's own failure ahead of any cleanup failure.
    failure = error;
  }
  const cleanupFailure = await cleanUpJourney({
    animamaEvidence,
    catalogBefore,
    conversationId,
    creatorContent,
    journeyKey: BATCH_JOURNEY_KEY,
    loadoutBefore,
    owned,
    page,
  });
  failure ??= cleanupFailure;
  if (failure) throw failure;
});

test(`${EFFECT_JOURNEY_KEY} @generate @surface-generate @channel-gesture @writes-local`, async ({
  animamaEvidence,
  creatorContent,
  page,
}) => {
  // One run with the page's checks and review sheets, and one save.
  test.setTimeout(300_000);
  const digits = runDigits(requiredEnvironment("ANIMAMA_E2E_RUN_ID"));
  const apiOrigin = new URL(requiredEnvironment("ANIMAMA_E2E_API_URL")).origin;
  // The deterministic author names the draft after its request and places
  // the first Avatar Effect the Library lists.
  const name = `Sparkle-${digits} with an effect`;
  const catalogBefore = await creatorContent.snapshotLocalCatalog();
  const animaId = await selectAnnieFromSidebar(page);
  const loadoutBefore = await creatorContent.snapshotAnimaLoadout(animaId);
  const owned: Array<{ plan: CreatorContentPlan; identity: OwnedGesture }> = [];
  let conversationId: string | null = null;
  let failure: unknown = null;

  const cards = page.getByTestId("generate-draft-card");

  try {
    const modelId =
      await test.step("Open Generate on an empty conversation", () =>
        openEmptyConversation(page, animamaEvidence, EFFECT_JOURNEY_KEY));

    const written =
      await test.step("Ask for a Gesture with an effect and watch the draft settle", async () => {
        const run = await sendRequest(page, name);
        conversationId = run.conversationId;
        expect(run.body).toMatchObject({
          message: name,
          model_provider_id: modelId,
          intent: "gesture",
        });
        await expect(cards).toHaveCount(1, { timeout: 30_000 });
        const draftId = await cards.getAttribute("data-draft-id");
        if (!draftId) throw new Error("The draft card names no draft.");
        const card = draftCard(page, draftId);
        await expect(draftStatus(card)).toHaveAttribute(
          "data-status",
          SETTLED,
          { timeout: SETTLE_TIMEOUT_MS },
        );
        await expectRunEnded(page);

        const snapshot = await readConversation(page, run.conversationId);
        const draft = snapshot.drafts.find((entry) => entry.id === draftId);
        expect(draft).toMatchObject({
          checked_version: draft?.version,
          check_report: { loadable: true },
          saved_item_id: null,
        });
        // Whichever Avatar Effect the Library lists first: the draft says
        // which, so nothing here names one.
        const dependencies = draftDependencies(draft);
        expect(
          dependencies,
          "the stack's Library lists a portable Avatar Effect to place",
        ).toHaveLength(1);
        const dependency = dependencies[0]!;
        expect(dependency).toMatchObject({
          content_type: "avatar_effect",
          source: { type: "catalog" },
        });
        expect(dependency.alias).toBeTruthy();
        expect(dependency.source.catalog_item_id).toBeTruthy();
        // One event from the clip's start plays that effect, by its alias.
        const events = draftClip(draft).events ?? [];
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          kind: "avatar_vfx",
          effectId: dependency.alias,
          time: 0,
        });
        await animamaEvidence.attachJson(`${EFFECT_JOURNEY_KEY}-draft`, {
          conversationId: run.conversationId,
          draftId,
          status: draft?.status,
          dependency,
          event: events[0],
        });

        // The card says what the draft plays, and the effect is still there.
        await expect(card.getByTestId("generate-draft-effects")).toContainText(
          dependency.alias,
        );
        await expect(
          card.getByTestId("generate-draft-missing-effects"),
        ).toHaveCount(0);
        await expect(card.getByTestId("generate-draft-save")).toBeEnabled();
        const planned = await planDraftSave({
          creatorContent,
          draft,
          evidence: animamaEvidence,
          journeyKey: EFFECT_JOURNEY_KEY,
        });
        expect(planned.name).toBe(name);
        return { card, dependency, event: events[0]!, planned };
      });

    await test.step("Save the draft and find its effect saved with it", async () => {
      const { card, dependency, event, planned } = written;
      await creatorContent.assertLocalCatalogUnchanged(
        catalogBefore,
        animamaEvidence,
        `${EFFECT_JOURNEY_KEY}-before-save`,
      );
      const saved = page.waitForResponse(
        (response) => isGestureSave(response, apiOrigin, planned.name),
        { timeout: 30_000 },
      );
      await card.getByTestId("generate-draft-save").click();
      const response = await saved;
      expect(
        response.ok(),
        `the Gesture save answered HTTP ${response.status()}`,
      ).toBe(true);
      const identity = await savedGesture(response);
      // Recorded before anything else can fail, so cleanup owns the item.
      await creatorContent.recordOwnedContent(planned.plan, identity);
      owned.push({ plan: planned.plan, identity });
      await expect(card.getByTestId("generate-draft-saved-link")).toBeVisible({
        timeout: 15_000,
      });

      // The saved clip still plays the effect from its start.
      const clip = savedClip(
        await creatorContent.verifyOwnedContent(planned.plan, identity),
      );
      expect(clip.events ?? []).toHaveLength(1);
      expect(clip.events![0]).toMatchObject({
        kind: "avatar_vfx",
        effectId: dependency.alias,
        time: event.time,
        // As long as the draft's event said the effect shows.
        ...(event.duration === undefined ? {} : { duration: event.duration }),
      });

      // And the saved Gesture depends on that Avatar Effect, under the alias
      // its event names.
      const read = await page.request.get(
        `/v1/gestures/${encodeURIComponent(identity.itemId)}`,
      );
      expect(
        read.ok(),
        `the saved Gesture read answered HTTP ${read.status()}`,
      ).toBe(true);
      const gesture = (await read.json()) as {
        source?: string;
        dependencies?: Array<{
          alias?: string | null;
          kind?: string;
          ref?: string;
          item_id?: string | null;
        }>;
      };
      await animamaEvidence.attachJson(`${EFFECT_JOURNEY_KEY}-saved`, {
        itemId: identity.itemId,
        dependencies: gesture.dependencies ?? [],
        events: clip.events ?? [],
      });
      expect(gesture.source).toBe("local");
      expect(gesture.dependencies ?? []).toHaveLength(1);
      const savedDependency = gesture.dependencies![0]!;
      expect(savedDependency).toMatchObject({
        alias: dependency.alias,
        kind: "avatar_effect",
      });
      // It names the very effect the draft pinned: by the Library item, or
      // by the reference the save wrote for it.
      expect(
        savedDependency.item_id === dependency.source.catalog_item_id ||
          [
            dependency.source.logical_key,
            dependency.source.catalog_item_id,
          ].includes(savedDependency.ref),
        "the saved dependency names the Avatar Effect the draft pinned",
      ).toBe(true);
    });
  } catch (error) {
    // Report the journey's own failure ahead of any cleanup failure.
    failure = error;
  }
  const cleanupFailure = await cleanUpJourney({
    animamaEvidence,
    catalogBefore,
    conversationId,
    creatorContent,
    journeyKey: EFFECT_JOURNEY_KEY,
    loadoutBefore,
    owned,
    page,
  });
  failure ??= cleanupFailure;
  if (failure) throw failure;
});
