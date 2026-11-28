// @vitest-environment happy-dom
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCapabilities } from "@animama/runtime-contracts";
import type {
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";

import { privateStateResets } from "@/app/runtime/private-module-state";
import { useGenerationConversation } from "@/query/hooks/useGeneration";
import {
  controlledSseResponse,
  generationDraft,
  generationSnapshot,
  jsonResponse,
  sseFrame,
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
import { GenerateConversationWithReferences } from "./GenerateConversationWithReferences";

/**
 * The Generate page's conversation with references in its composer, over a
 * fake backend: the Library's Gestures, the upload routes chat's images use,
 * and the assistant's run route.
 */

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn() },
}));

/** The video switch, and the video the stand-in decoder reports. */
const video = vi.hoisted(() => ({
  enabled: false,
  duration: 4,
  opened: [] as string[],
  drawn: 0,
}));
vi.mock("./videoReferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./videoReferences")>()),
  get GENERATE_VIDEO_REFERENCES_ENABLED() {
    return video.enabled;
  },
}));
// No video is decoded here: the decoder and the canvas are stand-ins.
vi.mock("./videoFrameSource", () => ({
  openVideoFrameSource: async (file: File) => {
    video.opened.push(file.name);
    return {
      duration: video.duration,
      width: 400,
      height: 300,
      frameAt: async (time: number) => `frame@${time}`,
      close: () => {},
    };
  },
  createStripCanvas: () => ({
    draw: () => {
      video.drawn += 1;
    },
    toJpeg: async () => new Blob([new Uint8Array(8)], { type: "image/jpeg" }),
  }),
}));

const CONVERSATION = "conversation-1";

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

const LIBRARY = [
  libraryGesture("bow", "Deep Bow"),
  libraryGesture("nod", "Nod"),
  libraryGesture("shrug", "Shrug"),
  libraryGesture("spin", "Spin"),
  libraryGesture("wave", "Wave Hello", { source: "included" }),
  libraryGesture("licensed", "Licensed Dance", {
    source: "included",
    portability: "non-portable",
  }),
  libraryGesture("imported", "Imported Walk", {
    implementation: { kind: "vrma" },
  }),
];

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

const server = {
  snapshot: generationSnapshot() as PyGenerationConversationSnapshot,
  gestures: LIBRARY,
  runs: [] as Record<string, unknown>[],
  streams: [] as ReturnType<typeof controlledSseResponse>[],
  /** The uploads started, by file name, in order. */
  uploads: [] as string[],
  /** The stored images the uploads list returns. */
  files: [] as ReturnType<typeof imageRow>[],
  /** Holds every upload's bytes until released. */
  holdUploads: null as Promise<void> | null,
  /** The status the next upload's bytes are answered with. */
  uploadStatus: 200,
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
    return jsonResponse({ files: server.files });
  throw new Error(`Unexpected request: ${request.method} ${pathname}`);
}

/** The browser's own `fetch`: an upload's bytes, and a stored image's. */
async function browserFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const { pathname } = new URL(String(input), "http://runtime.fixture.test");
  if (init?.method === "PUT" && pathname.startsWith("/v1/files/uploads/")) {
    const status = server.uploadStatus;
    await server.holdUploads;
    return new Response(null, { status });
  }
  if (/^\/v1\/files\/[^/]+\/content$/.test(pathname))
    return new Response(new Blob(["image"], { type: "image/png" }));
  throw new Error(`Unexpected browser request: ${pathname}`);
}

const UPLOADS: RuntimeCapabilities = {
  ...generationCapabilities,
  chat_file_uploads: true,
};

/** The assistant's chosen model row, as far as references read it. */
let model: { accepts: string[] } = { accepts: ["text", "image"] };
/** The model a run names; without one no run starts. */
let modelProviderId: string | null = "model-1";

function Page({ draft }: { draft: PyGenerationDraft | null }) {
  const [kind, setKind] = useState<"gesture" | "reaction">("gesture");
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
      selectedDraft={draft}
      onStartNewDraft={() => {}}
      newDraftKind={{ value: kind, onChange: setKind }}
    />
  );
}

let mounted: MountedNode | null = null;
async function open(
  draft: PyGenerationDraft | null = null,
  capabilities: RuntimeCapabilities = generationCapabilities,
) {
  mounted = renderInRuntime(<Page draft={draft} />, { fetch, capabilities });
  document.body.append(mounted.container);
  await settle();
  return mounted.container;
}

const find = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name,
  ) ?? null;
