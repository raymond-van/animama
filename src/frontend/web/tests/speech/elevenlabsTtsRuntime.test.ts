import { describe, expect, it } from "vitest";

import { buildDirectElevenLabsRealtimeWsUrl } from "@/hooks/use-elevenlabs-tts-runtime";

describe("ElevenLabs realtime TTS runtime", () => {
  it("builds Text to Dialogue websocket URLs from the provided session", () => {
    const url = buildDirectElevenLabsRealtimeWsUrl({
      voice_id: "voice/custom",
      model_id: "eleven_v4_turbo",
      output_format: "pcm_24000",
      sync_alignment: false,
      language_code: "en",
      token: "single use token",
      websocket_base_url: "wss://example.elevenlabs.test",
    });

    // The dialogue socket names its voice in the first message, not the path.
    expect(url).toContain(
      "wss://example.elevenlabs.test/v1/text-to-dialogue/stream-input?",
    );
    expect(url).not.toContain("voice%2Fcustom");
    expect(url).toContain("model_id=eleven_v4_turbo");
    expect(url).toContain("output_format=pcm_24000");
    expect(url).toContain("sync_alignment=false");
    expect(url).toContain("language_code=en");
    expect(url).toContain("single_use_token=single+use+token");
  });
});
