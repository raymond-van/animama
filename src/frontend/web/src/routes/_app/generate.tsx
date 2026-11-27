import { createFileRoute } from "@tanstack/react-router";

import { GeneratePage } from "@/ui/generate/GeneratePage";

/**
 * The content assistant's page. Offered only by runtimes that report
 * `content_generation` (`app/runtime/route-admission.ts`).
 */
export const Route = createFileRoute("/_app/generate")({
  component: GeneratePage,
});
