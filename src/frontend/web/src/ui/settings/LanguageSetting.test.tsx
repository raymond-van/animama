// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { HostedLocaleInput } from "@animama/runtime-contracts/locale";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageSelect } from "./LanguageSetting";

const mocks = vi.hoisted(() => ({
  hosted: { preference: null, visitor: "ja" } as HostedLocaleInput,
  update: vi.fn(async () => ({})),
}));
vi.mock("@/query/hooks/useUserSettings", () => ({
  useUserSettings: () => ({ data: { locale: mocks.hosted.preference } }),
}));
vi.mock("@/query/mutations/useUpdateUserSettings", () => ({
  useUpdateUserSettings: () => ({
    mutateAsync: mocks.update,
    isPending: false,
  }),
}));
vi.mock("@/app/runtime/RuntimeAdmissionProvider", () => ({
  useOptionalLocaleInput: () => mocks.hosted,
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

async function picker(input: HostedLocaleInput) {
  mocks.hosted = input;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  cleanup.push(() => {
    act(() => root.unmount());
    element.remove();
  });
  await act(async () => root.render(<LanguageSelect />));
  const trigger = element.querySelector<HTMLElement>('[role="combobox"]')!;
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  const options = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ];
  expect(options).toHaveLength(6);
  return { trigger, options };
}

async function activate(option: HTMLElement, method: "mouse" | "Enter" | " ") {
  await act(async () => {
    if (method === "mouse") {
      option.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerType: "mouse",
          button: 0,
          bubbles: true,
        }),
      );
      option.dispatchEvent(
        new PointerEvent("pointerup", {
          pointerType: "mouse",
          button: 0,
          bubbles: true,
          cancelable: true,
        }),
      );
    } else {
      option.focus();
      option.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: method,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  });
}

describe("language picker explicit selection", () => {
  it.each(["mouse", "Enter", " "] as const)(
    "clears an existing visitor choice by activating the selected System default with %s",
    async (method) => {
      const { trigger, options } = await picker({
        preference: null,
        visitor: "ja",
      });
      expect(trigger.textContent).toContain("System default");
      expect(options[0]!.dataset.state).toBe("checked");
      await activate(options[0]!, method);
      expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
        body: { locale: null },
      });
      expect(document.querySelector('[role="listbox"]')).toBeNull();
    },
  );

  it("refreshes a different visitor choice when the saved language is explicitly selected again", async () => {
    const { options } = await picker({ preference: "ja", visitor: "ko" });
    const japanese = options.find((option) => option.lang === "ja")!;
    expect(japanese.dataset.state).toBe("checked");
    await activate(japanese, "mouse");
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      body: { locale: "ja" },
    });
  });

  it("saves a changed option once through the ordinary Select path", async () => {
    const { options } = await picker({ preference: "ja", visitor: "ko" });
    await activate(options[0]!, "Enter");
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      body: { locale: null },
    });
  });

  it("does not save while Space is part of keyboard typeahead", async () => {
    const { options } = await picker({ preference: null, visitor: "ja" });
    await act(async () => {
      options[0]!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await activate(options[0]!, " ");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("respects the opening pointer release cancelled by Radix's capture handler", async () => {
    const { options } = await picker({ preference: null, visitor: "ja" });
    // Radix cancels the opening release when the pointer has moved <=10px.
    // Item callbacks run before its own defaultPrevented guard.
    document.addEventListener("pointerup", (event) => event.preventDefault(), {
      capture: true,
      once: true,
    });
    await activate(options[0]!, "mouse");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });
});
