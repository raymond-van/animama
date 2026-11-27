import { Link, useNavigate } from "@tanstack/react-router";
import { SparklesIcon, Trash2Icon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { apiErrorLine } from "@/lib/errors/apiError";
import { cn } from "@/lib/utils";
import {
  useContentGenerationAvailable,
  useGenerationConversation,
} from "@/query/hooks/useGeneration";
import { useDeleteGenerationConversation } from "@/query/mutations/useGenerationMutations";
import { usePoseCreatorStore } from "@/stores/pose-creator-store";
import { useActionEditorWorkspace } from "@/ui/action-editor/ActionEditorWorkspaceContext";
import {
  assistantDocumentFingerprint,
  assistantRunDocument,
  documentHasTimelineEvents,
} from "@/ui/action-editor/assistantDocument";
import { Button } from "@/ui/components/button";
import { GenerateConversation } from "../GenerateConversation";
import { GenerateDraftRemarks } from "../GenerateDraftCard";
import { GenerateConversationDiscardDialog } from "../GenerateHeader";
import { GenerateModelControl } from "../GenerateModelControl";
import { useGeneratePreviewAvatarExpressions } from "../GeneratePreview";
import {
  describeGenerationActionFailure,
  draftFailureText,
} from "../generationFailure";
import { useDraftWorker } from "../useDraftWorker";
import { useGenerationModel } from "../useGenerationModel";
import { useGenerationRun } from "../useGenerationRun";
import { useCreatorGenerationConversation } from "./useCreatorGenerationConversation";

/** One array for every render without drafts, so their readers stay still. */
const NO_DRAFTS: readonly PyGenerationDraft[] = [];

/** Why the last result did not reach the creator's document. */
type ResultNotice = "changed" | "not_applied" | "pose_draft";

/**
 * The assistant's conversation about the item open in the creator (R1.2).
 *
 * Each request starts from the creator's document as it stands (hand edits
 * included, and a pose being edited in Pose mode, which is committed first),
 * and the result is put back into that document as one undoable change: the
 * run's first result is one history entry and its later versions (repairs, a
 * review's edit) take that entry's place, so Undo returns to the document
 * from before the request and Redo to the result. The result plays in the creator's own preview
 * (R5.2), its checks run as on the Generate page, and nothing is saved: Save
 * stays the creator's own (R7.1).
 *
 * A result is never put over a document that changed while the assistant
 * worked. When the timeline is not what the run started from, or what its
 * last result left, the result is refused, the run is stopped and the panel
 * says so; the person's edits stay, each an entry of its own. Nothing is
 * applied after Stop or after a run has ended.
 */
function CreatorGenerateSession({
  titleId,
  onClose,
}: {
  /** The id the panel is labelled by. */
  titleId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("generate");
  const navigate = useNavigate();
  const workspace = useActionEditorWorkspace();
  const { intent } = workspace.document;
  const modelChoice = useGenerationModel();
  const scope = useCreatorGenerationConversation({
    intent,
    itemId: workspace.itemId ?? null,
    enabled: Boolean(modelChoice.model),
  });
  const { conversationId } = scope;
  const conversation = useGenerationConversation(conversationId);
  const snapshot = conversation.data;
  const drafts = snapshot?.drafts ?? NO_DRAFTS;
  const expressions = useGeneratePreviewAvatarExpressions();
  const [modelControlOpen, setModelControlOpen] = useState(false);
  const [notice, setNotice] = useState<ResultNotice | null>(null);

  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  /** What the run in flight may be applied over, and which versions are its own. */
  const runState = useRef<{
    /** The timeline the next result may replace. */
    expected: string;
    /** Each draft's version when the run started: later ones are its results. */
    versions: Map<string, number>;
    applied: Map<string, number>;
    /** A result of this run is an entry in the creator's history. */
    entered: boolean;
  } | null>(null);

  const runningRef = useRef(false);
  const creatorSource = useCallback(() => {
    // One run at a time: a second request must not reset what the run in
    // flight may be applied over.
    if (runningRef.current) return false;
    // A keyframe's pose being edited in Pose mode is applied first, and the
    // creator moves to Clip, so the run starts from what the person sees. An
    // unsaved pose of its own cannot be sent and would be lost: no run.
    const current = workspaceRef.current.prepareAssistantRun();
    if (!current) {
      setNotice("pose_draft");
      return false;
    }
    const document = assistantRunDocument(current);
    runState.current = {
      expected: assistantDocumentFingerprint(current),
      versions: new Map(
        draftsRef.current.map(({ id, version }) => [id, version]),
      ),
      applied: new Map(),
      entered: false,
    };
    setNotice(null);
    return {
      document,
      // An empty item is written anew, as a draft of its own.
      draftId: document ? (draftsRef.current.at(-1)?.id ?? null) : null,
    };
  }, []);

  const run = useGenerationRun({
    conversationId,
    modelProviderId: modelChoice.model?.id ?? null,
    reasoningEffort: modelChoice.effort,
    avatarExpressionNames: expressions?.names ?? null,
    arkitNames: expressions?.arkitNames,
    creatorSource,
  });
  const worker = useDraftWorker({
    conversationId,
    drafts,
    avatarExpressionNames: expressions ? expressions.names : expressions,
  });
  const { running } = run.run;
  runningRef.current = running;
  if (running && modelControlOpen) setModelControlOpen(false);
  // Stop ends the run for the creator at once: nothing that arrives after it
  // is put into the document.
  const { stop } = run;
  const controller = useMemo(
    () => ({
      ...run,
      stop: () => {
        runState.current = null;
        stop();
      },
    }),
    [run, stop],
  );

  // The request field takes the cursor once the conversation is read; it
  // cannot while it is still disabled, when the panel first opens.
  const body = useRef<HTMLDivElement>(null);
  const ready = Boolean(snapshot);
  useEffect(() => {
    if (ready)
      body.current
        ?.querySelector<HTMLElement>('[data-testid="generate-request"]')
        ?.focus();
  }, [ready]);

  // Put each of the run's loadable results into the creator's document. The
  // first is one new entry in the creator's history; a later version of the
  // same run (a repair, a review's edit) takes that entry's place, so Undo
  // returns to the document from before the request in one step. No history
  // group is held open, so an edit the person makes meanwhile is an entry of
  // its own, and it ends the run's claim on the timeline (below).
  const { validations } = worker;
  const pendingPlay = useRef(false);
  useEffect(() => {
    const state = runState.current;
    if (!state) return;
    for (const draft of drafts) {
      if (draft.project === null) continue;
      if (draft.version <= (state.versions.get(draft.id) ?? 0)) continue;
      if (state.applied.get(draft.id) === draft.version) continue;
      const validation = validations[draft.id];
      if (validation?.version !== draft.version) continue;
      state.applied.set(draft.id, draft.version);
      // A clip the page cannot load never reaches the document (T1).
      if (!validation.sequence) continue;
      const current = workspaceRef.current;
      // The timeline must be what the run started from, or what its last
      // result left, and the pose editor must hold nothing the result would
      // lose: a keyframe's pose changed again, or an unsaved pose of its own.
      const pending = current.pendingPoseEdit();
      if (
        pending ||
        assistantDocumentFingerprint(current.document) !== state.expected
      ) {
        runState.current = null;
        setNotice(pending === "pose_draft" ? "pose_draft" : "changed");
        stop();
        return;
      }
      try {
        const applied = current.applyAssistantResult(draft.project, {
          replace: state.entered,
        });
        if (applied.changed) state.entered = true;
        state.expected = assistantDocumentFingerprint(applied.document);
        pendingPlay.current = true;
        // An earlier version of this run that could not be applied is past.
        setNotice(null);
      } catch {
        setNotice("not_applied");
      }
    }
  }, [drafts, stop, validations]);
  // A run that has ended, however it ended, applies nothing more: a version
  // the server stored as the run was stopped or failed stays a stored draft.
  // Declared after the effect above, so a result that arrives with the run's
  // end is applied first.
  useEffect(() => {
    if (!running) runState.current = null;
  }, [running]);

  // Play the result once the timeline holds it: the timeline's own sync runs
  // before this effect, in the same commit.
  const { timelineSession } = workspace;
  useEffect(() => {
    if (!pendingPlay.current) return;
    pendingPlay.current = false;
    usePoseCreatorStore.getState().restartClipPreview();
  }, [timelineSession]);

  // Discarding the conversation (R6.4): the same action and confirmation as
  // on the Generate page. The item's next conversation starts empty.
  const { mutateAsync: removeConversation, isPending: removing } =
    useDeleteGenerationConversation();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const discard = async () => {
    setConfirmingDiscard(false);
    // The server refuses while a run works on the conversation.
    if (!conversationId || running) return;
    try {
      await removeConversation(conversationId);
      setNotice(null);
    } catch (error) {
      toast.error(apiErrorLine(describeGenerationActionFailure(error)));
    }
  };

  const result = drafts.at(-1) ?? null;
  const failureText = result ? draftFailureText(result) : null;
  const empty = assistantRunDocument(workspace.document) === null;
  const note = (
    <div
      className="text-muted-foreground space-y-1 px-1 text-xs"
      data-testid="creator-generate-note"
    >
      {notice ? (
        <p role="alert" className="text-foreground" data-notice={notice}>
          {notice === "changed"
            ? t("creator.changedMeanwhile")
            : notice === "pose_draft"
              ? t("creator.poseDraft")
              : t("creator.notApplied")}
        </p>
      ) : null}
      {running ? (
        <p role="status">{t("creator.running")}</p>
      ) : (
        <p>
          {empty
            ? intent === "gesture"
              ? t("creator.writes.gesture")
              : t("creator.writes.reaction")
            : intent === "gesture"
              ? t("creator.revises.gesture")
              : t("creator.revises.reaction")}
        </p>
      )}
      {!running && workspace.mode === "pose" ? (
        <p data-testid="creator-generate-pose-note">
          {t("creator.appliesPose")}
        </p>
      ) : null}
      {!running && documentHasTimelineEvents(workspace.document) ? (
        <p>{t("creator.keepsEffects")}</p>
      ) : null}
      {result && !running ? (
        <div data-testid="creator-generate-result" data-status={result.status}>
          {failureText ? <p>{failureText}</p> : null}
          {worker.failures[result.id] ? (
            <p>{t("drafts.checksUnavailable")}</p>
          ) : null}
          <GenerateDraftRemarks draft={result} />
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <header className="border-border/60 flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <h2
          id={titleId}
          className="min-w-0 flex-1 truncate text-sm font-semibold"
        >
          {t("creator.title")}
        </h2>
        {modelChoice.model ? (
          <GenerateModelControl
            choice={modelChoice}
            disabled={running}
            onOpenSetup={() => void navigate({ to: "/generate" })}
            usage={snapshot?.usage}
            open={modelControlOpen}
            onOpenChange={setModelControlOpen}
          />
        ) : null}
        {conversationId ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("header.discardConversation")}
            title={
              running ? t("header.waitForRun") : t("header.discardConversation")
            }
            data-testid="creator-generate-discard"
            disabled={running || removing}
            onClick={() => setConfirmingDiscard(true)}
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("creator.close")}
          data-testid="creator-generate-close"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </header>
      <GenerateConversationDiscardDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
        running={running}
        onConfirm={() => void discard()}
      />
      <div ref={body} className="min-h-0 flex-1">
        {modelChoice.isPending ? (
          <p className="text-muted-foreground p-4 text-sm" role="status">
            {t("page.loading")}
          </p>
        ) : !modelChoice.model ? (
          <div className="space-y-3 p-4" data-testid="creator-generate-setup">
            <p className="text-sm">{t("creator.setup")}</p>
            <Button asChild size="sm" variant="outline">
              <Link to="/generate">{t("creator.openGenerate")}</Link>
            </Button>
          </div>
        ) : scope.isError && !conversationId ? (
          <div className="space-y-3 p-4" role="alert">
            <p className="text-sm">{t("page.conversationsFailed")}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={scope.retry}
            >
              {t("page.retry")}
            </Button>
          </div>
        ) : (
          <GenerateConversation
            snapshot={snapshot}
            isLoading={!snapshot && !conversation.isError}
            loadFailed={conversation.isError && !snapshot}
            onReload={() => void conversation.refetch()}
            controller={controller}
            selectedDraft={null}
            onStartNewDraft={() => undefined}
            onChooseModel={() => setModelControlOpen(true)}
            framesStatus={worker.frames.status}
            composerNote={note}
            autoFocus
          />
        )}
      </div>
    </>
  );
}

/**
 * The Generate control of the Gesture and Reaction creators (R1.2): a button
 * at the bottom right, above the timeline, that opens the assistant's
 * conversation about the open item in a panel floating over the creator's
 * other panels. The panel takes no part in their sizing and does not trap
 * focus; Escape closes it and returns focus to the button. A run in flight
 * goes on while the panel is closed. Without the `content_generation`
 * capability nothing is rendered.
 */
export function CreatorGenerateControl({
  bottom,
}: {
  /** Pixels from the workspace's bottom edge: just above the timeline. */
  bottom: number;
}) {
  const { t } = useTranslation("generate");
  const available = useContentGenerationAvailable();
  const [open, setOpen] = useState(false);
  // Mounted on first use and kept, so closing the panel stops no run.
  const [used, setUsed] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();
  const titleId = useId();
  // Opening the panel again puts the cursor back in its request field; the
  // first time, the field focuses itself as it mounts.
  useEffect(() => {
    if (open)
      panel.current
        ?.querySelector<HTMLElement>('[data-testid="generate-request"]')
        ?.focus();
  }, [open]);
  if (!available) return null;

  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };

  return (
    // The button comes first in the document, so Tab moves from it into the
    // panel; the column is reversed to draw the panel above it.
    <div
      className="pointer-events-none absolute top-4 right-4 z-40 flex flex-col-reverse items-end gap-2 xl:right-8"
      style={{ bottom }}
    >
      <Button
        ref={toggle}
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls={used ? panelId : undefined}
        data-testid="creator-generate-toggle"
        className="bg-background pointer-events-auto shrink-0 shadow-md"
        onClick={() => {
          setUsed(true);
          setOpen((value) => !value);
        }}
      >
        <SparklesIcon className="size-4" aria-hidden="true" />
        {t("creator.open")}
      </Button>
      {used ? (
        <section
          ref={panel}
          id={panelId}
          aria-labelledby={titleId}
          hidden={!open}
          data-testid="creator-generate-panel"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.stopPropagation();
            close();
          }}
          className={cn(
            "border-border/65 bg-background pointer-events-auto max-h-[640px] min-h-0 w-[min(420px,calc(100vw-2rem))] flex-1 flex-col overflow-hidden rounded-2xl border shadow-xl shadow-black/10",
            open ? "flex" : "hidden",
          )}
        >
          <CreatorGenerateSession titleId={titleId} onClose={close} />
        </section>
      ) : null}
    </div>
  );
}
