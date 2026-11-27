// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";

import { privateStateResets } from "@/app/runtime/private-module-state";
import { actionDocumentDigest } from "@/lib/content/actionRecovery";
import { queryKeys } from "@/query/keys";
import {
  importedProjectDocument,
  parseActionImport,
} from "@/ui/action-editor/actionProject";
import { ActionDocumentIncompleteError } from "@/ui/action-editor/useSaveActionDocument";
import { createGestureDocument } from "@/ui/gesture-editor/gestureDocument";
import {
  effectGestureProject,
  generationDraft,
  generationSnapshot,
  gestureProject,
  jsonResponse,
  sparkleDependency,
  waveHelloClip,
} from "./testing/generationFixtures";
import {
  mountGenerationHook,
  settle,
  type MountedHook,
} from "./testing/generationHarness";
import { createGestureLibraryServer } from "./testing/gestureLibraryServer";
import { validateDraft } from "./useDraftWorker";
import {
  draftActionDocument,
  useSaveGenerationDraft,
  type SaveGenerationDraft,
} from "./useSaveGenerationDraft";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
// The real hash runs in a Web Worker, which this environment lacks.
vi.mock("@/lib/content/contentUploads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/contentUploads")>()),
  sha256File: (await import("./testing/generationFixtures")).sha256FileInline,
}));

const SNAPSHOT = queryKeys.generation.conversation("session", "conversation-1");
let library: ReturnType<typeof createGestureLibraryServer>;
/** `mark-saved` requests, and a refusal for the next one. */
const marks = {
  requests: [] as { draftId: string; itemId: unknown }[],
  failNext: false,
};
let mounted: MountedHook<null, SaveGenerationDraft>;

async function fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const mark = /^\/v1\/generation\/drafts\/([^/]+):mark-saved$/.exec(pathname);
  if (mark) {
    const { item_id } = (await request.json()) as { item_id: string };
    marks.requests.push({ draftId: mark[1]!, itemId: item_id });
    if (marks.failNext) {
      marks.failNext = false;
      return jsonResponse({ detail: "unavailable" }, 503);
    }
    return jsonResponse(
      generationDraft({
        id: mark[1]!,
        status: "ready",
        checked_version: 1,
        saved_item_id: item_id,
        updated_at: "2026-11-26T10:09:00Z",
      }),
    );
  }
  const answer = await library.handle(request);
  if (!answer) throw new Error(`Unexpected request: ${request.url}`);
  return answer;
}

function mount(drafts: PyGenerationDraft[]) {
  mounted = mountGenerationHook(useSaveGenerationDraft, {
    props: null,
    fetch,
  });
  mounted.queryClient.setQueryData(SNAPSHOT, generationSnapshot({ drafts }));
  return mounted.result;
}

const readyDraft = (overrides: Partial<PyGenerationDraft> = {}) =>
  generationDraft({ status: "ready", checked_version: 1, ...overrides });

beforeEach(() => {
  library = createGestureLibraryServer();
  marks.requests = [];
  marks.failNext = false;
});

afterEach(() => {
  mounted?.unmount();
  for (const reset of privateStateResets()) reset();
});

