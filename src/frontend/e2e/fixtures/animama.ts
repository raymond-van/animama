import path from "node:path";
import { open } from "node:fs/promises";
import type {
  PortableAnima,
  ReviewedPackageImport,
} from "@animama/runtime-contracts/api-types";

import {
  expect,
  test as base,
  type ConsoleMessage,
  type Request,
  type Response,
  type TestInfo,
} from "playwright/test";

import {
  appendEvidenceJsonLine,
  ensurePrivateDirectory,
  redactEvidence,
  writePrivateJson,
} from "../../scripts/e2e/run-support.mjs";
import { cleanupOwnedContent as cleanupLedgerOwnedContent } from "../../scripts/e2e/content-cleanup.mjs";
import {
  appendContentLedgerEvent,
  readContentLedger,
} from "../../scripts/e2e/content-ledger.mjs";
import { resolvePackageImportOwnership } from "../../scripts/e2e/package-import-ownership.mjs";
import {
  PackageStageLedger,
  releasePackageStages,
} from "../../scripts/e2e/package-stages.mjs";
import {
  createLocalCatalogClient,
  localCatalogSnapshot,
  stableJsonSha256,
} from "../../scripts/e2e/local-catalog-client.mjs";
import {
  verifyExpectedLocalPathAbsent,
  verifyLocalCatalogItemFiles,
  verifyLocalItemDirectoryAbsent,
} from "../../scripts/e2e/local-content-verifier.mjs";

const EVIDENCE_FILENAMES = [
  "browser-console.jsonl",
  "page-errors.jsonl",
  "request-failures.jsonl",
  "http-errors.jsonl",
];

export type EvidenceAttachment = {
  attachJson(name: string, value: unknown): Promise<void>;
  attachBuffer(name: string, body: Buffer, contentType: string): Promise<void>;
};

export type CreatorContentKind =
  | "gesture"
  | "pose"
  | "reaction"
  | "particle_effect"
  | "avatar_effect"
  | "scene_effect";

type PackageContentKind =
  | CreatorContentKind
  | "avatar"
  | "appearance"
  | "idle_style"
  | "sound_effect"
  | "anima";

export type CreatorContentPlan = {
  runId: string;
  journeyKey: string;
  kind: PackageContentKind;
  entryName: string;
  logicalKey: string;
};

export type CreatorPackageImportPlan = Omit<
  CreatorContentPlan,
  "logicalKey"
> & {
  operationId: string;
  stageId: string;
  reviewDigest: string;
  entryId: string;
  packageEntries?: Array<{
    entryId: string;
    kind: string;
    name: string;
    selected: boolean;
  }>;
  packageAnima?: PortableAnima | null;
};

export type LocalCatalogSnapshot = {
  itemCount: number;
  sha256: string;
  items: Array<{
    itemId: string;
    kind: string;
    logicalKey: string | null;
    displayName: string;
    revisionSha256: string | null;
    relativeLocator: string;
  }>;
};

export type AnimaLoadoutSnapshot = {
  animaId: string;
  sha256: string;
};

type ContentLedgerEvidenceEvent = {
  event: string;
  journeyKey: string;
  itemId?: string;
  revisionSha256?: string;
  relativeLocator?: string;
};

export type CreatorContentFixture = {
  snapshotLocalCatalog(): Promise<LocalCatalogSnapshot>;
  preflightContentAbsence(input: {
    logicalKey: string;
    expectedRelativePath: string;
  }): Promise<Record<string, unknown>>;
  assertLocalCatalogUnchanged(
    before: LocalCatalogSnapshot,
    evidence: EvidenceAttachment,
    name?: string,
  ): Promise<void>;
  snapshotAnimaLoadout(animaId: string): Promise<AnimaLoadoutSnapshot>;
  assertAnimaLoadoutUnchanged(
    before: AnimaLoadoutSnapshot,
    evidence: EvidenceAttachment,
  ): Promise<void>;
  planContent(
    input: Omit<CreatorContentPlan, "runId">,
  ): Promise<CreatorContentPlan>;
  planPackageImport(
    input: Omit<CreatorPackageImportPlan, "runId">,
  ): Promise<CreatorPackageImportPlan>;
  planWholePackageImport(
    review: ReviewedPackageImport,
    journeyKey: string,
  ): Promise<CreatorPackageImportPlan[]>;
  resolvePackageImport(plan: CreatorPackageImportPlan): Promise<{
    plan: CreatorContentPlan;
    itemId: string;
    revisionSha256: string;
  }>;
  recordOwnedContent(
    plan: CreatorContentPlan,
    owned: {
      itemId: string;
      revisionSha256: string;
    },
  ): Promise<void>;
  recordOwnedContentRevision(
    plan: CreatorContentPlan,
    previous: { itemId: string; revisionSha256: string },
    updated: { itemId: string; revisionSha256: string },
  ): Promise<void>;
  verifyOwnedContent(
    plan: CreatorContentPlan,
    owned: { itemId: string; revisionSha256: string },
  ): Promise<{ item: Record<string, unknown>; files: Record<string, unknown> }>;
  cleanupOwnedContent(): Promise<Record<string, unknown>>;
  assertDeletedContent(
    plan: CreatorContentPlan,
    owned: { itemId: string; revisionSha256: string },
  ): Promise<Record<string, unknown>>;
};

