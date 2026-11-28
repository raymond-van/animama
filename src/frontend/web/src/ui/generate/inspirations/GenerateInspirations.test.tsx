// @vitest-environment happy-dom
import { act } from "react";
import type { WebGLRenderer } from "three";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { RuntimeCapabilities } from "@animama/runtime-contracts";
import type { PyGenerationConversationSnapshot } from "@animama/runtime-contracts/api-types";

import { privateStateResets } from "@/app/runtime/private-module-state";
import type { IncludedAvatarReviewSheetsRequest } from "@/lib/avatar/motion-authoring/reviewSheet";
import { useGenerationConversation } from "@/query/hooks/useGeneration";
import {
  beginGenerationRun,
  endGenerationRun,
} from "@/stores/generation-store";
import { GenerateConversation } from "../GenerateConversation";
import { registerPreviewSheetRenderer } from "../previewSheetRenderer";
import { GenerateConversationWithReferences } from "../references/GenerateConversationWithReferences";
import {
  controlledSseResponse,
  generationSnapshot,
  jsonResponse,
  sha256FileInline,
  waveHelloClip,
} from "../testing/generationFixtures";
import {
  click,
  generationCapabilities,
  renderInRuntime,
  settle,
  type MountedNode,
} from "../testing/generationHarness";
import { enterPseudoLocale, unmarkedText } from "../testing/pseudoLocale";
import { useGenerationRun } from "../useGenerationRun";
import { INCLUDED_INSPIRATION_KEYS } from "./includedInspirations";

/**
 * The Inspirations dialog of the Generate page's composer, over a fake
 * backend: the Library's Gestures and their clip files, the person's stored
 * images, the upload routes, and the assistant's run route. Stills are drawn
 * by a stand-in for the sheet drawing, on a stand-in renderer.
 */

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn() },
}));

const sheets = vi.hoisted(() => ({
  /** The clips drawn, by name, in order. */
  requests: [] as { name: unknown; times: readonly number[]; view: unknown }[],
  /** Holds every drawing until released. */
  hold: null as Promise<void> | null,
  /** The names of clips whose drawing fails. */
  failing: new Set<string>(),
  /** The Avatars whose files were read. */
  avatarReads: [] as string[],
}));
// Stands in for the real sheet drawing: one sheet per Included Avatar, six
// rows of four views, as a Gesture's sheet is laid out.
vi.mock("@/lib/avatar/motion-authoring/reviewSheet", () => ({
  MAX_REVIEW_SHEET_ROWS: 6,
  DEFAULT_REVIEW_SHEET_TILE: { width: 220, height: 330 },
  reviewSheetColumns: () => [{}, {}, {}, {}],
  renderIncludedAvatarReviewSheets: async (
    request: IncludedAvatarReviewSheetsRequest,
  ) => {
    const clip = request.clip as { name: string };
    sheets.requests.push({
      name: clip.name,
      times: request.times,
      view: request.view,
    });
    await sheets.hold;
    if (sheets.failing.has(clip.name)) throw new Error("The clip cannot play.");
    const drawn = [];
    for (const avatar of ["Andrew", "Annie"] as const) {
      await request.avatarFile(avatar);
      drawn.push({
        avatar,
        blob: new Blob([`${avatar}:${clip.name}`], { type: "image/jpeg" }),
        width: 64 + 4 * 220,
        height: 28 + request.times.length * 330,
      });
    }
    return drawn;
  },
}));
// The Included Avatars' files are read without a catalog here.
vi.mock("../includedAvatarFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../includedAvatarFiles")>()),
  createIncludedAvatarFiles: () => async (avatar: string) => {
    sheets.avatarReads.push(avatar);
    return new ArrayBuffer(4);
  },
}));

const CONVERSATION = "conversation-1";

/** A clip file as the catalog lists it, with the bytes the content route serves. */
type ClipFile = { ref: string; sha256: string; bytes: Uint8Array<ArrayBuffer> };
const clipFiles = new Map<string, ClipFile>();

async function clipFile(id: string, name: string): Promise<ClipFile> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...waveHelloClip(), id, name }),
  );
  const file = {
    ref: `ref-${id}`,
    sha256: await sha256FileInline(new Blob([bytes])),
    bytes,
  };
  clipFiles.set(file.ref, file);
  return file;
}

