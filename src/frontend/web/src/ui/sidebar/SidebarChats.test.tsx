// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "@/query/keys";
import {
  isChatSendHeld,
  registerStreamingReply,
  useChatDeleteCoordinationStore,
} from "@/stores/chat-delete-coordination-store";
import { withRuntime } from "@/test/runtime-markup";
import { SidebarChats } from "./SidebarChats";

type ChatRow = {
  id: string;
  anima_id: string;
  title: string;
  pinned_at: string | null;
};

const fixture = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  pathname: "/",
  navigate: vi.fn<(options: unknown) => Promise<void>>(),
  chats: [] as ChatRow[],
  animas: [] as unknown[],
  patch: vi.fn(),
  remove: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    ...props
  }: { children?: ReactNode } & Record<string, unknown>) => {
    const attributes = Object.fromEntries(
      Object.entries(props).filter(
        ([key]) => !["to", "params", "search"].includes(key),
      ),
    );
    return (
      <a href="#" {...attributes}>
        {children}
      </a>
    );
  },
  useParams: () => fixture.params,
  useLocation: (options?: { select?: (location: unknown) => unknown }) => {
    const location = { pathname: fixture.pathname };
    return options?.select ? options.select(location) : location;
  },
  useNavigate: () => fixture.navigate,
}));
vi.mock("@/ui/sidebar/Sidebar", () => ({
  useSidebar: () => ({ open: true }),
  useCloseMobileSidebar: () => () => {},
}));
vi.mock("@/query/hooks/useAnimas", () => ({
  useAnimas: () => ({ data: fixture.animas, isLoading: false }),
}));
vi.mock("@/query/hooks/useChats", () => ({
  useChats: (options?: { animaId?: string | null }) => ({
    data: options?.animaId
      ? fixture.chats.filter((chat) => chat.anima_id === options.animaId)
      : fixture.chats,
    isLoading: false,
    isError: false,
    isSuccess: true,
  }),
}));
vi.mock("@animama/runtime-contracts/sdk", async (original) => ({
  ...(await original<typeof import("@animama/runtime-contracts/sdk")>()),
  updateChatV1ChatsChatIdPatch: fixture.patch,
  deleteChatV1ChatsChatIdDelete: fixture.remove,
}));
vi.mock("sonner", () => ({ toast: fixture.toast }));
// Radix renders menu content in a portal only while open; render the row
// menu's items inline so they can be inspected and chosen.
vi.mock("@/ui/components/dropdown-menu", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const RadioContext = React.createContext<(value: string) => void>(() => {});
  return {
    DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
      <>{children}</>
    ),
    DropdownMenuContent: ({ children }: { children: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuRadioGroup: ({
      children,
      onValueChange,
    }: {
      children: ReactNode;
      onValueChange: (value: string) => void;
    }) => (
      <RadioContext.Provider value={onValueChange}>
        {children}
      </RadioContext.Provider>
    ),
    DropdownMenuRadioItem: ({
      children,
      value,
    }: {
      children: ReactNode;
      value: string;
    }) => {
      const select = React.useContext(RadioContext);
      return (
        <button
          type="button"
          role="menuitemradio"
          onClick={() => select(value)}
        >
          {children}
        </button>
      );
    },
    DropdownMenuItem: ({
      children,
      onSelect,
    }: {
      children: ReactNode;
      onSelect?: (event: Event) => void;
    }) => (
      <button
        type="button"
        role="menuitem"
        onClick={() => onSelect?.(new Event("select", { cancelable: true }))}
      >
        {children}
      </button>
    ),
  };
});
// The right-click menu offers the same items as the More menu.
vi.mock("@/ui/components/context-menu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ANIMAS = [
  {
    id: "ava",
    display_name: "Ava",
    presentation: { profile_thumbnail: null },
  },
  {
    id: "bo",
    display_name: "Bo",
    presentation: { profile_thumbnail: null },
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient;

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        {withRuntime(<SidebarChats />)}
      </QueryClientProvider>,
    );
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const rowTitles = () =>
  [...container!.querySelectorAll<HTMLAnchorElement>("#sidebar-chats-list a")]
    .map((link) => link.getAttribute("title"))
    .filter(Boolean);
const row = (title: string) =>
  [...container!.querySelectorAll<HTMLElement>("[data-sidebar-row]")].find(
    (candidate) => candidate.querySelector(`a[title="${title}"]`) !== null,
  )!;
const rowItems = (title: string) =>
  [...row(title).querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
    (item) => item.textContent,
  );
const rowItem = (title: string, label: string) =>
  [...row(title).querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  )!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const dialogButton = (label: string) =>
  [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label,
  )!;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fixture.params = {};
  fixture.pathname = "/";
  fixture.navigate.mockReset();
  fixture.navigate.mockResolvedValue(undefined);
  fixture.animas = ANIMAS;
  fixture.chats = [
    { id: "c1", anima_id: "ava", title: "Newest", pinned_at: null },
    {
      id: "c2",
      anima_id: "bo",
      title: "Bo's pinned",
      pinned_at: "2026-11-20T10:00:00",
    },
    {
      id: "c3",
      anima_id: "ava",
      title: "Ava's pinned",
      pinned_at: "2026-11-25T10:00:00",
    },
    { id: "c4", anima_id: "ava", title: "Older", pinned_at: null },
  ];
  fixture.patch.mockReset();
  fixture.patch.mockImplementation(
    async ({
      path,
      body,
    }: {
      path: { chat_id: string };
      body: { pinned: boolean };
    }) => ({
      data: {
        ...fixture.chats.find((chat) => chat.id === path.chat_id),
        pinned_at: body.pinned ? "2026-11-26T12:00:00" : null,
      },
      response: new Response(null, { status: 200 }),
    }),
  );
  fixture.remove.mockReset();
  fixture.remove.mockResolvedValue({
    data: undefined,
    response: new Response(null, { status: 204 }),
  });
  fixture.toast.success.mockReset();
  fixture.toast.error.mockReset();
  client.setQueryData(queryKeys.chats.list("owner"), fixture.chats);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  client.clear();
  useChatDeleteCoordinationStore.setState({ replies: [], holds: [] });
});

