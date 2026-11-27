// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";

import {
  generationDraft,
  generationSnapshot,
} from "./testing/generationFixtures";
import {
  mountGenerationHook,
  type MountedHook,
} from "./testing/generationHarness";
import { useSelectedDraft } from "./useSelectedDraft";

type Props = {
  conversationId: string | null;
  snapshot: PyGenerationConversationSnapshot | undefined;
};
type Result = ReturnType<typeof useSelectedDraft>;

let mounted: MountedHook<Props, Result>;
function mount(props: Props) {
  mounted = mountGenerationHook(
    ({ conversationId, snapshot }: Props) =>
      useSelectedDraft(conversationId, snapshot),
    { props, fetch: () => Promise.reject(new Error("No request expected.")) },
  );
  return mounted;
}
afterEach(() => mounted.unmount());

const draft = (id: string, position: number) =>
  generationDraft({ id, position });
const withDrafts = (...drafts: PyGenerationDraft[]) =>
  generationSnapshot({ drafts });
const selectedId = () => mounted.result()[0]?.id ?? null;

describe("useSelectedDraft", () => {
  it("selects a conversation's latest draft when it opens", () => {
    mount({ conversationId: "conversation-1", snapshot: undefined });
    expect(selectedId()).toBeNull();
    mounted.rerender({
      conversationId: "conversation-1",
      snapshot: withDrafts(draft("draft-1", 0), draft("draft-2", 1)),
    });
    expect(selectedId()).toBe("draft-2");
  });

  it("selects a draft the assistant has just written", () => {
    const first = draft("draft-1", 0);
    mount({ conversationId: "conversation-1", snapshot: withDrafts(first) });
    expect(selectedId()).toBe("draft-1");
    mounted.rerender({
      conversationId: "conversation-1",
      snapshot: withDrafts(first, draft("draft-2", 1)),
    });
    expect(selectedId()).toBe("draft-2");
  });

  it("keeps the person's choice while the drafts change, and follows its new versions", () => {
    const first = draft("draft-1", 0);
    const second = draft("draft-2", 1);
    mount({
      conversationId: "conversation-1",
      snapshot: withDrafts(first, second),
    });
    act(() => mounted.result()[1]("draft-1"));
    expect(selectedId()).toBe("draft-1");

    const revised = { ...first, version: 2 };
    mounted.rerender({
      conversationId: "conversation-1",
      snapshot: withDrafts(revised, second),
    });
    expect(mounted.result()[0]).toBe(revised);
  });

  it("selects nothing once the person asks for a new draft, until one arrives", () => {
    const first = draft("draft-1", 0);
    mount({ conversationId: "conversation-1", snapshot: withDrafts(first) });
    act(() => mounted.result()[1](null));
    expect(selectedId()).toBeNull();
    // A change to the same drafts does not bring the selection back.
    mounted.rerender({
      conversationId: "conversation-1",
      snapshot: withDrafts({ ...first, status: "ready" }),
    });
    expect(selectedId()).toBeNull();
    mounted.rerender({
      conversationId: "conversation-1",
      snapshot: withDrafts(first, draft("draft-2", 1)),
    });
    expect(selectedId()).toBe("draft-2");
  });

  it("drops a selection whose draft was discarded", () => {
    const first = draft("draft-1", 0);
    const second = draft("draft-2", 1);
    mount({
      conversationId: "conversation-1",
      snapshot: withDrafts(first, second),
    });
    mounted.rerender({
      conversationId: "conversation-1",
      snapshot: withDrafts(first),
    });
    expect(selectedId()).toBeNull();
  });

  it("starts again from the latest draft in another conversation", () => {
    mount({
      conversationId: "conversation-1",
      snapshot: withDrafts(draft("draft-1", 0)),
    });
    // The other conversation is still being read.
    mounted.rerender({ conversationId: "conversation-2", snapshot: undefined });
    expect(selectedId()).toBeNull();
    mounted.rerender({
      conversationId: "conversation-2",
      snapshot: withDrafts(draft("draft-8", 0), draft("draft-9", 1)),
    });
    expect(selectedId()).toBe("draft-9");
  });

  describe("a batch, whose drafts are listed before they are written", () => {
    const planned = (id: string, position: number) =>
      generationDraft({ id, position, status: "writing", project: null });

    it("selects the first item to be written, and stays there as the others are", () => {
      const earlier = draft("draft-0", 0);
      mount({
        conversationId: "conversation-1",
        snapshot: withDrafts(earlier),
      });
      // A batch starts from no selection: it writes new drafts.
      act(() => mounted.result()[1](null));
      mounted.rerender({
        conversationId: "conversation-1",
        snapshot: withDrafts(
          earlier,
          planned("draft-1", 1),
          planned("draft-2", 2),
          planned("draft-3", 3),
        ),
      });
      // Nothing can be played or revised yet.
      expect(selectedId()).toBeNull();

      // The second item is written first: the preview gets a draft to play.
      mounted.rerender({
        conversationId: "conversation-1",
        snapshot: withDrafts(
          earlier,
          planned("draft-1", 1),
          draft("draft-2", 2),
          planned("draft-3", 3),
        ),
      });
      expect(selectedId()).toBe("draft-2");

      // The others being written does not take the selection away.
      mounted.rerender({
        conversationId: "conversation-1",
        snapshot: withDrafts(
          earlier,
          draft("draft-1", 1),
          draft("draft-2", 2),
          draft("draft-3", 3),
        ),
      });
      expect(selectedId()).toBe("draft-2");
    });

    it("leaves the person's own choice alone while the batch is written", () => {
      const earlier = draft("draft-0", 0);
      mount({
        conversationId: "conversation-1",
        snapshot: withDrafts(earlier),
      });
      mounted.rerender({
        conversationId: "conversation-1",
        snapshot: withDrafts(earlier, planned("draft-1", 1)),
      });
      expect(selectedId()).toBe("draft-0");
      mounted.rerender({
        conversationId: "conversation-1",
        snapshot: withDrafts(earlier, draft("draft-1", 1)),
      });
      expect(selectedId()).toBe("draft-0");
    });
  });

  describe("a failed draft that never had a project", () => {
    const empty = (id: string, position: number) =>
      generationDraft({ id, position, status: "failed", project: null });

    it("is not selected when the assistant lists it after a failed write", () => {
      const first = draft("draft-1", 0);
      mount({ conversationId: "conversation-1", snapshot: withDrafts(first) });
      // The person asked for a new draft; the write produced none that works.
      act(() => mounted.result()[1](null));
      mounted.rerender({
        conversationId: "conversation-1",
        snapshot: withDrafts(first, empty("draft-2", 1)),
      });
      expect(selectedId()).toBeNull();
    });

    it("leaves the selection where it was when it appears", () => {
      const first = draft("draft-1", 0);
      mount({ conversationId: "conversation-1", snapshot: withDrafts(first) });
      mounted.rerender({
        conversationId: "conversation-1",
        snapshot: withDrafts(first, empty("draft-2", 1)),
      });
      expect(selectedId()).toBe("draft-1");
    });

    it("is passed over on opening a conversation, for the latest draft that has one", () => {
      // After a reload: the failed draft is the conversation's latest.
      mount({
        conversationId: "conversation-1",
        snapshot: withDrafts(
          draft("draft-1", 0),
          draft("draft-2", 1),
          empty("draft-3", 2),
        ),
      });
      expect(selectedId()).toBe("draft-2");
      mounted.unmount();

      mount({
        conversationId: "conversation-1",
        snapshot: withDrafts(empty("draft-3", 0)),
      });
      expect(selectedId()).toBeNull();
    });

    it("can still be picked by the person, to see why it failed", () => {
      mount({
        conversationId: "conversation-1",
        snapshot: withDrafts(draft("draft-1", 0), empty("draft-2", 1)),
      });
      act(() => mounted.result()[1]("draft-2"));
      expect(selectedId()).toBe("draft-2");
    });
  });
});
