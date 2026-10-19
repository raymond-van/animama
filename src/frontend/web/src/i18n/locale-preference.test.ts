import { afterEach, describe, expect, it, vi } from "vitest";

import {
  initialLocale,
  pseudoLocaleActive,
  rememberAppliedLocale,
  shareAppliedLocaleWithShell,
} from "./locale-preference";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

function stubBrowser({
  search = "",
  languages = ["en-US"],
}: { search?: string; languages?: string[] } = {}) {
  const window = {
    location: { search },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
  };
  vi.stubGlobal("window", window);
  vi.stubGlobal("navigator", { languages, language: languages[0] });
  return window;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("first-paint UI Locale", () => {
  it("uses hosted preference, visitor and browser order without promoting the applied cache", () => {
    stubBrowser({ languages: ["fr-FR", "ko-KR"] });
    rememberAppliedLocale("en");
    expect(initialLocale({ preference: null, visitor: "zh-Hant" })).toBe(
      "zh-Hant",
    );
    expect(initialLocale({ preference: "ja", visitor: "zh-Hant" })).toBe("ja");
    expect(initialLocale({ preference: null, visitor: null })).toBe("ko");
    expect(initialLocale(null)).toBe("ko");
    // An older hosted server that omits the extension retains its fallback.
    expect(initialLocale(undefined)).toBe("en");
  });
  it("follows the system language list before anything was applied", () => {
    stubBrowser({ languages: ["fr-FR", "ko-KR"] });
    expect(initialLocale()).toBe("ko");
  });

  it("prefers the locale this browser last applied", () => {
    stubBrowser({ languages: ["en-US"] });
    rememberAppliedLocale("zh-Hant");
    expect(initialLocale()).toBe("zh-Hant");
  });

  it("ignores a remembered value outside the supported locales", () => {
    const window = stubBrowser({ languages: ["ja-JP"] });
    window.localStorage.setItem("animama.ui-locale.applied", "en-US");
    expect(initialLocale()).toBe("ja");
  });

  it("keeps the development pseudo-locale for the tab once requested", () => {
    const window = stubBrowser({ search: "?ui-locale=pseudo" });
    expect(initialLocale()).toBe("en-XA");
    window.location.search = "";
    expect(pseudoLocaleActive()).toBe(true);
    window.location.search = "?ui-locale=off";
    expect(pseudoLocaleActive()).toBe(false);
  });
});

describe("desktop shell locale", () => {
  it("reports the applied locale only from the desktop main window", () => {
    const setApplied = vi.fn(async () => undefined);
    for (const windowRole of ["pip", "quick-chat", "recovery", "main"]) {
      vi.stubGlobal("window", {
        animamaDesktop: { windowRole, locale: { setApplied } },
      });
      shareAppliedLocaleWithShell("ja");
    }
    expect(setApplied).toHaveBeenCalledOnce();
    expect(setApplied).toHaveBeenCalledWith("ja");
  });

  it("skips browsers and shells without the locale bridge, and ignores a rejected report", async () => {
    stubBrowser();
    expect(() => shareAppliedLocaleWithShell("ko")).not.toThrow();
    vi.stubGlobal("window", { animamaDesktop: { windowRole: "main" } });
    expect(() => shareAppliedLocaleWithShell("ko")).not.toThrow();
    const setApplied = vi.fn(async () => {
      throw new Error("ipc_caller_rejected");
    });
    vi.stubGlobal("window", {
      animamaDesktop: { windowRole: "main", locale: { setApplied } },
    });
    shareAppliedLocaleWithShell("ko");
    await expect(setApplied.mock.results[0]!.value).rejects.toThrow();
  });
});
