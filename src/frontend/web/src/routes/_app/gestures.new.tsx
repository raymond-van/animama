import { createFileRoute } from "@tanstack/react-router";

import { AppShellPage } from "@/ui/app/AppShellPage";
import { GestureEditorPage } from "@/ui/gesture-editor/GestureEditorPage";
import { parseNewGestureSearch } from "@/ui/gesture-editor/gestureSearch";

export const Route = createFileRoute("/_app/gestures/new")({
  validateSearch: parseNewGestureSearch,
  component: NewGestureRoute,
});

function NewGestureRoute() {
  const { component, componentType, draft, conversation } = Route.useSearch();
  return (
    <AppShellPage
      className="overflow-hidden"
      contentClassName="h-full max-w-none gap-0 px-0 py-0 md:px-0 lg:px-0"
      sidebarBehavior="adaptive-canvas"
    >
      <GestureEditorPage
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
