// @vitest-environment happy-dom
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PyGenerationConversation,
  PyGenerationConversationSnapshot,
} from "@animama/runtime-contracts/api-types";

import { privateStateResets } from "@/app/runtime/private-module-state";
import { useGenerationConversation } from "@/query/hooks/useGeneration";
import { queryKeys } from "@/query/keys";
import {
  controlledSseResponse,
  generationConversation,
  generationSnapshot,
  jsonResponse,
} from "../testing/generationFixtures";
import {
  click,
  renderInRuntime,
  settle,
  type MountedNode,
} from "../testing/generationHarness";
import { enterPseudoLocale, unmarkedText } from "../testing/pseudoLocale";
import { useGenerationRun } from "../useGenerationRun";
import { GenerateConversationWithReferences } from "./GenerateConversationWithReferences";

/**
 * The conversation's style choice in the Generate page's references row,
 * over a fake backend that stores the preset as the real one does.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const CONVERSATION = "conversation-1";
const OTHER = generationConversation({ id: "conversation-2", title: "Bows" });
/** The session key the test runtime gives the owner. */
const OWNER = "session";

const server = {
  snapshot: generationSnapshot() as PyGenerationConversationSnapshot,
  /** The bodies of the style requests received, in order. */
  styles: [] as unknown[],
  /** Answers the next style request instead of storing it. */
  refuseStyle: null as (() => Response) | null,
  /** Holds every style request until released. */
  holdStyle: null as Promise<void> | null,
  reads: 0,
  streams: [] as ReturnType<typeof controlledSseResponse>[],
};

async function fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/v1/gestures")
    return jsonResponse({ items: [] });
  if (request.method === "POST" && pathname.endsWith("/runs:sse")) {
    const stream = controlledSseResponse();
    server.streams.push(stream);
    return stream.response;
  }
  if (
    request.method === "PUT" &&
    pathname === `/v1/generation/conversations/${CONVERSATION}/style-preset`
  ) {
    const body = (await request.json()) as { style_preset: string | null };
    server.styles.push(body);
    await server.holdStyle;
    if (server.refuseStyle) {
      const refusal = server.refuseStyle();
      server.refuseStyle = null;
      return refusal;
    }
    server.snapshot = {
      ...server.snapshot,
      conversation: {
        ...server.snapshot.conversation,
        style_preset: body.style_preset,
      },
    };
    return jsonResponse(server.snapshot.conversation);
  }
  if (request.method === "GET" && pathname.endsWith(`/${CONVERSATION}`)) {
    server.reads += 1;
    return jsonResponse(server.snapshot);
  }
  throw new Error(`Unexpected request: ${request.method} ${pathname}`);
}

function Page() {
  const controller = useGenerationRun({
    conversationId: CONVERSATION,
    modelProviderId: "model-1",
  });
  const snapshot = useGenerationConversation(CONVERSATION).data;
  return (
    <GenerateConversationWithReferences
      conversationId={CONVERSATION}
      model={{ accepts: ["text", "image"] }}
      snapshot={snapshot}
      controller={controller}
      selectedDraft={null}
      onStartNewDraft={() => {}}
    />
  );
}

let mounted: MountedNode | null = null;
async function open() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The page's list of conversations, as its header has read it.
  queryClient.setQueryData<PyGenerationConversation[]>(
    queryKeys.generation.conversations(OWNER),
    [server.snapshot.conversation, OTHER],
  );
  mounted = renderInRuntime(<Page />, { fetch, queryClient });
  document.body.append(mounted.container);
  await settle();
}

const find = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const style = () => find("generate-style") as HTMLSelectElement;
const optionNames = () =>
  [...style().options].map((option) => option.textContent);

/** Choose a style as a person does. */
async function choose(value: string) {
  const select = style();
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

function stored(preset: string | null) {
  server.snapshot = generationSnapshot({
    conversation: generationConversation({ style_preset: preset }),
  });
}

function type(text: string) {
  const field = find("generate-request") as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setValue.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  stored(null);
  server.styles = [];
  server.refuseStyle = null;
  server.holdStyle = null;
  server.reads = 0;
  server.streams = [];
});
afterEach(() => {
  mounted?.unmount();
  mounted?.container.remove();
  mounted = null;
  for (const reset of privateStateResets()) reset();
});

