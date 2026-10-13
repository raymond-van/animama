import { createRouter, RouterProvider } from "@tanstack/react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useAdmittedRouter } from "./admitted-router";
import { useRuntimeAdmission } from "./runtime/RuntimeAdmissionProvider";
import type { AppRouterContext } from "./router-context";
import { AdmissionScreen } from "./runtime/AdmissionScreen";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import { routeTree } from "@web/routeTree.gen";
import {
  PageLoadError,
  subscribeToAppFileErrors,
} from "@/ui/app/PageLoadError";

export function createAppRouter(context: AppRouterContext) {
  return createRouter({
    routeTree,
    context,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultErrorComponent: PageLoadError,
  });
}

function createSessionRouter(queryClient: QueryClient) {
  return createAppRouter({ queryClient });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

export function AppRouter() {
  const [appFileError, setAppFileError] = useState(false);
  useEffect(
    () => subscribeToAppFileErrors(window, () => setAppFileError(true)),
    [],
  );
  const { admission, controller, composition, account } = useRuntimeAdmission();
  const platform = useRuntimePlatform();
  const queryClient = useQueryClient();
  const capabilities =
    admission.status === "ready" ? admission.capabilities : undefined;
  const router = useAdmittedRouter(
    createSessionRouter,
    queryClient,
    // The file-error screen replaces the router; it need not exist meanwhile.
    admission.status === "ready" && !appFileError,
  );
  const isDesktopAuxiliaryWindow =
    platform.kind === "desktop" &&
    (platform.desktopBridge.windowRole === "pip" ||
      platform.desktopBridge.windowRole === "quick-chat");
  if (appFileError) return <PageLoadError />;
  if (admission.status !== "ready") {
    if (isDesktopAuxiliaryWindow)
      return <div className="h-screen w-screen bg-transparent" />;
    return (
      <AdmissionScreen
        admission={admission}
        hosted={composition.kind === "hosted"}
        signOutIncomplete={account.signOutIncomplete}
        retry={() => {
          // An unfinished sign-out is retried, never replaced by readmission.
          void (account.signOutIncomplete
            ? controller.signOut()
            : controller.refresh(admission.status === "recovery"));
        }}
        signIn={composition.accountActions?.signIn}
        openAccount={
          account.canOpenAccount
            ? composition.accountActions?.openAccount
            : undefined
        }
        signOut={
          composition.accountActions
            ? () => {
                void controller.signOut();
              }
            : undefined
        }
      />
    );
  }

  // A ready admission always has its router; it is built during this render.
  if (!router) return null;
  return (
    <RouterProvider
      router={router}
      context={{
        queryClient,
        capabilities,
      }}
    />
  );
}
