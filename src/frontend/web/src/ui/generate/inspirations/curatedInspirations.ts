import type { TFunction } from "i18next";

/**
 * Curated outside images for the Inspirations dialog: the place where they
 * would be listed. **None is shipped.**
 *
 * An entry is added only after the owner approves that image, in an issue or
 * pull request the entry names. Its file goes in `./curated/`, next to this
 * module, and needs its own entry in the repository's licence record
 * (`licenses/source-review.json`), like every tracked file. The licence must
 * permit redistribution: an image that may only be viewed, or whose terms
 * are unknown, is never added.
 *
 * `curatedInspirations.test.ts` holds the list to that: every file in the
 * folder is named by exactly one entry, every entry names a file that is
 * there, and every licence record is complete and permits redistribution.
 */

/** The record of why an outside image may be shipped. */
export type CuratedInspirationLicence = {
  /** The licence's name, such as `CC0 1.0`. */
  licence: string;
  /** The https URL the image was obtained from. */
  source: string;
  /** The credit the licence asks for; say so in words when it asks for none. */
  attribution: string;
  /** Only an image whose licence permits redistribution is listed. */
  redistribution: "permitted";
  /**
   * The issue or pull request where the owner approved shipping the image:
   * `#123`, or its URL.
   */
  ownerApproval: string;
};

export type CuratedInspiration = {
  id: string;
  /** The file's name in `./curated/`. */
  file: string;
  /** That file's import: `import asset from "./curated/<file>"`. */
  asset: string;
  /**
   * The image's title, worded from the `generate` catalog: a function that
   * calls `t` with the key written out in the entry, so the catalog
   * extraction sees the key.
   */
  title: (t: TFunction<"generate">) => string;
  licence: CuratedInspirationLicence;
};

/** The curated images offered; none until the owner approves one. */
export const CURATED_INSPIRATIONS: readonly CuratedInspiration[] = [];
