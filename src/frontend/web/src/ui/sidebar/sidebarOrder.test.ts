import { describe, expect, it } from "vitest";

import type { PyAnimaListItem } from "@/lib/content/catalogTypes";
import {
  nextAnimaIdAfterDelete,
  orderSidebarAnimas,
  pinnedFirst,
} from "./sidebarOrder";

const compare = (left: string, right: string) => left.localeCompare(right);

function anima(
  id: string,
  name: string,
  updatedAt: string,
  pinnedAt: string | null = null,
): PyAnimaListItem {
  return {
    id,
    display_name: name,
    updated_at: updatedAt,
    created_at: updatedAt,
    pinned_at: pinnedAt,
  } as PyAnimaListItem;
}

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

describe("sidebar pins", () => {
  it("puts pinned items first and keeps the list's order within each group", () => {
    const items = [
      { id: "a", pinned_at: null },
      { id: "b", pinned_at: "2026-11-20T10:00:00" },
      { id: "c", pinned_at: null },
      { id: "d", pinned_at: "2026-11-01T10:00:00" },
    ];

    expect(ids(pinnedFirst(items))).toEqual(["b", "d", "a", "c"]);
    // The input is left as it was.
    expect(ids(items)).toEqual(["a", "b", "c", "d"]);
  });

  it("orders pinned Animas above the rest for every sort", () => {
    const animas = [
      anima("ava", "Ava", "2026-11-01T00:00:00"),
      anima("bo", "Bo", "2026-11-03T00:00:00", "2026-11-25T00:00:00"),
      anima("cy", "Cy", "2026-11-04T00:00:00"),
      anima("di", "Di", "2026-11-02T00:00:00", "2026-11-24T00:00:00"),
    ];

    expect(
      ids(orderSidebarAnimas(animas, { sort: "recent", compare })),
    ).toEqual(["bo", "di", "cy", "ava"]);
    expect(
      ids(orderSidebarAnimas(animas, { sort: "name-asc", compare })),
    ).toEqual(["bo", "di", "ava", "cy"]);
    expect(
      ids(orderSidebarAnimas(animas, { sort: "name-desc", compare })),
    ).toEqual(["di", "bo", "cy", "ava"]);
  });

  it("keeps the recently used Anima first within its group", () => {
    const animas = [
      anima("ava", "Ava", "2026-11-01T00:00:00"),
      anima("bo", "Bo", "2026-11-03T00:00:00", "2026-11-25T00:00:00"),
      anima("cy", "Cy", "2026-11-04T00:00:00"),
      anima("di", "Di", "2026-11-02T00:00:00", "2026-11-24T00:00:00"),
    ];

    expect(
      ids(
        orderSidebarAnimas(animas, {
          sort: "recent",
          compare,
          recentlyUsedAnimaId: "ava",
        }),
      ),
    ).toEqual(["bo", "di", "ava", "cy"]);
    expect(
      ids(
        orderSidebarAnimas(animas, {
          sort: "recent",
          compare,
          recentlyUsedAnimaId: "di",
        }),
      ),
    ).toEqual(["di", "bo", "cy", "ava"]);
  });
});

describe("the Anima opened after a delete", () => {
  it("is the next one in sidebar order, or the previous one at the end", () => {
    expect(nextAnimaIdAfterDelete(["a", "b", "c"], "a")).toBe("b");
    expect(nextAnimaIdAfterDelete(["a", "b", "c"], "b")).toBe("c");
    expect(nextAnimaIdAfterDelete(["a", "b", "c"], "c")).toBe("b");
  });

  it("is none when no other Anima remains", () => {
    expect(nextAnimaIdAfterDelete(["a"], "a")).toBeNull();
    expect(nextAnimaIdAfterDelete([], "a")).toBeNull();
  });

  it("is the first one when the deleted Anima is not listed", () => {
    expect(nextAnimaIdAfterDelete(["a", "b"], "gone")).toBe("a");
  });
});