type LocalCatalogClient = {
  listCatalog(): Promise<{ items: unknown[] }>;
  getItem(
    itemId: string,
    options?: { allowMissing?: boolean },
  ): Promise<Record<string, unknown> | null>;
  getAnimaLoadout(animaId: string): Promise<Record<string, unknown>>;
  getPackageOperation(operationId: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

type AnimamaFixtures = {
  animamaEvidence: EvidenceAttachment;
  captureBrowserEvidence: void;
  creatorContent: CreatorContentFixture;
  releaseOpenPackageStages: void;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} was not provided by the Animama E2E runner.`);
  }
  return value;
}

function eventBase(testInfo: TestInfo) {
  return {
    timestamp: new Date().toISOString(),
    runId: requiredEnvironment("ANIMAMA_E2E_RUN_ID"),
    test: testInfo.titlePath.join(" > "),
  };
}

function requestMetadata(request: Request) {
  return {
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
  };
}

export const test = base.extend<AnimamaFixtures>({
  animamaEvidence: async ({}, use, testInfo) => {
    await use({
      async attachJson(name, value) {
        await testInfo.attach(name, {
          body: Buffer.from(
            `${JSON.stringify(redactEvidence(value), null, 2)}\n`,
          ),
          contentType: "application/json",
        });
      },
      async attachBuffer(name, body, contentType) {
        await testInfo.attach(name, { body, contentType });
      },
    });
  },

  creatorContent: async ({}, use) => {
    const runId = requiredEnvironment("ANIMAMA_E2E_RUN_ID");
    const ledgerPath = requiredEnvironment("ANIMAMA_E2E_CONTENT_LEDGER");
    const cleanupSummaryPath = requiredEnvironment(
      "ANIMAMA_E2E_CLEANUP_SUMMARY",
    );
    const localRoot = requiredEnvironment("ANIMAMA_E2E_LOCAL_CONTENT_ROOT");
    const repositoryRoot = requiredEnvironment("ANIMAMA_E2E_REPOSITORY_ROOT");
    let client: LocalCatalogClient | null = null;

    const catalogClient = async () => {
      client ??= (await createLocalCatalogClient({
        apiUrl: requiredEnvironment("ANIMAMA_E2E_API_URL"),
      })) as LocalCatalogClient;
      return client;
    };

    // A timed-out explicit cleanup may still be running when teardown begins.
    // Both callers must await the same ledger pass before closing its client.
    let cleanupPromise: Promise<Record<string, unknown>> | null = null;
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        const summary = await cleanupLedgerOwnedContent({
          ledgerPath,
          catalogClient: await catalogClient(),
          localRoot,
          repositoryRoot,
          actor: "fixture",
        });
        await writePrivateJson(cleanupSummaryPath, {
          status: "complete",
          fixture: summary,
        });
        return summary;
      })().finally(() => {
        // A later explicit cleanup may own content created after this pass.
        cleanupPromise = null;
      });
      return cleanupPromise;
    };

    const readPlannedOwnedItem = async (
      plan: CreatorContentPlan,
      owned: { itemId: string; revisionSha256: string },
    ) => {
      if (plan.runId !== runId) {
        throw new Error("Creator ownership plan belongs to another run.");
      }
      const item = await (await catalogClient()).getItem(owned.itemId);
      if (!item) {
        throw new Error(
          "Saved creator content was not found by exact item ID.",
        );
      }
      if (
        item.source !== "local" ||
        item.origin !== "local" ||
        item.kind !== plan.kind ||
        item.logical_key !== plan.logicalKey ||
        item.revision_sha256 !== owned.revisionSha256
      ) {
        throw new Error(
          "Saved creator content does not match its planned Local identity.",
        );
      }
      if (
        typeof item.relative_locator !== "string" ||
        !item.relative_locator.trim()
      ) {
        throw new Error("Saved creator content omitted its catalog locator.");
      }
      return item;
    };

    const fixture: CreatorContentFixture = {
      async snapshotLocalCatalog() {
        return localCatalogSnapshot(
          await (await catalogClient()).listCatalog(),
        );
      },
      async preflightContentAbsence({ logicalKey, expectedRelativePath }) {
        const catalog = localCatalogSnapshot(
          await (await catalogClient()).listCatalog(),
        ) as LocalCatalogSnapshot;
        const matches = catalog.items.filter(
          (item) => item.logicalKey === logicalKey,
        );
        if (matches.length > 0) {
          throw new Error(
            `Generated Local logical key ${logicalKey} already exists; refusing to overwrite it.`,
          );
        }
        const host = await verifyExpectedLocalPathAbsent({
          expectedRelativePath,
          localRoot,
          repositoryRoot,
        });
        return {
          logicalKey,
          catalogMatchCount: 0,
          expectedRelativePath,
          host,
          cleanupAuthorityGranted: false,
        };
      },
      async assertLocalCatalogUnchanged(
        before,
        evidence,
        name = "local-catalog",
      ) {
        const after = localCatalogSnapshot(
          await (await catalogClient()).listCatalog(),
        );
        const unchanged = before.sha256 === after.sha256;
        await evidence.attachJson(`${name}-read-only-check`, {
          before,
          after,
          unchanged,
        });
        if (!unchanged) {
          throw new Error(
            "The neutral Local content catalog changed during the journey.",
          );
        }
      },
      async snapshotAnimaLoadout(animaId) {
        const loadout = await (await catalogClient()).getAnimaLoadout(animaId);
        return { animaId, sha256: stableJsonSha256(loadout) };
      },
      async assertAnimaLoadoutUnchanged(before, evidence) {
        // Require the exact original digest after bounded settling, retaining
        // every attempted digest as evidence rather than accepting a mismatch.
        const deadline = Date.now() + 5_000;
        const attempts: string[] = [];
        let after = await fixture.snapshotAnimaLoadout(before.animaId);
        attempts.push(after.sha256);
        while (before.sha256 !== after.sha256 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          after = await fixture.snapshotAnimaLoadout(before.animaId);
          attempts.push(after.sha256);
        }
        const unchanged = before.sha256 === after.sha256;
        await evidence.attachJson("annie-loadout-creator-check", {
          beforeSha256: before.sha256,
          afterSha256: after.sha256,
          attempts,
          unchanged,
        });
        if (!unchanged) {
          throw new Error(
            "Annie's loadout changed during the creator journey.",
          );
        }
      },
      async planContent(input) {
        const plan = { ...input, runId };
        await appendContentLedgerEvent(ledgerPath, {
          ...plan,
          event: "planned",
        });
        return plan;
      },
      async planPackageImport(input) {
        const plan = { ...input, runId };
        await appendContentLedgerEvent(ledgerPath, {
          ...plan,
          event: "import_planned",
        });
        return plan;
      },
      async planWholePackageImport(review, journeyKey) {
        const packageEntries = review.items.map((item) => ({
          entryId: item.entry_id,
          kind: item.kind,
          name: item.name,
          selected: item.selected,
        }));
        const choices = [
          ...review.items.map((item) => ({
            entryId: item.entry_id,
            kind: item.kind as PackageContentKind,
            name: item.name,
          })),
          ...(review.anima
            ? [
                {
                  entryId: "anima",
                  kind: "anima" as const,
                  name: review.anima.display_name,
                },
              ]
            : []),
        ];
        const plans = [];
        for (const [index, item] of choices.entries()) {
          plans.push(
            await fixture.planPackageImport({
              journeyKey: `${journeyKey}-${index}`,
              kind: item.kind,
              entryName: item.name,
              operationId: review.operation_id,
              stageId: review.stage_id,
              reviewDigest: review.review_digest,
              entryId: item.entryId,
              packageEntries,
              packageAnima: review.anima,
            }),
          );
        }
        return plans;
      },
      async resolvePackageImport(input) {
        if (input.runId !== runId)
          throw new Error("Package import plan belongs to another run.");
        const owned = await resolvePackageImportOwnership({
          ledgerPath,
          catalogClient: await catalogClient(),
          journeyKey: input.journeyKey,
        });
        const plan: CreatorContentPlan = {
          runId,
          journeyKey: owned.journeyKey,
          kind: owned.kind,
          entryName: owned.entryName,
          logicalKey: owned.logicalKey,
        };
        return {
          plan,
          itemId: owned.itemId,
          revisionSha256: owned.revisionSha256,
        };
      },
      async recordOwnedContent(plan, owned) {
        const item = await readPlannedOwnedItem(plan, owned);
        await appendContentLedgerEvent(ledgerPath, {
          ...plan,
          itemId: owned.itemId,
          revisionSha256: owned.revisionSha256,
          relativeLocator: item.relative_locator,
          event: "owned",
        });
      },
      async recordOwnedContentRevision(plan, previous, updated) {
        if (previous.itemId !== updated.itemId)
          throw new Error("Edited content changed its owned identity.");
        const item = await readPlannedOwnedItem(plan, updated);
        await appendContentLedgerEvent(ledgerPath, {
          ...plan,
          event: "updated",
          itemId: updated.itemId,
          revisionSha256: updated.revisionSha256,
          previousRevisionSha256: previous.revisionSha256,
          relativeLocator: item.relative_locator,
        });
      },
      async verifyOwnedContent(plan, owned) {
        const item = await readPlannedOwnedItem(plan, owned);
        const files = (await verifyLocalCatalogItemFiles({
          item,
          localRoot,
          repositoryRoot,
        })) as Record<string, unknown> & {
          fileCount: number;
          manifestSha256: string;
          manifest: Array<{
            relativePath: string;
            role: string;
            mediaType: string;
            sizeBytes: number;
            sha256: string;
          }>;
        };
        await appendContentLedgerEvent(ledgerPath, {
          ...plan,
          itemId: owned.itemId,
          revisionSha256: owned.revisionSha256,
          fileCount: files.fileCount,
          manifestSha256: files.manifestSha256,
          files: files.manifest,
          event: "verified",
        });
        return { item, files };
      },
      async cleanupOwnedContent() {
        return cleanup();
      },
      async assertDeletedContent(plan, owned) {
        if (plan.runId !== runId) {
          throw new Error("Creator deletion proof belongs to another run.");
        }
        const events = (
          (await readContentLedger(ledgerPath)) as ContentLedgerEvidenceEvent[]
        ).filter((event) => event.journeyKey === plan.journeyKey);
        const lifecycle = events.map((event) => event.event);
        // A failure immediately after Save can precede file verification.
        // Its exact cleanup must still succeed without replacing that original
        // assertion failure with a spurious missing-verification failure.
        const verified = lifecycle.includes("verified");
        const expectedLifecycle = [
          ...(lifecycle[0] === "import_planned"
            ? ["import_planned", "import_owned"]
            : ["planned", "owned"]),
          ...(verified ? ["verified"] : []),
          "cleanup_started",
          "deleted",
        ];
        if (
          lifecycle.includes("updated")
            ? lifecycle.at(-2) !== "cleanup_started" ||
              lifecycle.at(-1) !== "deleted"
            : lifecycle.length !== expectedLifecycle.length ||
              lifecycle.some(
                (event, index) => event !== expectedLifecycle[index],
              )
        ) {
          throw new Error(
            `Creator content ledger did not end in the exact owned deletion lifecycle: ${lifecycle.join(" -> ") || "empty"}.`,
          );
        }
        const ownedEvent = events.findLast((event) =>
          ["owned", "import_owned", "updated"].includes(event.event),
        );
        if (
          !ownedEvent ||
          ownedEvent.itemId !== owned.itemId ||
          ownedEvent.revisionSha256 !== owned.revisionSha256 ||
          typeof ownedEvent.relativeLocator !== "string"
        ) {
          throw new Error(
            "Creator deletion proof does not match the ledger-owned identity.",
          );
        }
        const itemAfter = await (
          await catalogClient()
        ).getItem(owned.itemId, {
          allowMissing: true,
        });
        if (itemAfter) {
          throw new Error("Deleted creator content remains in the catalog.");
        }
        const host = await verifyLocalItemDirectoryAbsent({
          relativeLocator: ownedEvent.relativeLocator,
          localRoot,
          repositoryRoot,
        });
        return {
          journeyKey: plan.journeyKey,
          lifecycle,
          itemId: owned.itemId,
          revisionSha256: owned.revisionSha256,
          catalogAbsent: true,
          host,
        };
      },
    };

    let fixtureError: unknown = null;
    try {
      await use(fixture);
    } catch (error) {
      fixtureError = error;
    }
    try {
      await cleanup();
    } catch (cleanupError) {
      const safeError = redactEvidence(cleanupError);
      const cleanupDetails =
        cleanupError &&
        typeof cleanupError === "object" &&
        "summary" in cleanupError
          ? redactEvidence(cleanupError.summary)
          : null;
      await writePrivateJson(cleanupSummaryPath, {
        status: "failed",
        message: safeError.message,
        summary: cleanupDetails,
      });
      throw cleanupError;
    } finally {
      await (client as LocalCatalogClient | null)?.close();
    }
    if (fixtureError) throw fixtureError;
  },

  captureBrowserEvidence: [
    async ({ page }, use, testInfo) => {
      const evidenceDirectory = requiredEnvironment("ANIMAMA_E2E_EVIDENCE_DIR");
      await ensurePrivateDirectory(evidenceDirectory);
      await Promise.all(
        EVIDENCE_FILENAMES.map(async (filename) => {
          const handle = await open(
            path.join(evidenceDirectory, filename),
            "a",
            0o600,
          );
          await handle.chmod(0o600);
          await handle.close();
        }),
      );
      const pendingWrites = new Set<Promise<void>>();
      const writeErrors: Error[] = [];
      const pageErrors: Error[] = [];

      const record = (filename: string, value: unknown) => {
        const pending = appendEvidenceJsonLine(
          path.join(evidenceDirectory, filename),
          value,
        ).catch((error) => {
          writeErrors.push(
            error instanceof Error
              ? error
              : new Error("Unknown evidence write failure"),
          );
        });
        pendingWrites.add(pending);
        void pending.finally(() => pendingWrites.delete(pending));
      };

      const onConsole = (message: ConsoleMessage) => {
        record("browser-console.jsonl", {
          ...eventBase(testInfo),
          type: message.type(),
          text: message.text(),
          location: message.location(),
        });
      };
      const onPageError = (error: Error) => {
        pageErrors.push(error);
        record("page-errors.jsonl", {
          ...eventBase(testInfo),
          error,
        });
      };
      const onRequestFailed = (request: Request) => {
        record("request-failures.jsonl", {
          ...eventBase(testInfo),
          ...requestMetadata(request),
          failure: request.failure()?.errorText ?? "unknown",
        });
      };
      const onResponse = (response: Response) => {
        if (response.status() < 400) {
          return;
        }
        record("http-errors.jsonl", {
          ...eventBase(testInfo),
          ...requestMetadata(response.request()),
          status: response.status(),
          statusText: response.statusText(),
        });
      };

      page.on("console", onConsole);
      page.on("pageerror", onPageError);
      page.on("requestfailed", onRequestFailed);
      page.on("response", onResponse);
      await use();
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);

      await Promise.allSettled([...pendingWrites]);
      expect(
        pageErrors.map((error) => error.message),
        "Unexpected browser page errors",
      ).toEqual([]);
      if (writeErrors.length > 0) {
        throw new Error(
          `Browser evidence capture failed ${writeErrors.length} time(s); inspect the private runner log.`,
        );
      }
    },
    { auto: true },
  ],

  // Package stages count toward the owner's two-stage limit until released or
  // expired. Release any a journey left open (for example a committed import
  // whose dialog it navigated away from) so later journeys are unaffected.
  // Helpers that open stages through `page.request` release their own.
  releaseOpenPackageStages: [
    async ({ context, animamaEvidence }, use) => {
      const ledger = new PackageStageLedger();
      const pendingReads = new Set<Promise<void>>();
      const unreadable: string[] = [];
      const onResponse = (response: Response) => {
        const method = response.request().method();
        const pending = ledger
          .observe({
            method,
            url: response.url(),
            status: response.status(),
            json: () => response.json(),
          })
          .catch(() => {
            unreadable.push(`${method} ${new URL(response.url()).pathname}`);
          });
        pendingReads.add(pending);
        void pending.finally(() => pendingReads.delete(pending));
      };
      context.on("response", onResponse);
      await use();
      context.off("response", onResponse);
      await Promise.allSettled([...pendingReads]);

      const open = ledger.open();
      if (open.length === 0 && unreadable.length === 0) return;
      const client = await createLocalCatalogClient({
        apiUrl: requiredEnvironment("ANIMAMA_E2E_API_URL"),
      });
      let outcome;
      try {
        outcome = await releasePackageStages(client, open);
      } finally {
        await client.close();
      }
      await animamaEvidence.attachJson(
        "package-stages-released-after-journey",
        {
          ...outcome,
          unreadable,
        },
      );
      // An unknown stage ID may still be counting toward the limit.
      if (outcome.held.length > 0 || unreadable.length > 0) {
        throw new Error(
          `Package stages may remain open after the journey: ${outcome.held.length} held, ${unreadable.length} unreadable replies. See package-stages-released-after-journey.`,
        );
      }
    },
    { auto: true },
  ],
});

export { expect };
