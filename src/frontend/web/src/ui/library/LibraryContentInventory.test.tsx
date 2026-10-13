import type { ReactNode } from "react";
import { renderToString } from "@/test/runtime-markup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostedExclusionReasons } from "@/app/runtime/route-admission";
import { normalizeContentLibrarySearch } from "@/lib/content/librarySearch";
import { LibraryContentInventory } from "./LibraryContentInventory";
const mocks = vi.hoisted(() => ({
  poseInput: vi.fn(),
  gestureInput: vi.fn(),
  layoutActions: {} as Record<string, () => void>,
  otherRows: [] as Array<Record<string, unknown>>,
  avatars: [] as Array<Record<string, unknown>>,
  capabilities: undefined as Record<string, unknown> | undefined,
  open: vi.fn(),
  preview: null as (() => void) | null,
}));
const items = [
  {
    item_id: "starter",
    pose_id: "builtin:pose:salute",
    name: "Salute",
    source: "included",
    editable: false,
    revision_sha256: "r1",
  },
  {
    item_id: "mine",
    pose_id: "local:pose:wave",
    name: "My Wave",
    source: "local",
    editable: true,
    revision_sha256: "r2",
  },
];
vi.mock("@/query/hooks/useIdleStyles", () => ({
  useIdleStyles: () => ({
    data: {
      pages: [
        { items: mocks.otherRows.filter((row) => row.family === "idle-style") },
      ],
    },
  }),
}));
vi.mock("@/query/hooks/usePoses", () => ({
  usePoses: (input: unknown) => {
    mocks.poseInput(input);
    return { data: { items }, isPending: false, error: null, refetch: vi.fn() };
  },
}));
vi.mock("@/query/hooks/useActions", () => ({
  useGestures: (input: unknown) => {
    mocks.gestureInput(input);
    return {
      data: {
        pages: [
          { items: mocks.otherRows.filter((row) => row.family === "gesture") },
        ],
      },
    };
  },
  useReactions: () => ({
    data: {
      pages: [
        { items: mocks.otherRows.filter((row) => row.family === "reaction") },
      ],
    },
  }),
}));
vi.mock("@/query/hooks/useEffects", () => ({
  useEffects: () =>
    Object.fromEntries(
      Object.entries({
        particles: "particle",
        sounds: "sound",
        avatars: "avatar-effect",
        scenes: "scene",
      }).map(([key, family]) => [
        key,
        {
          data: {
            pages: [
              { items: mocks.otherRows.filter((row) => row.family === family) },
            ],
          },
        },
      ]),
    ),
}));
vi.mock("@/query/hooks/useAvatarCatalog", () => ({
  useAvatarCatalog: () =>
    mocks.avatars.length
      ? {
          data: { pages: [{ items: mocks.avatars }] },
          isPending: false,
          error: null,
        }
      : {},
}));
vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({ data: mocks.capabilities }),
}));
vi.mock("@/ui/content-preview/ContentPreviewDockProvider", () => ({
  useContentPreviewDock: () => ({ openPreview: mocks.open }),
}));
vi.mock("@/ui/content-preview/useContentPreviewAudio", () => ({
  useContentPreviewAudio: () => ({}),
}));
vi.mock("@/ui/action-manage/ActionManageDialog", () => ({
  ActionManageDialog: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/ui/components/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));
vi.mock("@/ui/components/button", () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: {
    children: ReactNode;
    onClick?: () => void;
    "aria-label"?: string;
  }) => {
    if (onClick && props["aria-label"]?.endsWith(" view"))
      mocks.layoutActions[props["aria-label"]] = onClick;
    if (onClick && Array.isArray(children) && children.includes(" Preview"))
      mocks.preview ??= onClick;
    return <button {...props}>{children}</button>;
  },
}));
beforeEach(() => {
  vi.unstubAllGlobals();
  mocks.layoutActions = {};
  mocks.otherRows = [];
  mocks.avatars = [];
  mocks.capabilities = undefined;
  mocks.poseInput.mockClear();
  mocks.gestureInput.mockClear();
  mocks.open.mockClear();
  mocks.preview = null;
});
describe("Library Poses", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "list" } });
  });
  it("shows only the selected All subtype and disables unrelated family queries", () => {
    const html = renderToString(
      <LibraryContentInventory
        search={normalizeContentLibrarySearch({ type: "poses" })}
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain('id="library-poses-heading"');
    expect(html).not.toContain('id="library-gestures-heading"');
    expect(html).not.toContain('id="library-avatars-heading"');
    expect(mocks.poseInput).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(mocks.gestureInput).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("applies the Gesture motion filter under All", () => {
    renderToString(
      <LibraryContentInventory
        search={normalizeContentLibrarySearch({
          type: "gestures",
          gestureMotion: "vrma",
        })}
        onSearchChange={() => {}}
      />,
    );
    expect(mocks.gestureInput).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, implementationKind: "vrma" }),
    );
    expect(mocks.poseInput).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("renders Included and Local editing with no equipment or creation action", () => {
    const html = renderToString(
      <LibraryContentInventory
        search={normalizeContentLibrarySearch({
          section: "actions",
          action: "poses",
          query: "wave",
          showStarters: false,
        })}
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain('id="library-poses-heading"');
    expect(html).toContain('aria-label="Salute"');
    expect(html).not.toContain("Starter");
    expect(html).toContain("Local");
    expect(html).toContain('href="/poses/starter/edit"');
    expect(html).not.toContain("Customize");
    expect(html).toContain('href="/poses/mine/edit"');
    expect(html).toContain("Edit");
    expect(html).not.toMatch(
      /New Pose|Add \/ Manage|Use in Reaction|Use in Gesture/,
    );
    expect(mocks.poseInput).toHaveBeenCalledWith({
      query: "wave",
      origin: "owned",
      enabled: true,
    });
    expect(mocks.preview).not.toBeNull();
    mocks.preview!();
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: "pose_content", item: items[0] }),
    );
  });
  it.each([
    ["gesture", "gestures"],
    ["idle-style", "idle-styles"],
    ["reaction", "reactions"],
    ["particle", "particle-effects"],
    ["avatar-effect", "avatar-effects"],
    ["scene", "scene-effects"],
  ])(
    "places Included and Local %s Edit immediately after Preview",
    (family, path) => {
      mocks.otherRows = ["builtin", "owned"].map((origin) => ({
        family,
        origin,
        item_id: `${family}-${origin}`,
        name: `${family} ${origin}`,
        description: "",
        source: { type: "catalog", catalog_item_id: `${family}-${origin}` },
      }));
      const html = renderToString(
        <LibraryContentInventory
          search={normalizeContentLibrarySearch({})}
          onSearchChange={() => {}}
        />,
      );
      for (const origin of ["builtin", "owned"]) {
        const row = html
          .split(`aria-label="${family} ${origin}"`)[1]!
          .split("</article>")[0]!;
        expect(row).toContain(`href="/${path}/${family}-${origin}/edit"`);
        expect(row.indexOf("Preview")).toBeLessThan(row.indexOf("> Edit"));
        if (family === "gesture" || family === "reaction")
          expect(row.indexOf("> Edit")).toBeLessThan(
            row.indexOf("Add / Manage"),
          );
        expect(row).not.toContain("Customize");
        if (family === "idle-style") {
          expect(row).not.toMatch(
            /Use in Gesture|Use in Reaction|Add \/ Manage/,
          );
        }
      }
    },
  );
  it("opens sound management in the Library without a standalone editor link", () => {
    mocks.otherRows = [
      {
        family: "sound",
        origin: "owned",
        item_id: "sound-1",
        name: "Bell",
        description: "",
        source: { type: "catalog", catalog_item_id: "sound-1" },
      },
    ];
    const html = renderToString(
      <LibraryContentInventory
        search={normalizeContentLibrarySearch({ section: "fx", fx: "sound" })}
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Manage sound"');
    expect(html).not.toContain("/sound-effects/");
    expect(html).toContain('aria-label="Play"');
  });
  it("requests Poses in the combined All inventory", () => {
    renderToString(
      <LibraryContentInventory
        search={normalizeContentLibrarySearch({})}
        onSearchChange={() => {}}
      />,
    );
    expect(mocks.poseInput).toHaveBeenCalledWith({
      query: undefined,
      origin: "all",
      enabled: true,
    });
  });
});