describe("draftActionDocument", () => {
  it("is the document the creator's Import makes of the draft's project", () => {
    const draft = generationDraft();
    const imported = parseActionImport(draft.project, "gesture");
    if (imported.kind !== "project") throw new Error("Expected a project.");

    const document = draftActionDocument(draft);

    expect(document).toEqual(
      importedProjectDocument(createGestureDocument(), imported.project),
    );
    expect(document).toMatchObject({
      schema: 1,
      intent: "gesture",
      name: "Shy Wave",
      aiDescription: "A small, shy wave with a smile.",
      semanticKey: "shy_wave",
      implementation: "anima_clip",
      dependencies: [],
      sequence: {
        schema: "animaPoseClip/2.0",
        id: "shy-wave",
        name: "Shy Wave",
      },
    });
    // Unsaved: it differs from the blank document a new creator starts with.
    expect(actionDocumentDigest(document)).not.toBe(
      actionDocumentDigest(createGestureDocument()),
    );
  });

  it("keeps a draft's effects: its timeline events and the dependencies that pin them", () => {
    const draft = generationDraft({
      project: effectGestureProject({
        dependencies: [
          sparkleDependency(),
          // Declared but played by no event: left out, as the creator's Save does.
          {
            alias: "unused",
            content_type: "particle_effect",
            source: { type: "catalog", catalog_item_id: "effect-item-9" },
          },
        ],
      }),
    });
    const document = draftActionDocument(draft);
    expect(document.dependencies).toEqual([sparkleDependency()]);
    expect(document.sequence.events).toEqual([
      {
        id: "effect-1",
        time: 0,
        kind: "avatar_vfx",
        effectId: "sparkle",
        duration: 0.5,
      },
    ]);
  });

  it("refuses what the creator's Import would refuse", () => {
    // A bare clip is not a draft's project.
    expect(() =>
      draftActionDocument(generationDraft({ project: waveHelloClip() })),
    ).toThrow("could not be imported");
    expect(() =>
      draftActionDocument(generationDraft({ project: null })),
    ).toThrow();
    expect(() =>
      draftActionDocument(
        generationDraft({ project: gestureProject({ intent: "reaction" }) }),
      ),
    ).toThrow("cannot open in the gesture editor");
    expect(() =>
      draftActionDocument(
        generationDraft({
          project: gestureProject({
            sequence: { ...waveHelloClip(), beats: "none" },
          }),
        }),
      ),
    ).toThrow();
  });
});

