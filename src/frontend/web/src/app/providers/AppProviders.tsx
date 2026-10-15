import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { i18n as I18nInstance } from "i18next";
import { AnimamaI18nProvider } from "@animama/product-ui/i18n";

import { RuntimePlatformProvider } from "@/platform/RuntimePlatformProvider";
import { HostedLocaleSync, LocaleSync } from "@/i18n/LocaleSync";
import { Toaster } from "@/ui/components/sonner";
import { ThemeProvider } from "@/ui/theme/theme-provider";
import {
  RuntimeAdmissionProvider,
  useRuntimeAdmission,
} from "../runtime/RuntimeAdmissionProvider";
import { RuntimeOwnerProvider } from "../runtime/RuntimeOwnerContext";
import type { RuntimeController } from "../runtime/runtime-controller";

type AppProvidersProps = {
  children: ReactNode;
  controller: RuntimeController;
  i18n: I18nInstance;
};

export function AppProviders({
  children,
  controller,
  i18n,
}: AppProvidersProps) {
  return (
    <AnimamaI18nProvider i18n={i18n}>
      <ThemeProvider>
        <RuntimePlatformProvider>
          <RuntimeAdmissionProvider controller={controller}>
            <HostedLocaleSync />
            <ApplicationSession>{children}</ApplicationSession>
          </RuntimeAdmissionProvider>
        </RuntimePlatformProvider>
      </ThemeProvider>
    </AnimamaI18nProvider>
  );
}

function ApplicationSession({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { admission, scope, queryClient, reconnecting } = useRuntimeAdmission();
  return (
    <QueryClientProvider client={queryClient}>
      {admission.status === "ready" && scope ? (
        <RuntimeOwnerProvider
          key={admission.session.key}
          ownerId={admission.session.owner.id}
          sessionKey={admission.session.key}
          capabilities={admission.capabilities}
          transport={{ baseUrl: scope.transport.baseUrl, fetch: scope.fetch }}
        >
          <LocaleSync />
          {reconnecting && (
            <div
              role="status"
              className="bg-background text-foreground border-b px-4 py-2 text-sm"
            >
              {t("connection.reconnecting")}{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => window.location.reload()}
              >
                {t("actions.reload")}
              </button>
            </div>
          )}
          {children}
          <Toaster />
        </RuntimeOwnerProvider>
      ) : (
        children
      )}
    </QueryClientProvider>
  );
}
