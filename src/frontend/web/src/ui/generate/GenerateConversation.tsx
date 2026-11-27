import { useId, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ChatMessage } from "@animama/product-ui/chat";
import { ChatConversation } from "@animama/product-ui/components";
import type {
  PyGenerationAnswer,
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
} from "@animama/runtime-contracts/api-types";

import { errorWording } from "@/lib/errors/apiError";
import { cn } from "@/lib/utils";
import type {
  GenerationRunFailure,
  GenerationRunPhase,
} from "@/stores/generation-store";
import { Button } from "@/ui/components/button";
import {
  ChatInput,
  ChatInputSubmit,
  ChatInputTextArea,
} from "@/ui/components/chat-input";
import {
  ChatTranscript,
  ChatTranscriptContent,
  ChatTranscriptEmptyState,
  ChatTranscriptScrollButton,
} from "@/ui/components/chat-transcript";
import { Input } from "@/ui/components/input";
import MessageLoaderV2 from "@/ui/components/message-loader-v2";
import { PromptSuggestion } from "@/ui/main/chat/PromptSuggestion";
import {
  draftCanBeRevised,
  draftName,
  type PendingGenerationQuestions,
} from "./generationDrafts";
import {
  describeGenerationFailure,
  generationFailureSuggestsAnotherModel,
} from "./generationFailure";
import {
  failedRunStoredDraft,
  generationTranscript,
  type GenerationTranscriptEntry,
} from "./generationTranscript";
import type { DraftFramesStatus } from "./useDraftWorker";
import {
  MAX_GENERATION_ANSWER_LENGTH,
  MAX_GENERATION_MESSAGE_LENGTH,
  type GenerationRunController,
} from "./useGenerationRun";

/** What the run in flight is doing, in words (R6.1). */
function phaseText(
  t: TFunction<"generate">,
  phase: GenerationRunPhase | null,
): string {
  switch (phase) {
    case "thinking":
      return t("progress.thinking");
    case "writing":
      return t("progress.writing");
    case "checking":
      return t("progress.checking");
    case "repairing":
      return t("progress.repairing");
    case "reviewing_frames":
      return t("progress.reviewingFrames");
    case "starting":
    case null:
      return t("progress.starting");
  }
}

/**
 * A stored assistant turn's text. A turn that ended without text says how it
 * ended instead, so a failed or stopped run leaves a line in the transcript
 * after a reload. Questions already answered are listed; the ones still
 * waiting are shown as cards below the transcript.
 */
function assistantText(
  t: TFunction<"generate">,
  entry: GenerationTranscriptEntry,
  options: {
    /** Its questions wait for an answer, as cards below the transcript. */
    questionsWaiting: boolean;
    /** Its failure is shown by the notice of the run that just failed. */
    failureNoticed: boolean;
  },
): string {
  const parts = [entry.text.trim()];
  if (entry.questions.length > 0 && !options.questionsWaiting)
    parts.push(
      entry.questions.map(({ question }) => `- ${question}`).join("\n"),
    );
  if (entry.outcome === "stopped") parts.push(`*${t("transcript.stopped")}*`);
  if (entry.outcome === "failed" && !options.failureNoticed)
    parts.push(
      `*${
        (entry.errorCode
          ? errorWording("generation", entry.errorCode)
          : null) ?? t("transcript.failed")
      }*`,
    );
  return parts.filter(Boolean).join("\n\n");
}

/**
 * The person's turn. A turn that answered the assistant's questions carries
 * the request again, so it reads as the answers given, or as skipped; a new
 * message sent instead of answering reads as itself.
 */
function personText(
  t: TFunction<"generate">,
  entry: GenerationTranscriptEntry,
  /** The text of the person's turn before this one. */
  previousRequest: string | null,
): string {
  if (!entry.answers) return entry.text;
  const given = entry.answers.skipped ? [] : entry.answers.answers;
  if (given.length > 0)
    return given
      .map(({ question, answer }) =>
        t("transcript.answer", { question, answer }),
      )
      .join("\n");
  return entry.text === previousRequest
    ? t("transcript.skippedQuestions")
    : entry.text;
}

/**
 * The conversation as the chat's transcript component shows it. The person's
 * turn that a model failure belongs to carries that failure, so the chat's
 * own failure notice appears beside it; turns without anything to say are
 * left out.
 */
