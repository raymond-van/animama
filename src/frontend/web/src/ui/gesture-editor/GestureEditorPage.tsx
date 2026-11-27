import { ActionEditorGate } from "@/ui/action-editor/ActionEditorGate";
import { ActionEditorPage } from "@/ui/action-editor/ActionEditorPage";
import type { ActionComponentType } from "@/query/hooks/useEffects";

export function GestureEditorPage({
  gestureId,
  initialComponent,
  initialComponentType,
  initialDraft,
}: {
  gestureId?: string;
  initialComponent?: string;
  initialComponentType?: ActionComponentType;
  /** A content assistant draft to open as a new, unsaved Gesture. */
  initialDraft?: { conversationId: string; draftId: string };
}) {
  return (
    <ActionEditorGate intent="gesture" itemId={gestureId}>
      <ActionEditorPage
        // Another draft is another document: it starts a fresh editor. The
        // editor's leave guard asks first while the open one has unsaved edits.
        key={
          gestureId ?? (initialDraft ? `draft:${initialDraft.draftId}` : "new")
        }
        intent="gesture"
        itemId={gestureId}
        initialComponent={initialComponent}
        initialComponentType={initialComponentType}
        initialDraft={gestureId ? undefined : initialDraft}
      />
    </ActionEditorGate>
  );
}
