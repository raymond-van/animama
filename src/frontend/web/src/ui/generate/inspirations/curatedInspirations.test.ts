import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CURATED_INSPIRATIONS,
  type CuratedInspiration,
} from "./curatedInspirations";

/**
 * The licence gate for curated outside images: nothing may sit in the
 * `curated` folder without an entry that records a licence permitting
 * redistribution and the owner's approval, and no entry may name a file that
 * is not there.
 */

// Resolved from this directory: under a DOM test environment Vite turns
// `new URL(…, import.meta.url)` into an http URL.
const CURATED_DIRECTORY = resolve(import.meta.dirname, "curated");

/** The names of everything in the curated folder; none while it is absent. */
function curatedFiles(): string[] {
  return existsSync(CURATED_DIRECTORY)
    ? readdirSync(CURATED_DIRECTORY).sort()
    : [];
}

type Listed = Pick<CuratedInspiration, "id" | "file" | "asset" | "licence">;

/** What is wrong with the curated entries and files, in words; none when all is in order. */
function curatedProblems(
  entries: readonly Listed[],
  files: readonly string[],
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id))
      problems.push(`entry id "${entry.id}" is empty or used twice`);
    ids.add(entry.id);
    if (!files.includes(entry.file))
      problems.push(`${entry.id}: no file "${entry.file}" in curated/`);
    // The import is the file the entry names, not another one.
    if (!entry.asset.split(/[?#]/)[0]!.endsWith(`/${entry.file}`))
      problems.push(`${entry.id}: its asset is not curated/${entry.file}`);
    const { licence } = entry;
    for (const field of [
      "licence",
      "source",
      "attribution",
      "ownerApproval",
    ] as const)
      if (typeof licence[field] !== "string" || !licence[field].trim())
        problems.push(`${entry.id}: the licence record has no ${field}`);
    if (!/^https:\/\/\S+$/.test(licence.source ?? ""))
      problems.push(`${entry.id}: the source is not an https URL`);
    // The issue or pull request where the owner approved shipping the image.
    if (
      !/^(#\d+|https:\/\/\S+\/(issues|pull)\/\d+)$/.test(
        licence.ownerApproval ?? "",
      )
    )
      problems.push(
        `${entry.id}: ownerApproval names no issue or pull request`,
      );
    if ((licence.redistribution as string) !== "permitted")
      problems.push(`${entry.id}: redistribution is not permitted`);
  }
  for (const file of files) {
    const named = entries.filter((entry) => entry.file === file).length;
    if (named !== 1)
      problems.push(`curated/${file} is named by ${named} entries, not one`);
  }
  return problems;
}

const entry = (overrides: Partial<Listed> = {}): Listed => ({
  id: "moonlit-bow",
  file: "moonlit-bow.webp",
  asset: "/src/ui/generate/inspirations/curated/moonlit-bow.webp",
  licence: {
    licence: "CC0 1.0",
    source: "https://example.org/moonlit-bow",
    attribution: "None required",
    redistribution: "permitted",
    ownerApproval: "#1234",
  },
  ...overrides,
});

describe("curated inspirations", () => {
  it("names every curated file by exactly one entry, with a complete licence that permits redistribution", () => {
    expect(curatedProblems(CURATED_INSPIRATIONS, curatedFiles())).toEqual([]);
  });

  it("ships no curated image today", () => {
    expect(CURATED_INSPIRATIONS).toEqual([]);
    expect(curatedFiles()).toEqual([]);
  });
});

describe("the curated licence check", () => {
  const files = ["moonlit-bow.webp"];

  it("passes an approved image with its file", () => {
    expect(curatedProblems([entry()], files)).toEqual([]);
    expect(
      curatedProblems(
        [
          entry({
            licence: {
              ...entry().licence,
              ownerApproval: "https://github.com/example/app/pull/1234",
            },
          }),
        ],
        files,
      ),
    ).toEqual([]);
  });

  it("fails a file that no entry names", () => {
    expect(curatedProblems([], files)).toEqual([
      "curated/moonlit-bow.webp is named by 0 entries, not one",
    ]);
    expect(curatedProblems([entry()], [...files, "stray.png"])).toEqual([
      "curated/stray.png is named by 0 entries, not one",
    ]);
  });

  it("fails a file named twice, and an entry without its file", () => {
    expect(curatedProblems([entry(), entry({ id: "second" })], files)).toEqual([
      "curated/moonlit-bow.webp is named by 2 entries, not one",
    ]);
    expect(curatedProblems([entry()], [])).toEqual([
      'moonlit-bow: no file "moonlit-bow.webp" in curated/',
    ]);
    expect(
      curatedProblems([entry({ asset: "/src/elsewhere/other.webp" })], files),
    ).toEqual(["moonlit-bow: its asset is not curated/moonlit-bow.webp"]);
  });

  it("fails an entry that does not permit redistribution", () => {
    const refused = entry();
    (refused.licence as { redistribution: string }).redistribution =
      "not-permitted";
    expect(curatedProblems([refused], files)).toEqual([
      "moonlit-bow: redistribution is not permitted",
    ]);
  });

  it("fails an incomplete licence record", () => {
    expect(
      curatedProblems(
        [
          entry({
            licence: {
              licence: " ",
              source: "example.org",
              attribution: "",
              redistribution: "permitted",
              ownerApproval: "the owner said yes",
            },
          }),
        ],
        files,
      ),
    ).toEqual([
      "moonlit-bow: the licence record has no licence",
      "moonlit-bow: the licence record has no attribution",
      "moonlit-bow: the source is not an https URL",
      "moonlit-bow: ownerApproval names no issue or pull request",
    ]);
  });
});
