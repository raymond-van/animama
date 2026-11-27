import { afterEach, describe, expect, it, vi } from "vitest";

import {
  holdChatSends,
  isChatSendHeld,
  registerStreamingReply,
  stopStreamingReplies,
  useChatDeleteCoordinationStore,
} from "./chat-delete-coordination-store";

afterEach(() => {
  useChatDeleteCoordinationStore.setState({ replies: [], holds: [] });
});

describe("stopping a reply before a delete", () => {
  it("stops the reply streaming in the deleted chat only", () => {
    const deleted = vi.fn();
    const other = vi.fn();
    registerStreamingReply({ animaId: "ava", chatId: "c1", stop: deleted });
    registerStreamingReply({ animaId: "ava", chatId: "c2", stop: other });

    expect(stopStreamingReplies({ chatId: "c1" })).toBe(1);

    expect(deleted).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it("stops every reply of a deleted Anima, including a new chat's first one", () => {
    const first = vi.fn();
    const draft = vi.fn();
    const otherAnima = vi.fn();
    registerStreamingReply({ animaId: "ava", chatId: "c1", stop: first });
    registerStreamingReply({ animaId: "ava", chatId: null, stop: draft });
    registerStreamingReply({ animaId: "bo", chatId: "c3", stop: otherAnima });

    expect(stopStreamingReplies({ animaId: "ava" })).toBe(2);

    expect(first).toHaveBeenCalledTimes(1);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(otherAnima).not.toHaveBeenCalled();
  });

  it("stops nothing once a reply has finished", () => {
    const stop = vi.fn();
    const unregister = registerStreamingReply({
      animaId: "ava",
      chatId: "c1",
      stop,
    });
    unregister();

    expect(stopStreamingReplies({ chatId: "c1" })).toBe(0);
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("holding sends while a delete runs", () => {
  it("holds sends in the chat being deleted until the hold is released", () => {
    const release = holdChatSends({ chatId: "c1" });

    expect(isChatSendHeld({ animaId: "ava", chatId: "c1" })).toBe(true);
    expect(isChatSendHeld({ animaId: "ava", chatId: "c2" })).toBe(false);
    expect(isChatSendHeld({ animaId: "ava", chatId: null })).toBe(false);

    release();
    expect(isChatSendHeld({ animaId: "ava", chatId: "c1" })).toBe(false);
  });

  it("holds every send to an Anima being deleted, a new chat included", () => {
    const release = holdChatSends({ animaId: "ava" });

    expect(isChatSendHeld({ animaId: "ava", chatId: "c1" })).toBe(true);
    expect(isChatSendHeld({ animaId: "ava", chatId: null })).toBe(true);
    expect(isChatSendHeld({ animaId: "bo", chatId: "c3" })).toBe(false);

    release();
    expect(isChatSendHeld({ animaId: "ava", chatId: null })).toBe(false);
  });
});
