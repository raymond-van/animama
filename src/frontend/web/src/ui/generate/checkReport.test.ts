import { describe, expect, it } from "vitest";

import type {
  MotionCheckCategory,
  MotionCheckFinding,
} from "@/lib/avatar/motion-authoring/checks";
import {
  FINDING_CATEGORIES,
  MAX_REPORT_BYTES,
  MAX_REPORT_FINDINGS,
  MAX_REPORT_ISSUES,
  MAX_REPORT_NAMES,
  MAX_REPORT_NAME_LENGTH,
  MAX_REPORT_TEXT_LENGTH,
  buildCheckReport,
} from "./checkReport";

const finding = (
  overrides: Partial<MotionCheckFinding> = {},
): MotionCheckFinding => ({
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

const CLEAN = { loadable: true, issues: [], findings: [] };
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("buildCheckReport", () => {
  it("sends the page's result in the route's shape and nothing else", () => {
    const { body, dropped } = buildCheckReport({
      version: 3,
      checks: {
        // The page's own summary is not part of the route's schema.
        ok: false,
        loadable: true,
        issues: [{ path: "joints.head.flexion[1].v", message: "Too far." }],
        findings: [
          finding(),
          finding({
            category: "contact",
            severity: "warn",
            avatar: null,
            actualOffset: [0.01, -0.02, 0.03],
          }),
        ],
      } as Parameters<typeof buildCheckReport>[0]["checks"],
      expressionNames: { missing: ["tongueOut"], avatarOnly: ["cheekPuff"] },
    });

    expect(body).toEqual({
      version: 3,
      loadable: true,
      issues: [{ path: "joints.head.flexion[1].v", message: "Too far." }],
      findings: [
        {
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
        },
        {
          category: "contact",
          severity: "warn",
          avatar: null,
          subject: "rightHand/head",
          from: 0.8,
          to: 0.93,
          value: 0.074,
          limit: 0.015,
          unit: "m",
          detail: "The right hand passes through the head.",
          actualOffset: [0.01, -0.02, 0.03],
        },
      ],
      expression_names: { missing: ["tongueOut"], avatar_only: ["cheekPuff"] },
    });
    expect(Object.keys(body).sort()).toEqual([
      "expression_names",
      "findings",
      "issues",
      "loadable",
      "version",
    ]);
    expect(dropped).toEqual({ issues: 0, findings: 0, names: 0 });
  });

  it("reports a clip that does not load with its issues and no findings", () => {
    const { body } = buildCheckReport({
      version: 1,
      checks: {
        loadable: false,
        issues: [{ path: "beats", message: "Expected an array of beats." }],
        findings: [],
      },
    });
    expect(body).toEqual({
      version: 1,
      loadable: false,
      issues: [{ path: "beats", message: "Expected an array of beats." }],
      findings: [],
      expression_names: { missing: [], avatar_only: [] },
    });
  });

  it("lists the same categories as the page's checker", () => {
    const categories: Record<MotionCheckCategory, true> = {
      pose: true,
      range: true,
      smoothness: true,
      oscillation: true,
      intersection: true,
      fingers: true,
      contact: true,
      feet: true,
      loopSeam: true,
      parity: true,
    };
    expect([...FINDING_CATEGORIES].sort()).toEqual(
      Object.keys(categories).sort(),
    );
  });

  it("keeps at most the route's number of issues and findings, failed checks first", () => {
    const { body, dropped } = buildCheckReport({
      version: 1,
      checks: {
        loadable: true,
        issues: Array.from({ length: MAX_REPORT_ISSUES + 30 }, (_, index) => ({
          path: `joints.j${index}`,
          message: "Too far.",
        })),
        findings: [
          // Warnings come first from the checker here; the cut must not keep
          // them at the cost of failed checks.
          ...Array.from({ length: 150 }, (_, index) =>
            finding({ severity: "warn", subject: `warn-${index}` }),
          ),
          ...Array.from({ length: 120 }, (_, index) =>
            finding({ severity: "fail", subject: `fail-${index}` }),
          ),
        ],
      },
    });

    expect(body.issues).toHaveLength(MAX_REPORT_ISSUES);
    expect(body.issues!.at(-1)!.path).toBe(`joints.j${MAX_REPORT_ISSUES - 1}`);
    expect(body.findings).toHaveLength(MAX_REPORT_FINDINGS);
    const subjects = body.findings!.map(({ subject }) => subject);
    expect(subjects.slice(0, 120)).toEqual(
      Array.from({ length: 120 }, (_, index) => `fail-${index}`),
    );
    expect(subjects.slice(120)).toEqual(
      Array.from({ length: 80 }, (_, index) => `warn-${index}`),
    );
    expect(dropped).toEqual({ issues: 30, findings: 70, names: 0 });
  });

  it("cuts text to the longest the route holds and keeps it storable", () => {
    const long = "é".repeat(MAX_REPORT_TEXT_LENGTH + 40);
    // A surrogate pair straddling the cut, a NUL and a lone surrogate.
    const awkward = `${"a".repeat(MAX_REPORT_TEXT_LENGTH - 1)}😀`;
    const { body } = buildCheckReport({
      version: 1,
      checks: {
        loadable: true,
        issues: [{ path: long, message: awkward }],
        findings: [
          finding({ subject: long, unit: "m\u0000", detail: "bad\uD83D" }),
        ],
      },
    });

    expect(body.issues![0]!.path).toBe("é".repeat(MAX_REPORT_TEXT_LENGTH));
    expect(body.issues![0]!.message).toHaveLength(MAX_REPORT_TEXT_LENGTH);
    expect(body.issues![0]!.message.endsWith("�")).toBe(true);
    expect(body.findings![0]).toMatchObject({
      subject: "é".repeat(MAX_REPORT_TEXT_LENGTH),
      unit: "m",
      detail: "bad�",
    });
  });

  it("keeps names within their caps, missing names before Avatar-only ones", () => {
    const missing = Array.from(
      { length: 300 },
      (_, index) => `missing${index}`,
    );
    const avatarOnly = Array.from({ length: 300 }, (_, index) => `own${index}`);
    const { body, dropped } = buildCheckReport({
      version: 1,
      checks: CLEAN,
      expressionNames: {
        missing: [
          "",
          "x".repeat(MAX_REPORT_NAME_LENGTH + 1),
          "nul\u0000name",
          "lone\uD83D",
          "x".repeat(MAX_REPORT_NAME_LENGTH),
          ...missing,
          "missing0",
        ],
        avatarOnly: ["missing1", ...avatarOnly],
      },
    });

    const names = body.expression_names!;
    expect(names.missing).toEqual([
      "x".repeat(MAX_REPORT_NAME_LENGTH),
      ...missing,
    ]);
    // What room is left goes to Avatar-only names, none listed twice.
    expect(names.avatar_only).toEqual(avatarOnly.slice(0, 99));
    expect(names.missing!.length + names.avatar_only!.length).toBe(
      MAX_REPORT_NAMES,
    );
    expect(dropped.names).toBe(5 + 1 + 201);
  });

  it("leaves out findings the route would refuse and unmeasurable numbers", () => {
    const { body, dropped } = buildCheckReport({
      version: 1,
      checks: {
        loadable: true,
        issues: [],
        findings: [
          finding({ category: "balance" as MotionCheckCategory }),
          finding({ severity: "notice" as "warn" }),
          finding({
            from: Number.NaN,
            value: Number.POSITIVE_INFINITY,
            actualOffset: [0, Number.NaN, 0],
          }),
        ],
      },
    });

    expect(body.findings).toEqual([
      {
        category: "intersection",
        severity: "fail",
        avatar: "Andrew",
        subject: "rightHand/head",
        from: 0,
        to: 0.93,
        value: 0,
        limit: 0.015,
        unit: "m",
        detail: "The right hand passes through the head.",
      },
    ]);
    expect(dropped.findings).toBe(2);
    // Nothing the JSON encoder would turn into `null`.
    expect(JSON.stringify(body)).not.toContain("null,");
  });

  it("fits the whole report in the route's size, dropping warnings first", () => {
    const text = "界".repeat(MAX_REPORT_TEXT_LENGTH);
    const wordy = (severity: "fail" | "warn", index: number) =>
      finding({
        severity,
        avatar: text,
        subject: `${severity}-${index}`,
        unit: text,
        detail: text,
      });
    const { body, dropped } = buildCheckReport({
      version: 1,
      checks: {
        loadable: true,
        issues: [{ path: "$", message: "Too large." }],
        findings: [
          ...Array.from({ length: 100 }, (_, index) => wordy("warn", index)),
          ...Array.from({ length: 30 }, (_, index) => wordy("fail", index)),
        ],
      },
    });

    expect(bytes(body)).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    const kept = body.findings!;
    expect(kept.length).toBeGreaterThan(30);
    expect(kept.length).toBeLessThan(130);
    // Every failed check survived; only trailing warnings were dropped.
    expect(kept.slice(0, 30).every(({ severity }) => severity === "fail")).toBe(
      true,
    );
    expect(kept.slice(30).map(({ subject }) => subject)).toEqual(
      Array.from({ length: kept.length - 30 }, (_, index) => `warn-${index}`),
    );
    expect(body.issues).toHaveLength(1);
    expect(dropped.findings).toBe(130 - kept.length);
  });
});