describe("sidebar chat pins", () => {
  it("lists pinned chats first, in their usual order, and marks them", async () => {
    await render();

    expect(rowTitles()).toEqual([
      "Bo's pinned",
      "Ava's pinned",
      "Newest",
      "Older",
    ]);
    expect(row("Bo's pinned").querySelector("a")!.textContent).toContain(
      "Pinned",
    );
    expect(row("Newest").querySelector("a")!.textContent).not.toContain(
      "Pinned",
    );
  });

  it("keeps pinned chats first within the Anima filter", async () => {
    await render();

    const avaFilter = [
      ...container!.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((item) => item.textContent === "Ava")!;
    act(() => avaFilter.click());

    expect(rowTitles()).toEqual(["Ava's pinned", "Newest", "Older"]);
  });

  it("offers Pin or Unpin and Delete from a named More menu", async () => {
    await render();

    expect(rowItems("Newest")).toEqual(["Pin", "Delete"]);
    expect(rowItems("Ava's pinned")).toEqual(["Unpin", "Delete"]);
    expect(
      row("Newest").querySelector('[aria-label="More actions for Newest"]'),
    ).not.toBeNull();
  });

  it("pins a chat on the server and refreshes the chat list", async () => {
    await render();

    await act(async () => rowItem("Newest", "Pin").click());
    await settle();

    expect(fixture.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { chat_id: "c1" },
        body: { pinned: true },
        responseValidator: undefined,
      }),
    );
    expect(
      client.getQueryState(queryKeys.chats.list("owner"))?.isInvalidated,
    ).toBe(true);
  });

  it("unpins a pinned chat", async () => {
    await render();

    await act(async () => rowItem("Ava's pinned", "Unpin").click());
    await settle();

    expect(fixture.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { chat_id: "c3" },
        body: { pinned: false },
      }),
    );
  });
});

