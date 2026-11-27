import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import {
  CheckCircle2Icon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFormatters, type LocaleFormatters } from "@animama/product-ui/i18n";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { emotionLabel } from "@/lib/emotion/presentation";
import { cn } from "@/lib/utils";
import { reactionIntensityLabel } from "@/ui/animas/ActionLoadoutRows";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";
import {
  draftRemarks,
  type DraftNote,
  type DraftWarning,
} from "./draftWarnings";
import {
  draftLeftUnchecked,
  draftName,
  draftReactionPlacement,
} from "./generationDrafts";
import { draftFailureText } from "./generationFailure";
import type { DraftCheckFailure, DraftValidation } from "./useDraftWorker";

/** How many remarks a card shows before the rest fold away. */
const VISIBLE_REMARKS = 3;

/** Where a draft stands, in words (R3.3). */
function statusText(
  t: TFunction<"generate">,
  status: PyGenerationDraft["status"],
): string {
  switch (status) {
    case "writing":
      return t("drafts.status.writing");
    case "checking":
      return t("drafts.status.checking");
    case "repairing":
      return t("drafts.status.repairing");
    case "reviewing":
      return t("drafts.status.reviewing");
    case "ready":
      return t("drafts.status.ready");
    case "warnings":
      return t("drafts.status.warnings");
    case "failed":
      return t("drafts.status.failed");
  }
}

/** One plain-word sentence per warning (R4.3). */
function warningText(t: TFunction<"generate">, warning: DraftWarning): string {
  switch (warning.key) {
    case "issue":
      return t("warnings.issue");
    case "missingExpressions":
      return t("warnings.missingExpressions", { names: warning.names });
    case "unchecked":
      return t("warnings.unchecked");
    case "pose.fail":
      return t("warnings.pose.fail");
    case "pose.warn":
      return t("warnings.pose.warn");
    case "range.fail":
      return t("warnings.range.fail");
    case "range.warn":
      return t("warnings.range.warn");
    case "smoothness.fail":
      return t("warnings.smoothness.fail");
    case "smoothness.warn":
      return t("warnings.smoothness.warn");
    case "oscillation.fail":
      return t("warnings.oscillation.fail");
    case "oscillation.warn":
      return t("warnings.oscillation.warn");
    case "intersection.fail":
      return t("warnings.intersection.fail");
    case "intersection.warn":
      return t("warnings.intersection.warn");
    case "fingers.fail":
      return t("warnings.fingers.fail");
    case "fingers.warn":
      return t("warnings.fingers.warn");
    case "contact.fail":
      return t("warnings.contact.fail");
    case "contact.warn":
      return t("warnings.contact.warn");
    case "feet.fail":
      return t("warnings.feet.fail");
    case "feet.warn":
      return t("warnings.feet.warn");
    case "loopSeam.fail":
      return t("warnings.loopSeam.fail");
    case "loopSeam.warn":
      return t("warnings.loopSeam.warn");
    case "parity.fail":
      return t("warnings.parity.fail");
    case "parity.warn":
      return t("warnings.parity.warn");
    case "unknown.fail":
      return t("warnings.unknown.fail");
    case "unknown.warn":
      return t("warnings.unknown.warn");
  }
}

/**
 * Where a warning applies, under its sentence: the Included Avatar a finding
 * was measured on and its time range, or a clip problem's place and the
 * validator's own text.
 */
