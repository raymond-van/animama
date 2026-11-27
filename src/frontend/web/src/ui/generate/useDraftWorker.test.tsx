// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";

import { privateStateResets } from "@/app/runtime/private-module-state";
import type { DraftCheckReport } from "@/lib/avatar/motion-authoring/draftChecks";
import type { IncludedAvatarId } from "@/lib/avatar/motion-authoring/headlessVrm";
import { queryKeys } from "@/query/keys";
import {
  applyGenerationRunEvent,
  beginGenerationRun,
  endGenerationRun,
  forgetGenerationRunDraft,
  generationRunState,
} from "@/stores/generation-store";
import type { PreviewSheetRenderer } from "./previewSheetRenderer";
import {
  effectGestureProject,
  generationDraft,
  generationSnapshot,
  gestureProject,
  jsonResponse,
  reactionProject,
  waveHelloClip,
} from "./testing/generationFixtures";
import {
  mountGenerationHook,
  settle,
  type MountedHook,
} from "./testing/generationHarness";
import {
  AVATAR_NAMES_WAIT_MS,
  draftExpressionNames,
  useDraftWorker,
  validateDraft,
  type DraftWorker,
} from "./useDraftWorker";

const CONVERSATION = "conversation-1";
const REQUEST = { message: "a wave", draftId: null, answers: null };
type HookProps = Parameters<typeof useDraftWorker>[0];

/** The checks worker's client, as the page drives it. */
const checks = vi.hoisted(() => ({
  clients: [] as { disposed: boolean; avatarIds: string[] }[],
  /** The clips checked, in order. */
  checked: [] as unknown[],
  report: null as unknown,
  /** Holds every check until released, to observe one-at-a-time. */
  hold: null as Promise<void> | null,
  fail: false,
}));
const preview = vi.hoisted(() => ({
  render: null as unknown,
}));

vi.mock("@/lib/avatar/motion-authoring/draftChecksClient", () => ({
  createDraftChecksClient: (avatarBytes: (id: string) => Promise<unknown>) => {
    const client = { disposed: false, avatarIds: [] as string[] };
    checks.clients.push(client);
    return {
      check: async (clip: unknown) => {
        // As the real client: a disposed worker fails what it owed.
        const assertLive = () => {
          if (client.disposed)
            throw new Error("The draft checks were disposed.");
        };
        assertLive();
        // As the real client: the Included Avatars are read before a check.
        for (const id of ["Andrew", "Annie"]) {
          await avatarBytes(id);
          assertLive();
          client.avatarIds.push(id);
        }
        checks.checked.push(clip);
        await checks.hold;
        assertLive();
        if (checks.fail) throw new Error("The draft checks worker failed.");
        // A test may answer by clip, to tell two drafts' reports apart.
        return typeof checks.report === "function"
          ? (checks.report as (clip: unknown) => unknown)(clip)
          : checks.report;
      },
      dispose: () => {
        client.disposed = true;
      },
    };
  },
}));
vi.mock("./includedAvatarFiles", () => ({
  createIncludedAvatarFiles: () => async (id: string) =>
    new TextEncoder().encode(`bytes of ${id}`).buffer,
}));
vi.mock("./previewSheetRenderer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./previewSheetRenderer")>()),
  usePreviewSheetRenderer: () => preview.render,
}));

const CLEAN: DraftCheckReport = {
  ok: true,
  loadable: true,
  issues: [],
  findings: [],
};

/** The assistant's backend, as far as the page's reports touch it. */
const server = {
  reports: [] as { draftId: string; body: Record<string, unknown> }[],
  frames: [] as { draftId: string; version: string | null; files: File[] }[],
  refuseReport: null as (() => Response) | null,
  refuseFrames: null as (() => Response) | null,
  drafts: new Map<string, PyGenerationDraft>(),
};

async function fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const draftId = url.pathname.split("/")[4]!;
  if (request.method === "PUT" && url.pathname.endsWith("/check-report")) {
    const body = (await request.json()) as Record<string, unknown>;
    server.reports.push({ draftId, body });
    if (server.refuseReport) return server.refuseReport();
    // With no run in flight the report settles the draft.
    const stored = Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== "version"),
    );
    const remarks =
      (body.issues as unknown[]).length + (body.findings as unknown[]).length;
    const draft: PyGenerationDraft = {
      ...server.drafts.get(draftId)!,
      status: !body.loadable ? "failed" : remarks ? "warnings" : "ready",
      check_report: stored,
      checked_version: body.version as number,
      updated_at: "2026-11-26T10:01:00Z",
    };
    server.drafts.set(draftId, draft);
    return jsonResponse(draft);
  }
  if (request.method === "PUT" && url.pathname.endsWith("/review-frames")) {
    if (server.refuseFrames) return server.refuseFrames();
    const form = await request.formData();
    server.frames.push({
      draftId,
      version: url.searchParams.get("version"),
      files: form.getAll("frames") as File[],
    });
    return jsonResponse(null, 204);
  }
  throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
}

