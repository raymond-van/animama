// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "@/query/keys";
import {
  registerStreamingReply,
  useChatDeleteCoordinationStore,
} from "@/stores/chat-delete-coordination-store";
import { withRuntime } from "@/test/runtime-markup";
import { SidebarAnimas } from "./SidebarAnimas";
import { useSidebarAnimaSortStore } from "./sidebarOrder";

type AnimaRow = {
  id: string;
  display_name: string;
  updated_at: string;
  created_at: string;
  pinned_at: string | null;
  presentation: { profile_thumbnail: null };
};

const fixture = vi.hoisted(() => ({
  sidebarOpen: true,
  params: {} as Record<string, string>,
  pathname: "/",
  lastActiveAnimaId: null as string | null,
  navigate: vi.fn<(options: unknown) => Promise<void>>(),
  animas: [] as AnimaRow[],
  chats: [] as Array<{ id: string; anima_id: string }>,
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
  useSidebar: () => ({ open: fixture.sidebarOpen }),
  useCloseMobileSidebar: () => () => {},
}));
vi.mock("@/ui/settings/SettingsProvider", () => ({
  useSettings: () => ({
    userSettings: { last_active_anima_id: fixture.lastActiveAnimaId },
  }),
}));
vi.mock("@/query/hooks/useAnimas", () => ({
  useAnimas: () => ({
    data: fixture.animas,
    isLoading: false,
    isError: false,
  }),
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
  patchAnimaV1AnimasAnimaIdPatch: fixture.patch,
  deleteAnimaV1AnimasAnimaIdDelete: fixture.remove,
}));
vi.mock("sonner", () => ({ toast: fixture.toast }));
vi.mock("@/ui/components/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
// Radix renders menu content in a portal only while open; render the menus'
// items inline so they can be inspected and chosen.
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

function anima(
  id: string,
  name: string,
  updatedAt: string,
  pinnedAt: string | null = null,
): AnimaRow {
  return {
    id,
    display_name: name,
    updated_at: updatedAt,
    created_at: updatedAt,
    pinned_at: pinnedAt,
    presentation: { profile_thumbnail: null },
  };
}

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
        {withRuntime(<SidebarAnimas />)}
      </QueryClientProvider>,
    );
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The Anima rows' links, by accessible name, in sidebar order. */
const rowNames = () =>
  [
    ...container!.querySelectorAll<HTMLAnchorElement>("#sidebar-animas-list a"),
  ].map((link) => link.getAttribute("aria-label"));
const railNames = () =>
  [...container!.querySelectorAll<HTMLAnchorElement>("a")].map((link) =>
    link.getAttribute("aria-label"),
  );
const row = (name: string) =>
  [...container!.querySelectorAll<HTMLElement>("[data-sidebar-row]")].find(
    (candidate) =>
      candidate
        .querySelector("a")
        ?.getAttribute("aria-label")
        ?.startsWith(name),
  )!;
const rowItem = (name: string, label: string) =>
  [...row(name).querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  )!;
const chooseSort = (label: string) => {
  const item = [
    ...container!.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
  ].find((candidate) => candidate.textContent === label)!;
  act(() => item.click());
};
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const dialogButton = (label: string) =>
  [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label,
  )!;