describe("deleting a chat from the sidebar", () => {
  it("confirms with a plain dialog that names the chat and what is kept", async () => {
    await render();

    act(() => rowItem("Newest", "Delete").click());

    expect(dialog()?.textContent).toContain("Delete chat?");
    expect(dialog()?.textContent).toContain(
      "“Newest” and its messages will be deleted, along with any images only this chat uses. Memories already saved from it are kept.",
    );
    expect(fixture.remove).not.toHaveBeenCalled();

    act(() => dialogButton("Cancel").click());
    expect(dialog()).toBeNull();
    expect(fixture.remove).not.toHaveBeenCalled();
    // Focus returns to the row's More button once the dialog has gone.
    await settle();
    expect(document.activeElement).toBe(
      row("Newest").querySelector('[aria-label="More actions for Newest"]'),
    );
  });

  it("deletes the chat, removes it from the sidebar and says so", async () => {
    await render();

    act(() => rowItem("Newest", "Delete").click());
    await act(async () => dialogButton("Delete").click());
    await settle();

    expect(fixture.remove).toHaveBeenCalledWith(
      expect.objectContaining({ path: { chat_id: "c1" } }),
    );
    expect(dialog()).toBeNull();
    expect(fixture.toast.success).toHaveBeenCalledWith("Chat deleted.");
    expect(
      (client.getQueryData(queryKeys.chats.list("owner")) as ChatRow[]).map(
        (chat) => chat.id,
      ),
    ).toEqual(["c2", "c3", "c4"]);
    // The chat was not open, so the page stays where it is.
    expect(fixture.navigate).not.toHaveBeenCalled();
    // Focus moves to the chat that followed the deleted one.
    expect(document.activeElement).toBe(
      container!.querySelector('a[title="Older"]'),
    );
  });

  it("moves focus to the chat before a deleted last chat", async () => {
    await render();

    act(() => rowItem("Older", "Delete").click());
    await act(async () => dialogButton("Delete").click());
    await settle();

    expect(document.activeElement).toBe(
      container!.querySelector('a[title="Newest"]'),
    );
  });

  it("opens a new chat with the same Anima after deleting the open chat", async () => {
    fixture.params = { animaId: "ava", chatId: "c4" };
    fixture.pathname = "/ava/c/c4";
    await render();

    act(() => rowItem("Older", "Delete").click());
    await act(async () => dialogButton("Delete").click());
    await settle();

    // Replacing the history entry keeps Back from reopening the deleted chat.
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/$animaId",
      params: { animaId: "ava" },
      replace: true,
    });
  });

  it("stops the chat's streaming reply, then deletes it, holding sends meanwhile", async () => {
    const stop = vi.fn();
    registerStreamingReply({ animaId: "ava", chatId: "c1", stop });
    let finish!: () => void;
    fixture.remove.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              data: undefined,
              response: new Response(null, { status: 204 }),
            });
        }),
    );
    await render();

    act(() => rowItem("Newest", "Delete").click());
    await act(async () => dialogButton("Delete").click());

    expect(stop).toHaveBeenCalledTimes(1);
    expect(fixture.remove).toHaveBeenCalledTimes(1);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.remove.mock.invocationCallOrder[0]!,
    );
    // While the delete runs the dialog stays, cannot be dismissed, and the
    // chat takes no new message.
    expect(dialogButton("Delete").disabled).toBe(true);
    expect(dialogButton("Cancel").disabled).toBe(true);
    expect(isChatSendHeld({ animaId: "ava", chatId: "c1" })).toBe(true);

    await act(async () => finish());
    await settle();

    expect(dialog()).toBeNull();
    expect(isChatSendHeld({ animaId: "ava", chatId: "c1" })).toBe(false);
  });

  it("keeps the dialog open and says to try again while the reply is still stopping", async () => {
    fixture.params = { animaId: "ava", chatId: "c1" };
    fixture.remove.mockResolvedValue({
      error: { detail: { code: "chat_turn_stopping" } },
      response: new Response(null, { status: 409 }),
    });
    await render();

    act(() => rowItem("Newest", "Delete").click());
    await act(async () => dialogButton("Delete").click());
    await settle();

    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "The reply is still stopping. Try again in a moment.",
    );
    expect(dialogButton("Delete").disabled).toBe(false);
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.toast.success).not.toHaveBeenCalled();
    expect(isChatSendHeld({ animaId: "ava", chatId: "c1" })).toBe(false);
  });

  it("reports any other failure in the dialog", async () => {
    fixture.remove.mockResolvedValue({
      error: { detail: "Internal Server Error" },
      response: new Response(null, { status: 500 }),
    });
    await render();

    act(() => rowItem("Newest", "Delete").click());
    await act(async () => dialogButton("Delete").click());
    await settle();

    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "The chat could not be deleted. Try again.",
    );
  });

  it("treats a chat already deleted elsewhere as deleted", async () => {
    fixture.remove.mockResolvedValue({
      error: { detail: "Chat not found" },
      response: new Response(null, { status: 404 }),
    });
    await render();

    act(() => rowItem("Newest", "Delete").click());
    await act(async () => dialogButton("Delete").click());
    await settle();

    expect(dialog()).toBeNull();
    expect(fixture.toast.success).toHaveBeenCalledWith("Chat deleted.");
  });
});
