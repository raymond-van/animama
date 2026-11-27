import type {
  PyGenerationConversation,
  PyGenerationConversationSnapshot,
} from "@animama/runtime-contracts/api-types";
import type { Locator, Page, Response } from "playwright/test";

import { expect, test, type CreatorContentPlan } from "../fixtures/animama";
import { selectAnnieFromSidebar } from "../helpers/preview-surfaces";

/**
 * The Generate control of the Gesture and Reaction creators: write an item on
 * the Generate page and save it, open the saved Local item in its creator,
 * revise it through the assistant's panel there, and save it with the
 * creator's own Save, which keeps the item's identity. A reload finds the
 * item's conversation again.
 *
 * Needs a stack started with `ANIMAMA_LLM_SKIP`: the backend's deterministic
 * author stands in for the model. It writes the packaged example of the kind
 * asked for, and a revision lengthens the ending by 0.2 seconds. The page's
 * validation, checks and review sheets are real.
 */
const JOURNEY_KEY = "creator-generate-panel";

const RUN_PATH = /^\/v1\/generation\/conversations\/([^/]+)\/runs:sse$/;
/** Where a run leaves a draft that loads; `failed` is not expected here. */
const SETTLED = /^(?:ready|warnings)$/;
/** A run waits two minutes for the page's check report; sooner means checked. */
const SETTLE_TIMEOUT_MS = 90_000;
/** What the deterministic author adds to a clip's duration on a revision. */
const LENGTHENED_SECONDS = 0.2;
const REVISION_TEXT = "Hold the ending a little longer";

type Kind = "gesture" | "reaction";
type OwnedItem = { itemId: string; revisionSha256: string };
type SavedClip = { duration: number; beats: unknown[] };

