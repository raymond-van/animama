import { describe, expect, it } from "vitest";

import socketEn from "./fixtures/v4-turbo-socket-en.json";
import socketEs from "./fixtures/v4-turbo-socket-es.json";
import socketJa from "./fixtures/v4-turbo-socket-ja.json";
import socketKo from "./fixtures/v4-turbo-socket-ko.json";
import socketTags from "./fixtures/v4-turbo-socket-tags.json";
import socketZh from "./fixtures/v4-turbo-socket-zh.json";
import {
  createSpeechTimingCollector,
  type TimedChar,
} from "./provider-speech-timing";
import {
  buildSpeechTimingEvidence,
  classifyAudioTag,
} from "./speech-timing-evidence";

type SocketMessage = {
  samples?: number;
  alignment?: unknown;
  is_final_audio_for_turn?: boolean;
};

/** A captured dialogue socket run's timeline, as the runtime collects it. */
function timelineOf(fixture: { messages: readonly SocketMessage[] }) {
  const collector = createSpeechTimingCollector(24_000);
  const chars: TimedChar[] = [];
  for (const message of fixture.messages) {
    if (message.samples) collector.acceptAudio(message.samples);
    if (message.alignment) {
      chars.push(...collector.acceptDialogueAlignment(message.alignment));
    }
    if (message.is_final_audio_for_turn) collector.endTurn();
  }
  return chars;
}

/** A synthetic timeline giving every character 0.1 s. */
function evenTimeline(text: string): TimedChar[] {
  return Array.from(text).map((char, index) => ({
    char,
    startSec: index / 10,
    endSec: (index + 1) / 10,
  }));
}

describe("spoken words", () => {
  it("groups letters, digits and inner apostrophes into words", () => {
    const evidence = buildSpeechTimingEvidence(timelineOf(socketEn));

    expect(evidence.words.map((word) => word.text)).toEqual(
      [
        "Oh wow that's amazing I can't believe you did it",
        "Hmm I suppose we could try again tomorrow at 3 30 PM",
        "It costs 25 for 2 tickets and Dr Smith said it's fine",
      ]
        .join(" ")
        .split(" "),
    );
    expect(evidence.words.every((word) => word.kind === "word")).toBe(true);
  });

  it("reports each word's provider window unchanged", () => {
    const timeline = timelineOf(socketEn);
    const evidence = buildSpeechTimingEvidence(timeline);

    // "[laughs] " fills indexes 0–8; the laugh's closing bracket ends at 0.32 s
    // and the space after it runs to 0.48 s.
    const oh = evidence.words[0];
    expect(oh).toMatchObject({ text: "Oh", charStart: 9, charEnd: 11 });
    expect(oh.startSec).toBeCloseTo(0.48, 6);
    expect(oh.endSec).toBeCloseTo(0.64, 6);
    expect(
      timeline
        .slice(oh.charStart, oh.charEnd)
        .map((entry) => entry.char)
        .join(""),
    ).toBe("Oh");
  });

  it("keeps Spanish accents and inverted marks apart", () => {
    const evidence = buildSpeechTimingEvidence(timelineOf(socketEs));

    expect(evidence.words.map((word) => word.text)).toEqual(
      "Hola Hoy hace un día precioso Vamos a dar un paseo".split(" "),
    );
    expect(evidence.punctuation.map((entry) => entry.text)).toEqual([
      "¡",
      "!",
      ".",
      "¿",
      "?",
    ]);
  });

  it.each([
    [
      "Japanese",
      socketJa,
      "おはようございます今日はいい天気ですね散歩に行きましょう",
    ],
    ["Chinese", socketZh, "你好今天天气真好我们去散步吧"],
    ["Korean", socketKo, "안녕하세요오늘날씨가정말좋네요산책하러갈까요"],
  ])("gives each %s character its own window", (_name, fixture, characters) => {
    const timeline = timelineOf(fixture);
    const evidence = buildSpeechTimingEvidence(timeline);

    expect(evidence.words.map((word) => word.text)).toEqual(
      Array.from(characters),
    );
    for (const word of evidence.words) {
      expect(word.kind).toBe("character");
      expect(word.charEnd - word.charStart).toBe(1);
      expect(word.startSec).toBe(timeline[word.charStart].startSec);
      expect(word.endSec).toBe(timeline[word.charStart].endSec);
    }
  });

  it("splits mixed scripts at the script boundary", () => {
    const evidence = buildSpeechTimingEvidence(
      evenTimeline("Tシャツを3枚ください"),
    );

    expect(
      evidence.words.map((word) => [word.kind, word.text] as const),
    ).toEqual([
      ["word", "T"],
      ["character", "シ"],
      ["character", "ャ"],
      ["character", "ツ"],
      ["character", "を"],
      ["word", "3"],
      ["character", "枚"],
      ["character", "く"],
      ["character", "だ"],
      ["character", "さ"],
      ["character", "い"],
    ]);
  });
});

