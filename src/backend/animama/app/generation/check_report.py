"""The page's check report as the run pipeline reads it: its bounds, and what it means for a draft.

After each stored draft version the page validates the clip (structure,
anatomical limits, saved size), runs the motion checks on both Included Avatars
when the clip loads, compares the keyed expression names with the chosen
Avatar, and sends one report. The report is the page's word, so it is untrusted
(threat T6): the route bounds it with the limits here, and it only ever decides
whether a repair pass runs and which warnings a draft shows. Loading and Save
never depend on it.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final, Literal, get_args

from animama.domain.generation import GenerationDraftStatus

FindingCategory = Literal[
    "pose",
    "range",
    "smoothness",
    "oscillation",
    "intersection",
    "fingers",
    "contact",
    "feet",
    "loopSeam",
    "parity",
]
"""``MotionCheckCategory`` in the frontend's ``motion-authoring/checks.ts``."""
FindingSeverity = Literal["fail", "warn"]

FINDING_CATEGORIES: Final[tuple[str, ...]] = get_args(FindingCategory)
FINDING_SEVERITIES: Final[tuple[str, ...]] = get_args(FindingSeverity)

MAX_REPORT_ISSUES: Final = 200
MAX_REPORT_FINDINGS: Final = 200
MAX_REPORT_TEXT_LENGTH: Final = 500
"""The longest string a report holds, apart from an expression name."""
MAX_REPORT_NAMES: Final = 400
"""Expression names in a report, over both lists."""
MAX_REPORT_NAME_LENGTH: Final = 64
MAX_REPORT_BYTES: Final = 256 * 1024
"""A whole report as compact JSON."""

DRAFT_UNLOADABLE: Final = "generation_draft_unloadable"
"""The failure reason of a draft whose current version the page could not load."""


def unchecked_report() -> dict[str, Any]:
    """What is stored for a version whose report never arrived: the draft's checks did not run."""

    return {"unchecked": True}


def _entries(report: Mapping[str, Any], key: str) -> list[Any]:
    value = report.get(key)
    return value if isinstance(value, list) else []


def _names(report: Mapping[str, Any], key: str) -> list[str]:
    names = report.get("expression_names")
    listed = names.get(key) if isinstance(names, Mapping) else None
    return [name for name in listed if isinstance(name, str)] if isinstance(listed, list) else []


def is_unchecked(report: Mapping[str, Any]) -> bool:
    return report.get("unchecked") is True


def is_loadable(report: Mapping[str, Any]) -> bool:
    """Whether the page could load and play the clip. An unchecked version counts as loadable:
    the server's own validation passed, and nothing says otherwise."""

    return is_unchecked(report) or report.get("loadable") is True


def needs_repair(report: Mapping[str, Any]) -> bool:
    """Whether a repair pass should run: the clip does not load, has a validation issue or a failed check.

    Warnings and the expression-name lists never start a repair by
    themselves (decision D17); a repair pass that runs is told about them.
    """

    if is_unchecked(report):
        return False
    if not is_loadable(report) or _entries(report, "issues"):
        return True
    return any(
        isinstance(finding, Mapping) and finding.get("severity") == "fail" for finding in _entries(report, "findings")
    )


def final_status(report: Mapping[str, Any]) -> tuple[GenerationDraftStatus, str | None]:
    """How a draft is left once nothing more will be done about ``report``: its status and failure reason.

    ``failed`` when the version does not load; ``ready`` when it loads with
    nothing to warn of; otherwise ``warnings``: issues, findings of either
    severity, keyed expression names the chosen Avatar lacks (``missing``),
    or checks that never ran. Names only such Avatars have (``avatar_only``)
    are a note the report keeps, not a warning (decision D20): alone they
    leave the draft ``ready``.
    """

    if not is_loadable(report):
        return "failed", DRAFT_UNLOADABLE
    warned = (
        is_unchecked(report) or _entries(report, "issues") or _entries(report, "findings") or _names(report, "missing")
    )
    return ("warnings" if warned else "ready"), None


def names_not_on_review_sheets(report: Mapping[str, Any]) -> list[str]:
    """The keyed expression names a frame review must not judge from its sheets (decision D20).

    The sheets are drawn on the Included Avatars. A name the chosen Avatar
    lacks, or one only such Avatars have, may be missing there too; listing
    one the sheets do show only stops the model judging it.
    """

    return list(dict.fromkeys([*_names(report, "missing"), *_names(report, "avatar_only")]))


__all__ = [
    "DRAFT_UNLOADABLE",
    "FINDING_CATEGORIES",
    "FINDING_SEVERITIES",
    "FindingCategory",
    "FindingSeverity",
    "MAX_REPORT_BYTES",
    "MAX_REPORT_FINDINGS",
    "MAX_REPORT_ISSUES",
    "MAX_REPORT_NAMES",
    "MAX_REPORT_NAME_LENGTH",
    "MAX_REPORT_TEXT_LENGTH",
    "final_status",
    "is_loadable",
    "is_unchecked",
    "names_not_on_review_sheets",
    "needs_repair",
    "unchecked_report",
]
