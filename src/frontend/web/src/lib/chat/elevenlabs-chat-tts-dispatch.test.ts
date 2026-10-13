import { describe, expect, it } from "vitest";

import { buildElevenLabsChatTtsDispatchOptions } from "./elevenlabs-chat-tts-dispatch";

describe("buildElevenLabsChatTtsDispatchOptions", () => {
  it("asks for realtime Eleven v4 Turbo speech", () => {
    expect(
      buildElevenLabsChatTtsDispatchOptions({ modelId: "eleven_v4_turbo" }),
    ).toEqual({
      enabled: true,
      provider: "elevenlabs",
      transport: "auto",
      language_code: null,
      model_id: "eleven_v4_turbo",
    });
  });
});
