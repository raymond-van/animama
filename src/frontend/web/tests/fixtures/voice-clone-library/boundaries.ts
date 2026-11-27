import type { PreparedVoiceClone } from "@/lib/speech/pocket/voice-clones";
import type { Client } from "@animama/runtime-contracts/sdk";
import {
  ensurePocketVoiceCloningEncoder,
  type PocketVoiceEncoderOptions,
} from "@/lib/speech/pocket/voice-cloning-encoder";

/** Only expensive encoding and durable writes are replaced; React and the waiter run normally. */
export const observations = {
  preparations: [] as File[],
  encoded: [] as File[],
  saved: [] as PreparedVoiceClone[],
  busy: [] as boolean[],
};

export async function buildPocketVoiceCatalogFile(
  apiClient: Client,
  {
    sources,
    encoder,
  }: {
    sources: { file: File }[];
    encoder?: PocketVoiceEncoderOptions;
  },
) {
  const file = sources[0].file;
  observations.preparations.push(file);
  await ensurePocketVoiceCloningEncoder(apiClient, encoder);
  observations.encoded.push(file);
  return new File(["encoded fixture"], "voice.bin");
}

export function useVoiceCloneActions() {
  return {
    saveVoiceClone: {
      mutateAsync: async (prepared: PreparedVoiceClone) => {
        observations.saved.push(prepared);
      },
    },
  };
}
