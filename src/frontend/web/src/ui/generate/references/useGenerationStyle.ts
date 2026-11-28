import { useCallback, useState } from "react";

import { readApiError } from "@/lib/errors/apiError";
import { createLogger } from "@/lib/logger";
import { useSetGenerationStylePreset } from "@/query/mutations/useGenerationMutations";
import {
  knownStylePreset,
  type GenerationStylePresetId,
} from "../stylePresets";

const logger = createLogger("GenerateStyle");

/**
 * The style of one conversation with the content assistant (R8.5), as the
 * references row's choice shows and changes it.
 */
export type GenerationStyleChoice = {
  /**
   * The conversation's preset: the one being stored, else the stored one.
   * `null` for no style, and for a stored id this page does not list.
   */
  value: GenerationStylePresetId | null;
  /** Store a preset on the conversation, or clear it with `null`. */
  choose: (preset: GenerationStylePresetId | null) => void;
  /** A choice is being stored; no other is taken until it is answered. */
  saving: boolean;
  /**
   * The backend's code for why the last choice was not stored (`null` when
   * it gave none), or `undefined` when nothing failed. The choice is then
   * back at what is stored.
   */
  failure: string | null | undefined;
};

/**
 * The style choice of the conversation `conversationId`, whose stored preset
 * is `stored`. Mount it once per conversation.
 *
 * The run in flight keeps the style it started with: the backend reads the
 * preset when it plans a run, so a change applies from the next one.
 */
export function useGenerationStyle(
  conversationId: string | null,
  stored: string | null | undefined,
): GenerationStyleChoice {
  const { mutateAsync, isPending, variables } = useSetGenerationStylePreset();
  // The last preset this composer stored. A read of the conversation that
  // began before that change can be answered after it with the style as it
  // was; the choice the backend confirmed is the one shown.
  const [saved, setSaved] = useState<{
    preset: GenerationStylePresetId | null;
  } | null>(null);
  const [failure, setFailure] = useState<string | null | undefined>(undefined);

  const choose = useCallback(
    (preset: GenerationStylePresetId | null) => {
      // One choice at a time: no other is taken until this one is answered.
      if (!conversationId || isPending) return;
      setFailure(undefined);
      mutateAsync({ conversationId, stylePreset: preset }).then(
        (conversation) =>
          setSaved({ preset: knownStylePreset(conversation.style_preset) }),
        (error: unknown) => {
          const { code, status } = readApiError(error);
          logger.warn("Style", "The style was not stored", { code, status });
          setFailure(code ?? null);
        },
      );
    },
    [conversationId, isPending, mutateAsync],
  );

  return {
    value:
      isPending && variables
        ? knownStylePreset(variables.stylePreset)
        : saved
          ? saved.preset
          : knownStylePreset(stored),
    choose,
    saving: isPending,
    failure,
  };
}