export function generationChatMessages(
  t: TFunction<"generate">,
  entries: readonly GenerationTranscriptEntry[],
  options: {
    /** Questions wait for an answer: their cards replace the asking turn's list. */
    questionsWaiting: boolean;
    /**
     * The last run failed and its notice is on screen, so the failed turn it
     * stored (the last one) does not say so a second time.
     */
    failureNoticed?: boolean;
    /** That failure in chat's wording, when it is a model's, with its request. */
    failure?: { message: string; notice: NonNullable<ChatMessage["failure"]> };
  },
): { messages: ChatMessage[]; failureShown: boolean } {
  const asking = options.questionsWaiting
    ? entries.findLast(
        (entry) => entry.role === "assistant" && entry.questions.length > 0,
      )
    : undefined;
  // The request that failed is the person's latest turn with its text.
  const failed = options.failure
    ? entries.findLast(
        (entry) =>
          entry.role === "user" && entry.text === options.failure!.message,
      )
    : undefined;
  const last = entries.at(-1);
  let previousRequest: string | null = null;
  let previous: GenerationTranscriptEntry | undefined;
  const messages = entries.flatMap((entry): ChatMessage[] => {
    // The run in flight is answering questions: its turn repeats the request
    // until the stored turn, which reads as the answers, takes its place.
    const repeatsRequest =
      entry.pending &&
      entry.role === "user" &&
      entry.text === previousRequest &&
      previous?.role === "assistant" &&
      previous.questions.length > 0;
    previous = entry;
    if (repeatsRequest) return [];
    const text =
      entry.role === "user"
        ? personText(t, entry, previousRequest)
        : entry.pending
          ? entry.text
          : assistantText(t, entry, {
              questionsWaiting: entry === asking,
              failureNoticed: options.failureNoticed === true && entry === last,
            });
    if (entry.role === "user") previousRequest = entry.text;
    const failure = entry === failed ? options.failure!.notice : undefined;
    if (!text.trim() && !failure) return [];
    return [
      {
        id: entry.id,
        role: entry.role,
        text,
        // The run in flight streams its text into the last bubble.
        animateTextEffect: entry.pending && entry.role === "assistant",
        ...(failure ? { failure } : {}),
      },
    ];
  });
  return { messages, failureShown: Boolean(failed) };
}

/**
 * The assistant's questions as cards (R3.2): one answer per question from its
 * options (or typed, where it offers none), sent together, or skipped. Remount
 * it (by key) for a new set of questions.
 */
export function GenerateQuestionCards({
  pending,
  disabled = false,
  onAnswer,
}: {
  pending: PendingGenerationQuestions;
  disabled?: boolean;
  /** The answers given, or `null` to skip the questions. */
  onAnswer: (answers: PyGenerationAnswer[] | null) => void;
}) {
  const { t } = useTranslation("generate");
  const titleId = useId();
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const given = pending.questions.flatMap(({ question }, index) => {
    const answer = answers[index]?.trim();
    return answer ? [{ question, answer }] : [];
  });
  const setAnswer = (index: number, answer: string) =>
    setAnswers((current) => ({ ...current, [index]: answer }));

  return (
    <section
      aria-labelledby={titleId}
      data-testid="generate-questions"
      className="border-border/70 bg-background my-3 space-y-3 rounded-xl border p-3"
    >
      <div className="space-y-0.5">
        <h3 id={titleId} className="text-sm font-medium">
          {t("questions.title")}
        </h3>
        <p className="text-muted-foreground text-xs">{t("questions.hint")}</p>
      </div>
      {pending.questions.map(({ question, options }, index) => (
        <fieldset
          // Questions are a fixed list for the card's life.
          key={index}
          className="min-w-0 space-y-1.5"
          disabled={disabled}
        >
          <legend className="text-sm">{question}</legend>
          {options.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {options.map((option, optionIndex) => {
                const chosen = answers[index] === option;
                return (
                  <PromptSuggestion
                    key={optionIndex}
                    aria-pressed={chosen}
                    data-testid="generate-question-option"
                    data-question={index}
                    data-option={optionIndex}
                    className={cn(
                      "h-auto min-h-7 max-w-full py-1 text-left whitespace-normal",
                      chosen && "border-primary/40 bg-primary/8 text-primary",
                    )}
                    onClick={() => setAnswer(index, chosen ? "" : option)}
                  >
                    {option}
                  </PromptSuggestion>
                );
              })}
            </div>
          ) : (
            <Input
              value={answers[index] ?? ""}
              maxLength={MAX_GENERATION_ANSWER_LENGTH}
              aria-label={t("questions.answerFor", { question })}
              placeholder={t("questions.answerPlaceholder")}
              data-testid="generate-question-answer"
              data-question={index}
              className="h-8 text-sm"
              onChange={(event) => setAnswer(index, event.target.value)}
            />
          )}
        </fieldset>
      ))}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          data-testid="generate-questions-skip"
          onClick={() => onAnswer(null)}
        >
          {t("questions.skip")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={disabled || given.length === 0}
          data-testid="generate-questions-submit"
          onClick={() => onAnswer(given)}
        >
          {t("questions.submit")}
        </Button>
      </div>
    </section>
  );
}

