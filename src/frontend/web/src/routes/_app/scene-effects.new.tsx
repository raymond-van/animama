import { createFileRoute } from "@tanstack/react-router";

import { parseSceneEffectTemplateSearch } from "@/lib/effects/effectTemplates";
import { AppShellPage } from "@/ui/app/AppShellPage";
import { ContentPreviewExclusiveCanvasGate } from "@/ui/content-preview/ContentPreviewDockProvider";
import { SceneEffectCreatorPage } from "@/ui/scene-effect-creator/SceneEffectCreatorPage";

/**
 * `/scene-effects/new[?template=<id>]`: a new Scene Effect, blank or seeded
 * from a picker template (an Included Scene Effect's folder stem). The page is
 * keyed by template.
 */
export const Route = createFileRoute("/_app/scene-effects/new")({
  validateSearch: parseSceneEffectTemplateSearch,
  component: NewSceneEffectRoute,
});

function NewSceneEffectRoute() {
  const { template } = Route.useSearch();
  return (
    <AppShellPage
      sidebarBehavior="adaptive-canvas"
      className="overflow-hidden"
      contentClassName="h-full max-w-none gap-0 px-0 py-0 md:px-0 lg:px-0"
    >
      <ContentPreviewExclusiveCanvasGate ownerId="scene-effect-creator:new">
        <SceneEffectCreatorPage
          key={`new:${template ?? ""}`}
          templateId={template}
        />
      </ContentPreviewExclusiveCanvasGate>
    </AppShellPage>
  );
}
