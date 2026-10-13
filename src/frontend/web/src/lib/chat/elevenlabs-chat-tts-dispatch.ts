import type { PyAnimaTtsRunOptions } from "@/lib/content/catalogTypes";
import type { ElevenLabsTtsModelId } from "@/lib/settings/preferences";

type BuildElevenLabsChatTtsDispatchOptionsArgs = {
  modelId: ElevenLabsTtsModelId;
};

/**
 * Builds the backend chat TTS intent for ElevenLabs chat runs, which speak in
 * realtime with Eleven v4 Turbo.
 */
export function buildElevenLabsChatTtsDispatchOptions({
  modelId,
}: BuildElevenLabsChatTtsDispatchOptionsArgs): PyAnimaTtsRunOptions {
  return {
    enabled: true,
    provider: "elevenlabs",
    transport: "auto",
    language_code: null,
    model_id: modelId,
  };
}
