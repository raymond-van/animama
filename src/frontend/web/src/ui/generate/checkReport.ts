import type {
  PyGenerationCheckFinding,
  PyGenerationCheckIssue,
  PyGenerationCheckReport,
} from "@animama/runtime-contracts/api-types";

import type { MotionCheckFinding } from "@/lib/avatar/motion-authoring/checks";
import type { DraftCheckReport } from "@/lib/avatar/motion-authoring/draftChecks";

/**
 * The page's check report as `PUT /v1/generation/drafts/{id}/check-report`
 * takes it. The route refuses a body outside its bounds or with a field it
 * does not know, and a refused report leaves the run waiting two minutes
 * before it ends "unchecked". So a report is built here field by field from
 * the page's own check result and clamped to the route's bounds; nothing else
 * (such as the result's own `ok`) is sent.
 *
 * The bounds mirror the backend's: `MAX_REPORT_*` in
 * `src/backend/animama/app/generation/check_report.py`, applied by
 * `PyGenerationCheckReport` in `src/backend/animama/server/schemas/generation.py`.
 * Change them together.
 */

/** Validation issues in a report. */
export const MAX_REPORT_ISSUES = 200;
/** Motion check findings in a report. */
export const MAX_REPORT_FINDINGS = 200;
/** The longest string a report holds, apart from an expression name. */
export const MAX_REPORT_TEXT_LENGTH = 500;
/** Expression names in a report, over both lists. */
export const MAX_REPORT_NAMES = 400;
/** The longest expression name, at least one character. */
export const MAX_REPORT_NAME_LENGTH = 64;
/** A whole stored report as compact JSON. */
export const MAX_REPORT_BYTES = 256 * 1024;

/**
 * Bytes kept free below `MAX_REPORT_BYTES`: the backend measures the report
 * as it stores it, where a whole number such as `1` is written `1.0`.
 */
const REPORT_BYTES_MARGIN = 16 * 1024;

/**
 * The finding categories the route takes (`FindingCategory`). The page's
 * checker and the backend must agree: a category added to
 * `MotionCheckCategory` fails to compile here until the backend's list has it.
 */
const CATEGORIES: Record<PyGenerationCheckFinding["category"], true> &
  Record<MotionCheckFinding["category"], true> = {
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

/** The categories a report may hold, as the route lists them. */
export const FINDING_CATEGORIES = Object.keys(
  CATEGORIES,
) as PyGenerationCheckFinding["category"][];

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Whether the backend can store `value`: no NUL and no unpaired surrogate. */
function isStorable(value: string): boolean {
  return !value.includes("\u0000") && value.search(LONE_SURROGATE) < 0;
}

/** `value` as text the route takes: storable, and cut to the longest it holds. */
function reportText(value: unknown): string {
  return (typeof value === "string" ? value : String(value ?? ""))
    .replaceAll("\u0000", "")
    .slice(0, MAX_REPORT_TEXT_LENGTH)
    .replace(LONE_SURROGATE, "�");
}

/** The route refuses NaN and infinities; a measurement that is neither is kept. */
const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function reportFinding(
  finding: MotionCheckFinding,
): PyGenerationCheckFinding | null {
  // A category or severity the route does not list would refuse the whole report.
  if (!Object.hasOwn(CATEGORIES, finding.category)) return null;
  if (finding.severity !== "fail" && finding.severity !== "warn") return null;
  const offset = finding.actualOffset;
  return {
    category: finding.category,
    severity: finding.severity,
    avatar:
      typeof finding.avatar === "string" ? reportText(finding.avatar) : null,
    subject: reportText(finding.subject),
    from: finite(finding.from),
    to: finite(finding.to),
    value: finite(finding.value),
    limit: finite(finding.limit),
    unit: reportText(finding.unit),
    detail: reportText(finding.detail),
    ...(Array.isArray(offset) &&
    offset.length === 3 &&
    offset.every((axis) => typeof axis === "number" && Number.isFinite(axis))
      ? { actualOffset: [offset[0], offset[1], offset[2]] }
      : {}),
  };
}

/** Names the route takes, once each, until `room` is used up. */
function reportNames(
  names: readonly unknown[],
  room: number,
  taken: Set<string>,
): string[] {
  const kept: string[] = [];
  for (const name of names) {
    if (kept.length >= room) break;
    if (
      typeof name !== "string" ||
      name.length < 1 ||
      name.length > MAX_REPORT_NAME_LENGTH ||
      !isStorable(name) ||
      taken.has(name)
    )
      continue;
    taken.add(name);
    kept.push(name);
  }
  return kept;
}

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export type BuiltCheckReport = {
  body: PyGenerationCheckReport;
  /** How many entries the bounds left out, for a log line. */
  dropped: { issues: number; findings: number; names: number };
};

/**
 * Build the report for one draft version from the page's check result and the
 * comparison of its keyed expression names with the chosen preview Avatar.
 *
 * Within the bounds everything is sent as measured. Beyond them: issues keep
 * their order and lose the last; findings keep failed checks before warnings
 * and lose the last warnings first; `missing` names are kept before
 * `avatarOnly` ones; over-long text is cut. A finding the route would not
 * know is left out rather than sent to be refused.
 */
export function buildCheckReport(input: {
  version: number;
  checks: Pick<DraftCheckReport, "loadable" | "issues" | "findings">;
  expressionNames?: {
    missing: readonly string[];
    avatarOnly: readonly string[];
  };
}): BuiltCheckReport {
  const { checks } = input;
  const issues: PyGenerationCheckIssue[] = checks.issues
    .slice(0, MAX_REPORT_ISSUES)
    .map(({ path, message }) => ({
      path: reportText(path),
      message: reportText(message),
    }));
  const known = checks.findings.flatMap(
    (finding) => reportFinding(finding) ?? [],
  );
  // Stable, so each severity keeps the checker's order.
  const findings = [
    ...known.filter(({ severity }) => severity === "fail"),
    ...known.filter(({ severity }) => severity === "warn"),
  ].slice(0, MAX_REPORT_FINDINGS);

  const taken = new Set<string>();
  const given = input.expressionNames ?? { missing: [], avatarOnly: [] };
  const missing = reportNames(given.missing, MAX_REPORT_NAMES, taken);
  const avatarOnly = reportNames(
    given.avatarOnly,
    MAX_REPORT_NAMES - missing.length,
    taken,
  );

  const body: PyGenerationCheckReport = {
    version: input.version,
    loadable: checks.loadable === true,
    issues,
    findings,
    expression_names: { missing, avatar_only: avatarOnly },
  };
  // Entries are dropped from the end until the whole report fits: warnings go
  // before failed checks, and findings before validation issues.
  const budget = MAX_REPORT_BYTES - REPORT_BYTES_MARGIN;
  let bytes = jsonBytes(body);
  while (bytes > budget && (findings.length > 0 || issues.length > 0)) {
    const removed = findings.length > 0 ? findings.pop() : issues.pop();
    // The entry and the comma that joined it to its neighbour.
    bytes -= jsonBytes(removed) + 1;
  }
  return {
    body,
    dropped: {
      issues: checks.issues.length - issues.length,
      findings: checks.findings.length - findings.length,
      names:
        given.missing.length +
        given.avatarOnly.length -
        missing.length -
        avatarOnly.length,
    },
  };
}