let mounted: MountedHook<HookProps, DraftWorker>;

/** Mount the worker over a cached conversation, so reports update its drafts. */
async function mount(
  drafts: PyGenerationDraft[],
  props: Partial<HookProps> = {},
  options: { strict?: boolean } = {},
) {
  for (const draft of drafts) server.drafts.set(draft.id, draft);
  mounted = mountGenerationHook<HookProps, DraftWorker>(useDraftWorker, {
    props: {
      conversationId: CONVERSATION,
      drafts,
      avatarExpressionNames: ["happy", "blink"],
      ...props,
    },
    fetch,
    ...options,
  });
  mounted.queryClient.setQueryData(
    queryKeys.generation.conversation("session", CONVERSATION),
    generationSnapshot({ drafts }),
  );
  await settle();
  return mounted;
}

const cachedDrafts = () =>
  mounted.queryClient.getQueryData<PyGenerationConversationSnapshot>(
    queryKeys.generation.conversation("session", CONVERSATION),
  )!.drafts;

/** A project whose clip the app cannot load. */
const brokenProject = () =>
  gestureProject({ sequence: { ...waveHelloClip(), beats: "none" } });

beforeEach(() => {
  checks.clients = [];
  checks.checked = [];
  checks.report = CLEAN;
  checks.hold = null;
  checks.fail = false;
  preview.render = null;
  server.reports = [];
  server.frames = [];
  server.refuseReport = null;
  server.refuseFrames = null;
  server.drafts = new Map();
});

afterEach(() => {
  mounted?.unmount();
  for (const reset of privateStateResets()) reset();
  vi.useRealTimers();
});

describe("validateDraft", () => {
  it("hands a loadable clip to the preview and withholds one that does not load", () => {
    const draft = generationDraft();
    expect(validateDraft(draft)).toEqual({
      version: 1,
      loadable: true,
      sequence: (draft.project as { sequence: unknown }).sequence,
      issues: [],
    });

    const broken = validateDraft(generationDraft({ project: brokenProject() }));
    expect(broken).toMatchObject({ loadable: false, sequence: null });
    expect(broken.issues.length).toBeGreaterThan(0);

    for (const project of [null, {}, { sequence: "wave" }, { sequence: [] }])
      expect(validateDraft(generationDraft({ project }))).toMatchObject({
        loadable: false,
        sequence: null,
      });
  });

  it("hands a clip that plays effects to the preview with its events", () => {
    const draft = generationDraft({ project: effectGestureProject() });
    const validation = validateDraft(draft);
    // Timeline events are part of the clip format: nothing is reported.
    expect(validation).toMatchObject({ loadable: true, issues: [] });
    expect(validation.sequence).toBe(
      (draft.project as { sequence: unknown }).sequence,
    );
    expect(validation.sequence!.events).toEqual([
      {
        id: "effect-1",
        time: 0,
        kind: "avatar_vfx",
        effectId: "sparkle",
        duration: 0.5,
      },
    ]);
  });

  it("still plays a clip that only exceeds an anatomical limit", () => {
    const clip = waveHelloClip() as {
      joints: { rightUpperArm: { elevation: { v: number }[] } };
    };
    clip.joints.rightUpperArm.elevation[1]!.v = 250;
    const validation = validateDraft(
      generationDraft({ project: gestureProject({ sequence: clip }) }),
    );
    expect(validation.loadable).toBe(true);
    expect(validation.sequence).toBe(clip);
    expect(validation.issues).toEqual([
      {
        path: "joints.rightUpperArm.elevation[1].v",
        message: "250° is beyond the anatomical limit 0..180.",
      },
    ]);
  });
});

describe("draftExpressionNames", () => {
  it("separates names the Avatar lacks from names only such Avatars have", () => {
    const key = [{ beat: "start", v: 1 }];
    expect(
      draftExpressionNames(
        {
          expressions: {
            happy: key,
            tongueOut: key,
            cheekPuff: key,
            Fcl_BRW_Joy: key,
          },
        },
        ["happy", "cheekPuff"],
      ),
    ).toEqual({ missing: ["tongueOut"], avatarOnly: ["cheekPuff"] });
    expect(draftExpressionNames({ expressions: "none" }, [])).toEqual({
      missing: [],
      avatarOnly: [],
    });
  });
});

