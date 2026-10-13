import { createFileRoute } from "@tanstack/react-router";

import { parseParticleEffectTemplateSearch } from "@/lib/effects/effectTemplates";
import { AppShellPage } from "@/ui/app/AppShellPage";
import { ContentPreviewExclusiveCanvasGate } from "@/ui/content-preview/ContentPreviewDockProvider";
import { ParticleVFXCreatorPage } from "@/ui/particle-vfx-creator/ParticleVFXCreatorPage";

/**
 * `/particle-effects/new[?template=<id>]`: a new Particle Effect. The page is
 * keyed by template, so choosing another template starts a separate draft.
 * The creator does not load the template's settings yet; it opens blank.
 */
export const Route = createFileRoute("/_app/particle-effects/new")({
  validateSearch: parseParticleEffectTemplateSearch,
  component: NewParticleEffectRoute,
});

function NewParticleEffectRoute() {
  const { template } = Route.useSearch();
  return (
    <AppShellPage
      sidebarBehavior="adaptive-canvas"
      className="overflow-hidden"
      contentClassName="h-full max-w-none gap-0 px-0 py-0 md:px-0 lg:px-0"
    >
      <ContentPreviewExclusiveCanvasGate ownerId="particle-effect-creator:new">
        <ParticleVFXCreatorPage key={`new:${template ?? ""}`} />
      </ContentPreviewExclusiveCanvasGate>
    </AppShellPage>
  );
}
