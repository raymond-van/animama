import { ActionEditorGate } from "@/ui/action-editor/ActionEditorGate";
import { ActionEditorPage } from "@/ui/action-editor/ActionEditorPage";
import type { ActionComponentType } from "@/query/hooks/useEffects";

export function ReactionEditorPage({
  reactionId,
  initialComponent,
  initialComponentType,
  initialDraft,
}: {
  reactionId?: string;
  initialComponent?: string;
  initialComponentType?: ActionComponentType;
  /** A content assistant draft to open as a new, unsaved Reaction. */
  initialDraft?: { conversationId: string; draftId: string };
}) {
  return (
    <ActionEditorGate intent="reaction" itemId={reactionId}>
      <ActionEditorPage
        // Another draft is another document: it starts a fresh editor. The
        // editor's leave guard asks first while the open one has unsaved edits.
        key={
          reactionId ?? (initialDraft ? `draft:${initialDraft.draftId}` : "new")
        }
        intent="reaction"
        itemId={reactionId}
        initialComponent={initialComponent}
        initialComponentType={initialComponentType}
        initialDraft={reactionId ? undefined : initialDraft}
      />
    </ActionEditorGate>
  );
}
