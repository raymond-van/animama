// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "@/query/keys";
import { withRuntime } from "@/test/runtime-markup";
import { AnimaPageActions } from "./AnimaPageActions";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn<(options: unknown) => Promise<void>>(),
  animas: [] as unknown[],
  patch: vi.fn(),
  remove: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ animaId: "ava" }),
  useLocation: (options?: { select?: (location: unknown) => unknown }) => {
    const location = { pathname: "/animas/ava" };
    return options?.select ? options.select(location) : location;
  },
  useNavigate: () => fixture.navigate,
}));
vi.mock("@/ui/settings/SettingsProvider", () => ({
  useSettings: () => ({ userSettings: { last_active_anima_id: "ava" } }),
}));
vi.mock("@/query/hooks/useAnimas", () => ({
  useAnimas: () => ({ data: fixture.animas, isLoading: false }),
}));
vi.mock("@/query/hooks/useChats", () => ({
  useChats: () => ({
    data: [],
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
vi.mock("@/ui/components/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div role="menu">{children}</div>
  ),
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
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AVA = {
  id: "ava",
  display_name: "Ava",
  updated_at: "2026-11-02T00:00:00",
  created_at: "2026-11-02T00:00:00",
  pinned_at: null,
  presentation: { profile_thumbnail: null },
};
const BO = {
  ...AVA,
  id: "bo",
  display_name: "Bo",
  updated_at: "2026-11-01T00:00:00",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fixture.animas = [AVA, BO];
  fixture.navigate.mockReset();
  fixture.navigate.mockResolvedValue(undefined);
  fixture.remove.mockReset();
  fixture.remove.mockResolvedValue({
    data: undefined,
    response: new Response(null, { status: 204 }),
  });
  fixture.toast.success.mockReset();
  client.setQueryData(queryKeys.animas.list("owner"), fixture.animas);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  client.clear();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        {withRuntime(
          <AnimaPageActions animaId="ava" name="Ava" pinned={false} />,
        )}
      </QueryClientProvider>,
    );
  });
}

const item = (label: string) =>
  [...container!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent === label,
  )!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe("the Anima page's actions", () => {
  it("offer Pin and Delete from a named More menu", async () => {
    await render();

    expect(
      container!.querySelector('[aria-label="More actions for Ava"]'),
    ).not.toBeNull();
    expect(
      [...container!.querySelectorAll('[role="menuitem"]')].map(
        (candidate) => candidate.textContent,
      ),
    ).toEqual(["Pin", "Delete"]);
  });

  it("delete the Anima after the shared confirmation and open the next Anima's page", async () => {
    await render();

    act(() => item("Delete").click());
    expect(dialog()?.textContent).toContain("Delete Ava?");
    expect(dialog()?.textContent).toContain("Ava has 0 chats.");

    const confirm = [
      ...dialog()!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Delete")!;
    await act(async () => confirm.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fixture.remove).toHaveBeenCalledWith(
      expect.objectContaining({ path: { anima_id: "ava" } }),
    );
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/animas/$animaId",
      params: { animaId: "bo" },
      search: { tab: "overview" },
      replace: true,
    });
    expect(fixture.toast.success).toHaveBeenCalledWith("Ava deleted.");
    // Focus lands on the (next) page's More button.
    expect(document.activeElement).toBe(
      container!.querySelector('[aria-label="More actions for Ava"]'),
    );
  });

  it("return focus to the More button when the delete is cancelled", async () => {
    await render();

    act(() => item("Delete").click());
    const cancel = [
      ...dialog()!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Cancel")!;
    act(() => cancel.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(
      container!.querySelector('[aria-label="More actions for Ava"]'),
    );
  });
});