describe("punctuation", () => {
  it("keeps runs of punctuation together with their windows", () => {
    const timeline = timelineOf(socketEn);
    const evidence = buildSpeechTimingEvidence(timeline);

    expect(evidence.punctuation.map((entry) => entry.text)).toEqual([
      ",",
      "!",
      ".",
      "...",
      ",",
      ":",
      ".",
      "$",
      ",",
      ".",
      ".",
    ]);
    const ellipsis = evidence.punctuation[3];
    expect(ellipsis.startSec).toBe(timeline[ellipsis.charStart].startSec);
    expect(ellipsis.endSec).toBe(timeline[ellipsis.charEnd - 1].endSec);
  });

  it("treats full-width marks and brackets as punctuation", () => {
    const evidence = buildSpeechTimingEvidence(evenTimeline("「はい。」"));

    expect(evidence.punctuation.map((entry) => entry.text)).toEqual([
      "「",
      "。」",
    ]);
    expect(evidence.words.map((word) => word.text)).toEqual(["は", "い"]);
  });
});

describe("audio tags", () => {
  it("classifies the captured tags and never reports them as words", () => {
    const timeline = timelineOf(socketTags);
    const evidence = buildSpeechTimingEvidence(timeline);

    expect(
      evidence.tags.map((tag) => ({
        raw: tag.raw,
        tagClass: tag.tagClass,
        directions: tag.directions,
      })),
    ).toEqual([
      {
        raw: "[gasps]",
        tagClass: "nonverbal",
        directions: [{ text: "gasps", tagClass: "nonverbal" }],
      },
      {
        raw: "[whispers]",
        tagClass: "delivery",
        directions: [{ text: "whispers", tagClass: "delivery" }],
      },
      {
        raw: "[pause]",
        tagClass: "pacing",
        directions: [{ text: "pause", tagClass: "pacing" }],
      },
      {
        raw: "[whispering, playful]",
        tagClass: "delivery",
        directions: [
          { text: "whispering", tagClass: "delivery" },
          { text: "playful", tagClass: "delivery" },
        ],
      },
    ]);
    expect(evidence.words.map((word) => word.text)).toEqual(
      "Oh I have a secret Okay here it is You're my favourite".split(" "),
    );
    const gasps = evidence.tags[0];
    expect(gasps.startSec).toBe(timeline[gasps.charStart].startSec);
    expect(gasps.endSec).toBe(timeline[gasps.charEnd - 1].endSec);
  });

  it("times the laugh and the sigh in the English capture", () => {
    const evidence = buildSpeechTimingEvidence(timelineOf(socketEn));

    expect(evidence.tags.map((tag) => [tag.raw, tag.tagClass])).toEqual([
      ["[laughs]", "nonverbal"],
      ["[sighs]", "nonverbal"],
    ]);
    expect(evidence.tags[0].startSec).toBe(0);
    expect(evidence.tags[0].endSec).toBeCloseTo(0.32, 6);
  });

  it.each([
    ["laughs softly", "nonverbal"],
    ["clears throat", "nonverbal"],
    ["exhales sharply", "nonverbal"],
    ["long pause", "pacing"],
    ["short pause", "pacing"],
    ["door creaks", "sound_effect"],
    ["applause", "sound_effect"],
    ["mischievously", "delivery"],
    ["sarcastic", "delivery"],
    ["crying", "nonverbal"],
  ] as const)("classifies [%s] as %s", (direction, tagClass) => {
    expect(classifyAudioTag(direction)).toBe(tagClass);
  });

  it("gives a combined tag the class of its strongest direction", () => {
    const evidence = buildSpeechTimingEvidence(
      evenTimeline("[whispering, gasps] Oh. [thunder, laughs] Wow."),
    );

    expect(evidence.tags.map((tag) => tag.tagClass)).toEqual([
      "nonverbal",
      "sound_effect",
    ]);
    expect(evidence.tags[0].directions).toEqual([
      { text: "whispering", tagClass: "delivery" },
      { text: "gasps", tagClass: "nonverbal" },
    ]);
  });

  it("reads an unclosed bracket as punctuation once the timeline is complete", () => {
    const timeline = evenTimeline(
      "Press [ to open the menu, then pick a song.",
    );

    // While collecting, the bracket may still close, so the rest waits.
    expect(
      buildSpeechTimingEvidence(timeline).words.map((word) => word.text),
    ).toEqual(["Press"]);
    const complete = buildSpeechTimingEvidence(timeline, { complete: true });
    expect(complete.words.map((word) => word.text)).toEqual(
      "Press to open the menu then pick a song".split(" "),
    );
    expect(complete.punctuation.map((entry) => entry.text)).toEqual([
      "[",
      ",",
      ".",
    ]);
  });

  it("leaves out a tag that has not closed yet", () => {
    const evidence = buildSpeechTimingEvidence(evenTimeline("Hi. [whis"));

    expect(evidence.words.map((word) => word.text)).toEqual(["Hi"]);
    expect(evidence.tags).toEqual([]);
    expect(evidence.punctuation.map((entry) => entry.text)).toEqual(["."]);
  });

  it("reads a bracket without a short closing tag as punctuation", () => {
    const evidence = buildSpeechTimingEvidence(
      evenTimeline(`[${"a".repeat(80)}] [] ok`),
    );

    expect(evidence.tags).toEqual([]);
    expect(evidence.punctuation.map((entry) => entry.text)).toEqual([
      "[",
      "]",
      "[]",
    ]);
    expect(evidence.words.map((word) => word.text)).toEqual([
      "a".repeat(80),
      "ok",
    ]);
  });
});