/** The choices of the picker that is open. */
const options = () => [
  ...document.querySelectorAll<HTMLElement>('[role="option"]'),
];
const optionNames = () =>
  options().map((option) => option.querySelector("span span")!.textContent);
const option = (name: string) =>
  options().find(
    (candidate) => candidate.querySelector("span span")!.textContent === name,
  ) ?? null;

const START = "Start from a Gesture in your Library";
const EXAMPLE = "Add an example of the feel from your Library";

/** Open or close a picker by its button, and let its list settle. */
async function toggle(picker: string) {
  await click(button(picker));
  await settle(1);
}

/** Open a picker and choose one of its Gestures. */
async function choose(picker: string, name: string) {
  await toggle(picker);
  await click(option(name));
  await settle(1);
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

const chips = (testId: string) =>
  [...(find(testId)?.querySelectorAll("li") ?? [])].map(
    (chip) => chip.querySelector("span")!.textContent,
  );

beforeEach(() => {
  server.snapshot = generationSnapshot();
  server.gestures = LIBRARY;
  server.runs = [];
  server.streams = [];
  server.uploads = [];
  server.files = [];
  server.holdUploads = null;
  server.uploadStatus = 200;
  model = { accepts: ["text", "image"] };
  modelProviderId = "model-1";
  video.enabled = false;
  video.duration = 4;
  video.opened = [];
  video.drawn = 0;
  toastError.mockClear();
  vi.stubGlobal("fetch", browserFetch);
});
afterEach(() => {
  mounted?.unmount();
  mounted?.container.remove();
  mounted = null;
  for (const reset of privateStateResets()) reset();
  vi.unstubAllGlobals();
});

describe("references in the Generate page's composer", () => {
  it("offers ready, portable clip Gestures, and never a non-portable one", async () => {
    await open();
    expect(find("generate-references")).not.toBeNull();

    await toggle(START);
    expect(optionNames()).toEqual([
      "Deep Bow",
      "Nod",
      "Shrug",
      "Spin",
      "Wave Hello",
    ]);
    // The Generate page holds the preview canvas, so a choice has no Preview.
    expect(options()[0]!.querySelector("button")).toBeNull();
    await toggle(START);

    await toggle(EXAMPLE);
    expect(optionNames()).not.toContain("Licensed Dance");
    expect(optionNames()).not.toContain("Imported Walk");
    expect(optionNames()).toHaveLength(5);
  });

  it("sends exactly the starting point and the examples chosen, then clears them", async () => {
    await open();
    await choose(START, "Wave Hello");
    await choose(EXAMPLE, "Deep Bow");
    await choose(EXAMPLE, "Nod");
    expect(chips("generate-reference-start-list")).toEqual(["Wave Hello"]);
    expect(chips("generate-reference-examples-list")).toEqual([
      "Deep Bow",
      "Nod",
    ]);

    type("a wave like this, but shy");
    await click(find("generate-send"));
    await settle();
    expect(server.runs).toHaveLength(1);
    expect(server.runs[0]).toMatchObject({
      message: "a wave like this, but shy",
      intent: "gesture",
      references: { starting_point: "wave", examples: ["bow", "nod"] },
    });
    expect(server.runs[0]!.references).toEqual({
      starting_point: "wave",
      examples: ["bow", "nod"],
    });
    expect(server.runs[0]).not.toHaveProperty("draft_id");

    // The composer starts the next message without them.
    expect(find("generate-reference-start-list")).toBeNull();
    expect(find("generate-reference-examples-list")).toBeNull();
    // The turn in flight says what it carries.
    const carried = find("generate-turn-references")!;
    expect(carried.textContent).toContain("Starts from Wave Hello");
    expect(carried.textContent).toContain("Examples of the feel: Deep Bow");
    expect(carried.textContent).toContain("Nod");

    server.streams[0]!.send(sseFrame("run.completed", {}));
    await settle();
    type("another");
    await click(find("generate-send"));
    await settle();
    expect(server.runs[1]).not.toHaveProperty("references");
  });

  it("replaces the starting point, and removes a chip on request", async () => {
    await open();
    await choose(START, "Wave Hello");
    await choose(START, "Deep Bow");
    expect(chips("generate-reference-start-list")).toEqual(["Deep Bow"]);
    await choose(EXAMPLE, "Nod");
    await choose(EXAMPLE, "Spin");

    await click(button("Remove Nod from the examples"));
    expect(chips("generate-reference-examples-list")).toEqual(["Spin"]);
    await click(button("Remove Deep Bow as the starting point"));
    expect(find("generate-reference-start-list")).toBeNull();

    type("a spin");
    await click(find("generate-send"));
    await settle();
    expect(server.runs[0]!.references).toEqual({ examples: ["spin"] });
  });

  it("takes no fourth example, and shows a chosen Gesture as taken", async () => {
    await open();
    for (const name of ["Deep Bow", "Nod"]) await choose(EXAMPLE, name);
    await toggle(EXAMPLE);
    expect(option("Deep Bow")!.getAttribute("aria-disabled")).toBe("true");
    expect(option("Deep Bow")!.textContent).toContain("Already chosen");
    expect(option("Shrug")!.getAttribute("aria-disabled")).not.toBe("true");
    // A Gesture already chosen cannot be chosen twice.
    await click(option("Deep Bow"));
    expect(chips("generate-reference-examples-list")).toEqual([
      "Deep Bow",
      "Nod",
    ]);
    await click(option("Shrug"));
    await settle(1);

    const add = button(EXAMPLE)!;
    expect(add.disabled).toBe(true);
    const note = document.getElementById(add.getAttribute("aria-describedby")!);
    expect(note!.textContent).toBe(
      "A request takes up to 3 examples. Remove one to add another.",
    );
    expect(chips("generate-reference-examples-list")).toHaveLength(3);

    await click(button("Remove Nod from the examples"));
    expect(button(EXAMPLE)!.disabled).toBe(false);
    expect(button(EXAMPLE)!.hasAttribute("aria-describedby")).toBe(false);
  });

  it("offers no starting point for a Reaction, and drops the one chosen", async () => {
    await open();
    await choose(START, "Wave Hello");
    await choose(EXAMPLE, "Nod");

    await click(find("generate-kind-reaction"));
    expect(button(START)).toBeNull();
    expect(find("generate-reference-start-list")).toBeNull();
    // Examples go with a Reaction too.
    expect(chips("generate-reference-examples-list")).toEqual(["Nod"]);

    // Back at a Gesture, the starting point is not put back.
    await click(find("generate-kind-gesture"));
    expect(button(START)).not.toBeNull();
    expect(find("generate-reference-start-list")).toBeNull();

    await click(find("generate-kind-reaction"));
    type("a nod of approval");
    await click(find("generate-send"));
    await settle();
    expect(server.runs[0]).toMatchObject({
      intent: "reaction",
      references: { examples: ["nod"] },
    });
    expect(server.runs[0]!.references).not.toHaveProperty("starting_point");
  });

  it("offers no starting point for a revision, and drops the one chosen", async () => {
    const draft = generationDraft({ status: "ready", checked_version: 1 });
    server.snapshot = generationSnapshot({ drafts: [draft] });
    await open();
    await choose(START, "Wave Hello");

    // The person selects a draft: the next message revises it.
    mounted!.rerender(<Page draft={draft} />);
    expect(button(START)).toBeNull();
    expect(find("generate-reference-start-list")).toBeNull();
    expect(button(EXAMPLE)).not.toBeNull();

    await choose(EXAMPLE, "Deep Bow");
    type("more like this");
    await click(find("generate-send"));
    await settle();
    expect(server.runs[0]).toMatchObject({
      draft_id: draft.id,
      references: { examples: ["bow"] },
    });
    expect(server.runs[0]!.references).not.toHaveProperty("starting_point");
  });

  it("holds the references while the assistant works", async () => {
    await open();
    type("a wave");
    await click(find("generate-send"));
    await settle();
    expect(button(START)!.disabled).toBe(true);
    expect(button(EXAMPLE)!.disabled).toBe(true);
  });

  it("says when the Library's Gestures cannot be read", async () => {
    server.gestures = null as unknown as typeof LIBRARY;
    await open();
    await toggle(EXAMPLE);
    expect(document.body.textContent).toContain(
      "Gestures could not be loaded.",
    );
  });

  it("offers prompt starters in an empty conversation, which fill the request field", async () => {
    await open();
    const starters = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="generate-starter"]',
      ),
    ];
    expect(starters).toHaveLength(6);
    await click(starters[5]);
    const field = find("generate-request") as HTMLTextAreaElement;
    expect(field.value).toBe("Three greetings: a wave, a bow and a salute");
    expect(document.activeElement).toBe(field);
    // Nothing is sent until the person sends it.
    expect(server.runs).toEqual([]);

    await click(find("generate-send"));
    await settle();
    expect(server.runs[0]).toMatchObject({
      message: "Three greetings: a wave, a bow and a salute",
      intent: "gesture",
    });
    // The conversation has a turn now: the starters are gone.
    expect(find("generate-starters")).toBeNull();
  });

  it("words the references from the catalog", async () => {
    await open();
    await choose(START, "Wave Hello");
    await choose(EXAMPLE, "Deep Bow");
    await choose(EXAMPLE, "Nod");
    await choose(EXAMPLE, "Shrug");
    const leave = await enterPseudoLocale();
    try {
      expect(
        unmarkedText(find("generate-references")!, [
          "Wave Hello",
          "Deep Bow",
          "Nod",
          "Shrug",
        ]),
      ).toEqual([]);
    } finally {
      await leave();
    }
  });
});

