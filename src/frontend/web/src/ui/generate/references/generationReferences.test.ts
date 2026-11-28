import { describe, expect, it } from "vitest";

import type { PyGesture } from "@/lib/content/catalogTypes";
import {
  generationReferencesBody,
  hasGenerationReferences,
  referenceGestureChoices,
  storedGenerationReferences,
  storedImagesSent,
  type GenerationRunReferences,
} from "./generationReferences";

function gesture(
  itemId: string,
  name: string,
  overrides: Partial<PyGesture> = {},
): PyGesture {
  return {
    item_id: itemId,
    name,
    description: null,
    origin: "owned",
    state: "ready",
    created_at: null,
    updated_at: null,
    source: { type: "catalog", catalog_item_id: itemId, source: "local" },
    implementation_kind: "anima_clip",
    portability: "portable",
    ...overrides,
  } as PyGesture;
}

const NONE: GenerationRunReferences = {
  startingPoint: null,
  examples: [],
  images: [],
};

describe("referenceGestureChoices", () => {
  it("offers ready, portable clip Gestures, Local and Included apart", () => {
    const choices = referenceGestureChoices([
      gesture("local-1", "Shy Wave"),
      gesture("included-1", "Wave Hello", { origin: "builtin" }),
      gesture("included-2", "Licensed Dance", {
        origin: "builtin",
        portability: "non-portable",
      }),
      gesture("local-2", "Imported Bow", { implementation_kind: "vrma" }),
      gesture("local-3", "Broken", { state: "invalid" }),
      gesture("local-4", "Gone", { source: null }),
    ]);
    expect(choices.local.map(({ item_id }) => item_id)).toEqual(["local-1"]);
    expect(choices.included.map(({ item_id }) => item_id)).toEqual([
      "included-1",
    ]);
  });
});

describe("generationReferencesBody", () => {
  it("names each reference by id, in the order chosen", () => {
    expect(
      generationReferencesBody({
        startingPoint: { itemId: "wave", name: "Wave Hello" },
        examples: [
          { itemId: "bow", name: "Deep Bow" },
          { itemId: "nod", name: "Nod" },
        ],
        images: [
          { fileId: "file-1", name: "pose.png", kind: "image" },
          { fileId: "file-2", name: "clip-frames.jpg", kind: "video_frames" },
        ],
      }),
    ).toEqual({
      starting_point: "wave",
      examples: ["bow", "nod"],
      images: [
        { file_id: "file-1", kind: "image" },
        { file_id: "file-2", kind: "video_frames" },
      ],
    });
  });

  it("sends only the parts a request carries, and nothing without any", () => {
    expect(
      generationReferencesBody({
        ...NONE,
        examples: [{ itemId: "bow", name: "Deep Bow" }],
      }),
    ).toEqual({ examples: ["bow"] });
    expect(generationReferencesBody(NONE)).toBeNull();
    expect(generationReferencesBody(null)).toBeNull();
    expect(generationReferencesBody(undefined)).toBeNull();
    expect(hasGenerationReferences(NONE)).toBe(false);
    expect(
      hasGenerationReferences({
        ...NONE,
        images: [{ fileId: "file-1", name: "pose.png", kind: "image" }],
      }),
    ).toBe(true);
  });
});

describe("storedGenerationReferences", () => {
  it("reads what a stored turn carried, names and sizes included", () => {
    expect(
      storedGenerationReferences({
        references: {
          starting_point: { item_id: "wave", name: "Wave Hello" },
          examples: [
            { item_id: "bow", name: "Deep Bow" },
            { item_id: "nod", name: "Nod" },
          ],
        },
        images: [
          {
            file_id: "file-1",
            name: "pose.png",
            width: 640,
            height: 480,
            kind: "image",
          },
          { file_id: "file-2", name: "clip-frames.jpg", kind: "video_frames" },
        ],
      }),
    ).toEqual({
      startingPoint: { itemId: "wave", name: "Wave Hello" },
      examples: [
        { itemId: "bow", name: "Deep Bow" },
        { itemId: "nod", name: "Nod" },
      ],
      images: [
        {
          fileId: "file-1",
          name: "pose.png",
          kind: "image",
          width: 640,
          height: 480,
        },
        { fileId: "file-2", name: "clip-frames.jpg", kind: "video_frames" },
      ],
    });
  });

  it("is nothing for a turn without references, and drops what it cannot read", () => {
    expect(storedGenerationReferences({})).toBeNull();
    expect(storedGenerationReferences(null)).toBeNull();
    expect(
      storedGenerationReferences({ references: "wave", images: "none" }),
    ).toBeNull();
    expect(
      storedGenerationReferences({
        references: {
          starting_point: { name: "No id" },
          examples: [{ item_id: "bow" }, 7, { item_id: "" }],
        },
        images: [{ name: "no id" }, { file_id: "file-1", width: "wide" }],
      }),
    ).toEqual({
      startingPoint: null,
      // A reference without a name still names its Gesture.
      examples: [{ itemId: "bow", name: "" }],
      images: [{ fileId: "file-1", name: "", kind: "image" }],
    });
  });

  it("says a run's model took no images only when the turn records it", () => {
    expect(storedImagesSent({ images_sent: false })).toBe(false);
    expect(storedImagesSent({ images_sent: true })).toBe(true);
    expect(storedImagesSent({})).toBe(true);
    expect(storedImagesSent(null)).toBe(true);
  });
});