async function confirmDelete(name: string) {
  act(() => rowItem(name, "Delete").click());
  await act(async () => dialogButton("Delete").click());
  await settle();
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fixture.sidebarOpen = true;
  fixture.params = {};
  fixture.pathname = "/";
  fixture.lastActiveAnimaId = null;
  fixture.navigate.mockReset();
  fixture.navigate.mockResolvedValue(undefined);
  fixture.animas = [
    anima("ava", "Ava", "2026-11-01T00:00:00"),
    anima("bo", "Bo", "2026-11-03T00:00:00", "2026-11-25T00:00:00"),
    anima("cy", "Cy", "2026-11-04T00:00:00"),
  ];
  fixture.chats = [
    { id: "c1", anima_id: "ava" },
    { id: "c2", anima_id: "ava" },
    { id: "c3", anima_id: "bo" },
  ];
  fixture.patch.mockReset();
  fixture.patch.mockImplementation(
    async ({
      path,
      body,
    }: {
      path: { anima_id: string };
      body: { pinned: boolean };
    }) => ({
      data: {
        ...fixture.animas.find((candidate) => candidate.id === path.anima_id),
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
  client.setQueryData(queryKeys.animas.list("owner"), fixture.animas);
  client.setQueryData(queryKeys.chats.list("owner"), fixture.chats);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  client.clear();
  useChatDeleteCoordinationStore.setState({ replies: [], holds: [] });
  useSidebarAnimaSortStore.setState({ sort: "recent" });
});

describe("sidebar Anima pins", () => {
  it("lists pinned Animas first whatever the sort, and marks them", async () => {
    await render();

    expect(rowNames()).toEqual(["Bo, pinned", "Cy", "Ava"]);

    chooseSort("Name: A–Z");
    expect(rowNames()).toEqual(["Bo, pinned", "Ava", "Cy"]);

    chooseSort("Name: Z–A");
    expect(rowNames()).toEqual(["Bo, pinned", "Cy", "Ava"]);
  });

  it("lists Animas in the same order on the collapsed rail", async () => {
    fixture.sidebarOpen = false;
    useSidebarAnimaSortStore.setState({ sort: "name-asc" });
    await render();

    expect(railNames()).toEqual(["Bo", "Ava", "Cy"]);
  });

  it("offers Pin or Unpin and Delete from a named More menu", async () => {
    await render();

    const items = (name: string) =>
      [...row(name).querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
        (item) => item.textContent,
      );
    expect(items("Ava")).toEqual(["Pin", "Delete"]);
    expect(items("Bo")).toEqual(["Unpin", "Delete"]);
    expect(
      row("Ava").querySelector('[aria-label="More actions for Ava"]'),
    ).not.toBeNull();
  });

  it("pins an Anima without an aggregate revision and refreshes the roster", async () => {
    await render();

    await act(async () => rowItem("Ava", "Pin").click());
    await settle();

    expect(fixture.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { anima_id: "ava" },
        body: { pinned: true },
        responseValidator: undefined,
      }),
    );
    expect(
      client.getQueryState(queryKeys.animas.list("owner"))?.isInvalidated,
    ).toBe(true);
  });
});

describe("deleting an Anima from the sidebar", () => {
  it("confirms with a plain dialog naming the Anima, its chat count and what is kept", async () => {
    await render();

    act(() => rowItem("Ava", "Delete").click());

    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Delete Ava?");
    expect(text).toContain("Ava has 2 chats.");
    expect(text).toContain(
      "Its chats and their messages, its Anima memory files (IDENTITY.md and MEMORIES.md) and any images only its chats use will be deleted. Shared memories and Library content are kept.",
    );
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("removes a deleted Anima that was not open without moving the page", async () => {
    fixture.params = { animaId: "bo" };
    fixture.pathname = "/bo";
    await render();

    await confirmDelete("Ava");

    expect(fixture.remove).toHaveBeenCalledWith(
      expect.objectContaining({ path: { anima_id: "ava" } }),
    );
    expect(dialog()).toBeNull();
    expect(fixture.toast.success).toHaveBeenCalledWith("Ava deleted.");
    expect(
      (client.getQueryData(queryKeys.animas.list("owner")) as AnimaRow[]).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["bo", "cy"]);
    expect(
      (
        client.getQueryData(queryKeys.chats.list("owner")) as Array<{
          id: string;
        }>
      ).map((chat) => chat.id),
    ).toEqual(["c3"]);
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("opens the next Anima in sidebar order after deleting the open one", async () => {
    fixture.params = { animaId: "cy", chatId: "c9" };
    fixture.pathname = "/cy/c/c9";
    await render();
    // Sidebar order: Bo (pinned), Cy (open, so most recent), Ava.
    expect(rowNames()).toEqual(["Bo, pinned", "Cy", "Ava"]);

    await confirmDelete("Cy");

    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/$animaId",
      params: { animaId: "ava" },
      replace: true,
    });
    // Focus moves to the Anima that followed the deleted one.
    expect(document.activeElement).toBe(row("Ava").querySelector("a"));
  });

  it("returns focus to the row's More button when the delete is cancelled", async () => {
    await render();

    act(() => rowItem("Ava", "Delete").click());
    act(() => dialogButton("Cancel").click());
    await settle();

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(
      row("Ava").querySelector('[aria-label="More actions for Ava"]'),
    );
  });

  it("shows the empty roster when no Anima remains", async () => {
    fixture.animas = [anima("ava", "Ava", "2026-11-01T00:00:00")];
    client.setQueryData(queryKeys.animas.list("owner"), fixture.animas);
    fixture.params = { animaId: "ava" };
    fixture.pathname = "/ava";
    await render();

    await confirmDelete("Ava");

    expect(fixture.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
    // With no row left, focus goes to the list's heading.
    expect(document.activeElement).toBe(
      container!.querySelector('[aria-controls="sidebar-animas-list"]'),
    );
  });

  it("stays on Anima pages when the deleted Anima's page was open", async () => {
    fixture.params = { animaId: "ava" };
    fixture.pathname = "/animas/ava";
    fixture.lastActiveAnimaId = "cy";
    await render();

    // Sidebar order: Bo (pinned), Cy (last active), Ava; Ava is last, so the
    // one before it opens.
    await confirmDelete("Ava");

    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/animas/$animaId",
      params: { animaId: "cy" },
      search: { tab: "overview" },
      replace: true,
    });
  });

  it("stops the Anima's streaming replies before deleting it", async () => {
    const stop = vi.fn();
    const otherStop = vi.fn();
    registerStreamingReply({ animaId: "ava", chatId: "c1", stop });
    registerStreamingReply({ animaId: "bo", chatId: "c3", stop: otherStop });
    await render();

    await confirmDelete("Ava");

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.remove.mock.invocationCallOrder[0]!,
    );
    expect(otherStop).not.toHaveBeenCalled();
  });

  it("keeps the dialog open while the reply is still stopping", async () => {
    fixture.remove.mockResolvedValue({
      error: { detail: { code: "chat_turn_stopping" } },
      response: new Response(null, { status: 409 }),
    });
    await render();

    await confirmDelete("Ava");

    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "The reply is still stopping. Try again in a moment.",
    );
    expect(fixture.toast.success).not.toHaveBeenCalled();
  });
});