const image = (name: string, size = 4) =>
  new File([new Uint8Array(size)], name, { type: "image/png" });

/** Choose files in the attach control's file picker. */
async function attach(...files: File[]) {
  const input = find("generate-reference-images-input") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Wait until the page shows what an upload leads to. */
async function until(reached: () => boolean) {
  for (let turn = 0; turn < 40 && !reached(); turn += 1) await settle(2);
  expect(reached()).toBe(true);
}

/** The tray's cards, each named with its file and status. */
const cards = () =>
  [...document.querySelectorAll<HTMLElement>("[aria-label]")]
    .map((element) => element.getAttribute("aria-label")!)
    .filter((label) => /\.(png|jpg) /.test(label));
const ready = (count: number) => () =>
  cards().filter((label) => label.endsWith(" Ready")).length === count;
const send = () => find("generate-send") as HTMLButtonElement;

describe("reference images in the Generate page's composer", () => {
  it("offers no attach control where the runtime offers no uploads", async () => {
    await open();
    expect(find("generate-references")).not.toBeNull();
    expect(find("generate-reference-attach")).toBeNull();
    expect(find("generate-reference-images-input")).toBeNull();
  });

  it("uploads an attached image and names it in the request by its file id", async () => {
    await open(null, UPLOADS);
    const add = find("generate-reference-attach") as HTMLButtonElement;
    expect(add.textContent).toBe("Add images");
    // Chat's image formats, and several at once.
    const input = find("generate-reference-images-input") as HTMLInputElement;
    expect(input.accept).toBe(".png,.jpg,.jpeg,.webp,.gif");
    expect(input.multiple).toBe(true);

    await attach(image("pose.png"));
    await until(ready(1));
    expect(server.uploads).toEqual(["pose.png"]);

    type("a pose like this");
    await click(send());
    await settle();
    expect(server.runs[0]!.references).toEqual({
      images: [{ file_id: "file-1", kind: "image" }],
    });
    // The image goes with its message: the tray is empty again.
    expect(cards()).toEqual([]);
    // The turn in flight shows it, as a chat message shows its images.
    const sent = find("generate-turn-references")!;
    expect(sent.querySelector("ul")!.getAttribute("aria-label")).toBe(
      "Images sent with this message",
    );
    expect(sent.querySelector("button")!.getAttribute("aria-label")).toBe(
      "Open pose.png",
    );
  });

  it("refuses a fifth image, and a file that is no image, with chat's messages", async () => {
    await open(null, UPLOADS);
    await attach(
      ...["a.png", "b.png", "c.png", "d.png", "e.png"].map((name) =>
        image(name),
      ),
    );
    await until(ready(4));
    expect(server.uploads).toEqual(["a.png", "b.png", "c.png", "d.png"]);
    expect(toastError).toHaveBeenCalledWith("Image not added", {
      description: "A message can carry up to 4 images.",
    });

    await click(
      [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Remove from composer",
      ),
    );
    toastError.mockClear();
    await attach(
      new File(["notes"], "notes.txt", { type: "text/plain" }),
      image("photo.heic"),
    );
    await settle();
    expect(server.uploads).toHaveLength(4);
    expect(toastError.mock.calls.map(([, detail]) => detail)).toEqual([
      {
        description:
          "notes.txt is in a format Animama can't read. Convert it to JPEG or PNG and try again.",
      },
      {
        description:
          "photo.heic is in a format Animama can't read. Convert it to JPEG or PNG and try again.",
      },
    ]);
  });

  it("holds Send while an image uploads", async () => {
    let release!: () => void;
    server.holdUploads = new Promise<void>((resolve) => (release = resolve));
    await open(null, UPLOADS);
    await attach(image("pose.png"));
    await until(() => server.uploads.length === 1);
    type("a pose like this");

    expect(send().getAttribute("aria-disabled")).toBe("true");
    expect(send().getAttribute("aria-label")).toBe(
      "Waiting for files to be ready",
    );
    await click(send());
    await settle();
    expect(server.runs).toEqual([]);
    expect((find("generate-request") as HTMLTextAreaElement).value).toBe(
      "a pose like this",
    );

    release();
    await until(ready(1));
    expect(send().getAttribute("aria-disabled")).not.toBe("true");
    expect(send().getAttribute("aria-label")).toBe("Send request");
    await click(send());
    await settle();
    expect(server.runs[0]!.references).toEqual({
      images: [{ file_id: "file-1", kind: "image" }],
    });
  });

  it("blocks Send while an image failed to upload, until it is removed", async () => {
    server.uploadStatus = 500;
    await open(null, UPLOADS);
    await attach(image("pose.png"));
    await until(() => cards().some((label) => label.endsWith(" Failed")));
    type("a pose like this");
    expect(send().getAttribute("aria-label")).toBe(
      "Remove unreadable files to send",
    );
    await click(send());
    await settle();
    expect(server.runs).toEqual([]);

    await click(
      [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Remove from composer",
      ),
    );
    await click(send());
    await settle();
    expect(server.runs).toHaveLength(1);
    expect(server.runs[0]).not.toHaveProperty("references");
  });

  it("puts everything back when the request could not be sent", async () => {
    // Without a model no run starts.
    modelProviderId = null;
    await open(null, UPLOADS);
    await choose(START, "Wave Hello");
    await choose(EXAMPLE, "Nod");
    await attach(image("pose.png"));
    await until(ready(1));

    type("a pose like this");
    await click(send());
    await until(ready(1));
    expect(server.runs).toEqual([]);
    expect((find("generate-request") as HTMLTextAreaElement).value).toBe(
      "a pose like this",
    );
    expect(chips("generate-reference-start-list")).toEqual(["Wave Hello"]);
    expect(chips("generate-reference-examples-list")).toEqual(["Nod"]);
    // The image is attached again by the id its upload got: it is stored
    // already, and is not uploaded a second time.
    expect(cards()).toHaveLength(1);
    expect(server.uploads).toEqual(["pose.png"]);
  });

  it("says a model without image input keeps the images unused, and still sends them", async () => {
    model = { accepts: ["text"] };
    await open(null, UPLOADS);
    const note =
      "This model cannot look at images. They are kept with this conversation, but the assistant does not use them.";
    // Said only while an image is attached.
    expect(document.body.textContent).not.toContain(note);
    await attach(image("pose.png"));
    await until(ready(1));
    expect(toastError).not.toHaveBeenCalled();
    expect(find("generate-references")!.textContent).toContain(note);

    type("a pose like this");
    await click(send());
    await settle();
    expect(server.runs[0]!.references).toEqual({
      images: [{ file_id: "file-1", kind: "image" }],
    });
    expect(find("generate-references")!.textContent).not.toContain(note);
  });

  it("says nothing of the kind on a model that takes images", async () => {
    await open(null, UPLOADS);
    await attach(image("pose.png"));
    await until(ready(1));
    expect(find("generate-references")!.textContent).not.toContain(
      "cannot look at images",
    );
  });

  it("attaches an image pasted into the request field, and pastes text as text", async () => {
    await open(null, UPLOADS);
    const paste = (files: File[], text = "") => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { files, getData: () => text },
      });
      act(() => {
        find("generate-request")!.dispatchEvent(event);
      });
      return event;
    };
    expect(paste([image("pasted.png")]).defaultPrevented).toBe(true);
    await until(ready(1));
    expect(server.uploads).toEqual(["pasted.png"]);

    // A clipboard that carries text pastes its text.
    expect(paste([image("cells.png")], "A1\tB1").defaultPrevented).toBe(false);
    await settle();
    expect(server.uploads).toEqual(["pasted.png"]);
  });

  it("shows a stored turn's images, and says when the model took none", async () => {
    server.snapshot = generationSnapshot({
      messages: [
        {
          id: "message-1",
          role: "user",
          text: "a pose like this",
          created_at: "2026-11-26T10:00:00Z",
          data: {
            images: [
              {
                file_id: "file-9",
                name: "pose.png",
                width: 640,
                height: 480,
                kind: "image",
              },
            ],
            images_sent: false,
          },
        },
        {
          id: "message-2",
          role: "assistant",
          text: "Here is the pose.",
          created_at: "2026-11-26T10:00:01Z",
          data: { outcome: "draft", draft_id: "draft-1" },
        },
      ],
    });
    await open(null, UPLOADS);
    const carried = find("generate-turn-references")!;
    expect(carried.querySelector("button")!.getAttribute("aria-label")).toBe(
      "Open pose.png",
    );
    expect(carried.textContent).toContain(
      "These images were not sent to the model.",
    );
  });
});

