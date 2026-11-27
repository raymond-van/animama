import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import type { MotionCheckCategory } from "@/lib/avatar/motion-authoring/checks";
import { isRecord } from "@/lib/records";

/**
 * What a draft's stored check report says, as keys the page words. The report
 * is the page's own earlier measurement read back from the backend, so it is
 * read tolerantly: an entry this page cannot read is skipped, and a check
 * category it does not know falls back to a general key.
 *
 * Nothing here decides whether a draft plays or saves: that is the page's own
 * validation (`useDraftWorker`), never the stored report.
 */

/** The check categories this page words, each with a fail and a warn sentence. */
const KNOWN_CATEGORIES: Record<MotionCheckCategory, true> = {
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

export type DraftFindingSeverity = "fail" | "warn";

/** One sentence per check category and severity; `unknown` for a category from a newer checker. */
export type DraftFindingKey =
  `${MotionCheckCategory | "unknown"}.${DraftFindingSeverity}`;

/**
 * Something about a draft the person should know before saving it.
 *
 * - `issue`: a validation problem of the clip, by JSON path. `message` is the
 *   validator's English text, to show as detail.
 * - `finding`: a motion check finding on an Included Avatar (`avatar` is
 *   `null` when it holds for every Avatar), between `from` and `to` seconds.
 * - `missingExpressions`: keyed expression names the chosen preview Avatar
 *   would not show.
 * - `unchecked`: the checks never ran for this version.
 */
export type DraftWarning =
  | { kind: "issue"; key: "issue"; path: string; message: string }
  | {
      kind: "finding";
      key: DraftFindingKey;
      category: string;
      severity: DraftFindingSeverity;
      avatar: string | null;
      /** The bone, joint component or body pair concerned. */
      subject: string;
      from: number | null;
      to: number | null;
    }
  | { kind: "missingExpressions"; key: "missingExpressions"; names: string[] }
  | { kind: "unchecked"; key: "unchecked" };

/**
 * Something worth saying that is no fault of the draft. `avatarOnlyExpressions`:
 * keyed names the chosen Avatar has but other Avatars may lack, which play
 * only on Avatars that have them.
 */
export type DraftNote = {
  kind: "avatarOnlyExpressions";
  key: "avatarOnlyExpressions";
  names: string[];
};

export type DraftRemarks = {
  /**
   * Whether a report exists for the draft's current version. While `false`
   * there is nothing to show: the version is still to be checked.
   */
  checked: boolean;
  /** What the report says about playing the clip; `null` without a current report or when unchecked. */
  loadable: boolean | null;
  /** Validation problems, then failed checks, then warnings, each in time order. */
  warnings: DraftWarning[];
  notes: DraftNote[];
};

const NO_REMARKS: DraftRemarks = {
  checked: false,
  loadable: null,
  warnings: [],
  notes: [],
};

const entries = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string" && !!name)
    : [];

const seconds = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The key that words a finding; a category this page does not know reads as `unknown`. */
export function draftFindingKey(
  category: unknown,
  severity: unknown,
): DraftFindingKey {
  const level: DraftFindingSeverity = severity === "fail" ? "fail" : "warn";
  return typeof category === "string" &&
    Object.hasOwn(KNOWN_CATEGORIES, category)
    ? `${category as MotionCheckCategory}.${level}`
    : `unknown.${level}`;
}

function findingWarning(
  finding: Record<string, unknown>,
): Extract<DraftWarning, { kind: "finding" }> {
  const key = draftFindingKey(finding.category, finding.severity);
  return {
    kind: "finding",
    key,
    category: typeof finding.category === "string" ? finding.category : "",
    severity: key.endsWith(".fail") ? "fail" : "warn",
    avatar:
      typeof finding.avatar === "string" && finding.avatar
        ? finding.avatar
        : null,
    subject: typeof finding.subject === "string" ? finding.subject : "",
    from: seconds(finding.from),
    to: seconds(finding.to),
  };
}

/**
 * What the stored report says about a draft's current version: warnings,
 * which the person should weigh, and notes, which are information only.
 */
export function draftRemarks(
  draft: Pick<
    PyGenerationDraft,
    "check_report" | "checked_version" | "version"
  >,
): DraftRemarks {
  const report = draft.check_report;
  if (!isRecord(report) || draft.checked_version !== draft.version)
    return NO_REMARKS;
  if (report.unchecked === true)
    return {
      checked: true,
      loadable: null,
      warnings: [{ kind: "unchecked", key: "unchecked" }],
      notes: [],
    };

  const issues: DraftWarning[] = entries(report.issues).map((issue) => ({
    kind: "issue",
    key: "issue",
    path: typeof issue.path === "string" ? issue.path : "",
    message: typeof issue.message === "string" ? issue.message : "",
  }));
  const findings = entries(report.findings)
    .map(findingWarning)
    // Failed checks first; within a severity, as the clip plays.
    .sort(
      (left, right) =>
        Number(right.severity === "fail") - Number(left.severity === "fail") ||
        (left.from ?? 0) - (right.from ?? 0),
    );
  const expressionNames = isRecord(report.expression_names)
    ? report.expression_names
    : {};
  const missing = names(expressionNames.missing);
  const avatarOnly = names(expressionNames.avatar_only);
  return {
    checked: true,
    loadable: report.loadable === true,
    warnings: [
      ...issues,
      ...findings,
      ...(missing.length > 0
        ? [
            {
              kind: "missingExpressions",
              key: "missingExpressions",
              names: missing,
            } as const,
          ]
        : []),
    ],
    notes:
      avatarOnly.length > 0
        ? [
            {
              kind: "avatarOnlyExpressions",
              key: "avatarOnlyExpressions",
              names: avatarOnly,
            },
          ]
        : [],
  };
}
