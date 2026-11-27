import type { PyContentUsage } from "@animama/runtime-contracts/api-types";

import type { ContentKind } from "@/lib/content/catalogTypes";
import { readApiError } from "@/lib/errors/apiError";

export type { PyContentUsage };

/** One Local item a delete is asked for, at the revision it was shown at. */
export type ContentDeleteRequest = {
  itemId: string;
  kind: ContentKind;
  revision: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** The `used_by` entries of an in-use refusal; malformed entries are dropped. */
function usedByEntries(value: unknown): PyContentUsage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const use = record(entry);
    return use &&
      typeof use.kind === "string" &&
      typeof use.id === "string" &&
      typeof use.name === "string"
      ? [use as PyContentUsage]
      : [];
  });
}

/**
 * A content delete or usage read the server refused (issue #950, R15–R17),
 * with its status, code and what the delete dialog needs to say why.
 */
export class ContentDeleteError extends Error {
  readonly status: number;
  /** Such as `catalog_item_in_use` or `catalog_item_changed`. */
  readonly code: string | null;
  /** `catalog_item_in_use`: what uses the item, at most ten, Anima uses first. */
  readonly usedBy: PyContentUsage[];
  /** A revision refusal's current revision, which a retry deletes. */
  readonly currentRevision: string | null;

  constructor(status: number, body: unknown) {
    const info = readApiError(body);
    super(info.message ?? `Delete failed (${status}).`);
    this.name = "ContentDeleteError";
    this.status = status;
    this.code = info.code;
    const detail = record(record(body)?.detail);
    this.usedBy = usedByEntries(detail?.used_by);
    this.currentRevision =
      typeof detail?.current_revision === "string"
        ? detail.current_revision
        : null;
  }
}

/**
 * Whether a delete was refused because the item changed since it was shown:
 * a stale revision, or a file changed on disk (R17).
 */
export function isContentChangedRefusal(error: unknown): boolean {
  return (
    error instanceof ContentDeleteError &&
    (error.code === "catalog_revision_conflict" ||
      error.code === "catalog_item_changed")
  );
}

/** The uses an in-use refusal names, or none for any other failure. */
export function inUseRefusalUses(error: unknown): PyContentUsage[] {
  return error instanceof ContentDeleteError &&
    error.code === "catalog_item_in_use"
    ? error.usedBy
    : [];
}