describe("the conversation's style in the Generate page's composer", () => {
  it("offers None and the five presets, named from the catalog", async () => {
    await open();
    const select = style();
    // Labelled in words, inside the references row.
    expect(select.labels[0]!.textContent).toBe("Style");
    expect(find("generate-references")!.contains(select)).toBe(true);
    expect(optionNames()).toEqual([
      "None",
      "Expressive anime",
      "Soft and natural",
      "Cute and playful",
      "Cool and composed",
      "Dramatic and theatrical",
    ]);
    expect(select.value).toBe("");
    expect(select.disabled).toBe(false);
  });

  it("shows the preset the conversation stores", async () => {
    stored("cute_playful");
    await open();
    expect(style().value).toBe("cute_playful");
    expect(style().selectedOptions[0]!.textContent).toBe("Cute and playful");
  });

  it("stores a chosen preset by its id, and keeps it after the conversation is read again", async () => {
    await open();
    await choose("soft_natural");
    // The id and nothing else: the sentence is the backend's.
    expect(server.styles).toEqual([{ style_preset: "soft_natural" }]);
    expect(style().value).toBe("soft_natural");
    expect(find("generate-style-failure")).toBeNull();

    // The cached conversation and the page's list both carry it.
    const client = mounted!.queryClient;
    expect(
      client.getQueryData<PyGenerationConversationSnapshot>(
        queryKeys.generation.conversation(OWNER, CONVERSATION),
      )!.conversation.style_preset,
    ).toBe("soft_natural");
    expect(
      client
        .getQueryData<
          PyGenerationConversation[]
        >(queryKeys.generation.conversations(OWNER))!
        .map(({ id, style_preset }) => [id, style_preset]),
    ).toEqual([
      [CONVERSATION, "soft_natural"],
      [OTHER.id, null],
    ]);

    const reads = server.reads;
    await act(async () => {
      await client.invalidateQueries({
        queryKey: queryKeys.generation.conversation(OWNER, CONVERSATION),
      });
    });
    await settle();
    expect(server.reads).toBe(reads + 1);
    expect(style().value).toBe("soft_natural");

    // A reload opens on the stored choice.
    mounted!.unmount();
    mounted!.container.remove();
    await open();
    expect(style().value).toBe("soft_natural");
  });

  it("clears the style with None", async () => {
    stored("dramatic_theatrical");
    await open();
    await choose("");
    expect(server.styles).toEqual([{ style_preset: null }]);
    expect(style().value).toBe("");
    expect(server.snapshot.conversation.style_preset).toBeNull();
  });

  it("shows a stored id the page does not know as None", async () => {
    stored("noir_detective");
    await open();
    expect(style().value).toBe("");
    expect(optionNames()).toHaveLength(6);
    // Nothing is sent until the person chooses.
    expect(server.styles).toEqual([]);
  });

  it("says in words when the style was refused, and returns to the stored one", async () => {
    stored("cool_composed");
    await open();
    server.refuseStyle = () =>
      jsonResponse(
        {
          detail: {
            code: "generation_style_preset_unknown",
            message: "Unknown style preset.",
          },
        },
        422,
      );
    await choose("anime_expressive");
    expect(style().value).toBe("cool_composed");
    const failure = find("generate-style-failure")!;
    expect(failure.getAttribute("role")).toBe("alert");
    expect(failure.textContent).toBe(
      "The style could not be saved, so it is as it was. This style is not available here. Choose another.",
    );
    expect(failure.textContent).not.toContain("generation_style");
    expect(style().getAttribute("aria-describedby")).toBe(failure.id);

    // A conversation that is gone says so; any other failure says to retry.
    server.refuseStyle = () =>
      jsonResponse({ detail: { code: "generation_not_found" } }, 404);
    await choose("soft_natural");
    expect(find("generate-style-failure")!.textContent).toBe(
      "The style could not be saved, so it is as it was. This conversation or draft no longer exists.",
    );
    server.refuseStyle = () => new Response(null, { status: 500 });
    await choose("soft_natural");
    expect(find("generate-style-failure")!.textContent).toBe(
      "The style could not be saved, so it is as it was. Try again.",
    );

    // The next choice that is stored takes the notice away.
    await choose("soft_natural");
    expect(style().value).toBe("soft_natural");
    expect(find("generate-style-failure")).toBeNull();
    expect(style().hasAttribute("aria-describedby")).toBe(false);
  });

  it("shows the choice while it is being stored, and takes no second one meanwhile", async () => {
    let release!: () => void;
    server.holdStyle = new Promise<void>((resolve) => (release = resolve));
    await open();
    await choose("cute_playful");
    expect(style().value).toBe("cute_playful");
    // Not disabled: a disabled control would drop the keyboard's focus.
    expect(style().disabled).toBe(false);
    expect(style().getAttribute("aria-disabled")).toBe("true");
    expect(style().getAttribute("aria-busy")).toBe("true");
    style().focus();

    // A second choice made meanwhile is ignored, and the first stays shown.
    await choose("cool_composed");
    expect(style().value).toBe("cute_playful");
    expect(server.styles).toHaveLength(1);
    expect(document.activeElement).toBe(style());

    await act(async () => release());
    await settle();
    expect(style().disabled).toBe(false);
    expect(style().hasAttribute("aria-disabled")).toBe(false);
    expect(style().getAttribute("aria-busy")).not.toBe("true");
    expect(server.styles).toEqual([{ style_preset: "cute_playful" }]);
    expect(style().value).toBe("cute_playful");
    expect(document.activeElement).toBe(style());
  });

  it("stays available while the assistant works", async () => {
    await open();
    type("a shy little wave");
    await click(find("generate-send"));
    await settle();
    expect(find("generate-stop")).not.toBeNull();
    expect(style().disabled).toBe(false);

    await choose("anime_expressive");
    expect(server.styles).toEqual([{ style_preset: "anime_expressive" }]);
    expect(style().value).toBe("anime_expressive");
  });

  it("waits for the conversation before it can be chosen", async () => {
    let answer!: () => void;
    const held = new Promise<void>((resolve) => (answer = resolve));
    mounted = renderInRuntime(<Page />, {
      fetch: async (request) => {
        if (new URL(request.url).pathname.endsWith(`/${CONVERSATION}`))
          await held;
        return fetch(request);
      },
    });
    document.body.append(mounted.container);
    await settle(2);
    expect(style().disabled).toBe(true);
    await act(async () => answer());
    await settle();
    expect(style().disabled).toBe(false);
  });

  it("words the choice from the catalog", async () => {
    await open();
    server.refuseStyle = () => new Response(null, { status: 500 });
    await choose("soft_natural");
    const leave = await enterPseudoLocale();
    try {
      expect(unmarkedText(find("generate-references")!)).toEqual([]);
    } finally {
      await leave();
    }
  });
});
