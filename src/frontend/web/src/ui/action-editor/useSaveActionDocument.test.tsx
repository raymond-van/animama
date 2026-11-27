// @vitest-environment happy-dom
import { act } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { privateStateResets } from "@/app/runtime/private-module-state";
import { serializeAnimaPoseClipFile } from "@/lib/avatar/poses/animaPoseClip";
import { ContentSaveApiError } from "@/lib/content/contentSaveErrors";
import { queryKeys } from "@/query/keys";
import {
  generationDraft,
  jsonResponse,
} from "@/ui/generate/testing/generationFixtures";
import {
  mountGenerationHook,
  settle,
  type MountedHook,
} from "@/ui/generate/testing/generationHarness";
import { createGestureLibraryServer } from "@/ui/generate/testing/gestureLibraryServer";
import { draftActionDocument } from "@/ui/generate/useSaveGenerationDraft";
import { createGestureDocument } from "@/ui/gesture-editor/gestureDocument";
import {
  ActionDocumentIncompleteError,
  useSaveActionDocument,
} from "./useSaveActionDocument";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
// The real hash runs in a Web Worker, which this environment lacks.
vi.mock("@/lib/content/contentUploads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/contentUploads")>()),
  sha256File: (await import("@/ui/generate/testing/generationFixtures"))
    .sha256FileInline,
}));

type Saver = ReturnType<typeof useSaveActionDocument>;
let library: ReturnType<typeof createGestureLibraryServer>;
let mounted: MountedHook<null, Saver>;

function mount() {
  mounted = mountGenerationHook(() => useSaveActionDocument("gesture"), {
    props: null,
    fetch: async (request) => {
      const answer = await library.handle(request);
      if (!answer) throw new Error(`Unexpected request: ${request.url}`);
      return answer;
    },
  });
  return mounted.result;
}

beforeEach(() => {
  library = createGestureLibraryServer();
});

afterEach(() => {
  mounted.unmount();
  for (const reset of privateStateResets()) reset();
});