/** A Gesture as the Library's list returns it. */
function libraryGesture(
  itemId: string,
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    item_id: itemId,
    kind: "gesture",
    source: "local",
    logical_key: `local:gesture:${itemId}`,
    name,
    description: null,
    semantic_key: itemId,
    implementation: { kind: "anima_clip" },
    config: {},
    dependencies: [],
    files: [],
    revision_sha256: "0".repeat(64),
    editable: true,
    portability: "portable",
    ...overrides,
  };
}

/** One of the listed Included Gestures, with its clip file. */
async function includedGesture(
  index: number,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  const key = INCLUDED_INSPIRATION_KEYS[index]!;
  const id = key.split(":").at(-1)!;
  const file = await clipFile(id, name);
  return libraryGesture(`included-${id}`, name, {
    source: "included",
    logical_key: key,
    editable: false,
    revision_sha256: file.sha256,
    files: [
      {
        file_ref: file.ref,
        filename: `${id}.json`,
        logical_path: `${id}.json`,
        media_type: "application/json",
        ordinal: 0,
        role: "sequence",
        sha256: file.sha256,
        size_bytes: file.bytes.byteLength,
        url: `/v1/content/files/${file.ref}`,
      },
    ],
    ...overrides,
  });
}

/** A stored image as the uploads list returns it once it is ready. */
function imageRow(fileId: string, name: string, status = "ready") {
  return {
    file_id: fileId,
    original_filename: name,
    normalized_extension: ".png",
    declared_size_bytes: 4,
    stored_size_bytes: 4,
    status,
    chunk_count: 0,
    metadata: { kind: "image", image: { width: 640, height: 480 } },
  };
}

let LIBRARY: Record<string, unknown>[] = [];

const server = {
  snapshot: generationSnapshot() as PyGenerationConversationSnapshot,
  gestures: [] as Record<string, unknown>[],
  runs: [] as Record<string, unknown>[],
  streams: [] as ReturnType<typeof controlledSseResponse>[],
  /** The uploads started, by file name, in order. */
  uploads: [] as string[],
  /** The stored files the uploads list returns. */
  files: [] as Record<string, unknown>[],
  /** Answers the uploads list with a failure. */
  filesFail: false,
  /** The clip files read through the content route, by file ref. */
  clipReads: [] as string[],
};

async function fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/v1/gestures")
    return jsonResponse({ items: server.gestures });
  if (request.method === "POST" && pathname.endsWith("/runs:sse")) {
    server.runs.push((await request.json()) as Record<string, unknown>);
    const stream = controlledSseResponse();
    server.streams.push(stream);
    return stream.response;
  }
  if (request.method === "GET" && pathname.endsWith(`/${CONVERSATION}`))
    return jsonResponse(server.snapshot);
  if (request.method === "POST" && pathname === "/v1/files/uploads") {
    const { filename } = (await request.json()) as { filename: string };
    server.uploads.push(filename);
    const fileId = `file-${server.uploads.length}`;
    return jsonResponse({
      file_id: fileId,
      upload_url: `/v1/files/uploads/${fileId}`,
      method: "PUT",
      headers: {},
      expires_at: "2026-11-27T10:00:00Z",
    });
  }
  const finalized = /^\/v1\/files\/([^/]+):finalize$/.exec(pathname);
  if (request.method === "POST" && finalized) {
    const fileId = finalized[1]!;
    const number = Number(fileId.replace("file-", ""));
    const row = imageRow(fileId, server.uploads[number - 1]!);
    server.files.push(row);
    return jsonResponse(row);
  }
  if (request.method === "GET" && pathname === "/v1/files")
    return server.filesFail
      ? jsonResponse({ detail: "unavailable" }, 500)
      : jsonResponse({ files: server.files });
  throw new Error(`Unexpected request: ${request.method} ${pathname}`);
}

