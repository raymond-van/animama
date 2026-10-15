// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { getI18n, useTranslation } from "react-i18next";
import { AnimamaI18nProvider } from "@animama/product-ui/i18n";
import { currentChatClientContext } from "@animama/product-ui/chat";
import type { HostedLocaleInput } from "@animama/runtime-contracts/locale";
import type { RuntimeAdmission } from "@animama/runtime-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeAdmissionProvider,
  useRuntimeAdmission,
} from "@/app/runtime/RuntimeAdmissionProvider";
import { AdmissionScreen } from "@/app/runtime/AdmissionScreen";
import { createHostedComposition } from "@/app/hosted-runtime/hosted-composition";
import { RuntimeController } from "@/app/runtime/runtime-controller";
import { hostedCapabilitiesFixture as capabilities } from "@/app/runtime/runtime-fixture";
import { HostedLocaleSync, LocaleSync } from "./LocaleSync";
import { createWebI18n } from "./web-i18n";

vi.mock("@/query/hooks/useUserSettings", () => ({
  useUserSettings: () => ({ data: { locale: "ko" }, isSuccess: true }),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  vi.unstubAllGlobals();
  await getI18n().changeLanguage("en");
});

describe("composition locale rendering", () => {
  it("rewords an existing admission error without rereading or consuming it", async () => {
    const i18n = await createWebI18n("en");
    window.history.replaceState(null, "", "/?sign_in=failed");
    const fetch = vi.fn(async () =>
      Response.json({
        schema_version: 1,
        state: "session_required",
        user_id: null,
        csrf_token: null,
        capabilities: {},
        locale: { preference: null, visitor: "ja" },
      }),
    );
    const controller = new RuntimeController(
      createHostedComposition({
        baseUrl: "https://app.example.test",
        fetch,
        navigate: vi.fn(),
      }),
    );
    const element = document.createElement("div");
    const root = createRoot(element);
    function Screen() {
      const { admission } = useRuntimeAdmission();
      return admission.status === "ready" ? null : (
        <AdmissionScreen admission={admission} hosted retry={vi.fn()} />
      );
    }
    try {
      await act(async () => {
        root.render(
          <AnimamaI18nProvider i18n={i18n}>
            <RuntimeAdmissionProvider controller={controller}>
              <HostedLocaleSync />
              <Screen />
            </RuntimeAdmissionProvider>
          </AnimamaI18nProvider>,
        );
      });
      await act(async () => {
        await vi.waitFor(() => expect(i18n.language).toBe("ja"));
      });
      expect(element.querySelector('[role="alert"]')?.textContent).toBe(
        i18n.getFixedT(null, "app")("admission.messages.signInNotFinished"),
      );
      const admission = controller.getSnapshot().admission;
      const calls = fetch.mock.calls.length;
      await act(async () => {
        await i18n.changeLanguage("ko");
      });
      expect(element.querySelector('[role="alert"]')?.textContent).toBe(
        i18n.getFixedT(null, "app")("admission.messages.signInNotFinished"),
      );
      expect(controller.getSnapshot().admission).toBe(admission);
      expect(fetch).toHaveBeenCalledTimes(calls);
    } finally {
      act(() => root.unmount());
      window.history.replaceState(null, "", "/");
    }
  });
  it("does not apply a superseded locale when its catalogs finish loading late", async () => {
    const i18n = await createWebI18n("en");
    // Let the newer language load independently of the deliberately held reads.
    Object.assign(i18n.services.backendConnector, { maxParallelReads: 1000 });
    const backend = i18n.services.backendConnector.backend;
    const read = backend.read.bind(backend);
    const delayed: (() => void)[] = [];
    const spy = vi
      .spyOn(backend, "read")
      .mockImplementation((language, namespace, callback) => {
        if (language === "ja")
          delayed.push(() => read(language, namespace, callback));
        else read(language, namespace, callback);
      });
    let locale: HostedLocaleInput = { preference: "ja", visitor: null };
    const controller = new RuntimeController({
      kind: "hosted",
      transport: { baseUrl: "https://app.example.test", fetch: vi.fn() },
      localeInput: () => locale,
      readAdmission: async () => ({ status: "sign-in-required" }),
      repair: async () => ({ status: "sign-in-required" }),
    });
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => {
        root.render(
          <AnimamaI18nProvider i18n={i18n}>
            <RuntimeAdmissionProvider controller={controller}>
              <HostedLocaleSync />
            </RuntimeAdmissionProvider>
          </AnimamaI18nProvider>,
        );
      });
      expect(delayed.length).toBeGreaterThan(0);
      locale = { preference: "ko", visitor: null };
      await act(async () => {
        await controller.refresh();
      });
      await act(async () => {
        await vi.waitFor(() => expect(i18n.language).toBe("ko"));
      });
      await act(async () => {
        delayed.forEach((release) => release());
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(i18n.language).toBe("ko");
      expect(document.documentElement.lang).toBe("ko");
    } finally {
      act(() => root.unmount());
      delayed.splice(0).forEach((release) => release());
      spy.mockRestore();
    }
  });
  it("updates pre-admission text and active chat language without losing mounted state or accepting stale settings", async () => {
    vi.stubGlobal("navigator", {
      language: "en-GB",
      languages: ["fr-FR", "en-GB"],
    });
    let locale: HostedLocaleInput = { preference: null, visitor: "ja" };
    let admission: RuntimeAdmission = { status: "sign-in-required" };
    const controller = new RuntimeController({
      kind: "hosted",
      transport: { baseUrl: "https://app.example.test", fetch: vi.fn() },
      localeInput: () => locale,
      readAdmission: async () => admission,
      repair: async () => admission,
    });
    const element = document.createElement("div");
    const root = createRoot(element);
    let edit!: (draft: string) => void;
    function Screen() {
      const [draft, setDraft] = useState("initial");
      edit = setDraft;
      const { t } = useTranslation("settings");
      return (
        <>
          <span>{t("language.label")}</span>
          <input value={draft} readOnly />
        </>
      );
    }
    const i18n = await createWebI18n("en");
    try {
      await act(async () => {
        root.render(
          <AnimamaI18nProvider i18n={i18n}>
            <RuntimeAdmissionProvider controller={controller}>
              <HostedLocaleSync />
              <LocaleSync />
              <Screen />
            </RuntimeAdmissionProvider>
          </AnimamaI18nProvider>,
        );
      });
      await act(async () => {
        await vi.waitFor(() => expect(i18n.language).toBe("ja"));
      });
      expect(controller.getSnapshot().admission.status).toBe(
        "sign-in-required",
      );
      expect(document.documentElement.lang).toBe("ja");
      expect(document.documentElement.dir).toBe("ltr");
      expect(currentChatClientContext()).toMatchObject({
        ui_locale: "ja",
        locale: "fr-FR",
      });
      act(() => edit("unsaved draft"));
      const input = element.querySelector("input");
      admission = {
        status: "ready",
        session: { key: "one-session", owner: { id: "owner" } },
        capabilities,
        onboardingRequired: false,
      };
      await act(async () => {
        await controller.refresh();
      });
      const scope = controller.getSnapshot().scope;
      locale = { preference: "zh-Hant", visitor: "ja" };
      await act(async () => {
        await controller.refresh();
      });
      await act(async () => {
        await vi.waitFor(() => expect(i18n.language).toBe("zh-Hant"));
      });
      expect(document.documentElement.lang).toBe("zh-Hant");
      expect(currentChatClientContext()).toMatchObject({
        ui_locale: "zh-Hant",
        locale: "fr-FR",
      });
      expect(controller.getSnapshot().scope).toBe(scope);
      expect(element.querySelector("input")).toBe(input);
      expect(input?.value).toBe("unsaved draft");
      // Explicit null clears visitor too, leaving the full browser language list.
      locale = { preference: null, visitor: null };
      await act(async () => {
        await controller.refresh();
      });
      await act(async () => {
        await vi.waitFor(() => expect(i18n.language).toBe("en"));
      });
      vi.stubGlobal("navigator", {
        language: "fr-FR",
        languages: ["fr-FR", "ko-KR"],
      });
      await act(async () => {
        window.dispatchEvent(new Event("languagechange"));
      });
      await act(async () => {
        await vi.waitFor(() => expect(i18n.language).toBe("ko"));
      });
      expect(controller.getSnapshot().scope).toBe(scope);
      expect(input?.value).toBe("unsaved draft");
    } finally {
      act(() => root.unmount());
    }
  });
});
