import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { PyGesture } from "@/lib/content/catalogTypes";
import {
  INCLUDED_INSPIRATION_KEYS,
  includedInspirations,
} from "./includedInspirations";

// Resolved from this directory: under a DOM test environment Vite turns
// `new URL(…, import.meta.url)` into an http URL.
const INCLUDED_GESTURES = resolve(
  import.meta.dirname,
  "../../../../../../../content/included/gestures",
);

const gesture = (key: string, name: string): PyGesture =>
  ({
    item_id: `item-${key}`,
    logical_key: key,
    name,
    origin: "builtin",
    state: "ready",
  }) as PyGesture;

describe("the Included Gestures offered as inspirations", () => {
  it("is a short list without repeats", () => {
    expect(INCLUDED_INSPIRATION_KEYS.length).toBeGreaterThanOrEqual(6);
    expect(INCLUDED_INSPIRATION_KEYS.length).toBeLessThanOrEqual(10);
    expect(new Set(INCLUDED_INSPIRATION_KEYS).size).toBe(
      INCLUDED_INSPIRATION_KEYS.length,
    );
  });

  it("names portable clip Gestures of the repository's Included content", () => {
    for (const key of INCLUDED_INSPIRATION_KEYS) {
      const id = key.replace(/^builtin:gesture:/, "");
      const path = resolve(INCLUDED_GESTURES, id, `${id}.meta.json`);
      expect(existsSync(path), key).toBe(true);
      const meta = JSON.parse(readFileSync(path, "utf8")) as {
        content_id: string;
        content_type: string;
        distribution?: string;
        implementation: { kind: string };
      };
      expect(meta.content_id).toBe(key);
      expect(meta.content_type).toBe("gesture");
      // The assistant reads a clip, and never non-portable content.
      expect(meta.implementation.kind).toBe("anima_clip");
      expect(meta.distribution).not.toBe("non-portable");
    }
  });

  it("offers the listed Gestures the Library has, in the list's order", () => {
    const [first, second, third] = INCLUDED_INSPIRATION_KEYS;
    const offered = includedInspirations([
      gesture(third!, "Third"),
      gesture("builtin:gesture:not-listed", "Not listed"),
      gesture(first!, "First"),
      // A Local Gesture never stands in for an Included one.
      { ...gesture(second!, "Local copy"), origin: "owned" },
    ]);
    expect(offered.map(({ name }) => name)).toEqual(["First", "Third"]);
    expect(includedInspirations([])).toEqual([]);
  });
});
