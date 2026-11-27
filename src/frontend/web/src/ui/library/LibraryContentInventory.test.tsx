import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
// The shared delete confirmation has its own tests.
vi.mock("@/ui/content-delete/ContentDeleteDialog", () => ({
  ContentDeleteDialog: () => null,
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

describe("Library avatar settings action", () => {
  const avatars = [
    {
      avatar_id: "avatar-1",
      catalog_item_id: "catalog-avatar-1",
      name: "Aiko",
      description: "",
      origin: "included",
      preview_url: null,
    },
    {
      avatar_id: "avatar-2",
      catalog_item_id: "catalog-avatar-2",
      name: "Mika",
      description: "",
      origin: "local",
      preview_url: null,
    },
    {
      avatar_id: "avatar-3",
      catalog_item_id: null,
      name: "Draft",
      description: "",
      origin: "local",
      preview_url: null,
    },
  ];
  const renderRows = (layout: "grid" | "list") => {
    vi.stubGlobal("window", { localStorage: { getItem: () => layout } });
    mocks.avatars = avatars;
    const html = renderToString(
      <LibraryContentInventory
        search={normalizeContentLibrarySearch({ section: "avatars" })}
        onSearchChange={() => {}}
      />,
    );
    const row = (name: string) =>
      html.split(`aria-label="${name}"`)[1]!.split("</article>")[0]!;
    return { aiko: row("Aiko"), mika: row("Mika"), draft: row("Draft") };
  };

  it.each(["grid", "list"] as const)(
    "offers Avatar settings on Included and Local cards in the %s layout",
    (layout) => {
      const rows = renderRows(layout);
      for (const row of [rows.aiko, rows.mika])
        expect(row).toContain('aria-label="Avatar settings"');
      // A card without a catalog item has nothing to keep settings for.
      expect(rows.draft).not.toContain('aria-label="Avatar settings"');
      if (layout === "list") expect(rows.aiko).toContain(" Settings");
    },
  );
});

describe("Library Delete", () => {
  const families = [
    "gesture",
    "reaction",
    "particle",
    "avatar-effect",
    "scene",
    "sound",
  ];
  it.each(["grid", "list"] as const)(
    "offers Delete on every Local kind with a revision and on no Included item in the %s layout",
    (layout) => {
      vi.stubGlobal("window", { localStorage: { getItem: () => layout } });
      mocks.otherRows = families.flatMap((family) =>
        ["builtin", "owned"].map((origin) => ({
          family,
          origin,
          item_id: `${family}-${origin}`,
          name: `${family} ${origin}`,
          description: "",
          source: { type: "catalog", catalog_item_id: `${family}-${origin}` },
          revision_sha256: "revision",
        })),
      );
      mocks.avatars = [
        {
          avatar_id: "avatar-1",
          catalog_item_id: "catalog-avatar-1",
          name: "Aiko",
          description: "",
          origin: "included",
          preview_url: null,
        },
        {
          avatar_id: "avatar-2",
          catalog_item_id: "catalog-avatar-2",
          name: "Mika",
          description: "",
          origin: "local",
          preview_url: null,
        },
      ];
      const html = renderToString(
        <LibraryContentInventory
          search={normalizeContentLibrarySearch({})}
          onSearchChange={() => {}}
        />,
      );
      const more = (name: string) => `aria-label="More actions for ${name}"`;
      for (const family of families) {
        expect(html).toContain(more(`${family} owned`));
        expect(html).not.toContain(more(`${family} builtin`));
      }
      // The Pose fixtures: Included "Salute" and Local "My Wave".
      expect(html).toContain(more("My Wave"));
      expect(html).not.toContain(more("Salute"));
      expect(html).toContain(more("Mika"));
      expect(html).not.toContain(more("Aiko"));
    },
  );

  it("offers no Delete for a Local item without a revision", () => {
    mocks.otherRows = [
      {
        family: "gesture",
        origin: "owned",
        item_id: "unreadable",
        name: "Unreadable",
        description: "",
        source: { type: "catalog", catalog_item_id: "unreadable" },
        revision_sha256: null,
      },
    ];
    const html = renderToString(
      <LibraryContentInventory
        search={normalizeContentLibrarySearch({ type: "gestures" })}
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Unreadable"');
    expect(html).not.toContain("More actions for Unreadable");
  });
});

describe("Library tile previews", () => {
  const renderRows = () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "grid" } });
    mocks.otherRows = [
      {
        family: "particle",
        origin: "builtin",
        item_id: "sparks",
        name: "Sparks",
        description: "",
        source: { type: "catalog", catalog_item_id: "sparks" },
        thumbnail_url: "/v1/content/files/sparks-texture?variant=thumbnail",
        particle_thumbnail: {
          manifestUrl: "/v1/content/files/sparks-manifest",
          texturePath: "sparks.png",
          revision: "r1",
        },
      },
      {
        family: "scene",
        origin: "builtin",
        item_id: "sky",
        name: "Sky",
        description: "",
        source: { type: "catalog", catalog_item_id: "sky" },
        thumbnail_url: "/v1/content/files/sky-image?variant=thumbnail",
      },
    ];
    mocks.avatars = [
      {
        avatar_id: "avatar-1",
        catalog_item_id: "catalog-avatar-1",
        name: "Aiko",
        description: "",
        origin: "included",
        preview_url: "/v1/content/files/aiko-portrait",
      },
    ];
    const html = renderToString(
      <QueryClientProvider client={new QueryClient()}>
        <LibraryContentInventory
          search={normalizeContentLibrarySearch({})}
          onSearchChange={() => {}}
        />
      </QueryClientProvider>,
    );
    const row = (name: string) =>
      html.split(`aria-label="${name}"`)[1]!.split("</article>")[0]!;
    return { sparks: row("Sparks"), sky: row("Sky"), aiko: row("Aiko") };
  };

  it.each([
    ["unknown", undefined],
    ["absent", {}],
    ["on", { library_previews: true }],
  ])("loads tile previews while the capability is %s", (_, capabilities) => {
    mocks.capabilities = capabilities;
    const rows = renderRows();
    expect(rows.sparks).toContain(
      'src="/v1/content/files/sparks-texture?variant=thumbnail"',
    );
    expect(rows.sky).toContain(
      'src="/v1/content/files/sky-image?variant=thumbnail"',
    );
  });

  it("shows family icons and asks for no preview when the runtime offers none", () => {
    mocks.capabilities = { library_previews: false };
    const rows = renderRows();
    for (const [row, icon] of [
      [rows.sparks, "lucide-sparkles"],
      [rows.sky, "lucide-layers"],
    ] as const) {
      expect(row).toContain(icon);
      expect(row).not.toContain("<img");
      expect(row).not.toContain("/v1/content/files/");
    }
    // An Avatar portrait is the item's own image, not a Library preview.
    expect(rows.aiko).toContain('src="/v1/content/files/aiko-portrait"');
  });
});
