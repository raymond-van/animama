import { describe, expect, it } from "vitest";

import socketEn from "./fixtures/v4-turbo-socket-en.json";
import socketEs from "./fixtures/v4-turbo-socket-es.json";
import socketJa from "./fixtures/v4-turbo-socket-ja.json";
import socketKo from "./fixtures/v4-turbo-socket-ko.json";
import socketTags from "./fixtures/v4-turbo-socket-tags.json";
import socketZh from "./fixtures/v4-turbo-socket-zh.json";
import runAlignmentEn from "./fixtures/v4-turbo-run-alignment-en.json";
import {
  createSpeechTimingCollector,
  type TimedChar,
} from "./provider-speech-timing";

const SAMPLE_RATE = 24_000;

type SocketMessage = {
  samples?: number;
  alignment?: unknown;
  is_final_audio_for_turn?: boolean;
  is_final?: boolean;
};

/** Replay a captured dialogue socket run, as the runtime handles each message. */
function replaySocket(messages: readonly SocketMessage[]): {
  chars: TimedChar[];
  turns: TimedChar[][];
  turnStartsSec: number[];
} {
  const collector = createSpeechTimingCollector(SAMPLE_RATE);
  const turns: TimedChar[][] = [[]];
  let samples = 0;
  const turnStartsSec = [0];
  for (const message of messages) {
    if (message.samples) {
      collector.acceptAudio(message.samples);
      samples += message.samples;
    }
    if (message.alignment) {
      turns
        .at(-1)
        ?.push(...collector.acceptDialogueAlignment(message.alignment));
    }
    if (message.is_final_audio_for_turn) {
      collector.endTurn();
      turnStartsSec.push(samples / SAMPLE_RATE);
      turns.push([]);
    }
  }
  return { chars: turns.flat(), turns, turnStartsSec };
}

function textOf(chars: readonly TimedChar[]): string {
  return chars.map((entry) => entry.char).join("");
}

describe("dialogue socket timing", () => {
  it.each([
    ["English with tags and turns", socketEn],
    ["Japanese", socketJa],
    ["Korean", socketKo],
    ["Chinese", socketZh],
    ["Spanish", socketEs],
    ["audio tags", socketTags],
  ])(
    "places every character of the sent text in order (%s)",
    (_name, fixture) => {
      const { chars, turns, turnStartsSec } = replaySocket(fixture.messages);

      expect(textOf(chars)).toBe(fixture.text);
      for (const [turnIndex, turn] of turns.entries()) {
        for (const [index, entry] of turn.entries()) {
          expect(entry.endSec).toBeGreaterThanOrEqual(entry.startSec);
          expect(entry.startSec).toBeGreaterThanOrEqual(
            index === 0 ? turnStartsSec[turnIndex] : turn[index - 1].startSec,
          );
        }
        // A turn's timing can run past its audio into the next turn, by up to 80 ms here.
        const next = turnStartsSec[turnIndex + 1];
        const last = turn.at(-1);
        if (next !== undefined && last) {
          expect(last.endSec - next).toBeLessThanOrEqual(0.1);
        }
      }
    },
  );

  it("starts each frame where the turn's previous frame ended", () => {
    const { chars } = replaySocket(socketJa.messages);

    // Frames restart at 0 ms; お and は (0–80 ms) are followed by よ at 80 ms.
    expect(chars.slice(0, 5)).toEqual([
      { char: "お", startSec: 0, endSec: 0.04 },
      { char: "は", startSec: 0.04, endSec: 0.08 },
      { char: "よ", startSec: 0.08, endSec: 0.16 },
      { char: "う", startSec: 0.16, endSec: 0.24 },
      { char: "ご", startSec: 0.24, endSec: 0.32 },
    ]);
  });

  it("restarts each turn at the audio received when the previous turn ended", () => {
    const { chars, turnStartsSec } = replaySocket(socketJa.messages);

    // The first turn's timing totals 1.2 s, but its audio is 1.12 s long.
    expect(turnStartsSec[1]).toBeCloseTo(1.12, 6);
    const secondTurn = chars.find((entry) => entry.char === "今");
    expect(secondTurn?.startSec).toBeCloseTo(1.12, 6);
  });

  it("keeps the clock across audio frames that carry no timing", () => {
    const { chars, turnStartsSec } = replaySocket(socketEn.messages);

    // The third turn begins with four audio frames without timing.
    const hmm = chars.findIndex(
      (entry, index) => entry.char === "H" && chars[index + 1]?.char === "m",
    );
    expect(chars[hmm].startSec).toBeCloseTo(turnStartsSec[2] + 0.32, 6);
  });

  it("ignores malformed timing without moving the clock", () => {
    const collector = createSpeechTimingCollector(SAMPLE_RATE);

    for (const malformed of [
      null,
      "chars",
      { chars: ["a", "b"], char_start_times_ms: [0], char_durations_ms: [40] },
      { chars: ["a"], char_start_times_ms: [-5], char_durations_ms: [40] },
      { chars: ["a"], char_start_times_ms: [0], char_durations_ms: ["40"] },
      { chars: [1], char_start_times_ms: [0], char_durations_ms: [40] },
    ]) {
      expect(collector.acceptDialogueAlignment(malformed)).toEqual([]);
    }
    expect(
      collector.acceptDialogueAlignment({
        chars: ["H", "i"],
        char_start_times_ms: [0, 80],
        char_durations_ms: [80, 120],
      }),
    ).toEqual([
      { char: "H", startSec: 0, endSec: 0.08 },
      { char: "i", startSec: 0.08, endSec: 0.2 },
    ]);
  });
});

describe("run-relative timing from a hosted server socket", () => {
  it.each(runAlignmentEn.lines.map((line) => [line.text, line] as const))(
    "appends the times as they are (%s)",
    (_text, line) => {
      const collector = createSpeechTimingCollector(SAMPLE_RATE);
      const chars: TimedChar[] = [];
      for (const message of line.messages) {
        collector.acceptAudio(message.samples);
        if (message.alignment) {
          chars.push(...collector.acceptRunAlignment(message.alignment));
        }
      }

      expect(textOf(chars)).toBe(line.text);
      const expected = line.messages.flatMap((message) =>
        message.alignment
          ? message.alignment.characters.map((char, index) => ({
              char,
              startSec: message.alignment.character_start_times_seconds[index],
              endSec: message.alignment.character_end_times_seconds[index],
            }))
          : [],
      );
      expect(chars).toEqual(expected);
    },
  );

  it("ignores malformed run timing", () => {
    const collector = createSpeechTimingCollector(SAMPLE_RATE);

    expect(
      collector.acceptRunAlignment({
        characters: ["a"],
        character_start_times_seconds: [0.4],
        character_end_times_seconds: [0.2],
      }),
    ).toEqual([]);
    expect(
      collector.acceptRunAlignment({
        chars: ["a"],
        char_start_times_ms: [0],
        char_durations_ms: [40],
      }),
    ).toEqual([]);
  });
});