/**
 * The last run's failure with its retry (R2.4). A model, plan or connection
 * failure reads as it does in chat, beside the request that failed; this
 * block then only adds the actions. The assistant's own failures are worded
 * here. Where another model could do better (a model, plan or connection
 * failure, a refused model or effort, or no draft that works), it also
 * offers the model control.
 */
function GenerateFailure({
  failure,
  noticeShown,
  onRetry,
  onChooseModel,
  onDismiss,
}: {
  failure: GenerationRunFailure;
  /** The chat's failure notice is already shown in the transcript. */
  noticeShown: boolean;
  /** Send the failed request again; absent when the run had stored its draft. */
  onRetry?: () => void;
  /** Open the assistant's model control. */
  onChooseModel?: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("generate");
  const described = describeGenerationFailure(failure);
  const own = described.source === "assistant" ? described : null;
  return (
    <div
      className="my-3 space-y-2"
      data-testid="generate-failure"
      data-code={failure.code}
    >
      {noticeShown ? null : (
        <div
          role="alert"
          className="border-destructive/40 bg-background text-foreground rounded-lg border p-3"
        >
          <p className="text-sm font-medium">
            {own?.message ?? t("failure.model")}
          </p>
          {own?.detail ? (
            <p className="text-muted-foreground mt-1 text-xs">{own.detail}</p>
          ) : null}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {onRetry ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="generate-retry"
            onClick={onRetry}
          >
            {t("failure.retry")}
          </Button>
        ) : null}
        {onChooseModel && generationFailureSuggestsAnotherModel(described) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="generate-choose-model"
            onClick={onChooseModel}
          >
            {t("failure.chooseModel")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="generate-failure-dismiss"
          onClick={onDismiss}
        >
          {t("failure.dismiss")}
        </Button>
        <p className="text-muted-foreground text-xs">{t("failure.kept")}</p>
      </div>
    </div>
  );
}

/**
 * The conversation with the assistant: the transcript, what the run in flight
 * is doing, its questions and failure, and the request field with Send and,
 * during a run, Stop.
 */
export function GenerateConversation({
  snapshot,
  isLoading = false,
  loadFailed = false,
  onReload,
  controller,
  selectedDraft,
  onStartNewDraft,
  onChooseModel,
  framesStatus = "idle",
  autoFocus = false,
}: {
  snapshot: PyGenerationConversationSnapshot | undefined;
  /** The conversation is being read for the first time. */
  isLoading?: boolean;
  loadFailed?: boolean;
  onReload?: () => void;
  controller: GenerationRunController;
  /**
   * The selected draft, which the next message revises when it has a project;
   * `null`, or one without a project, means a new draft.
   */
  selectedDraft: PyGenerationDraft | null;
  /** Clear the selection, so the next message writes a new draft. */
  onStartNewDraft: () => void;
  /** Open the assistant's model control, offered beside a failure's retry. */
  onChooseModel?: () => void;
  /** Where the review sheets of the run in flight stand. */
  framesStatus?: DraftFramesStatus;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation("generate");
  const { run, questions } = controller;
  const [input, setInput] = useState("");
  // The draft the next message revises: the selected one, unless it has
  // nothing to revise (a failed write), which the backend would refuse.
  const revisedDraft =
    selectedDraft && draftCanBeRevised(selectedDraft) ? selectedDraft : null;
  const entries = useMemo(
    () => generationTranscript(snapshot, run),
    [snapshot, run],
  );
  const described = run.failure ? describeGenerationFailure(run.failure) : null;
  const { messages, failureShown } = generationChatMessages(t, entries, {
    questionsWaiting: Boolean(questions),
    failureNoticed: Boolean(run.failure) && !run.running,
    failure:
      run.failure && described?.source === "model"
        ? { message: run.failure.request.message, notice: described.failure }
        : undefined,
  });
  const lastEntry = entries.at(-1);
  const overLimit = input.length > MAX_GENERATION_MESSAGE_LENGTH;
  const hasDrafts = (snapshot?.drafts.length ?? 0) > 0;
  const ready = Boolean(snapshot) && !loadFailed;

  const submit = () => {
    const message = input.trim();
    if (!message || overLimit || run.running || !ready) return;
    setInput("");
    void controller
      .send(message, { draftId: revisedDraft?.id ?? null })
      .then((started) => {
        // A request that was not taken goes back into the field.
        if (!started) setInput((current) => current || message);
      });
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="generate-conversation"
    >
      <ChatTranscript className="min-h-40">
        <ChatTranscriptContent className="px-3 py-1">
          {loadFailed ? (
            <div className="space-y-2 p-4 text-center" role="alert">
              <p className="text-sm">{t("transcript.loadFailed")}</p>
              {onReload ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onReload}
                >
                  {t("page.retry")}
                </Button>
              ) : null}
            </div>
          ) : isLoading || !snapshot ? (
            <p
              className="text-muted-foreground p-4 text-center text-sm"
              role="status"
            >
              {t("transcript.loading")}
            </p>
          ) : messages.length === 0 && !run.running ? (
            <ChatTranscriptEmptyState
              className="px-2 py-8"
              title={t("transcript.emptyTitle")}
              description={t("transcript.emptyDescription")}
            />
          ) : (
            <ChatConversation
              messages={messages}
              isStreaming={run.running}
              markdownEnabled
              layout="chat-only"
            />
          )}
          {run.running ? (
            <div
              className="text-muted-foreground flex items-center gap-2 py-2 text-sm"
              role="status"
              data-testid="generate-progress"
              data-phase={run.phase ?? "starting"}
            >
              <MessageLoaderV2 />
              <span>{phaseText(t, run.phase)}</span>
            </div>
          ) : null}
          {run.running &&
          (framesStatus === "unavailable" || framesStatus === "failed") ? (
            <p className="text-muted-foreground pb-2 text-xs" role="status">
              {t("progress.framesUnavailable")}
            </p>
          ) : null}
          {!run.running &&
          run.stopped &&
          !run.failure &&
          lastEntry?.outcome !== "stopped" ? (
            <p
              className="text-muted-foreground py-2 text-xs"
              role="status"
              data-testid="generate-stopped"
            >
              {t("transcript.stopped")}
            </p>
          ) : null}
          {!run.running && run.failure ? (
            <GenerateFailure
              failure={run.failure}
              noticeShown={failureShown}
              // A run that stored its draft is not run a second time.
              onRetry={
                failedRunStoredDraft(run, entries)
                  ? undefined
                  : () => void controller.retry()
              }
              onChooseModel={onChooseModel}
              onDismiss={controller.dismissFailure}
            />
          ) : null}
          {questions ? (
            <GenerateQuestionCards
              // A new set of questions starts with no answers.
              key={JSON.stringify(questions.questions)}
              pending={questions}
              disabled={run.running}
              onAnswer={(answers) => void controller.answer(answers)}
            />
          ) : null}
        </ChatTranscriptContent>
        <ChatTranscriptScrollButton
          aria-label={t("transcript.scrollToLatest")}
        />
      </ChatTranscript>

      <div className="shrink-0 space-y-1.5 p-3 pt-2">
        {hasDrafts ? (
          <p
            className="text-muted-foreground flex min-h-5 items-center gap-2 px-1 text-xs"
            data-testid="generate-revision-target"
          >
            {revisedDraft ? (
              <>
                <span className="min-w-0 flex-1 truncate">
                  {t("composer.revises", {
                    name: draftName(revisedDraft) || t("drafts.unnamed"),
                  })}
                </span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto shrink-0 p-0 text-xs"
                  data-testid="generate-new-draft"
                  onClick={onStartNewDraft}
                >
                  {t("composer.newDraftInstead")}
                </Button>
              </>
            ) : (
              <span>{t("composer.writesNew")}</span>
            )}
          </p>
        ) : null}
        <ChatInput
          variant="default"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onSubmit={submit}
          loading={run.running}
          onStop={controller.stop}
          // The chat's submit control offers Stop only in its voice-capable
          // mode; without a run this composer sends text and nothing else.
          submitMode={run.running ? "text-or-voice" : "text-only"}
          disabled={!ready}
          className="border-border/70"
          actions={
            <ChatInputSubmit
              aria-label={run.running ? t("composer.stop") : t("composer.send")}
              data-testid={run.running ? "generate-stop" : "generate-send"}
              disabled={run.running ? false : !ready || overLimit}
            />
          }
        >
          <ChatInputTextArea
            autoFocus={autoFocus}
            className="bg-transparent"
            aria-label={t("composer.label")}
            placeholder={
              revisedDraft
                ? t("composer.revisePlaceholder")
                : t("composer.placeholder")
            }
            data-testid="generate-request"
          />
        </ChatInput>
        {overLimit ? (
          <p className="text-destructive px-1 text-xs" role="alert">
            {t("composer.tooLong", { max: MAX_GENERATION_MESSAGE_LENGTH })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