describe("Library layout", () => {
  const renderInventory = () =>
    renderToString(
      <LibraryContentInventory
        search={normalizeContentLibrarySearch({
          section: "actions",
          action: "poses",
        })}
        onSearchChange={() => {}}
      />,
    );

  it("defaults to grid and remembers an explicitly selected list", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    vi.stubGlobal("window", { localStorage: storage });
    const grid = renderInventory();
    expect(grid.indexOf('aria-label="Grid view"')).toBeLessThan(
      grid.indexOf('aria-label="List view"'),
    );
    expect(grid).toContain('aria-label="Grid view" aria-pressed="true"');
    const row = grid.split('aria-label="Salute"')[1]!.split("</article>")[0]!;
    expect(row).toContain('aria-label="Preview"');
    expect(row).toContain('aria-label="Edit"');
    expect(row).toContain('href="/poses/starter/edit"');
    expect(row).not.toContain(" Preview<");
    expect(row).not.toContain(" Edit<");
    mocks.layoutActions["List view"]!();
    expect(renderInventory()).toContain(
      'aria-label="List view" aria-pressed="true"',
    );
  });

  it("keeps the Library usable when preference storage is unavailable", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("Storage unavailable");
      },
    });
    expect(renderInventory()).toContain(
      'aria-label="Grid view" aria-pressed="true"',
    );
    expect(() => mocks.layoutActions["List view"]!()).not.toThrow();
    expect(warning).toHaveBeenCalled();
  });
});

describe("Library avatar Create Anima action", () => {
  const avatar = {
    avatar_id: "avatar-1",
    catalog_item_id: "catalog-avatar-1",
    name: "Aiko",
    description: "",
    origin: "included",
    preview_url: null,
  };
  const renderAvatarRow = () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "list" } });
    mocks.avatars = [avatar];
    const html = renderToString(
      <LibraryContentInventory
        search={normalizeContentLibrarySearch({ section: "avatars" })}
        onSearchChange={() => {}}
      />,
    );
    return html.split('aria-label="Aiko"')[1]!.split("</article>")[0]!;
  };

  it("opens the creator with the avatar while creation is offered", () => {
    mocks.capabilities = { anima_creation: true };
    const row = renderAvatarRow();
    expect(row).toContain('href="/animas/new"');
    expect(row).not.toContain("aria-disabled");
  });

  it("stays visible but disabled with the shared reason when creation is withheld", () => {
    mocks.capabilities = { anima_creation: false };
    const row = renderAvatarRow();
    expect(row).not.toContain("/animas/new");
    const action = row.match(
      /<button[^>]*aria-label="Create Anima"[^>]*>/,
    )?.[0];
    expect(action).toContain('aria-disabled="true"');
    const reasonId = action?.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(row).toContain(
      `id="${reasonId}" class="sr-only">${hostedExclusionReasons.anima_creation}<`,
    );
  });

  it("offers no create action before capabilities are known", () => {
    const row = renderAvatarRow();
    expect(row).not.toContain("Create Anima");
  });
});
