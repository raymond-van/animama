// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatConversation } from "@animama/product-ui/components";
import type { ChatMessage } from "@animama/product-ui/chat";
import { describe, expect, it, vi } from "vitest";

import { renderToStaticMarkup, withRuntime } from "@/test/runtime-markup";
import { ChatMessageImages } from "@/ui/main/chat/ChatMessageImages";

/** Which copy each rendered image asked for, as `fileId:variant`. */
const requested = vi.hoisted(() => new Set<string>());

/** Each fixture file id names the state its image request is in. */
vi.mock("@/query/hooks/useUserFileImageUrl", () => ({
  useUserFileImageUrl: (fileId: string, variant: string) => {
    requested.add(`${fileId}:${variant}`);
    return {
      url: fileId === "ready" ? "blob:ready" : null,
      isPending: fileId === "loading",
      isGone: fileId === "gone",
      isError: fileId === "failed",
    };
  },
}));

const image = (fileId: string, name = `${fileId}.png`) => ({ fileId, name });

describe("images sent with a message", () => {
  it("are shown above the person's bubble and never beside a reply", () => {
    const rendered: string[] = [];
    const messages: ChatMessage[] = [
      {
        id: "user-1",
        role: "user",
        text: "What is this?",
        images: [image("ready", "cat.png")],
      },
      { id: "assistant-1", role: "assistant", text: "A cat." },
      { id: "user-2", role: "user", text: "Thanks" },
    ];

    const html = renderToStaticMarkup(
      <ChatConversation
        messages={messages}
        renderUserAttachments={(message) => {
          rendered.push(message.id);
          return message.images?.length ? (
            <span>attachments of {message.id}</span>
          ) : null;
        }}
      />,
    );

    expect(rendered).toEqual(["user-1", "user-2"]);
    expect(html.indexOf("attachments of user-1")).toBeGreaterThan(-1);
    expect(html.indexOf("attachments of user-1")).toBeLessThan(
      html.indexOf("What is this?"),
    );
    expect(html).not.toContain("attachments of user-2");
  });

  it("open by name once loaded, wait while loading, and leave a placeholder when gone", () => {
    const html = renderToStaticMarkup(
      <ChatMessageImages
        images={[
          image("ready", "cat.png"),
          image("loading", "dog.png"),
          image("gone", "old.png"),
          image("failed", "net.png"),
        ]}
      />,
    );

    expect(html).toContain('aria-label="Images sent with this message"');
    expect(html).toMatch(
      /aria-label="Open cat\.png"[^>]*>\s*<img[^>]*src="blob:ready"/,
    );
    expect(html).toMatch(
      /aria-label="Open dog\.png"[^>]*>\s*<span[^>]*animate-pulse/,
    );
    expect(html).toContain('aria-label="old.png: Image no longer available"');
    expect(html).toContain('aria-label="net.png: Image could not be loaded"');
    expect(html).not.toContain("Open old.png");
  });

  it("open larger in a dialog and give focus back to the thumbnail on close", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        withRuntime(<ChatMessageImages images={[image("ready", "cat.png")]} />),
      ),
    );
    const thumbnail = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open cat.png"]',
    )!;

    thumbnail.focus();
    await act(async () => thumbnail.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("cat.png");
    expect(dialog?.querySelector("img")?.getAttribute("src")).toBe(
      "blob:ready",
    );
    // The transcript shows the preview copy; the dialog shows the original.
    expect([...requested]).toEqual(
      expect.arrayContaining(["ready:preview", "ready:original"]),
    );
    expect([...requested]).not.toContain("ready:thumbnail");

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    // Radix restores focus in a timeout after the dialog unmounts.
    await vi.waitFor(() => expect(document.activeElement).toBe(thumbnail));

    act(() => root.unmount());
    container.remove();
  });

  it("open inside the fullscreen element when the chat is fullscreen", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const fullscreen = document.createElement("div");
    document.body.append(fullscreen);
    const container = document.createElement("div");
    fullscreen.append(container);
    // The document's own property hides the prototype getter until deleted.
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreen,
    });
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          withRuntime(
            <ChatMessageImages images={[image("ready", "cat.png")]} />,
          ),
        ),
      );
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Open cat.png"]',
          )!
          .click(),
      );

      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(fullscreen.contains(dialog)).toBe(true);
    } finally {
      act(() => root.unmount());
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      fullscreen.remove();
    }
  });
});