describe("useSaveGenerationDraft", () => {
  it("saves a draft through the creator's save and records the item on the draft", async () => {
    const draft = readyDraft();
    const result = mount([draft]);

    let saved!: PyGenerationDraft;
    await act(async () => {
      saved = await result().save(draft, validateDraft(draft));
    });

    expect(library.saves).toHaveLength(1);
    expect(library.saves[0]).toMatchObject({
      entryName: "Shy Wave",
      catalogItemId: null,
      descriptor: { content_type: "gesture", semantic_key: "shy_wave" },
      file: { name: "shy-wave.json" },
    });
    expect(marks.requests).toEqual([{ draftId: draft.id, itemId: "item-1" }]);
    expect(saved.saved_item_id).toBe("item-1");
    expect(
      mounted.queryClient.getQueryData<PyGenerationConversationSnapshot>(
        SNAPSHOT,
      )!.drafts[0]!.saved_item_id,
    ).toBe("item-1");
    await settle();
    expect(result()).toMatchObject({ savingDraftId: null, stage: "idle" });
  });

  it("saves a draft's effects with it: the dependencies in its descriptor, the events in its clip", async () => {
    const draft = readyDraft({ project: effectGestureProject() });
    const result = mount([draft]);

    await act(async () => {
      await result().save(draft, validateDraft(draft));
    });

    expect(library.saves).toHaveLength(1);
    const { descriptor, file } = library.saves[0]!;
    // The creator's own dependency record (R7.3): the alias the events name,
    // pinned to the Library item.
    expect(descriptor.dependencies).toEqual([
      {
        ref: "local:avatar-effect:sparkle",
        alias: "sparkle",
        content_type: "avatar_effect",
        source: sparkleDependency().source,
        config: {},
      },
    ]);
    expect(file.clip.events).toEqual([
      {
        id: "effect-1",
        time: 0,
        kind: "avatar_vfx",
        effectId: "sparkle",
        duration: 0.5,
      },
    ]);
    expect(marks.requests).toEqual([{ draftId: draft.id, itemId: "item-1" }]);
  });

  it("refuses, in the creator's words, a draft whose event names an effect it never pinned", async () => {
    const draft = readyDraft({
      project: effectGestureProject({ dependencies: [] }),
    });
    const result = mount([draft]);
    await act(async () => {
      await expect(
        result().save(draft, validateDraft(draft)),
      ).rejects.toBeInstanceOf(ActionDocumentIncompleteError);
    });
    expect(library.saves).toEqual([]);
    expect(marks.requests).toEqual([]);
  });

  it("saves nothing for a draft the page did not validate as loadable", async () => {
    const broken = readyDraft({
      project: gestureProject({
        sequence: { ...waveHelloClip(), beats: "none" },
      }),
    });
    const draft = readyDraft();
    const result = mount([broken, draft]);

    await act(async () => {
      // Its clip does not load, whatever its stored status says.
      await expect(
        result().save(broken, validateDraft(broken)),
      ).rejects.toThrow();
      await expect(result().save(draft, undefined)).rejects.toThrow();
      // A validation of an earlier version does not admit the current one.
      await expect(
        result().save({ ...draft, version: 2 }, validateDraft(draft)),
      ).rejects.toThrow();
    });
    expect(library.saves).toEqual([]);
    expect(marks.requests).toEqual([]);
  });

  it("only records the item again when the save succeeded but its record did not", async () => {
    const draft = readyDraft();
    const result = mount([draft]);
    marks.failNext = true;

    await act(async () => {
      await expect(
        result().save(draft, validateDraft(draft)),
      ).rejects.toThrow();
    });
    expect(library.saves).toHaveLength(1);

    await act(async () => {
      await result().save(draft, validateDraft(draft));
    });
    // No second Library item for the same version.
    expect(library.saves).toHaveLength(1);
    expect(marks.requests).toEqual([
      { draftId: draft.id, itemId: "item-1" },
      { draftId: draft.id, itemId: "item-1" },
    ]);
  });

  it("replaces the Library item of a draft that was saved before", async () => {
    library.add("item-7", {
      id: "local:gesture:shy-wave",
      name: "Shy Wave",
      semantic_key: "shy_wave",
      implementation: { kind: "anima_clip", file_role: "sequence" },
    });
    const revised = readyDraft({
      version: 2,
      checked_version: 2,
      saved_item_id: "item-7",
    });
    const result = mount([revised]);

    await act(async () => {
      await result().save(revised, validateDraft(revised));
    });

    expect(library.saves[0]).toMatchObject({ catalogItemId: "item-7" });
    expect(marks.requests).toEqual([{ draftId: revised.id, itemId: "item-7" }]);
  });

  it("saves a new item when the saved one was deleted from the Library", async () => {
    const draft = readyDraft({ saved_item_id: "item-gone" });
    const result = mount([draft]);

    await act(async () => {
      await result().save(draft, validateDraft(draft));
    });

    expect(library.reads).toContain("item-gone");
    expect(library.saves[0]).toMatchObject({ catalogItemId: null });
    expect(marks.requests).toEqual([{ draftId: draft.id, itemId: "item-1" }]);
  });

  it("rejects with wording for the person when the Library refuses the save", async () => {
    const draft = readyDraft();
    const result = mount([draft]);
    library.refuseNextSave(() =>
      jsonResponse(
        {
          detail: {
            code: "content_save_conflict",
            message: "A Gesture with this Selector ID already exists.",
          },
        },
        409,
      ),
    );

    const failure = await act(() =>
      result()
        .save(draft, validateDraft(draft))
        .catch((error: unknown) => error),
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBeTruthy();
    expect(marks.requests).toEqual([]);
    await settle();
    expect(result().savingDraftId).toBeNull();
  });

  it("passes on an incomplete document's error, which a toast already explained", async () => {
    const draft = readyDraft({
      project: gestureProject({ aiDescription: "" }),
    });
    const result = mount([draft]);
    await act(async () => {
      await expect(
        result().save(draft, validateDraft(draft)),
      ).rejects.toBeInstanceOf(ActionDocumentIncompleteError);
    });
    expect(library.saves).toEqual([]);
  });
});
