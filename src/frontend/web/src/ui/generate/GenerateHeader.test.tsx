// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GenerateConversationMenu, GenerateHeader } from "./GenerateHeader";
import { generationConversation } from "./testing/generationFixtures";
import {
  click,
  mountInDocument,
  type MountedInDocument,
} from "./testing/generationHarness";
import { enterPseudoLocale, unmarkedText } from "./testing/pseudoLocale";
import type { GenerationConversationChoice } from "./useGenerationConversationChoice";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

function choice(
  overrides: Partial<GenerationConversationChoice> = {},
): GenerationConversationChoice {
  return {
    conversations: [
      generationConversation({
        id: "latest",
        title: "a bow",
        updated_at: "2026-11-26T12:30:00",
      }),
      generationConversation({ id: "older", title: "  " }),
    ],
    conversationId: "latest",
    isError: false,
    retry: vi.fn(),
    open: vi.fn(),
    startNew: vi.fn(async () => {}),
    isStarting: false,
    discard: vi.fn(async () => {}),
    isDiscarding: false,
    ...overrides,
  };
}

let mounted: MountedInDocument | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  toastError.mockClear();
});

const find = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const findAll = (testId: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

function menu(
  selected: GenerationConversationChoice,
  props: { running?: boolean; currentIsEmpty?: boolean } = {},
) {
  mounted = mountInDocument(
    <GenerateConversationMenu
      choice={selected}
      running={props.running ?? false}
      currentIsEmpty={props.currentIsEmpty ?? false}
    />,
  );
}

/** Open the earlier-conversations menu from the keyboard. */
async function openMenu() {
  const trigger = find("generate-conversations-menu")!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

describe("the conversation menu", () => {
  it("starts a new conversation", async () => {
    const selected = choice();
    menu(selected);
    const start = find("generate-new-conversation") as HTMLButtonElement;
    expect(start.getAttribute("aria-label")).toBe("New conversation");
    await click(start);
    expect(selected.startNew).toHaveBeenCalledTimes(1);
  });

  it("does not start another conversation while the open one is empty", () => {
    menu(choice(), { currentIsEmpty: true });
    expect(
      (find("generate-new-conversation") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("lists the earlier conversations and reopens the one picked", async () => {
    const selected = choice();
    menu(selected);
    const trigger = find("generate-conversations-menu")!;
    expect(trigger.getAttribute("aria-label")).toBe("Earlier conversations");
    await openMenu();
    const items = findAll("generate-conversation-item");
    expect(items.map((item) => item.dataset.conversationId)).toEqual([
      "latest",
      "older",
    ]);
    // A conversation without a first message yet has no title of its own.
    expect(items[0]!.textContent).toContain("a bow");
    expect(items[1]!.textContent).toContain("New conversation");
    expect(items[0]!.getAttribute("aria-checked")).toBe("true");

    await click(items[1]);
    expect(selected.open).toHaveBeenCalledWith("older");
  });

  it("discards the open conversation only after the person confirms", async () => {
    const selected = choice();
    menu(selected);
    await openMenu();
    await click(find("generate-conversation-discard"));
    const dialog = find("generate-conversation-discard-dialog")!;
    expect(dialog.textContent).toContain("Discard this conversation?");
    expect(dialog.textContent).toContain(
      "Its messages and unsaved drafts are removed. Items you saved stay in your Library.",
    );
    expect(selected.discard).not.toHaveBeenCalled();

    await click(find("generate-conversation-discard-confirm"));
    expect(selected.discard).toHaveBeenCalledWith("latest");
    expect(find("generate-conversation-discard-dialog")).toBeNull();
  });

  it("words a refused discard from its code", async () => {
    const selected = choice({
      discard: vi.fn(async () => {
        throw { detail: { code: "generation_run_in_progress" } };
      }),
    });
    menu(selected);
    await openMenu();
    await click(find("generate-conversation-discard"));
    await click(find("generate-conversation-discard-confirm"));
    expect(toastError).toHaveBeenCalledWith(
      "The assistant is still working on this conversation. Wait for it to finish or stop it first.",
    );
  });

  it("waits for a run in flight, and says so", () => {
    menu(choice(), { running: true });
    for (const id of [
      "generate-new-conversation",
      "generate-conversations-menu",
    ]) {
      const control = find(id) as HTMLButtonElement;
      expect(control.disabled).toBe(true);
      expect(control.title).toBe("Available when the assistant has finished.");
    }
  });

  it("does not discard the conversation while its run is in flight", async () => {
    const selected = choice();
    menu(selected);
    await openMenu();
    await click(find("generate-conversation-discard"));
    // A run starts behind the open confirmation.
    mounted!.rerender(
      <GenerateConversationMenu
        choice={selected}
        running
        currentIsEmpty={false}
      />,
    );
    const confirm = find(
      "generate-conversation-discard-confirm",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.title).toBe("Available when the assistant has finished.");
    await click(confirm);
    expect(selected.discard).not.toHaveBeenCalled();
  });

  it("takes every word it shows from the catalog", async () => {
    const leave = await enterPseudoLocale();
    try {
      mounted = mountInDocument(
        <GenerateHeader
          conversationMenu={
            <GenerateConversationMenu
              choice={choice()}
              running={false}
              currentIsEmpty={false}
            />
          }
          modelControl={null}
        />,
      );
      await openMenu();
      const dates = findAll("generate-conversation-item").flatMap((item) =>
        [...item.querySelectorAll("span span")]
          .slice(1)
          .map((date) => date.textContent ?? ""),
      );
      expect(unmarkedText(document.body, ["a bow", ...dates])).toEqual([]);
      await click(find("generate-conversation-discard"));
      expect(unmarkedText(document.body, ["a bow", ...dates])).toEqual([]);
    } finally {
      await leave();
    }
  });
});
