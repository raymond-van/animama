import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chatRunMessageId,
  mapServerMessagesForDisplay,
  messageTimestampMs,
  sortDisplayMessagesByCreatedAt,
} from "@animama/product-ui/chat";

describe("display message mapping", () => {
  it("expands one persisted structured assistant row into speech then display", () => {
    expect(
      mapServerMessagesForDisplay([
        {
          id: 123,
          chat_id: "chat-1",
          run_id: "run-1",
          role: "assistant",
          content: "Longer display details.",
          data: {
            structured: {
              speech: "Short spoken reply.",
              display: "Longer display details.",
            },
          },
        },
      ]),
    ).toEqual([
      {
        id: chatRunMessageId("run-1", "assistant"),
        role: "assistant",
        text: "Short spoken reply.",
      },
      {
        id: chatRunMessageId("run-1", "assistant", 1),
        role: "assistant",
        text: "Longer display details.",
      },
    ]);
  });

  it("hides audio tags in reloaded speech, and drops a tag-only speech bubble", () => {
    expect(
      mapServerMessagesForDisplay([
        {
          id: 1,
          chat_id: "chat-1",
          run_id: "run-1",
          role: "assistant",
          content: "Oh my gosh, [laughs] that is so funny!",
          data: {
            structured: {
              speech: "Oh my gosh, [laughs] that is so funny!",
              display: null,
            },
          },
        },
        {
          id: 2,
          chat_id: "chat-1",
          run_id: "run-2",
          role: "assistant",
          content: "Details.",
          data: { structured: { speech: "[laughs]", display: "Details." } },
        },
      ]).map((message) => message.text),
    ).toEqual(["Oh my gosh, that is so funny!", "Details."]);
  });

  it("shows no bubble for reloaded speech of only tags, not its content", () => {
    expect(
      mapServerMessagesForDisplay([
        {
          id: 3,
          chat_id: "chat-1",
          run_id: "run-3",
          role: "assistant",
          content: "[laughs] [sighs]",
          data: { structured: { speech: "[laughs] [sighs]", display: null } },
        },
      ]),
    ).toEqual([]);
  });

  it("suppresses display text that duplicates structured speech", () => {
    expect(
      mapServerMessagesForDisplay([
        {
          run_id: "run-1",
          role: "assistant",
          content: "Same answer.",
          data: {
            structured: {
              speech: " Same answer. ",
              display: "Same answer.",
            },
          },
        },
      ]),
    ).toEqual([
      {
        id: chatRunMessageId("run-1", "assistant"),
        role: "assistant",
        text: "Same answer.",
      },
    ]);
  });

  it("gives expanded structured messages stable unique ids without a run id", () => {
    expect(
      mapServerMessagesForDisplay([
        {
          id: 123,
          role: "assistant",
          content: "Display details.",
          data: {
            structured: {
              speech: "Spoken answer.",
              display: "Display details.",
            },
          },
        },
      ]).map((message) => message.id),
    ).toEqual(["msg-123", "msg-123-1"]);
  });

  it("uses run-stable ids for messages from the same streamed turn", () => {
    const messages = mapServerMessagesForDisplay([
      {
        chat_id: "chat-1",
        run_id: "run-1",
        role: "user",
        content: "Hello",
        created_at: "2026-07-05T12:00:00.000Z",
      },
      {
        chat_id: "chat-1",
        run_id: "run-1",
        role: "assistant",
        content: "Spoken answer.",
        created_at: "2026-07-05T12:00:01.000Z",
      },
      {
        chat_id: "chat-1",
        run_id: "run-1",
        role: "assistant",
        content: "Display details.",
        created_at: "2026-07-05T12:00:02.000Z",
      },
    ]);

    expect(messages.map((message) => message.id)).toEqual([
      chatRunMessageId("run-1", "user"),
      chatRunMessageId("run-1", "assistant"),
      chatRunMessageId("run-1", "assistant", 1),
    ]);
  });

  it("falls back to persisted ids for legacy messages without run ids", () => {
    expect(
      mapServerMessagesForDisplay([
        {
          id: 123,
          chat_id: "chat-1",
          role: "assistant",
          content: "Historical answer.",
        },
      ]),
    ).toEqual([
      {
        id: "msg-123",
        role: "assistant",
        text: "Historical answer.",
      },
    ]);
  });

  it("falls back to content when structured assistant data is unusable", () => {
    expect(
      mapServerMessagesForDisplay([
        {
          id: 123,
          role: "assistant",
          content: "Historical answer.",
          data: {
            structured: {
              speech: null,
              display: 42,
            },
          },
        },
      ]),
    ).toEqual([
      {
        id: "msg-123",
        role: "assistant",
        text: "Historical answer.",
      },
    ]);
  });

  it("puts a reply's memory cue only on the last bubble of its row", () => {
    const memoryCue = {
      episode: { text: "They adopted a cat named Miso." },
      memories: { entry_id: "mem-1", version: 3, excerpt: "- Miso the cat" },
    };
    const messages = mapServerMessagesForDisplay([
      {
        id: 10,
        run_id: "run-1",
        role: "user",
        content: "I adopted a cat!",
        memory_cue: null,
      },
      {
        id: 11,
        run_id: "run-1",
        role: "assistant",
        content: "Tell me everything.",
        data: {
          structured: {
            speech: "A cat!",
            display: "Tell me everything.",
          },
        },
        memory_cue: memoryCue,
      },
    ]);

    expect(messages.map((message) => message.memoryCue ?? null)).toEqual([
      null,
      null,
      memoryCue,
    ]);
  });

  it("keeps the cue on a single-bubble reply and ignores empty or malformed cues", () => {
    const [withCue, emptyCue, malformedCue] = mapServerMessagesForDisplay([
      {
        id: 1,
        role: "assistant",
        content: "Noted.",
        memory_cue: {
          episode: null,
          memories: { entry_id: "mem-1", version: 2, excerpt: "" },
        },
      },
      {
        id: 2,
        role: "assistant",
        content: "Nothing to remember.",
        memory_cue: { episode: null, memories: null },
      },
      {
        id: 3,
        role: "assistant",
        content: "Broken cue.",
        memory_cue: {
          episode: { text: "  " },
          memories: { entry_id: "mem-1", version: "2", excerpt: "x" },
        } as never,
      },
    ]);

    // A removal-only change has an empty excerpt but is still an update.
    expect(withCue.memoryCue).toEqual({
      episode: null,
      memories: { entry_id: "mem-1", version: 2, excerpt: "" },
    });
    expect(emptyCue).not.toHaveProperty("memoryCue");
    expect(malformedCue).not.toHaveProperty("memoryCue");
  });

  it("skips internal and empty messages", () => {
    expect(
      mapServerMessagesForDisplay([
        {
          run_id: "run-1",
          role: "assistant",
          content: "Hidden.",
          internal: true,
        },
        {
          run_id: "run-1",
          role: "assistant",
          content: "   ",
        },
      ]),
    ).toEqual([]);
  });
});

