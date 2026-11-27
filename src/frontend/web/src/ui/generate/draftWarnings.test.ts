import { describe, expect, it } from "vitest";

import { FINDING_CATEGORIES } from "./checkReport";
import {
  draftFindingKey,
  draftRemarks,
  type DraftFindingKey,
} from "./draftWarnings";
import { generationDraft } from "./testing/generationFixtures";

const finding = (overrides: Record<string, unknown> = {}) => ({
  category: "intersection",
  severity: "fail",
  avatar: "Andrew",
  subject: "rightHand/head",
  from: 0.8,
  to: 0.93,
  value: 0.074,
  limit: 0.015,
  unit: "m",
  detail: "The right hand passes through the head.",
  ...overrides,
});

const checked = (report: Record<string, unknown>) =>
  generationDraft({ checked_version: 1, check_report: report });

describe("draftFindingKey", () => {
  it("gives every check category a key for each severity", () => {
    const keys = FINDING_CATEGORIES.flatMap((category) => [
      draftFindingKey(category, "fail"),
      draftFindingKey(category, "warn"),
    ]);
    expect(keys).toEqual(
      FINDING_CATEGORIES.flatMap((category) => [
        `${category}.fail`,
        `${category}.warn`,
      ]),
    );
    // Twenty sentences for the ten categories, and none repeats.
    expect(new Set(keys).size).toBe(20);
  });

  it("falls back for a category or severity it does not know", () => {
    const fallbacks: [unknown, unknown, DraftFindingKey][] = [
      ["balance", "fail", "unknown.fail"],
      ["balance", "warn", "unknown.warn"],
      [undefined, "fail", "unknown.fail"],
      // An inherited property name is not a category.
      ["toString", "warn", "unknown.warn"],
      ["__proto__", "fail", "unknown.fail"],
      // An unknown severity reads as the milder one.
      ["intersection", "error", "intersection.warn"],
      ["intersection", undefined, "intersection.warn"],
    ];
    for (const [category, severity, key] of fallbacks)
      expect(draftFindingKey(category, severity)).toBe(key);
  });
});

describe("draftRemarks", () => {
  it("has nothing to say until the current version was checked", () => {
    const none = { checked: false, loadable: null, warnings: [], notes: [] };
    expect(draftRemarks(generationDraft())).toEqual(none);
    // The stored report is for the version before.
    expect(
      draftRemarks(
        generationDraft({
          version: 2,
          checked_version: 1,
          check_report: { loadable: true, findings: [finding()] },
        }),
      ),
    ).toEqual(none);
  });

  it("is clean for a report with nothing in it", () => {
    expect(
      draftRemarks(
        checked({
          loadable: true,
          issues: [],
          findings: [],
          expression_names: { missing: [], avatar_only: [] },
        }),
      ),
    ).toEqual({ checked: true, loadable: true, warnings: [], notes: [] });
  });

  it("lists validation problems, then failed checks, then warnings, in time order", () => {
    const remarks = draftRemarks(
      checked({
        loadable: true,
        issues: [
          {
            path: "joints.head.flexion[1].v",
            message: "95° is beyond the anatomical limit -60..70.",
          },
        ],
        findings: [
          finding({ category: "smoothness", severity: "warn", from: 0.2 }),
          finding({ from: 1.4, to: 1.5 }),
          finding({
            category: "feet",
            severity: "fail",
            avatar: null,
            from: 0.1,
          }),
        ],
        expression_names: { missing: ["tongueOut"], avatar_only: [] },
      }),
    );
    expect(remarks.warnings.map(({ key }) => key)).toEqual([
      "issue",
      "feet.fail",
      "intersection.fail",
      "smoothness.warn",
      "missingExpressions",
    ]);
    expect(remarks.warnings[0]).toEqual({
      kind: "issue",
      key: "issue",
      path: "joints.head.flexion[1].v",
      message: "95° is beyond the anatomical limit -60..70.",
    });
    expect(remarks.warnings[1]).toEqual({
      kind: "finding",
      key: "feet.fail",
      category: "feet",
      severity: "fail",
      avatar: null,
      subject: "rightHand/head",
      from: 0.1,
      to: 0.93,
    });
    expect(remarks.warnings[4]).toEqual({
      kind: "missingExpressions",
      key: "missingExpressions",
      names: ["tongueOut"],
    });
  });

  it("treats Avatar-only names as a note, not a warning", () => {
    expect(
      draftRemarks(
        checked({
          loadable: true,
          expression_names: { missing: [], avatar_only: ["cheekPuff"] },
        }),
      ),
    ).toEqual({
      checked: true,
      loadable: true,
      warnings: [],
      notes: [
        {
          kind: "avatarOnlyExpressions",
          key: "avatarOnlyExpressions",
          names: ["cheekPuff"],
        },
      ],
    });
  });

  it("says when the checks never ran", () => {
    expect(draftRemarks(checked({ unchecked: true }))).toEqual({
      checked: true,
      loadable: null,
      warnings: [{ kind: "unchecked", key: "unchecked" }],
      notes: [],
    });
  });

  it("reports a clip the page could not load", () => {
    const remarks = draftRemarks(
      checked({
        loadable: false,
        issues: [{ path: "beats", message: "Expected an array of beats." }],
      }),
    );
    expect(remarks.loadable).toBe(false);
    expect(remarks.warnings).toHaveLength(1);
  });

  it("reads a report from a newer checker without failing", () => {
    const remarks = draftRemarks(
      checked({
        loadable: true,
        issues: ["not an object", { path: 3 }],
        findings: [
          null,
          finding({ category: "balance", severity: "fail", avatar: 7 }),
          finding({ severity: "notice", from: "soon", to: null }),
        ],
        expression_names: {
          missing: "tongueOut",
          avatar_only: [3, "", "blush"],
        },
        gaze: { ok: true },
      }),
    );
    expect(remarks.warnings).toEqual([
      { kind: "issue", key: "issue", path: "", message: "" },
      {
        kind: "finding",
        key: "unknown.fail",
        category: "balance",
        severity: "fail",
        avatar: null,
        subject: "rightHand/head",
        from: 0.8,
        to: 0.93,
      },
      {
        kind: "finding",
        key: "intersection.warn",
        category: "intersection",
        severity: "warn",
        avatar: "Andrew",
        subject: "rightHand/head",
        from: null,
        to: null,
      },
    ]);
    expect(remarks.notes).toEqual([
      {
        kind: "avatarOnlyExpressions",
        key: "avatarOnlyExpressions",
        names: ["blush"],
      },
    ]);
    // A report that is not an object says nothing.
    expect(
      draftRemarks(
        generationDraft({
          checked_version: 1,
          check_report: [] as unknown as Record<string, unknown>,
        }),
      ).checked,
    ).toBe(false);
  });
});
