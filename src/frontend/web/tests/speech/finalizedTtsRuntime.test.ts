import { describe, expect, it } from "vitest";

import {
  convertPcm16ToFloat32,
  decodeBase64Pcm16,
} from "@/hooks/use-finalized-tts-runtime";

describe("finalized TTS runtime helpers", () => {
  it("decodes base64 PCM into Int16 samples", () => {
    expect(Array.from(decodeBase64Pcm16("AQACAA=="))).toEqual([1, 2]);
  });

  it("converts Int16 PCM into normalized Float32 samples", () => {
    const samples = convertPcm16ToFloat32(
      new Int16Array([-32768, -16384, 0, 16384, 32767]),
    );

    expect(Array.from(samples)).toEqual([-1, -0.5, 0, 0.5, 32767 / 32768]);
  });
});