const KINDS = {
  gesture: {
    label: "Gesture",
    routes: "gestures",
    revises: "Your request changes the Gesture open here. Undo puts it back.",
  },
  reaction: {
    label: "Reaction",
    routes: "reactions",
    revises: "Your request changes the Reaction open here. Undo puts it back.",
  },
} as const;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for ${JOURNEY_KEY}.`);
  return value;
}

/** The run's ten-digit timestamp, which makes this run's names unique. */
function runDigits(runId: string): string {
  const match = /(\d{10})$/.exec(runId);
  if (!match?.[1])
    throw new Error(`${JOURNEY_KEY} requires a timestamped run; got ${runId}.`);
  return match[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A Save of the named item, from the Generate page or from its creator. */
function isItemSave(
  response: Response,
  apiOrigin: string,
  kind: Kind,
  entryName: string,
): boolean {
  if (response.request().method() !== "PUT") return false;
  const url = new URL(response.url());
  const entry = new RegExp(`^/v1/${KINDS[kind].routes}/([^/:]+)$`).exec(
    url.pathname,
  )?.[1];
  if (url.origin !== apiOrigin || !entry) return false;
  try {
    return decodeURIComponent(entry) === entryName;
  } catch {
    return false;
  }
}

async function savedIdentity(response: Response): Promise<OwnedItem> {
  expect(response.ok(), `the save answered HTTP ${response.status()}`).toBe(
    true,
  );
  const body = (await response.json()) as Record<string, unknown>;
  return {
    itemId: String(body.item_id ?? ""),
    revisionSha256: String(body.revision_sha256 ?? ""),
  };
}

async function readConversations(
  page: Page,
): Promise<PyGenerationConversation[]> {
  const response = await page.request.get("/v1/generation/conversations");
  if (!response.ok())
    throw new Error(
      `The conversation list failed with HTTP ${response.status()}.`,
    );
  return (
    (await response.json()) as { conversations: PyGenerationConversation[] }
  ).conversations;
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

/** Type a request into `within`, send it, and return the run request made. */
async function sendRequest(
  page: Page,
  within: Locator,
  message: string,
): Promise<{ conversationId: string; body: Record<string, unknown> }> {
  const started = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      RUN_PATH.test(new URL(request.url()).pathname),
  );
  await within.getByTestId("generate-request").fill(message);
  await within.getByTestId("generate-send").click();
  const request = await started;
  const conversationId = RUN_PATH.exec(new URL(request.url()).pathname)?.[1];
  if (!conversationId)
    throw new Error("The run request names no conversation.");
  return {
    conversationId: decodeURIComponent(conversationId),
    body: request.postDataJSON() as Record<string, unknown>,
  };
}

/** Send is back in place of Stop, and the run left no failure. */
async function expectRunEnded(within: Locator): Promise<void> {
  await expect(within.getByTestId("generate-send")).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
  await expect(within.getByTestId("generate-stop")).toHaveCount(0);
  await expect(within.getByTestId("generate-failure")).toHaveCount(0);
}

function clipOf(snapshot: PyGenerationConversationSnapshot): SavedClip {
  const sequence = (
    snapshot.drafts.at(-1)?.project as unknown as
      | { sequence?: SavedClip }
      | null
      | undefined
  )?.sequence;
  if (!sequence) throw new Error("The conversation's draft holds no clip.");
  return sequence;
}

for (const kind of ["gesture", "reaction"] as const) {
  const names = KINDS[kind];
  test(`${JOURNEY_KEY}-${kind} @generate @surface-creator @channel-${kind} @writes-local`, async ({
    animamaEvidence,
    creatorContent,
    page,
  }) => {
    // Two runs with the page's checks, the creator and a reload do not fit
    // the 90 s default.
    test.setTimeout(420_000);
    const digits = runDigits(requiredEnvironment("ANIMAMA_E2E_RUN_ID"));
    const apiOrigin = new URL(requiredEnvironment("ANIMAMA_E2E_API_URL"))
      .origin;
    // The deterministic author names a draft after its request.
    const name = `${kind === "gesture" ? "Lean" : "Gasp"}-${digits}`;
    const slug = name.toLowerCase();
    const logicalKey = `local:${kind}:${slug}`;
    const journeyKey = `${JOURNEY_KEY}-${kind}`;
    const catalogBefore = await creatorContent.snapshotLocalCatalog();
    const preflight = await creatorContent.preflightContentAbsence({
      logicalKey,
      expectedRelativePath: `${names.routes}/${slug}`,
    });
    await animamaEvidence.attachJson(`${journeyKey}-preflight`, preflight);
    const animaId = await selectAnnieFromSidebar(page);
    const loadoutBefore = await creatorContent.snapshotAnimaLoadout(animaId);
    const plan: CreatorContentPlan = await creatorContent.planContent({
      journeyKey,
      kind,
      entryName: name,
      logicalKey,
    });
    let owned: OwnedItem | null = null;
    let failure: unknown = null;
    /** The assistant conversations this journey started, removed at its end. */
    const conversations = new Set<string>();

    const generatePage = page.getByTestId("generate-conversation");
    const panel = page.getByTestId("creator-generate-panel");
    const toggle = page.getByTestId("creator-generate-toggle");

    try {
      const written =
        await test.step(`Write a ${names.label} on Generate and save it`, async () => {
          await page.goto("/generate");
          const setup = page.getByTestId("generate-setup");
          await expect(setup.or(generatePage)).toBeVisible({ timeout: 30_000 });
          // A fresh installation has no saved choice and shows setup.
          if (await setup.isVisible())
            await setup.getByTestId("generate-model-option").first().click();
          await expect(generatePage).toBeVisible({ timeout: 30_000 });
          // Start from an empty conversation, whatever an earlier run left.
          const newConversation = page.getByTestId("generate-new-conversation");
          await expect(
            page
              .getByTestId("generate-drafts-empty")
              .or(page.getByTestId("generate-drafts")),
          ).toBeVisible({ timeout: 30_000 });
          if (await newConversation.isEnabled()) {
            const created = page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname ===
                  "/v1/generation/conversations" &&
                response.ok(),
            );
            await newConversation.click();
            await created;
          }
          // A new draft is a Gesture unless the person chooses a Reaction.
          const kindChoice = page.getByTestId("generate-draft-kind");
          await expect(kindChoice).toHaveAttribute("data-kind", "gesture");
          if (kind === "reaction") {
            await page.getByTestId("generate-kind-reaction").click();
            await expect(kindChoice).toHaveAttribute("data-kind", "reaction");
          }

          const run = await sendRequest(page, generatePage, name);
          conversations.add(run.conversationId);
          expect(run.body).toMatchObject({ message: name, intent: kind });
          expect(run.body).not.toHaveProperty("document");
          const card = page.getByTestId("generate-draft-card");
          await expect(card).toHaveCount(1, { timeout: 30_000 });
          await expect(
            card.getByTestId("generate-draft-status"),
          ).toHaveAttribute("data-status", SETTLED, {
            timeout: SETTLE_TIMEOUT_MS,
          });
          await expectRunEnded(generatePage);
          await expect(card.getByTestId("generate-draft-kind")).toHaveAttribute(
            "data-intent",
            kind,
          );
          if (kind === "reaction")
            // The draft card says where the Reaction suggests it fits.
            await expect(card.getByTestId("generate-draft-kind")).toContainText(
              /^Reaction · .+ · .+$/,
            );

          const saved = page.waitForResponse(
            (response) => isItemSave(response, apiOrigin, kind, name),
            { timeout: 30_000 },
          );
          await card.getByTestId("generate-draft-save").click();
          const identity = await savedIdentity(await saved);
          // Recorded before anything else can fail, so cleanup owns the item.
          await creatorContent.recordOwnedContent(plan, identity);
          owned = identity;
          const clip = clipOf(await readConversation(page, run.conversationId));
          return { identity, clip, card };
        });

      await test.step(`Open the saved ${names.label} in its creator`, async () => {
        const savedLink = written.card.getByTestId("generate-draft-saved-link");
        await expect(savedLink).toBeVisible({ timeout: 15_000 });
        await savedLink.click();
        await expect(page).toHaveURL(
          new RegExp(
            `/${names.routes}/${escapeRegExp(
              encodeURIComponent(written.identity.itemId),
            )}/edit(?:[?#]|$)`,
          ),
        );
        await expect(
          page.getByRole("textbox", { name: `${kind} name`, exact: true }),
        ).toHaveValue(name, { timeout: 30_000 });
        // The control sits in the creator; nothing of the assistant is
        // started until it is used.
        await expect(toggle).toBeVisible({ timeout: 30_000 });
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(panel).toHaveCount(0);
      });

      const revision =
        await test.step("Revise the open item through the assistant's panel", async () => {
          await toggle.click();
          await expect(panel).toBeVisible();
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          await expect(panel.getByTestId("generate-request")).toBeFocused({
            timeout: 30_000,
          });
          await expect(
            panel.getByTestId("creator-generate-note"),
          ).toContainText(names.revises);

          const run = await sendRequest(page, panel, REVISION_TEXT);
          conversations.add(run.conversationId);
          // The run starts from the creator's own document, not a stored draft.
          expect(run.body).toMatchObject({
            message: REVISION_TEXT,
            document: { schema: "animamaActionProject/1.0", intent: kind },
          });
          expect(run.body).not.toHaveProperty("draft_id");
          const sent = (
            run.body.document as { sequence: SavedClip; name: string }
          ).sequence;
          expect(sent.duration).toBeCloseTo(written.clip.duration, 3);
          await expectRunEnded(panel);
          await expect(
            panel.getByTestId("creator-generate-result"),
          ).toHaveAttribute("data-status", SETTLED, {
            timeout: SETTLE_TIMEOUT_MS,
          });
          // No result was refused: the timeline was left alone meanwhile.
          await expect(
            panel.getByTestId("creator-generate-note").getByRole("alert"),
          ).toHaveCount(0);

          const snapshot = await readConversation(page, run.conversationId);
          // The conversation belongs to this item, in this creator.
          expect(snapshot.conversation.scope).toEqual({
            kind: "creator",
            intent: kind,
            catalog_item_id: written.identity.itemId,
          });
          const result = clipOf(snapshot);
          expect(result.duration).toBeCloseTo(
            written.clip.duration + LENGTHENED_SECONDS,
            3,
          );
          await animamaEvidence.attachJson(`${journeyKey}-revision`, {
            conversationId: run.conversationId,
            sentDuration: sent.duration,
            resultDuration: result.duration,
          });
          return { conversationId: run.conversationId, clip: result };
        });

      await test.step("Close the panel with Escape and save with the creator's Save", async () => {
        // The assistant saved nothing: the Library item is as it was.
        await creatorContent.verifyOwnedContent(plan, written.identity);
        await panel.getByTestId("generate-request").press("Escape");
        await expect(panel).toBeHidden();
        await expect(toggle).toBeFocused();

        const saved = page.waitForResponse(
          (response) => isItemSave(response, apiOrigin, kind, name),
          { timeout: 30_000 },
        );
        await page.getByRole("button", { name: "Save content" }).click();
        const identity = await savedIdentity(await saved);
        // Recorded before anything else can fail: the ledger accepts a new
        // revision only as an update of the one it holds, and cleanup deletes
        // exactly the revision recorded last. It refuses another item id, so
        // this is also the proof that Save kept the item's identity.
        await creatorContent.recordOwnedContentRevision(
          plan,
          written.identity,
          identity,
        );
        owned = identity;
        // The same Library item, at a new revision.
        expect(identity.itemId).toBe(written.identity.itemId);
        expect(identity.revisionSha256).not.toBe(
          written.identity.revisionSha256,
        );
        const verified = await creatorContent.verifyOwnedContent(
          plan,
          identity,
        );
        const files = verified.files as unknown as {
          parsedJson: Record<string, unknown>;
        };
        const clip = Object.entries(files.parsedJson).find(
          ([path]) => path.endsWith(".json") && !path.endsWith(".meta.json"),
        )?.[1] as SavedClip | undefined;
        if (!clip) throw new Error("The saved item has no clip file.");
        // What was saved is the assistant's revision of the item.
        expect(clip.duration).toBeCloseTo(revision.clip.duration, 3);
        expect(clip.beats).toHaveLength(written.clip.beats.length);
      });

      await test.step("Reload and find the item's conversation again", async () => {
        await page.reload();
        await expect(toggle).toBeVisible({ timeout: 30_000 });
        await toggle.click();
        await expect(panel).toBeVisible();
        await expect(panel.getByTestId("generate-conversation")).toContainText(
          REVISION_TEXT,
          { timeout: 30_000 },
        );
        const ofItem = (await readConversations(page)).filter(
          ({ scope }) =>
            scope.kind === "creator" &&
            scope.intent === kind &&
            scope.catalog_item_id === written.identity.itemId,
        );
        // One conversation per item, found again and not started anew.
        expect(ofItem.map(({ id }) => id)).toEqual([revision.conversationId]);
      });
    } catch (error) {
      // Report the journey's own failure ahead of any cleanup failure.
      failure = error;
    } finally {
      try {
        const cleanup = await creatorContent.cleanupOwnedContent();
        if (owned) {
          expect(cleanup).toMatchObject({
            attempted: 1,
            deleted: 1,
            failed: 0,
          });
          await creatorContent.assertDeletedContent(plan, owned);
        }
        await creatorContent.assertLocalCatalogUnchanged(
          catalogBefore,
          animamaEvidence,
          journeyKey,
        );
        await creatorContent.assertAnimaLoadoutUnchanged(
          loadoutBefore,
          animamaEvidence,
        );
      } catch (error) {
        failure ??= error;
      }
      // After the Library item, and on its own: a conversation that cannot
      // be removed must not keep the item from being cleaned up.
      try {
        const removed: Record<string, number> = {};
        for (const id of conversations)
          removed[id] = await deleteConversation(page, id);
        await animamaEvidence.attachJson(
          `${journeyKey}-conversations-removed`,
          removed,
        );
        // Gone, or already gone with the page's own discard.
        for (const status of Object.values(removed))
          expect([204, 404]).toContain(status);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  });
}