describe("useSaveActionDocument", () => {
  it("saves a document built from a draft's project as a new Local Gesture", async () => {
    const document = draftActionDocument(generationDraft());
    const result = mount();
    const invalidated = vi.spyOn(mounted.queryClient, "invalidateQueries");
    const onSaved = vi.fn(() => {
      // Called once the catalog accepted the save, before the person is told.
      expect(library.saves).toHaveLength(1);
      expect(toast.success).not.toHaveBeenCalled();
    });

    let target!: Awaited<ReturnType<Saver["saveDocument"]>>;
    await act(async () => {
      target = await result().saveDocument({ document, onSaved });
    });

    expect(library.saves).toEqual([
      {
        entryName: "Shy Wave",
        catalogItemId: null,
        expectedRevision: null,
        descriptor: {
          schema_version: 1,
          content_type: "gesture",
          id: "local:gesture:shy-wave",
          name: "Shy Wave",
          ai_description: "A small, shy wave with a smile.",
          semantic_key: "shy_wave",
          implementation: { kind: "anima_clip", file_role: "sequence" },
          files: [{ path: "shy-wave.json", role: "sequence" }],
          dependencies: [],
        },
        file: {
          name: "shy-wave.json",
          // The clip as the creator writes it: the file every Gesture saves.
          clip: JSON.parse(serializeAnimaPoseClipFile(document.sequence)),
        },
      },
    ]);
    expect(target).toEqual({
      kind: "gesture",
      itemId: "item-1",
      name: "Shy Wave",
      description: "A small, shy wave with a smile.",
      source: {
        type: "catalog",
        catalog_item_id: "item-1",
        logical_key: "local:gesture:shy-wave",
        source: "local",
      },
      semanticKey: "shy_wave",
      includedCount: 0,
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Gesture saved.", {
      description:
        "The readable Local files were updated. Active chats keep their mounted bytes until reopened.",
    });
    // The Library's lists read the new item.
    expect(invalidated).toHaveBeenCalledWith({
      queryKey: queryKeys.gestures.all("session"),
    });
    await settle();
    expect(result()).toMatchObject({
      stage: "idle",
      identity: null,
      isSaving: false,
    });
  });

  it("replaces the Local item the document was loaded from", async () => {
    library.add("item-7", {
      id: "local:gesture:old-wave",
      name: "Old Wave",
      semantic_key: "old_wave",
      implementation: { kind: "anima_clip", file_role: "sequence" },
    });
    const result = mount();
    await act(async () => {
      await result().saveDocument({
        document: draftActionDocument(generationDraft()),
        itemId: "item-7",
      });
    });

    expect(library.saves[0]).toMatchObject({
      entryName: "Shy Wave",
      catalogItemId: "item-7",
      expectedRevision: "0".repeat(64),
      // The item keeps its identity under its new name.
      descriptor: { id: "local:gesture:old-wave", name: "Shy Wave" },
    });
  });

  it("names the missing details and sends nothing for an incomplete document", async () => {
    const result = mount();
    const incomplete = {
      ...draftActionDocument(generationDraft()),
      aiDescription: " ",
    };

    const failure = await act(() =>
      result()
        .saveDocument({ document: incomplete })
        .catch((error: unknown) => error),
    );

    expect(failure).toBeInstanceOf(ActionDocumentIncompleteError);
    expect(toast.error).toHaveBeenCalledWith(
      "Complete the required Gesture details.",
      { description: (failure as Error).message },
    );
    expect(library.saves).toEqual([]);
    expect(result().stage).toBe("idle");
    // A blank new document is incomplete too.
    await act(async () => {
      await expect(
        result().saveDocument({ document: createGestureDocument() }),
      ).rejects.toBeInstanceOf(ActionDocumentIncompleteError);
    });
  });

  it("keeps the edit session after a failure, so a retry continues it", async () => {
    const result = mount();
    const document = draftActionDocument(generationDraft());
    library.refuseNextSave(() =>
      jsonResponse(
        { detail: { code: "content_name_conflict", field: "name" } },
        409,
      ),
    );

    const failure = await act(() =>
      result()
        .saveDocument({ document })
        .catch((error: unknown) => error),
    );
    expect(failure).toBeInstanceOf(ContentSaveApiError);
    expect(toast.success).not.toHaveBeenCalled();
    await settle();
    const open = result().identity;
    expect(open).toMatchObject({ sessionRevision: 1 });
    expect(result().stage).toBe("idle");

    await act(async () => {
      await result().saveDocument({ document });
    });
    expect(library.saves).toHaveLength(2);
    await settle();
    expect(result().identity).toBeNull();
  });

  it("starts a new session for a document saved under another key", async () => {
    const result = mount();
    const document = draftActionDocument(generationDraft());
    const refuse = () =>
      library.refuseNextSave(() =>
        jsonResponse({ detail: { code: "content_name_conflict" } }, 409),
      );
    const failedSave = async (sessionKey: string) => {
      refuse();
      await act(() =>
        result()
          .saveDocument({ document, sessionKey })
          .catch(() => undefined),
      );
      await settle();
      return result().identity!;
    };

    const first = await failedSave("draft-1");
    const again = await failedSave("draft-1");
    // The same document's retry continued its session.
    expect(again.sessionId).toBe(first.sessionId);
    expect(again.sessionRevision).toBe(first.sessionRevision + 1);

    const other = await failedSave("draft-2");
    expect(other.sessionId).not.toBe(first.sessionId);
    expect(other.sessionRevision).toBe(1);
  });

  it("lets a caller restore and forget an edit session", async () => {
    const result = mount();
    const session = {
      itemId: "new:recovered",
      itemRevision: null,
      sessionId: "recovered",
      sessionRevision: 3,
    };
    act(() => result().restoreSession(session));
    expect(result().identity).toEqual(session);
    act(() => result().resetSession());
    expect(result().identity).toBeNull();
  });
});