describe("a video as a reference, behind its switch", () => {
  const clip = (name = "shy wave.mp4") =>
    new File(["video"], name, { type: "video/mp4" });

  async function attachVideo(file: File) {
    const input = find("generate-reference-video-input") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("is not offered while the switch is off", async () => {
    await open(null, UPLOADS);
    expect(find("generate-reference-attach")).not.toBeNull();
    expect(find("generate-reference-video")).toBeNull();
    expect(find("generate-reference-video-input")).toBeNull();
    expect(document.body.textContent).not.toContain("Add video");
  });

  it("is not offered without uploads, even with the switch on", async () => {
    video.enabled = true;
    await open();
    expect(find("generate-reference-video")).toBeNull();
    expect(find("generate-reference-video-input")).toBeNull();
  });

  it("uploads one strip of a video's frames and names it as video frames", async () => {
    video.enabled = true;
    await open(null, UPLOADS);
    expect(find("generate-reference-video")!.textContent).toBe("Add video");
    const input = find("generate-reference-video-input") as HTMLInputElement;
    expect(input.accept).toBe("video/*");
    expect(input.multiple).toBe(false);

    await attachVideo(clip());
    await until(ready(1));
    // The video itself is read here and never uploaded: only its strip is.
    expect(video.opened).toEqual(["shy wave.mp4"]);
    expect(video.drawn).toBe(8);
    expect(server.uploads).toEqual(["shy wave-frames.jpg"]);
    expect(toastError).not.toHaveBeenCalled();

    // An image beside it stays an image.
    await attach(image("pose.png"));
    await until(ready(2));
    type("move like this");
    await click(send());
    await settle();
    expect(server.runs[0]!.references).toEqual({
      images: [
        { file_id: "file-1", kind: "video_frames" },
        { file_id: "file-2", kind: "image" },
      ],
    });
  });

  it("sends an image put back after an unsent request by the id it already has", async () => {
    video.enabled = true;
    modelProviderId = null;
    await open(null, UPLOADS);
    await attachVideo(clip());
    await until(ready(1));
    await attach(image("pose.png"));
    await until(ready(2));

    type("move like this");
    await click(send());
    await until(ready(2));
    expect(server.runs).toEqual([]);

    // A model is chosen, and the page draws again.
    modelProviderId = "model-1";
    await click(find("generate-kind-reaction"));
    await click(find("generate-kind-gesture"));
    await click(send());
    await settle();

    // The same two files, each still what it was, and no upload but the first two.
    expect(server.runs[0]!.references).toEqual({
      images: [
        { file_id: "file-1", kind: "video_frames" },
        { file_id: "file-2", kind: "image" },
      ],
    });
    expect(server.uploads).toEqual(["shy wave-frames.jpg", "pose.png"]);
    expect(cards()).toHaveLength(0);
  });

  it("refuses a video longer than twenty seconds, and uploads nothing", async () => {
    video.enabled = true;
    video.duration = 21;
    await open(null, UPLOADS);
    await attachVideo(clip("long take.mov"));
    await settle();
    expect(toastError).toHaveBeenCalledWith("Video not added", {
      description:
        "A video longer than 20 seconds cannot be used as a reference. Trim it and try again.",
    });
    expect(video.drawn).toBe(0);
    expect(server.uploads).toEqual([]);
    expect(cards()).toEqual([]);
    // The control is ready for another video.
    expect(
      (find("generate-reference-video") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("counts a video's strip among the four images a request carries", async () => {
    video.enabled = true;
    await open(null, UPLOADS);
    await attach(
      ...["a.png", "b.png", "c.png", "d.png"].map((name) => image(name)),
    );
    await until(ready(4));
    await attachVideo(clip());
    await settle();
    expect(server.uploads).toHaveLength(4);
    expect(toastError).toHaveBeenCalledWith("Image not added", {
      description: "A message can carry up to 4 images.",
    });
  });
});
