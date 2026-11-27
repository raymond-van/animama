import { createFileRoute } from "@tanstack/react-router";

import { AppShellPage } from "@/ui/app/AppShellPage";
import { parseNewGestureSearch } from "@/ui/gesture-editor/gestureSearch";
import { ReactionEditorPage } from "@/ui/reaction-editor/ReactionEditorPage";

export const Route = createFileRoute("/_app/reactions/new")({
  // The same search as a new Gesture's: an effect to start with, or a content
  // assistant draft to open.
  validateSearch: parseNewGestureSearch,
  component: NewReactionRoute,
});

function NewReactionRoute() {
  const { component, componentType, draft, conversation } = Route.useSearch();
  return (
    <AppShellPage
      className="overflow-hidden"
      contentClassName="h-full max-w-none gap-0 px-0 py-0 md:px-0 lg:px-0"
      sidebarBehavior="adaptive-canvas"
    >
      <ReactionEditorPage
        initialComponent={component}
        initialComponentType={componentType}
        initialDraft={
          draft && conversation
            ? { draftId: draft, conversationId: conversation }
            : undefined
        }
      />
    </AppShellPage>
  );
}
