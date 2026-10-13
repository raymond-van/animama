import { describe, expect, it } from "vitest";

import {
  appendStructuredSpeechVisemeInputs,
  createStructuredResponseStreamState,
  getStructuredAssistantTexts,
  reduceStructuredResponseStream,
  selectStructuredSpeechVisemePayload,
  selectStructuredSpeechTtsPayload,
} from "./structured-response-stream";

describe("structured response stream", () => {
  it("accumulates multiple speech deltas into one assistant speech text", () => {
    let state = createStructuredResponseStreamState();

    state = reduceStructuredResponseStream(state, {
      response_part: "speech",
      text: "First sentence.",
      is_delta: true,
      part_index: 0,
    }).state;
    state = reduceStructuredResponseStream(state, {
      response_part: "speech",
      text: " Second sentence.",
      is_delta: true,
      part_index: 1,
    }).state;

    expect(state.speechText).toBe("First sentence. Second sentence.");
    expect(state.speechSegments).toEqual([
      "First sentence.",
      " Second sentence.",
    ]);
    expect(getStructuredAssistantTexts(state)).toEqual([
      "First sentence. Second sentence.",
    ]);
  });

  it("marks an empty final speech marker without changing text", () => {
    let state = createStructuredResponseStreamState();
    state = reduceStructuredResponseStream(state, {
      response_part: "speech",
      text: "Ready.",
      is_delta: true,
      part_index: 0,
      part_final: false,
    }).state;

    const update = reduceStructuredResponseStream(state, {
      response_part: "speech",
      text: "",
      is_delta: true,
      part_index: 1,
      part_final: true,
    });

    expect(update.textChanged).toBe(false);
    expect(update.state.speechText).toBe("Ready.");
    expect(update.state.speechSegments).toEqual(["Ready."]);
    expect(update.state.speechFinal).toBe(true);
    expect(update.state.lastSpeechPartIndex).toBe(1);
  });

  it("replaces streamed speech when a complete non-delta speech event arrives", () => {
    let state = createStructuredResponseStreamState();
    state = reduceStructuredResponseStream(state, {
      response_part: "speech",
      text: "Draft text.",
      is_delta: true,
    }).state;

    state = reduceStructuredResponseStream(state, {
      response_part: "speech",
      text: "Corrected complete text.",
      is_delta: false,
    }).state;

    expect(state.speechText).toBe("Corrected complete text.");
    expect(state.speechSegments).toEqual(["Corrected complete text."]);
    expect(getStructuredAssistantTexts(state)).toEqual([
      "Corrected complete text.",
    ]);
  });

  it("accumulates display deltas as a separate assistant message", () => {
    let state = createStructuredResponseStreamState();
    state = reduceStructuredResponseStream(state, {
      response_part: "speech",
      text: "Short spoken text.",
      is_delta: true,
    }).state;
    state = reduceStructuredResponseStream(state, {
      response_part: "display",
      text: "Visible ",
      is_delta: true,
      part_index: 0,
    }).state;
    state = reduceStructuredResponseStream(state, {
      response_part: "display",
      text: "details.",
      is_delta: true,
      part_index: 1,
      part_final: true,
    }).state;

    expect(state.displayText).toBe("Visible details.");
    expect(state.displayFinal).toBe(true);
    expect(getStructuredAssistantTexts(state)).toEqual([
      "Short spoken text.",
      "Visible details.",
    ]);
  });

  it("does not duplicate display text that is equal to speech", () => {
    let state = createStructuredResponseStreamState();
    state = reduceStructuredResponseStream(state, {
      response_part: "speech",
      text: "Same text.",
      is_delta: true,
    }).state;
    state = reduceStructuredResponseStream(state, {
      response_part: "display",
      text: "Same text.",
      is_delta: true,
    }).state;

    expect(getStructuredAssistantTexts(state)).toEqual(["Same text."]);
  });

  it("tolerates missing and unknown metadata", () => {
    let state = createStructuredResponseStreamState();
    const ignored = reduceStructuredResponseStream(state, {
      response_part: "unknown",
      text: "Ignored.",
      is_delta: true,
    });

    expect(ignored.handled).toBe(false);
    expect(ignored.state).toBe(state);

    state = reduceStructuredResponseStream(state, {
      response_part: "speech",
      text: "Complete fallback text.",
    }).state;

    expect(state.speechText).toBe("Complete fallback text.");
    expect(state.speechFinal).toBe(false);
    expect(state.lastSpeechPartIndex).toBeNull();
  });

  it("selects gruut tts_text for structured speech deltas when present", () => {
    expect(
      selectStructuredSpeechTtsPayload({
        visibleText: "Visible sentence.",
        ttsText: " Gruut sentence. ",
        ttsTextBasis: "gruut_text_with_ws",
        isDelta: true,
        structuredTtsAppended: false,
      }),
    ).toEqual({
      text: " Gruut sentence. ",
      textBasis: "gruut_text_with_ws",
    });
  });

  it("falls back to visible speech text for deltas without valid tts_text", () => {
    expect(
      selectStructuredSpeechTtsPayload({
        visibleText: " Second visible sentence.",
        ttsText: " ",
        ttsTextBasis: "gruut_text_with_ws",
        isDelta: true,
        structuredTtsAppended: false,
      }),
    ).toEqual({ text: " Second visible sentence." });
  });

  it("speaks a segment without tts fields, such as Japanese, as written", () => {
    expect(
      selectStructuredSpeechTtsPayload({
        visibleText: "おはようございます。",
        ttsText: undefined,
        ttsTextBasis: undefined,
        isDelta: true,
        structuredTtsAppended: false,
      }),
    ).toEqual({ text: "おはようございます。" });
  });

  it("does not select TTS text for an empty final marker", () => {
    expect(
      selectStructuredSpeechTtsPayload({
        visibleText: "",
        ttsText: null,
        ttsTextBasis: null,
        isDelta: true,
        structuredTtsAppended: true,
      }),
    ).toBeNull();
  });

  it("selects gruut tts_text for complete non-delta fallback speech", () => {
    expect(
      selectStructuredSpeechTtsPayload({
        visibleText: "Visible complete text.",
        ttsText: "Gruut complete text.",
        ttsTextBasis: "gruut_text_with_ws",
        isDelta: false,
        structuredTtsAppended: false,
      }),
    ).toEqual({
      text: "Gruut complete text.",
      textBasis: "gruut_text_with_ws",
    });
  });

  it("does not re-select replacement speech after structured TTS was appended", () => {
    expect(
      selectStructuredSpeechTtsPayload({
        visibleText: "Corrected complete text.",
        ttsText: "Corrected TTS text.",
        ttsTextBasis: "gruut_text_with_ws",
        isDelta: false,
        structuredTtsAppended: true,
      }),
    ).toBeNull();
  });

  it("selects gruut phonemes for structured speech visemes when TTS text is gruut based", () => {
    const ttsPayload = selectStructuredSpeechTtsPayload({
      visibleText: " Visible sentence.",
      ttsText: "Gruut sentence.",
      ttsTextBasis: "gruut_text_with_ws",
      isDelta: true,
      structuredTtsAppended: false,
    });

    expect(
      selectStructuredSpeechVisemePayload({
        ttsPayload,
        ttsPhonemizedText: [["G"], ["R"]],
        phonemizedText: [["V"]],
        tokenizedText: "Visible sentence.",
        fallbackTokenizedText: "Visible sentence.",
      }),
    ).toEqual({
      tokenizedText: "Gruut sentence.",
      phonemizedText: [["G"], ["R"]],
    });
  });

  it("accumulates structured speech viseme inputs across TTS speech segments", () => {
    let inputs = appendStructuredSpeechVisemeInputs(null, {
      tokenizedText: "First sentence.",
      phonemizedText: [["F"], ["S"]],
    });

    inputs = appendStructuredSpeechVisemeInputs(inputs, {
      tokenizedText: "Second sentence.",
      phonemizedText: [["S"], ["S"]],
    });

    expect(inputs).toEqual({
      tokenizedText: "First sentence. Second sentence.",
      phonemizedText: [["F"], ["S"], ["S"], ["S"]],
    });
  });

  it("does not select viseme payloads for empty final markers or corrections that were not sent to TTS", () => {
    expect(
      selectStructuredSpeechVisemePayload({
        ttsPayload: null,
        ttsPhonemizedText: [["IGNORED"]],
        phonemizedText: [["IGNORED"]],
        tokenizedText: "",
        fallbackTokenizedText: "",
      }),
    ).toBeNull();
  });
});
