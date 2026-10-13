import { describe, expect, it } from "vitest";
import {
  buildDirectElevenLabsRealtimeWsUrl,
  type ElevenLabsSessionResponse,
} from "./use-elevenlabs-tts-runtime";

const session: ElevenLabsSessionResponse = {
  voice_id: "voice-fixture",
  model_id: "eleven_v4_turbo",
  output_format: "pcm_24000",
  sync_alignment: true,
};
const hosted = { origin: "https://app.example.test", allowDirect: false };

describe("admitted realtime speech transport", () => {
  it("uses a cookie-authorized same-origin server stream without a provider token", () => {
    expect(
      buildDirectElevenLabsRealtimeWsUrl(
        {
          ...session,
          transport: "server",
          websocket_url: "/v1/voice/streams/fixture",
        },
        hosted,
      ),
    ).toBe("wss://app.example.test/v1/voice/streams/fixture");
  });

  it.each([
    "wss://provider.example.test/v1/voice/streams/fixture",
    "ws://app.example.test/v1/voice/streams/fixture",
    "wss://name:secret@app.example.test/v1/voice/streams/fixture",
    "/v1/voice/streams/fixture?token=private",
    "/v1/voice/streams/fixture#private",
    "https://app.example.test/v1/voice/streams/fixture",
  ])("rejects unadmitted server socket %s", (websocket_url) => {
    expect(() =>
      buildDirectElevenLabsRealtimeWsUrl(
        { ...session, transport: "server", websocket_url },
        hosted,
      ),
    ).toThrow();
  });

  it("never falls back to provider authority when the server descriptor is missing", () => {
    expect(() =>
      buildDirectElevenLabsRealtimeWsUrl(
        { ...session, transport: "server", token: "provider-token" },
        hosted,
      ),
    ).toThrow();
  });

  it("withholds direct provider sessions without connection authority", () => {
    expect(() =>
      buildDirectElevenLabsRealtimeWsUrl(
        { ...session, token: "provider-token" },
        hosted,
      ),
    ).toThrow();
  });

  it("retains the local backend-issued direct session", () => {
    const url = new URL(
      buildDirectElevenLabsRealtimeWsUrl(
        { ...session, token: "provider-token" },
        { origin: "http://localhost:8360", allowDirect: true },
      ),
    );
    expect(url.origin).toBe("wss://api.elevenlabs.io");
    expect(url.pathname).toBe("/v1/text-to-dialogue/stream-input");
    expect(url.searchParams.get("single_use_token")).toBe("provider-token");
    expect(url.searchParams.get("model_id")).toBe(session.model_id);
  });
});