describe("useDraftWorker", () => {
  it("checks a draft that waits for it and reports once for the version", async () => {
    const draft = generationDraft();
    checks.report = {
      ok: false,
      loadable: true,
      issues: [],
      findings: [
        {
          category: "intersection",
          severity: "fail",
          avatar: "Andrew",
          subject: "rightHand/head",
          from: 0.8,
          to: 0.93,
          value: 0.074,
          limit: 0.015,
          unit: "m",
          detail: "The right hand passes through the head.",
        },
      ],
    };
    const { result, rerender } = await mount([draft]);

    expect(result().validations[draft.id]).toMatchObject({
      version: 1,
      loadable: true,
    });
    // Checked on the two Included Avatars, with the clip the preview plays.
    expect(checks.clients[0]!.avatarIds).toEqual(["Andrew", "Annie"]);
    expect(checks.checked).toEqual([result().validations[draft.id]!.sequence]);
    expect(server.reports).toEqual([
      {
        draftId: draft.id,
        body: {
          version: 1,
          loadable: true,
          issues: [],
          findings: [
            {
              category: "intersection",
              severity: "fail",
              avatar: "Andrew",
              subject: "rightHand/head",
              from: 0.8,
              to: 0.93,
              value: 0.074,
              limit: 0.015,
              unit: "m",
              detail: "The right hand passes through the head.",
            },
          ],
          expression_names: { missing: [], avatar_only: [] },
        },
      },
    ]);
    // The backend's answer replaces the draft in the conversation.
    expect(cachedDrafts()[0]).toMatchObject({
      status: "warnings",
      checked_version: 1,
    });
    expect(result().checkingDraftId).toBeNull();
    expect(result().failures).toEqual({});

    // A run can leave the same version waiting again; it is not checked twice.
    rerender({
      conversationId: CONVERSATION,
      drafts: [{ ...draft }],
      avatarExpressionNames: ["happy", "blink"],
    });
    await settle();
    expect(checks.checked).toHaveLength(1);
    expect(server.reports).toHaveLength(1);
  });

  it("checks and reports a draft that plays effects as any other draft", async () => {
    const draft = generationDraft({ project: effectGestureProject() });
    checks.report = CLEAN;
    const { result } = await mount([draft]);

    // The clip is measured as the preview plays it, events included.
    const { sequence } = result().validations[draft.id]!;
    expect(checks.checked).toEqual([sequence]);
    expect((checks.checked[0] as { events: unknown[] }).events).toHaveLength(1);
    // Nothing about the events is reported as a problem.
    expect(server.reports).toEqual([
      {
        draftId: draft.id,
        body: {
          version: 1,
          loadable: true,
          issues: [],
          findings: [],
          expression_names: { missing: [], avatar_only: [] },
        },
      },
    ]);
    expect(result().failures).toEqual({});
  });

  it("reports an unloadable clip without measuring it or handing it to the preview", async () => {
    const draft = generationDraft({ project: brokenProject() });
    const { result } = await mount([draft]);

    expect(result().validations[draft.id]).toMatchObject({
      loadable: false,
      sequence: null,
    });
    expect(checks.checked).toEqual([]);
    expect(server.reports).toHaveLength(1);
    expect(server.reports[0]!.body).toMatchObject({
      version: 1,
      loadable: false,
      findings: [],
      expression_names: { missing: [], avatar_only: [] },
    });
    expect(
      (server.reports[0]!.body.issues as unknown[]).length,
    ).toBeGreaterThan(0);
    expect(cachedDrafts()[0]!.status).toBe("failed");
  });

  it("adds the keyed names the chosen Avatar lacks and the ones only it has", async () => {
    const key = [{ beat: "start", v: 1 }];
    const sequence = {
      ...waveHelloClip(),
      expressions: { happy: key, tongueOut: key, cheekPuff: key },
    };
    const draft = generationDraft({ project: gestureProject({ sequence }) });
    await mount([draft], {
      avatarExpressionNames: ["happy", "cheekPuff", "blink"],
    });

    expect(server.reports[0]!.body.expression_names).toEqual({
      missing: ["tongueOut"],
      avatar_only: ["cheekPuff"],
    });
  });

  it("waits a little for the preview Avatar before comparing names", async () => {
    const key = [{ beat: "start", v: 1 }];
    const draft = generationDraft({
      project: gestureProject({
        sequence: { ...waveHelloClip(), expressions: { tongueOut: key } },
      }),
    });
    const { rerender } = await mount([draft], {
      avatarExpressionNames: undefined,
    });
    // The checks ran; the report waits for the Avatar's names.
    expect(checks.checked).toHaveLength(1);
    expect(server.reports).toEqual([]);

    rerender({
      conversationId: CONVERSATION,
      drafts: [draft],
      avatarExpressionNames: ["happy"],
    });
    await settle();
    expect(server.reports[0]!.body.expression_names).toEqual({
      missing: ["tongueOut"],
      avatar_only: [],
    });
  });

  it("reports without comparing names when no Avatar can be shown", async () => {
    const key = [{ beat: "start", v: 1 }];
    const draft = generationDraft({
      project: gestureProject({
        sequence: { ...waveHelloClip(), expressions: { tongueOut: key } },
      }),
    });
    await mount([draft], { avatarExpressionNames: null });
    expect(server.reports[0]!.body.expression_names).toEqual({
      missing: [],
      avatar_only: [],
    });
  });

  it("stops waiting for the preview Avatar and reports without names", async () => {
    let release!: () => void;
    checks.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const key = [{ beat: "start", v: 1 }];
    const draft = generationDraft({
      project: gestureProject({
        sequence: { ...waveHelloClip(), expressions: { tongueOut: key } },
      }),
    });
    await mount([draft], { avatarExpressionNames: undefined });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    release();

    await act(() => vi.advanceTimersByTimeAsync(AVATAR_NAMES_WAIT_MS - 1));
    expect(server.reports).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(1));
    await vi.waitFor(() => expect(server.reports).toHaveLength(1));
    expect(server.reports[0]!.body.expression_names).toEqual({
      missing: [],
      avatar_only: [],
    });
  });

  it("picks up a draft a stopped run left unchecked, and leaves checked drafts alone", async () => {
    const checked = generationDraft({
      id: "draft-1",
      status: "ready",
      checked_version: 1,
      check_report: { loadable: true },
    });
    const awaiting = generationDraft({
      id: "draft-2",
      position: 1,
      version: 2,
      checked_version: 1,
    });
    const writing = generationDraft({
      id: "draft-3",
      position: 2,
      status: "writing",
    });
    const empty = generationDraft({
      id: "draft-4",
      position: 3,
      status: "failed",
      project: null,
    });
    const { result } = await mount([checked, awaiting, writing, empty]);

    expect(
      server.reports.map(({ draftId, body }) => [draftId, body.version]),
    ).toEqual([["draft-2", 2]]);
    // Every draft with a project is validated for the preview, checked or not.
    expect(Object.keys(result().validations).sort()).toEqual([
      "draft-1",
      "draft-2",
      "draft-3",
    ]);
  });

  it("checks one draft at a time, then the next version of the same draft", async () => {
    let release!: () => void;
    checks.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = generationDraft({ id: "draft-1" });
    const second = generationDraft({ id: "draft-2", position: 1 });
    const { result, rerender } = await mount([first, second]);

    expect(checks.checked).toHaveLength(1);
    expect(result().checkingDraftId).toBe("draft-1");

    checks.hold = null;
    release();
    await settle();
    expect(checks.checked).toHaveLength(2);
    expect(server.reports.map(({ draftId }) => draftId)).toEqual([
      "draft-1",
      "draft-2",
    ]);

    // A repair stores a new version of the first draft.
    const repaired = generationDraft({
      id: "draft-1",
      version: 2,
      checked_version: 1,
      updated_at: "2026-11-26T10:02:00Z",
    });
    rerender({
      conversationId: CONVERSATION,
      drafts: [repaired, cachedDrafts()[1]!],
      avatarExpressionNames: ["happy", "blink"],
    });
    await settle();
    expect(server.reports.at(-1)).toMatchObject({
      draftId: "draft-1",
      body: { version: 2 },
    });
    expect(server.reports).toHaveLength(3);
  });

  it("reports two drafts that wait at once each for its own id, version and clip", async () => {
    // As in a batch: two items in flight, both waiting for their reports.
    let release!: () => void;
    checks.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clip = (name: string) => ({ ...waveHelloClip(), name });
    const wave = generationDraft({
      id: "draft-1",
      version: 2,
      project: gestureProject({ sequence: clip("Wave") }),
    });
    const bow = generationDraft({
      id: "draft-2",
      position: 1,
      version: 5,
      project: gestureProject({ sequence: clip("Bow") }),
    });
    // The checks answer by clip: only the bow has a finding.
    checks.report = (checked: { name: string }) =>
      checked.name === "Bow"
        ? {
            ...CLEAN,
            ok: false,
            findings: [
              {
                category: "range",
                severity: "fail",
                avatar: "Andrew",
                subject: "spine",
                from: 0.2,
                to: 0.4,
                message: "The bow bends too far.",
              },
            ],
          }
        : CLEAN;
    await mount([wave, bow]);

    // One at a time: the second waits while the first is measured.
    expect(checks.checked).toEqual([clip("Wave")]);
    expect(server.reports).toEqual([]);

    checks.hold = null;
    release();
    await settle();
    expect(checks.checked).toEqual([clip("Wave"), clip("Bow")]);
    expect(
      server.reports.map(({ draftId, body }) => ({
        draftId,
        version: body.version,
        findings: (body.findings as { subject: string }[]).map(
          ({ subject }) => subject,
        ),
      })),
    ).toEqual([
      { draftId: "draft-1", version: 2, findings: [] },
      { draftId: "draft-2", version: 5, findings: ["spine"] },
    ]);
    // Each draft is settled from its own report.
    expect(cachedDrafts().map(({ id, status }) => [id, status])).toEqual([
      ["draft-1", "ready"],
      ["draft-2", "warnings"],
    ]);
  });

  it("goes on to the next waiting draft when one draft's report is refused", async () => {
    // As when a batch item is discarded while its check runs.
    const gone = generationDraft({ id: "draft-1" });
    const kept = generationDraft({ id: "draft-2", position: 1 });
    server.refuseReport = () => {
      server.refuseReport = null;
      return jsonResponse({ detail: { code: "generation_not_found" } }, 404);
    };
    const { result } = await mount([gone, kept]);
    await settle();

    expect(server.reports.map(({ draftId }) => draftId)).toEqual([
      "draft-1",
      "draft-2",
    ]);
    expect(Object.keys(result().failures)).toEqual(["draft-1"]);
    expect(cachedDrafts()[1]).toMatchObject({
      id: "draft-2",
      status: "ready",
      checked_version: 1,
    });
  });

  describe("a version a run stopped waiting for", () => {
    /** As the run leaves it: `warnings`, with a report that says only "not checked". */
    const leftUnchecked = () =>
      generationDraft({
        status: "warnings",
        version: 2,
        checked_version: 2,
        check_report: { unchecked: true },
      });

    it("is checked when the page opens the conversation", async () => {
      await mount([leftUnchecked()]);
      expect(
        server.reports.map(({ draftId, body }) => [draftId, body.version]),
      ).toEqual([["draft-1", 2]]);
      // The report replaces "not checked" and settles the draft.
      expect(cachedDrafts()[0]).toMatchObject({
        status: "ready",
        checked_version: 2,
        check_report: { loadable: true },
      });
    });

    it("is checked once for the version, whatever the report said", async () => {
      const draft = leftUnchecked();
      const { rerender } = await mount([draft]);
      // The same draft again, as a later read of the conversation gives it.
      rerender({
        conversationId: CONVERSATION,
        drafts: [{ ...draft }],
        avatarExpressionNames: ["happy", "blink"],
      });
      await settle();
      expect(checks.checked).toHaveLength(1);
      expect(server.reports).toHaveLength(1);
    });

    it("is left alone while a run is in flight, and checked once it has ended", async () => {
      // The run may still be working on the draft: its checks are the run's to ask for.
      beginGenerationRun(CONVERSATION, REQUEST);
      await mount([leftUnchecked()]);
      expect(checks.checked).toEqual([]);
      expect(server.reports).toEqual([]);

      act(() => endGenerationRun(CONVERSATION));
      await settle();
      expect(
        server.reports.map(({ draftId, body }) => [draftId, body.version]),
      ).toEqual([["draft-1", 2]]);
    });

    it("is checked again on request after a check that failed", async () => {
      checks.fail = true;
      const draft = leftUnchecked();
      const { result } = await mount([draft]);
      expect(server.reports).toEqual([]);
      expect(result().failures).toEqual({
        [draft.id]: { version: 2, kind: "checks_unavailable", code: null },
      });

      checks.fail = false;
      act(() => result().retryCheck(draft.id));
      await settle();
      expect(checks.checked).toHaveLength(2);
      expect(
        server.reports.map(({ draftId, body }) => [draftId, body.version]),
      ).toEqual([["draft-1", 2]]);
      expect(result().failures).toEqual({});
    });

    it("does not concern a draft without a project, or one whose report is of an earlier version", async () => {
      await mount([
        generationDraft({
          id: "draft-1",
          status: "failed",
          project: null,
          checked_version: 1,
          check_report: { unchecked: true },
        }),
        // A revision in another step: the old version's report is not about it.
        generationDraft({
          id: "draft-2",
          position: 1,
          status: "writing",
          version: 3,
          checked_version: 2,
          check_report: { unchecked: true },
        }),
      ]);
      expect(checks.checked).toEqual([]);
    });
  });

  it("keeps a failure for a retry when the checks cannot run", async () => {
    checks.fail = true;
    const draft = generationDraft();
    const { result } = await mount([draft]);

    expect(server.reports).toEqual([]);
    expect(result().failures).toEqual({
      [draft.id]: { version: 1, kind: "checks_unavailable", code: null },
    });
    // No loop: the version is not checked again by itself.
    await settle();
    expect(checks.checked).toHaveLength(1);

    checks.fail = false;
    act(() => result().retryCheck(draft.id));
    await settle();
    expect(checks.checked).toHaveLength(2);
    expect(server.reports).toHaveLength(1);
    expect(result().failures).toEqual({});
  });

  it("does not send a refused report again", async () => {
    server.refuseReport = () =>
      jsonResponse(
        { detail: { code: "generation_check_report_too_large" } },
        413,
      );
    const draft = generationDraft();
    const { result } = await mount([draft]);
    await settle();

    expect(server.reports).toHaveLength(1);
    expect(result().failures).toEqual({
      [draft.id]: {
        version: 1,
        kind: "report_failed",
        code: "generation_check_report_too_large",
      },
    });
    expect(cachedDrafts()[0]!.status).toBe("checking");
  });

  it("drops a report for a version the draft has moved on from", async () => {
    server.refuseReport = () =>
      jsonResponse({ detail: { code: "generation_stale_version" } }, 409);
    const draft = generationDraft();
    const { result } = await mount([draft]);

    expect(server.reports).toHaveLength(1);
    expect(result().failures).toEqual({});
  });

  describe("review sheets", () => {
    const sheet = (avatar: IncludedAvatarId, size = 12) => ({
      avatar,
      blob: new Blob(["x".repeat(size)], { type: "image/jpeg" }),
      width: 944,
      height: 2008,
    });
    const requestFrames = (draft: PyGenerationDraft) =>
      act(() => {
        beginGenerationRun(CONVERSATION, REQUEST);
        applyGenerationRunEvent(
          CONVERSATION,
          {
            type: "frames.requested",
            draftId: draft.id,
            version: draft.version,
          },
          REQUEST,
        );
      });
    const readyDraft = () =>
      generationDraft({ status: "checking", checked_version: 1 });

    it("are drawn only when a run asks for them", async () => {
      const render = vi.fn<PreviewSheetRenderer>(async () => [
        sheet("Andrew"),
        sheet("Annie"),
      ]);
      preview.render = render;
      const draft = readyDraft();
      const { result } = await mount([draft]);
      expect(render).not.toHaveBeenCalled();
      expect(result().frames).toEqual({ status: "idle", draftId: null });

      requestFrames(draft);
      await settle();

      expect(render).toHaveBeenCalledTimes(1);
      const request = render.mock.calls[0]![0];
      expect(request.clip).toBe(result().validations[draft.id]!.sequence);
      // One row per beat of the clip.
      expect(request.times).toEqual([0, 0.5, 0.9, 2, 2.5]);
      // The sheets' Avatars come from the Included files, by id.
      expect(
        new TextDecoder().decode(
          (await request.avatarFile("Annie")) as ArrayBuffer,
        ),
      ).toBe("bytes of Annie");

      expect(server.frames).toHaveLength(1);
      expect(server.frames[0]).toMatchObject({
        draftId: draft.id,
        version: "1",
      });
      expect(
        server.frames[0]!.files.map(({ name, type }) => [name, type]),
      ).toEqual([
        ["Andrew.jpg", "image/jpeg"],
        ["Annie.jpg", "image/jpeg"],
      ]);
      // Answered: the request is forgotten and not drawn again.
      expect(generationRunState(CONVERSATION).framesRequests).toEqual([]);
      await settle();
      expect(render).toHaveBeenCalledTimes(1);
    });

    it("show a draft that plays effects at its beats, as any other", async () => {
      const render = vi.fn<PreviewSheetRenderer>(async () => [sheet("Andrew")]);
      preview.render = render;
      const draft = generationDraft({
        status: "checking",
        checked_version: 1,
        project: effectGestureProject(),
      });
      const { result } = await mount([draft]);
      requestFrames(draft);
      await settle();

      const request = render.mock.calls[0]![0];
      expect(request.clip).toBe(result().validations[draft.id]!.sequence);
      // One row per beat: an event adds none.
      expect(request.times).toEqual([0, 0.5, 0.9, 2, 2.5]);
      expect(request.view).toBe("body");
      expect(server.frames).toHaveLength(1);
    });

    it("show the body for a Gesture and only the face for a Reaction", async () => {
      const render = vi.fn<PreviewSheetRenderer>(async () => [sheet("Andrew")]);
      preview.render = render;
      const gesture = readyDraft();
      const reaction = generationDraft({
        id: "draft-2",
        intent: "reaction",
        position: 1,
        status: "checking",
        checked_version: 1,
        project: reactionProject(),
      });
      await mount([gesture, reaction]);

      requestFrames(gesture);
      await settle();
      requestFrames(reaction);
      await settle();

      expect(render.mock.calls.map(([request]) => request.view)).toEqual([
        "body",
        "face",
      ]);
      // A Reaction's rows are its beats too: the flash and the held face.
      expect(render.mock.calls[1]![0].times).toEqual([0, 0.25]);
      expect(server.frames.map(({ draftId }) => draftId)).toEqual([
        "draft-1",
        "draft-2",
      ]);
    });

    describe("for two drafts at once", () => {
      /** Sheets that carry their clip's name, so an upload shows whose it is. */
      const namedSheets = (hold?: Promise<void>) =>
        vi.fn<PreviewSheetRenderer>(async (request) => {
          await hold;
          return [
            {
              ...sheet("Andrew"),
              blob: new Blob(
                [`${(request.clip as { name: string }).name}/${request.view}`],
                { type: "image/jpeg" },
              ),
            },
          ];
        });
      const wave = () =>
        generationDraft({
          id: "draft-1",
          status: "checking",
          version: 2,
          checked_version: 2,
          project: gestureProject({
            sequence: { ...waveHelloClip(), name: "Wave" },
          }),
        });
      const joy = () =>
        generationDraft({
          id: "draft-2",
          intent: "reaction",
          position: 1,
          status: "checking",
          version: 4,
          checked_version: 4,
          project: reactionProject(),
        });
      /** Both requests outstanding before either is answered, as in a batch. */
      const requestBoth = (...drafts: PyGenerationDraft[]) =>
        act(() => {
          beginGenerationRun(CONVERSATION, REQUEST);
          for (const draft of drafts)
            applyGenerationRunEvent(
              CONVERSATION,
              {
                type: "frames.requested",
                draftId: draft.id,
                version: draft.version,
              },
              REQUEST,
            );
        });
      const uploads = () =>
        Promise.all(
          server.frames.map(async ({ draftId, version, files }) => ({
            draftId,
            version,
            sheets: await Promise.all(files.map((file) => file.text())),
          })),
        );

      it("are drawn one after another and sent each for its own draft and version", async () => {
        let release!: () => void;
        const render = namedSheets(
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
        preview.render = render;
        const { result } = await mount([wave(), joy()]);
        requestBoth(wave(), joy());
        await settle();

        // The canvas draws one thing at a time: the second request waits.
        expect(render).toHaveBeenCalledTimes(1);
        expect(result().frames).toEqual({
          status: "rendering",
          draftId: "draft-1",
        });
        expect(generationRunState(CONVERSATION).framesRequests).toHaveLength(2);

        release();
        await settle();
        expect(render).toHaveBeenCalledTimes(2);
        expect(await uploads()).toEqual([
          { draftId: "draft-1", version: "2", sheets: ["Wave/body"] },
          { draftId: "draft-2", version: "4", sheets: ["Soft Joy/face"] },
        ]);
        expect(generationRunState(CONVERSATION).framesRequests).toEqual([]);
        expect(result().frames).toEqual({ status: "idle", draftId: null });
      });

      it("answer the second when the first cannot be drawn or sent", async () => {
        preview.render = namedSheets();
        // The first draft's sheets are refused; the second's are taken.
        server.refuseFrames = () => {
          server.refuseFrames = null;
          return jsonResponse(
            { detail: { code: "generation_frames_not_expected" } },
            409,
          );
        };
        const { result } = await mount([wave(), joy()]);
        requestBoth(wave(), joy());
        await settle();

        expect(await uploads()).toEqual([
          { draftId: "draft-2", version: "4", sheets: ["Soft Joy/face"] },
        ]);
        // The failure is the first draft's, and is not tried again.
        expect(result().frames).toEqual({
          status: "failed",
          draftId: "draft-1",
        });
        expect(generationRunState(CONVERSATION).framesRequests).toEqual([
          { draftId: "draft-1", version: 2 },
        ]);
        await settle();
        expect(preview.render).toHaveBeenCalledTimes(2);
      });

      it("never send one draft's sheets for a version the page does not hold of it", async () => {
        const render = namedSheets();
        preview.render = render;
        await mount([wave(), joy()]);
        // The first request names a version this page has not validated.
        requestBoth({ ...wave(), version: 3 }, joy());
        await settle();

        // It is not drawn from another version or draft, and holds nothing up.
        expect(await uploads()).toEqual([
          { draftId: "draft-2", version: "4", sheets: ["Soft Joy/face"] },
        ]);
        expect(render).toHaveBeenCalledTimes(1);
      });

      it("drop what was drawn for a draft that is discarded meanwhile", async () => {
        let release!: () => void;
        preview.render = namedSheets(
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
        server.refuseFrames = () => {
          server.refuseFrames = null;
          return jsonResponse(
            { detail: { code: "generation_not_found" } },
            404,
          );
        };
        const { result } = await mount([wave(), joy()]);
        requestBoth(wave(), joy());
        await settle();
        act(() => forgetGenerationRunDraft(CONVERSATION, "draft-1"));
        release();
        await settle();

        // The other draft's sheets are sent, and nothing is reported failed.
        expect(await uploads()).toEqual([
          { draftId: "draft-2", version: "4", sheets: ["Soft Joy/face"] },
        ]);
        expect(result().frames).toEqual({ status: "idle", draftId: null });
      });
    });

    it("are not drawn without a preview canvas, and the page can say so", async () => {
      const draft = readyDraft();
      const { result, rerender } = await mount([draft]);
      requestFrames(draft);
      await settle();

      expect(result().frames).toEqual({
        status: "unavailable",
        draftId: draft.id,
      });
      expect(server.frames).toEqual([]);

      // A canvas that mounts while the run still waits draws them.
      const render = vi.fn<PreviewSheetRenderer>(async () => [sheet("Andrew")]);
      preview.render = render;
      rerender({
        conversationId: CONVERSATION,
        drafts: [draft],
        avatarExpressionNames: ["happy", "blink"],
      });
      await settle();
      expect(render).toHaveBeenCalledTimes(1);
      expect(server.frames).toHaveLength(1);
    });

    it("are never drawn for a clip the page did not validate as loadable", async () => {
      const render = vi.fn<PreviewSheetRenderer>(async () => [sheet("Andrew")]);
      preview.render = render;
      const broken = generationDraft({
        project: brokenProject(),
        status: "failed",
        checked_version: 1,
      });
      await mount([broken]);
      requestFrames(broken);
      await settle();
      expect(render).not.toHaveBeenCalled();

      // Nor for a version this page does not hold.
      act(() =>
        applyGenerationRunEvent(
          CONVERSATION,
          { type: "frames.requested", draftId: broken.id, version: 7 },
          REQUEST,
        ),
      );
      await settle();
      expect(render).not.toHaveBeenCalled();
      expect(server.frames).toEqual([]);
    });

    it("report a failure once, without drawing or uploading again", async () => {
      const render = vi.fn<PreviewSheetRenderer>(async () => {
        throw new Error("The preview renderer is not available.");
      });
      preview.render = render;
      const draft = readyDraft();
      const { result } = await mount([draft]);
      requestFrames(draft);
      await settle();

      expect(result().frames).toEqual({ status: "failed", draftId: draft.id });
      expect(server.frames).toEqual([]);
      await settle();
      expect(render).toHaveBeenCalledTimes(1);
    });

    it("leave out a sheet the backend would refuse for its size", async () => {
      preview.render = vi.fn<PreviewSheetRenderer>(async () => [
        sheet("Andrew", 4 * 1024 * 1024 + 1),
        sheet("Annie"),
      ]);
      const draft = readyDraft();
      await mount([draft]);
      requestFrames(draft);
      await settle();
      expect(server.frames[0]!.files.map(({ name }) => name)).toEqual([
        "Annie.jpg",
      ]);
    });
  });

  it("still checks a waiting draft when development replays its effects", async () => {
    const draft = generationDraft();
    const { result } = await mount([draft], {}, { strict: true });

    // The first worker was stopped by the replay; the second did the check.
    expect(checks.clients.map(({ disposed }) => disposed)).toEqual([
      true,
      false,
    ]);
    expect(server.reports).toHaveLength(1);
    expect(result().failures).toEqual({});
    expect(cachedDrafts()[0]!.checked_version).toBe(1);
  });

  it("stops the checks worker when it unmounts", async () => {
    const { unmount } = await mount([generationDraft()]);
    expect(checks.clients).toHaveLength(1);
    expect(checks.clients[0]!.disposed).toBe(false);
    unmount();
    expect(checks.clients[0]!.disposed).toBe(true);
  });
});
