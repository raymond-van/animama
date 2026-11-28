import type { ComponentProps } from "react";

import { GenerateConversation } from "../GenerateConversation";
import { generationRequestWrites } from "../generationDrafts";
import { useGenerateReferences } from "./useGenerateReferences";
import { useGenerationStyle } from "./useGenerationStyle";

/**
 * The Generate page's conversation: the one the creators' panel shows, with
 * references and the conversation's style in its composer. Mount it once per
 * conversation (by key), so another conversation starts with no references.
 */
export function GenerateConversationWithReferences({
  conversationId,
  model,
  ...conversation
}: Omit<ComponentProps<typeof GenerateConversation>, "references" | "style"> & {
  conversationId: string | null;
  /** The assistant's chosen model row, read for whether it takes images. */
  model: { accepts?: readonly string[] | null } | null;
}) {
  const references = useGenerateReferences({
    conversationId,
    // Only a request for a new Gesture draft may start from a Gesture.
    offersStartingPoint:
      generationRequestWrites(
        conversation.selectedDraft,
        conversation.newDraftKind?.value,
      ) === "gesture",
    model,
  });
  const style = useGenerationStyle(
    conversationId,
    conversation.snapshot?.conversation.style_preset,
  );
  return (
    <GenerateConversation
      {...conversation}
      references={references}
      style={style}
    />
  );
}