/** The browser's own `fetch`: Included clip files, uploads and stored images. */
async function browserFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const { pathname } = new URL(String(input), "http://runtime.fixture.test");
  const content =
    /^\/v1\/content\/files\/([^/]+)\/sha256\/([0-9a-f]{64})$/.exec(pathname);
  if (content) {
    const file = clipFiles.get(decodeURIComponent(content[1]!));
    if (!file || file.sha256 !== content[2])
      return new Response(null, { status: 404 });
    server.clipReads.push(file.ref);
    return new Response(file.bytes, {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (init?.method === "PUT" && pathname.startsWith("/v1/files/uploads/"))
    return new Response(null, { status: 200 });
  if (/^\/v1\/files\/[^/]+\/content$/.test(pathname))
    return new Response(new Blob(["image"], { type: "image/png" }));
  throw new Error(`Unexpected browser request: ${pathname}`);
}

const UPLOADS: RuntimeCapabilities = {
  ...generationCapabilities,
  chat_file_uploads: true,
};

/** The model a run names; without one no run starts. */
let modelProviderId: string | null = "model-1";
/** The assistant's chosen model row, as far as references read it. */
let model: { accepts: string[] } = { accepts: ["text", "image"] };

function Page() {
  const controller = useGenerationRun({
    conversationId: CONVERSATION,
    modelProviderId,
  });
  const snapshot = useGenerationConversation(CONVERSATION).data;
  return (
    <GenerateConversationWithReferences
      conversationId={CONVERSATION}
      model={model}
      snapshot={snapshot}
      controller={controller}
      selectedDraft={null}
      onStartNewDraft={() => {}}
      newDraftKind={{ value: "gesture", onChange: () => {} }}
    />
  );
}

let mounted: MountedNode | null = null;
async function open(
  capabilities: RuntimeCapabilities = generationCapabilities,
) {
  mounted = renderInRuntime(<Page />, { fetch, capabilities });
  document.body.append(mounted.container);
  await settle();
}

const find = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const findAll = (testId: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];
/** The name a card or an image choice shows. */
const NAME = '[data-testid="generate-inspiration-name"]';
const opener = () => find("generate-inspirations-open") as HTMLButtonElement;
const dialog = () => find("generate-inspirations");
const cards = () => findAll("generate-inspiration-gesture");
const cardNames = () =>
  cards().map((card) => card.querySelector(NAME)!.textContent);
const card = (name: string) =>
  cards().find(
    (candidate) => candidate.querySelector(NAME)!.textContent === name,
  )!;
const imageChoices = () => findAll("generate-inspiration-image");
const imageChoice = (name: string) =>
  imageChoices().find(
    (candidate) => candidate.querySelector(NAME)!.textContent === name,
  )!;
const exampleChips = () =>
  [
    ...(find("generate-reference-examples-list")?.querySelectorAll("li") ?? []),
  ].map((chip) => chip.querySelector("span")!.textContent);
/** The tray's cards, each named with its file and status. */
const trayCards = () =>
  [...mounted!.container.querySelectorAll<HTMLElement>("[aria-label]")]
    .map((element) => element.getAttribute("aria-label")!)
    .filter((label) => /\.(png|jpg) /.test(label));

async function openDialog() {
  await click(opener());
  await settle();
  expect(dialog()).not.toBeNull();
}

function press(key: string) {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
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

/** Wait until the page shows what a request leads to. */
async function until(reached: () => boolean) {
  for (let turn = 0; turn < 40 && !reached(); turn += 1) await settle(2);
  expect(reached()).toBe(true);
}

function fakeRenderer() {
  const state = { lost: false };
  return {
    renderer: {
      getContext: () => ({ isContextLost: () => state.lost }),
    } as unknown as WebGLRenderer,
    loseContext: () => {
      state.lost = true;
    },
  };
}

let withdrawRenderer: (() => void) | null = null;
function registerRenderer() {
  const fake = fakeRenderer();
  withdrawRenderer?.();
  act(() => {
    withdrawRenderer = registerPreviewSheetRenderer(fake.renderer);
  });
  return fake;
}
const stillStates = () => cards().map((entry) => entry.dataset.still);

beforeAll(async () => {
  LIBRARY = [
    libraryGesture("bow", "Deep Bow"),
    libraryGesture("nod", "Nod"),
    await includedGesture(0, "Wave Hello"),
    await includedGesture(1, "Small Wave"),
    await includedGesture(2, "Hearty Laugh"),
    await includedGesture(3, "Polite Bow"),
    // Listed, but for use in this app only: never offered.
    await includedGesture(4, "Licensed Thinking", {
      portability: "non-portable",
    }),
    // An Included Gesture that is not on the list.
    libraryGesture("included-spin", "Spin", {
      source: "included",
      logical_key: "builtin:gesture:spin",
    }),
    // The rest of the list is missing from this Library.
  ];
});

beforeEach(() => {
  server.snapshot = generationSnapshot();
  server.gestures = LIBRARY;
  server.runs = [];
  server.streams = [];
  server.uploads = [];
  server.files = [];
  server.filesFail = false;
  server.clipReads = [];
  modelProviderId = "model-1";
  model = { accepts: ["text", "image"] };
  sheets.requests = [];
  sheets.hold = null;
  sheets.failing = new Set();
  sheets.avatarReads = [];
  toastError.mockClear();
  vi.stubGlobal("fetch", browserFetch);
});
afterEach(() => {
  vi.useRealTimers();
  withdrawRenderer?.();
  withdrawRenderer = null;
  mounted?.unmount();
  mounted?.container.remove();
  mounted = null;
  endGenerationRun(CONVERSATION);
  for (const reset of privateStateResets()) reset();
  vi.unstubAllGlobals();
});

describe("the Inspirations dialog", () => {
  it("opens from the references row and closes with Escape, giving focus back", async () => {
    await open();
    const button = opener();
    expect(button.textContent).toBe("Inspirations");
    expect(find("generate-references")!.contains(button)).toBe(true);
    expect(dialog()).toBeNull();

    button.focus();
    await openDialog();
    const shown = dialog()!;
    expect(shown.getAttribute("role")).toBe("dialog");
    expect(
      document.getElementById(shown.getAttribute("aria-labelledby")!)!
        .textContent,
    ).toBe("Inspirations");
    expect(
      document.getElementById(shown.getAttribute("aria-describedby")!)!
        .textContent,
    ).toBe(
      "Ideas for your next request. Nothing here is sent until you send it.",
    );
    // The keyboard is inside the dialog.
    expect(shown.contains(document.activeElement)).toBe(true);
    expect(
      [...shown.querySelectorAll("h3")].map((heading) => heading.textContent),
    ).toEqual(["Prompt starters", "From Animama's Included content"]);

    press("Escape");
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button);
    // Nothing was chosen.
    expect((find("generate-request") as HTMLTextAreaElement).value).toBe("");
    expect(exampleChips()).toEqual([]);
  });

  it("closes with its Close button too", async () => {
    await open();
    await openDialog();
    await click(
      [...dialog()!.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Close",
      ),
    );
    await settle();
    expect(dialog()).toBeNull();
  });

  it("is held while the assistant works", async () => {
    await open();
    type("a wave");
    await click(find("generate-send"));
    await settle();
    expect(opener().disabled).toBe(true);
  });

  it("puts a chosen starter in the request field, closes, and focuses the field", async () => {
    // The conversation has a turn: the dialog is where the starters still are.
    server.snapshot = generationSnapshot({
      messages: [
        {
          id: "message-1",
          role: "user",
          text: "a wave",
          data: {},
          created_at: "2026-11-26T10:00:00Z",
        },
      ],
    });
    await open();
    expect(find("generate-starters")).toBeNull();
    await openDialog();
    const starters = [
      ...dialog()!.querySelectorAll<HTMLElement>(
        '[data-testid="generate-starter"]',
      ),
    ];
    expect(starters).toHaveLength(6);

    await click(starters[1]);
    await settle();
    expect(dialog()).toBeNull();
    const field = find("generate-request") as HTMLTextAreaElement;
    expect(field.value).toBe(
      "Thinking with a hand on the chin, held while the Anima thinks",
    );
    expect(document.activeElement).toBe(field);
    expect(server.runs).toEqual([]);
  });
});

describe("Included Gestures as inspirations", () => {
  it("shows the listed Gestures the Library has, and never a non-portable or missing one", async () => {
    await open();
    await openDialog();
    expect(cardNames()).toEqual([
      "Wave Hello",
      "Small Wave",
      "Hearty Laugh",
      "Polite Bow",
    ]);
    const list = find("generate-inspirations-included")!;
    expect(list.textContent).not.toContain("Licensed Thinking");
    expect(list.textContent).not.toContain("Spin");
    expect(list.textContent).not.toContain("Deep Bow");
  });

  it("says when the Library has none of them, and when it cannot be read", async () => {
    server.gestures = [libraryGesture("bow", "Deep Bow")];
    await open();
    await openDialog();
    expect(cards()).toEqual([]);
    expect(find("generate-inspirations-included")!.textContent).toContain(
      "None of these Gestures are in your Library.",
    );
    press("Escape");
    await settle();
    mounted!.unmount();
    mounted!.container.remove();

    server.gestures = null as unknown as typeof LIBRARY;
    await open();
    await openDialog();
    expect(find("generate-inspirations-included")!.textContent).toContain(
      "Gestures could not be loaded.",
    );
  });

  it("adds a chosen Gesture as an example of the feel, and says so", async () => {
    await open();
    await openDialog();
    expect(find("generate-inspiration-added")!.textContent).toBe("");

    await click(card("Hearty Laugh"));
    // The dialog stays open for another choice.
    expect(dialog()).not.toBeNull();
    const added = find("generate-inspiration-added")!;
    expect(added.getAttribute("role")).toBe("status");
    expect(added.textContent).toBe(
      "Added Hearty Laugh as an example of the feel.",
    );
    expect(card("Hearty Laugh").getAttribute("aria-disabled")).toBe("true");
    expect(card("Hearty Laugh").textContent).toContain("Already chosen");
    // Choosing it again adds nothing.
    await click(card("Hearty Laugh"));

    press("Escape");
    await settle();
    expect(exampleChips()).toEqual(["Hearty Laugh"]);

    type("laugh like this, but shy");
    await click(find("generate-send"));
    await settle();
    expect(server.runs[0]!.references).toEqual({
      examples: ["included-hearty-laugh"],
    });
  });

  it("refuses a fourth example with the limit's words", async () => {
    await open();
    await openDialog();
    for (const name of ["Wave Hello", "Small Wave", "Hearty Laugh"])
      await click(card(name));

    const fourth = card("Polite Bow");
    expect(fourth.getAttribute("aria-disabled")).toBe("true");
    const note = document.getElementById(
      fourth.getAttribute("aria-describedby")!,
    )!;
    expect(note.textContent).toBe(
      "A request takes up to 3 examples. Remove one to add another.",
    );
    await click(fourth);
    expect(find("generate-inspiration-added")!.textContent).toBe(
      "Added Hearty Laugh as an example of the feel.",
    );

    press("Escape");
    await settle();
    expect(exampleChips()).toEqual([
      "Wave Hello",
      "Small Wave",
      "Hearty Laugh",
    ]);
  });

  it("counts the examples chosen in the row's own picker", async () => {
    await open();
    await click(
      [...document.querySelectorAll("button")].find(
        (candidate) =>
          candidate.getAttribute("aria-label") ===
          "Add an example of the feel from your Library",
      ),
    );
    await settle(1);
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.textContent?.includes("Wave Hello"),
      ),
    );
    await settle(1);
    await openDialog();
    expect(card("Wave Hello").getAttribute("aria-disabled")).toBe("true");
    expect(card("Wave Hello").textContent).toContain("Already chosen");
    expect(card("Small Wave").getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("an inspiration's still", () => {
  it("shows the names only while no preview canvas can draw", async () => {
    await open();
    await openDialog();
    await settle();
    expect(stillStates()).toEqual(["none", "none", "none", "none"]);
    expect(cards().every((entry) => !entry.querySelector("img"))).toBe(true);
    expect(sheets.requests).toEqual([]);
    expect(server.clipReads).toEqual([]);
    // A card without a still is chosen as any other.
    await click(card("Wave Hello"));
    expect(find("generate-inspiration-added")!.textContent).toBe(
      "Added Wave Hello as an example of the feel.",
    );
  });

  it("draws each card's still on the preview's renderer, one at a time, from its own clip", async () => {
    let release!: () => void;
    sheets.hold = new Promise<void>((resolve) => (release = resolve));
    registerRenderer();
    await open();
    // Nothing is read or drawn until the dialog opens.
    expect(sheets.requests).toEqual([]);
    expect(server.clipReads).toEqual([]);

    await openDialog();
    await until(() => sheets.requests.length === 1);
    await settle();
    // The first card's sheet is being drawn; no other has started. Each
    // card keeps its still's place meanwhile.
    expect(sheets.requests).toHaveLength(1);
    expect(stillStates()).toEqual(["pending", "pending", "pending", "pending"]);
    expect(cards().every((entry) => !entry.querySelector("img"))).toBe(true);
    expect(server.clipReads).toEqual(["ref-wave-hello"]);

    sheets.hold = null;
    await act(async () => release());
    await until(() => stillStates().every((state) => state === "ready"));
    expect(sheets.requests.map(({ name }) => name)).toEqual([
      "Wave Hello",
      "Small Wave",
      "Hearty Laugh",
      "Polite Bow",
    ]);
    // A Gesture's sheet: its beats, whole body.
    expect(sheets.requests[0]).toMatchObject({
      times: [0, 0.5, 0.9, 2, 2.5],
      view: "body",
    });
    // The Included Avatars' files are read once for the whole dialog.
    expect(sheets.avatarReads).toEqual(["Andrew", "Annie"]);

    const image = card("Wave Hello").querySelector("img")!;
    expect(image.getAttribute("alt")).toBe("");
    expect(image.getAttribute("src")).toMatch(/^blob:/);
    // The card rests on the beat in the middle of the clip.
    expect(card("Wave Hello").dataset.frame).toBe("2");
    // Nothing drawn here is uploaded or sent anywhere.
    expect(server.uploads).toEqual([]);
    expect(server.runs).toEqual([]);
  });

  it("keeps the stills for the session", async () => {
    registerRenderer();
    await open();
    await openDialog();
    await until(() => stillStates().every((state) => state === "ready"));
    const drawn = sheets.requests.length;
    const source = card("Wave Hello").querySelector("img")!.src;

    press("Escape");
    await settle();
    await openDialog();
    await settle();
    expect(stillStates()).toEqual(["ready", "ready", "ready", "ready"]);
    expect(card("Wave Hello").querySelector("img")!.src).toBe(source);
    expect(sheets.requests).toHaveLength(drawn);
  });

  it("shows the name only for a clip that cannot be drawn, and goes on with the next", async () => {
    sheets.failing.add("Small Wave");
    registerRenderer();
    await open();
    await openDialog();
    await until(() => sheets.requests.length === 4);
    await settle();
    expect(stillStates()).toEqual(["ready", "none", "ready", "ready"]);
    expect(card("Small Wave").querySelector("img")).toBeNull();
    // It is not drawn again.
    await settle();
    expect(sheets.requests).toHaveLength(4);
  });

  it("stops at a lost WebGL context, and draws again on a new canvas", async () => {
    const first = registerRenderer();
    first.loseContext();
    await open();
    await openDialog();
    await settle();
    expect(sheets.requests).toEqual([]);
    expect(stillStates()).toEqual(["none", "none", "none", "none"]);

    registerRenderer();
    await until(() => stillStates().every((state) => state === "ready"));
  });

  it("starts no drawing while the assistant works", async () => {
    await open();
    await openDialog();
    // A run starts behind the open dialog, and then a canvas can draw.
    act(() => {
      beginGenerationRun(CONVERSATION, {
        message: "a wave",
        draftId: null,
        answers: null,
      });
    });
    registerRenderer();
    await settle();
    expect(sheets.requests).toEqual([]);
    expect(server.clipReads).toEqual([]);

    act(() => endGenerationRun(CONVERSATION));
    await until(() => stillStates().every((state) => state === "ready"));
  });

  it("steps through the beat poses on hover and on keyboard focus", async () => {
    registerRenderer();
    await open();
    await openDialog();
    await until(() => stillStates().every((state) => state === "ready"));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const wave = card("Wave Hello");
    const frame = () => wave.dataset.frame;
    const transform = () => wave.querySelector("img")!.style.transform;
    const rest = transform();
    expect(frame()).toBe("2");

    act(() => {
      wave.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    // The loop starts at the clip's first beat.
    expect(frame()).toBe("0");
    expect(transform()).not.toBe(rest);
    act(() => vi.advanceTimersByTime(500));
    expect(frame()).toBe("1");
    act(() => vi.advanceTimersByTime(500 * 4));
    // Five beats, then round again.
    expect(frame()).toBe("0");

    act(() => {
      wave.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(frame()).toBe("2");
    expect(transform()).toBe(rest);
    act(() => vi.advanceTimersByTime(2000));
    expect(frame()).toBe("2");

    act(() => wave.focus());
    expect(frame()).toBe("0");
    act(() => vi.advanceTimersByTime(500));
    expect(frame()).toBe("1");
    act(() => wave.blur());
    expect(frame()).toBe("2");
  });

  it("does not animate under reduced motion", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    registerRenderer();
    await open();
    await openDialog();
    await until(() => stillStates().every((state) => state === "ready"));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const wave = card("Wave Hello");
    act(() => {
      wave.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(3000));
    expect(wave.dataset.frame).toBe("2");
  });
});

describe("the person's own images as inspirations", () => {
  const image = (name: string) =>
    new File([new Uint8Array(4)], name, { type: "image/png" });

  /** Choose files in the attach control's file picker. */
  async function attach(...files: File[]) {
    const input = find("generate-reference-images-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  const ready = (count: number) => () =>
    trayCards().filter((label) => label.endsWith(" Ready")).length === count;

  beforeEach(() => {
    server.files = [
      imageRow("stored-1", "pose.png"),
      imageRow("stored-2", "outfit.png"),
      // Not ready yet, and no image: neither is offered.
      imageRow("stored-3", "uploading.png", "uploading"),
      {
        ...imageRow("stored-4", "notes.pdf"),
        normalized_extension: ".pdf",
        metadata: {},
      },
    ];
  });

  it("is not offered where the runtime offers no uploads", async () => {
    await open();
    await openDialog();
    expect(find("generate-inspirations-images")).toBeNull();
    expect(dialog()!.textContent).not.toContain("Your images");
  });

  it("lists the ready images with their names", async () => {
    await open(UPLOADS);
    await openDialog();
    const section = find("generate-inspirations-images")!;
    expect(section.querySelector("h3")!.textContent).toBe("Your images");
    expect(
      imageChoices().map((choice) => choice.querySelector(NAME)!.textContent),
    ).toEqual(["pose.png", "outfit.png"]);
    expect(imageChoice("pose.png").getAttribute("aria-pressed")).toBe("false");
  });

  it("says when the person has no images, and when they cannot be read", async () => {
    server.files = [];
    await open(UPLOADS);
    await openDialog();
    expect(find("generate-inspirations-images")!.textContent).toContain(
      "You have no images yet. Images you add to a request or a chat appear here.",
    );
    press("Escape");
    await settle();
    mounted!.unmount();
    mounted!.container.remove();

    server.filesFail = true;
    await open(UPLOADS);
    await openDialog();
    await until(() =>
      find("generate-inspirations-images")!.textContent!.includes(
        "Your images could not be loaded.",
      ),
    );
  });

  it("offers none of the person's images on a model without image input, and says why", async () => {
    model = { accepts: ["text"] };
    await open(UPLOADS);
    await openDialog();
    const section = find("generate-inspirations-images")!;
    expect(section.textContent).toContain(
      "This model can't see images. Choose a model that accepts images to attach them.",
    );
    expect(
      section.querySelectorAll('[data-testid="generate-inspiration-image"]'),
    ).toHaveLength(0);
    // The Included Gestures are still offered.
    expect(
      find("generate-inspirations-included")!.querySelectorAll(
        '[data-testid="generate-inspiration-gesture"]',
      ).length,
    ).toBeGreaterThan(0);
  });

  it("attaches a chosen image by its file id, without an upload", async () => {
    await open(UPLOADS);
    await openDialog();
    await click(imageChoice("pose.png"));
    expect(imageChoice("pose.png").getAttribute("aria-pressed")).toBe("true");
    expect(imageChoice("pose.png").textContent).toContain("Attached");
    press("Escape");
    await settle();

    // In the tray as chat shows a file chosen from the Library, with Remove.
    expect(trayCards()).toEqual(["pose.png Ready"]);
    expect(server.uploads).toEqual([]);

    type("a pose like this");
    await click(find("generate-send"));
    await settle();
    expect(server.runs[0]!.references).toEqual({
      images: [{ file_id: "stored-1", kind: "image" }],
    });
    expect(server.uploads).toEqual([]);
    // The image goes with its message: the tray is empty again.
    expect(trayCards()).toEqual([]);
    // The turn in flight shows it.
    expect(
      find("generate-turn-references")!
        .querySelector("button")!
        .getAttribute("aria-label"),
    ).toBe("Open pose.png");
  });

  it("takes an attached image off again, in the dialog and in the tray", async () => {
    await open(UPLOADS);
    await openDialog();
    await click(imageChoice("pose.png"));
    await click(imageChoice("outfit.png"));
    await click(imageChoice("pose.png"));
    expect(imageChoice("pose.png").getAttribute("aria-pressed")).toBe("false");
    press("Escape");
    await settle();
    expect(trayCards()).toEqual(["outfit.png Ready"]);

    await click(
      [...mounted!.container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Remove from composer",
      ),
    );
    expect(trayCards()).toEqual([]);
    type("a pose");
    await click(find("generate-send"));
    await settle();
    expect(server.runs[0]).not.toHaveProperty("references");
  });

  it("counts chosen images with uploads against the four a request carries", async () => {
    server.files = ["a", "b", "c"].map((name) =>
      imageRow(`stored-${name}`, `${name}.png`),
    );
    await open(UPLOADS);
    await attach(image("one.png"), image("two.png"));
    await until(ready(2));
    await openDialog();
    // An image uploaded for this message is in the list as attached already.
    expect(imageChoice("one.png").getAttribute("aria-disabled")).toBe("true");
    expect(imageChoice("one.png").getAttribute("aria-pressed")).toBe("true");

    await click(imageChoice("a.png"));
    await click(imageChoice("b.png"));
    expect(toastError).not.toHaveBeenCalled();
    // The fifth is refused with chat's words.
    await click(imageChoice("c.png"));
    expect(toastError).toHaveBeenCalledWith("Image not added", {
      description: "A message can carry up to 4 images.",
    });
    expect(imageChoice("c.png").getAttribute("aria-pressed")).toBe("false");
    press("Escape");
    await settle();

    // An upload is refused too while four are attached.
    toastError.mockClear();
    await attach(image("three.png"));
    await settle();
    expect(toastError).toHaveBeenCalledWith("Image not added", {
      description: "A message can carry up to 4 images.",
    });
    expect(server.uploads).toEqual(["one.png", "two.png"]);

    type("like these");
    await click(find("generate-send"));
    await settle();
    expect(server.runs[0]!.references).toEqual({
      images: [
        { file_id: "file-1", kind: "image" },
        { file_id: "file-2", kind: "image" },
        { file_id: "stored-a", kind: "image" },
        { file_id: "stored-b", kind: "image" },
      ],
    });
  });

  it("puts a chosen image back when the request could not be sent", async () => {
    // Without a model no run starts.
    modelProviderId = null;
    await open(UPLOADS);
    await openDialog();
    await click(imageChoice("pose.png"));
    press("Escape");
    await settle();
    type("a pose like this");
    await click(find("generate-send"));
    await settle();
    expect(server.runs).toEqual([]);
    expect((find("generate-request") as HTMLTextAreaElement).value).toBe(
      "a pose like this",
    );
    expect(trayCards()).toEqual(["pose.png Ready"]);
  });
});

describe("the dialog's wording", () => {
  it("comes from the catalog", async () => {
    server.files = [imageRow("stored-1", "pose.png")];
    registerRenderer();
    await open(UPLOADS);
    await openDialog();
    await until(() => stillStates().every((state) => state === "ready"));
    for (const name of ["Wave Hello", "Small Wave", "Hearty Laugh"])
      await click(card(name));
    await click(imageChoice("pose.png"));
    const leave = await enterPseudoLocale();
    try {
      expect(
        unmarkedText(dialog()!, [
          "Wave Hello",
          "Small Wave",
          "Hearty Laugh",
          "Polite Bow",
          "pose.png",
          // The product's name stays as it is.
          "Animama",
          "Anima",
        ]),
      ).toEqual([]);
    } finally {
      await leave();
    }
  });
});

describe("a creator's Generate panel", () => {
  it("offers no inspirations", async () => {
    function Panel() {
      const controller = useGenerationRun({
        conversationId: CONVERSATION,
        modelProviderId: "model-1",
      });
      const snapshot = useGenerationConversation(CONVERSATION).data;
      return (
        <GenerateConversation
          snapshot={snapshot}
          controller={controller}
          selectedDraft={null}
          onStartNewDraft={() => {}}
          composerNote={null}
        />
      );
    }
    mounted = renderInRuntime(<Panel />, { fetch });
    document.body.append(mounted.container);
    await settle();
    expect(find("generate-request")).not.toBeNull();
    expect(find("generate-inspirations-open")).toBeNull();
    expect(find("generate-starters")).toBeNull();
    expect(find("generate-style")).toBeNull();
  });
});