function warningDetail(
  t: TFunction<"generate">,
  formatters: LocaleFormatters,
  warning: DraftWarning,
): string | null {
  if (warning.kind === "issue") {
    if (!warning.message) return warning.path || null;
    return warning.path
      ? t("warnings.issueAt", { path: warning.path, message: warning.message })
      : warning.message;
  }
  if (warning.kind !== "finding") return null;
  const seconds = (value: number) =>
    formatters.number(value, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const { from, to, avatar } = warning;
  const when =
    from === null
      ? null
      : to !== null && to > from
        ? t("warnings.where.range", { from: seconds(from), to: seconds(to) })
        : t("warnings.where.at", { time: seconds(from) });
  if (!avatar) return when;
  return when
    ? t("warnings.where.avatarWhen", { avatar, when })
    : t("warnings.where.avatar", { avatar });
}

function noteText(t: TFunction<"generate">, note: DraftNote): string {
  switch (note.key) {
    case "avatarOnlyExpressions":
      return t("warnings.avatarOnlyExpressions", { names: note.names });
  }
}

type Remark = {
  /** A warning carries the warning mark; a note is information only. */
  tone: "warning" | "note";
  text: string;
  detail: string | null;
};

/** A draft's warnings and notes; a long list folds after the first few. */
function DraftRemarks({ remarks }: { remarks: readonly Remark[] }) {
  const { t } = useTranslation("generate");
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (remarks.length === 0) return null;
  const long = remarks.length > VISIBLE_REMARKS;
  const shown = long && !expanded ? remarks.slice(0, VISIBLE_REMARKS) : remarks;
  return (
    <div className="space-y-1.5">
      <ul
        id={listId}
        className="space-y-1.5"
        data-testid="generate-draft-remarks"
      >
        {shown.map((remark, index) => (
          <li
            key={index}
            className="flex items-start gap-1.5 text-xs"
            data-tone={remark.tone}
          >
            {remark.tone === "warning" ? (
              <TriangleAlertIcon
                className="text-warning mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
            ) : (
              <InfoIcon
                className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0">
              <span className="block">{remark.text}</span>
              {remark.detail ? (
                <span className="text-muted-foreground block break-words">
                  {remark.detail}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {long ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          aria-expanded={expanded}
          aria-controls={listId}
          data-testid="generate-draft-remarks-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t("drafts.showFewer")
            : t("drafts.showAll", { total: remarks.length })}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * What a draft's checks left, in words: its warnings, then its notes. The
 * draft card lists them, and so does a creator's assistant panel for the
 * result it applied.
 */
export function GenerateDraftRemarks({
  draft,
}: {
  draft: Pick<
    PyGenerationDraft,
    "check_report" | "checked_version" | "version"
  >;
}) {
  const { t } = useTranslation("generate");
  const formatters = useFormatters();
  const report = draftRemarks(draft);
  const remarks: Remark[] = [
    ...report.warnings.map((warning) => ({
      tone: "warning" as const,
      text: warningText(t, warning),
      detail: warningDetail(t, formatters, warning),
    })),
    ...report.notes.map((note) => ({
      tone: "note" as const,
      text: noteText(t, note),
      detail: null,
    })),
  ];
  return <DraftRemarks remarks={remarks} />;
}

export type GenerateDraftCardProps = {
  draft: PyGenerationDraft;
  /** The page's own validation of the draft's current version. */
  validation: DraftValidation | undefined;
  /** The draft the preview plays and the next message revises. */
  selected: boolean;
  onSelect: () => void;
  /** A run is in flight on the conversation. */
  running: boolean;
  /** That run is working on this draft: discarding it would fail the run. */
  inRun?: boolean;
  /** The page is checking this draft now. */
  checking?: boolean;
  /** Its checks did not reach the backend. */
  checkFailure?: DraftCheckFailure;
  onRetryCheck?: () => void;
  /** This draft is being saved. */
  saving?: boolean;
  /** Another action on a draft is in flight. */
  busy?: boolean;
  onSave: () => void;
  onRestore: () => void;
  /** Called once the person confirmed. */
  onDiscard: () => void;
};

/**
 * One draft: its name, where it stands, what its checks left as warnings, and
 * the person's actions on it. Save and Open in creator are offered only for a
 * draft the page can load (R4.1); warnings never block Save (R4.3).
 */
export function GenerateDraftCard({
  draft,
  validation,
  selected,
  onSelect,
  running,
  inRun = false,
  checking = false,
  checkFailure,
  onRetryCheck,
  saving = false,
  busy = false,
  onSave,
  onRestore,
  onDiscard,
}: GenerateDraftCardProps) {
  const { t } = useTranslation("generate");
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const name = draftName(draft) || t("drafts.unnamed");
  const placement = draftReactionPlacement(draft);
  const validated = validation?.version === draft.version;
  const loadable = validated && Boolean(validation?.sequence);
  const unplayable =
    draft.project !== null && validated && !validation?.sequence;
  const inProgress =
    draft.status === "writing" ||
    draft.status === "checking" ||
    draft.status === "repairing" ||
    draft.status === "reviewing";
  // A draft left waiting for checks that could not be sent says so instead.
  const checksStuck = Boolean(checkFailure) && !checking;
  // A run stopped waiting for this version's checks; the page runs them once
  // no run is in flight, and "Check again" asks for them again.
  const leftUnchecked = draftLeftUnchecked(draft);
  const pageChecking = checking && !inProgress;
  const offersCheck =
    !checking &&
    (checksStuck || leftUnchecked) &&
    // While a run is in flight an unchecked version's checks are the run's.
    !(leftUnchecked && running);
  const failureText = draftFailureText(draft);

  const waitsForRun = running
    ? { disabled: true, title: t("drafts.waitForRun") }
    : {};

  return (
    <article
      data-testid="generate-draft-card"
      data-draft-id={draft.id}
      data-selected={selected}
      data-version={draft.version}
      className={cn(
        "border-border/70 bg-background space-y-2.5 rounded-xl border p-3",
        selected && "border-primary/50 ring-primary/30 ring-1",
      )}
    >
      <div className="space-y-1">
        <button
          type="button"
          aria-pressed={selected}
          aria-label={t("drafts.select", { name })}
          data-testid="generate-draft-select"
          onClick={onSelect}
          className="focus-visible:ring-ring/50 block w-full truncate rounded-md py-0.5 text-left text-sm font-medium outline-none focus-visible:ring-[3px]"
        >
          {name}
        </button>
        <p
          className="text-muted-foreground text-xs"
          data-testid="generate-draft-kind"
          data-intent={draft.intent}
        >
          {draft.intent === "gesture"
            ? t("drafts.kind.gesture")
            : placement
              ? t("drafts.kind.reactionPlaced", {
                  emotion: emotionLabel(placement.emotion),
                  intensity: reactionIntensityLabel(placement.intensity),
                })
              : t("drafts.kind.reaction")}
        </p>
        {/* Beside the button, not inside it, so a change of status is read out. */}
        <p
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          role="status"
          data-testid="generate-draft-status"
          data-status={draft.status}
        >
          {(inProgress || pageChecking) && !checksStuck ? (
            <LoaderCircleIcon
              className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-full",
                draft.status === "ready" && "bg-success",
                draft.status === "failed" && "bg-destructive",
                (draft.status === "warnings" || checksStuck) && "bg-warning",
              )}
            />
          )}
          {checksStuck
            ? t("drafts.checksUnavailable")
            : statusText(t, pageChecking ? "checking" : draft.status)}
        </p>
      </div>

      {offersCheck && onRetryCheck ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="generate-draft-retry-check"
          onClick={onRetryCheck}
        >
          {t("drafts.actions.retryCheck")}
        </Button>
      ) : null}

      {failureText ? (
        <p className="text-destructive text-xs">{failureText}</p>
      ) : null}
      {unplayable ? (
        <p className="text-xs" data-testid="generate-draft-unplayable">
          {t("drafts.unplayable")}
        </p>
      ) : null}

      <GenerateDraftRemarks draft={draft} />

      {draft.saved_item_id ? (
        <p
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
          data-testid="generate-draft-saved"
        >
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2Icon
              className="text-success size-3.5 shrink-0"
              aria-hidden="true"
            />
            {t("drafts.saved")}
          </span>
          {draft.intent === "gesture" ? (
            <Link
              to="/gestures/$gestureId/edit"
              params={{ gestureId: draft.saved_item_id }}
              data-testid="generate-draft-saved-link"
              className="text-foreground decoration-foreground/40 hover:decoration-foreground focus-visible:ring-ring rounded-sm font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
            >
              {t("drafts.openSaved")}
            </Link>
          ) : (
            <Link
              to="/reactions/$reactionId/edit"
              params={{ reactionId: draft.saved_item_id }}
              data-testid="generate-draft-saved-link"
              className="text-foreground decoration-foreground/40 hover:decoration-foreground focus-visible:ring-ring rounded-sm font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
            >
              {t("drafts.openSaved")}
            </Link>
          )}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {loadable ? (
          <Button
            type="button"
            size="sm"
            variant={selected ? "default" : "outline"}
            data-testid="generate-draft-save"
            disabled={busy || saving || running}
            title={running ? t("drafts.waitForRun") : undefined}
            onClick={onSave}
          >
            {saving ? (
              <LoaderCircleIcon
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {saving
              ? t("drafts.actions.saving")
              : draft.saved_item_id
                ? t("drafts.actions.saveAgain")
                : t("drafts.actions.save")}
          </Button>
        ) : null}
        {loadable ? (
          <Button asChild size="sm" variant="outline">
            <Link
              to={
                draft.intent === "gesture" ? "/gestures/new" : "/reactions/new"
              }
              search={{ draft: draft.id, conversation: draft.conversation_id }}
              data-testid="generate-draft-open"
            >
              {t("drafts.actions.open")}
            </Link>
          </Button>
        ) : null}
        {draft.has_previous_version ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="generate-draft-restore"
            disabled={busy || saving}
            {...waitsForRun}
            onClick={onRestore}
          >
            {t("drafts.actions.restore")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          data-testid="generate-draft-discard"
          disabled={busy || saving || inRun}
          title={inRun ? t("drafts.waitForRun") : undefined}
          onClick={() => setConfirmingDiscard(true)}
        >
          {t("drafts.actions.discard")}
        </Button>
      </div>

      <Dialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <DialogContent data-testid="generate-draft-discard-dialog">
          <DialogHeader>
            <DialogTitle>{t("drafts.discard.title", { name })}</DialogTitle>
            <DialogDescription>
              {draft.saved_item_id
                ? t("drafts.discard.savedDescription")
                : t("drafts.discard.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmingDiscard(false)}
            >
              {t("drafts.discard.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="generate-draft-discard-confirm"
              // The run began on this draft behind the open confirmation.
              disabled={inRun}
              title={inRun ? t("drafts.waitForRun") : undefined}
              onClick={() => {
                setConfirmingDiscard(false);
                onDiscard();
              }}
            >
              {t("drafts.discard.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}
