import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { AppProviders } from "@/app/providers/AppProviders";
import { createLocalComposition } from "@/app/local-runtime/local-composition";
import { RuntimeController } from "@/app/runtime/runtime-controller";
import { useRuntimeAdmission } from "@/app/runtime/RuntimeAdmissionProvider";
import { Route } from "@/routes/setup";
import { FirstRunAgeConfirmation } from "@/app/local-runtime/setup/FirstRunAgeConfirmation";
import { useUserProfile } from "@/query/hooks/useUserProfile";
import "@/index.css";

// Only native IPC is simulated. Runtime readiness, form, secure-key panel, model
// controls, queries and mutations use production code with intercepted HTTP.
const invoke = (method: string, args?: unknown) =>
  (
    window as unknown as {
      fixtureNative(method: string, args?: unknown): Promise<unknown>;
    }
  ).fixtureNative(method, args);
Object.assign(window, {
  animamaDesktop: {
    version: 2,
    isDesktop: true,
    platform: "darwin",
    windowRole: "main",
    runtime: {
      onStatus: () => () => undefined,
      status: async () => ({ state: "ready", origin: window.location.origin }),
    },
    credentials: {
      list: () => invoke("credentials"),
      apply: (changes: unknown) => invoke("credentials.apply", changes),
    },
    // Speech models install through backend model assets; the desktop's
    // remaining packs are not part of setup.
    featurePacks: {
      list: async () => [],
      install: async () => undefined,
      remove: async () => undefined,
      cancel: async () => undefined,
      onProgress: () => () => undefined,
    },
  },
});
const controller = new RuntimeController(createLocalComposition());
const rootRoute = createRootRoute({ component: Outlet });
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: Route.options.component,
});
function Completion() {
  return (
    <FirstRunAgeConfirmation>
      <LoadedApplication />
    </FirstRunAgeConfirmation>
  );
}
/** A persistent application instance makes background loading observable. */
function LoadedApplication() {
  const { admission } = useRuntimeAdmission();
  const profile = useUserProfile();
  const [instance] = useState(() => crypto.randomUUID());
  return (
    <div data-testid="loaded-application" data-instance={instance}>
      <button type="button">Application control</button>
      <p data-testid="profile-name">
        {profile.isSuccess
          ? (profile.data.display_name ?? "You")
          : "Loading profile"}
      </p>
      {admission.status === "ready" && !admission.onboardingRequired ? (
        <p>Setup complete</p>
      ) : null}
    </div>
  );
}
const completedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Completion,
});
const animaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$animaId",
  component: Completion,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([setupRoute, completedRoute, animaRoute]),
  history: createMemoryHistory({ initialEntries: ["/setup"] }),
});
function FixtureRouter() {
  const { admission } = useRuntimeAdmission();
  return admission.status === "ready" ? (
    <RouterProvider router={router} />
  ) : (
    <p>Preparing local runtime</p>
  );
}
createRoot(document.getElementById("root")!).render(
  <AppProviders controller={controller}>
    <FixtureRouter />
  </AppProviders>,
);