describe("display message ordering", () => {
  // A zone west of UTC reproduces persisted rows sorting into the future.
  const originalTimeZone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "America/New_York";
  });
  afterEach(() => {
    process.env.TZ = originalTimeZone;
  });

  it("reads offset-less server timestamps as UTC", () => {
    const utc = Date.parse("2026-10-08T17:58:01.492Z");
    expect(messageTimestampMs("2026-10-08T17:58:01.492")).toBe(utc);
    expect(messageTimestampMs("2026-10-08T17:58:01.492Z")).toBe(utc);
    expect(messageTimestampMs("2026-10-08T13:58:01.492-04:00")).toBe(utc);
    expect(messageTimestampMs("2026-10-08T19:58:01.492+0200")).toBe(utc);
  });

  it("treats missing or invalid timestamps as zero", () => {
    expect(messageTimestampMs(undefined)).toBe(0);
    expect(messageTimestampMs("")).toBe(0);
    expect(messageTimestampMs("not a date")).toBe(0);
  });

  it("keeps a just-sent message after earlier persisted rows", () => {
    const messages = [
      {
        id: "run-1-user",
        role: "user" as const,
        text: "First",
        createdAt: "2026-10-08T17:58:01.492418",
      },
      {
        id: "run-1-assistant",
        role: "assistant" as const,
        text: "Reply",
        createdAt: "2026-10-08T17:58:01.492418",
      },
      {
        id: "run-2-user",
        role: "user" as const,
        text: "Second",
        createdAt: "2026-10-08T18:00:00.000Z",
      },
    ];

    expect(
      sortDisplayMessagesByCreatedAt([
        messages[2],
        ...messages.slice(0, 2),
      ]).map((message) => message.id),
    ).toEqual(["run-1-user", "run-1-assistant", "run-2-user"]);
  });

  it("shows a user message with images as the person's text and its images", () => {
    expect(
      mapServerMessagesForDisplay([
        {
          id: 7,
          chat_id: "chat-1",
          run_id: "run-1",
          role: "user",
          content: "What is this?\n\n[Image: cat.png]\n[Image: dog.jpg]",
          data: {
            attached_file_ids: ["file-1", "file-2", "doc-1"],
            images: [
              { file_id: "file-1", name: "cat.png", width: 40, height: 20 },
              { file_id: "file-2", name: "dog.jpg" },
            ],
            user_text: "What is this?",
          },
        },
      ]),
    ).toEqual([
      {
        id: chatRunMessageId("run-1", "user"),
        role: "user",
        text: "What is this?",
        images: [
          { fileId: "file-1", name: "cat.png", width: 40, height: 20 },
          { fileId: "file-2", name: "dog.jpg" },
        ],
      },
    ]);
  });

  it("ignores image entries it cannot read and keeps the saved text without them", () => {
    expect(
      mapServerMessagesForDisplay([
        {
          id: 8,
          chat_id: "chat-1",
          run_id: "run-2",
          role: "user",
          content: "Look\n\n[Image: cat.png]",
          data: {
            images: [{ name: "no id" }, "file-1", null],
            user_text: "Look",
          },
        },
      ]),
    ).toEqual([
      {
        id: chatRunMessageId("run-2", "user"),
        role: "user",
        text: "Look\n\n[Image: cat.png]",
      },
    ]);
  });
});
