import { Navigate, createFileRoute } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { useLocalRuntime } from "@/app/local-runtime/LocalRuntimeProvider";
import {
  readSetupDraft,
  SETUP_STEPS,
  writeSetupDraft,
  type SetupDraft,
  type SetupStep,
} from "@/app/local-runtime/setup-draft";
import { cn } from "@/lib/utils";
import {
  DISPLAY_NAME_MAX_LENGTH,
  normalizeLocalDisplayName,
} from "@/lib/user-profile/display-name";
import { useUserSettings } from "@/query/hooks/useUserSettings";
import { useMergeUserPreferences } from "@/query/mutations/useUpdateUserSettings";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import type { DesktopCredentialsController } from "@/ui/settings/DesktopCredentialsPanel";
import { LanguageSelect } from "@/ui/settings/LanguageSetting";
import { SetupAiStep } from "@/app/local-runtime/setup/SetupAiStep";
import { SetupVoiceStep } from "@/app/local-runtime/setup/SetupVoiceStep";
import {
  adjacentSetupStep,
  resolveSetupSttChoice,
  resolveSetupTtsProvider,
  setupStepLabel,
  setupStepPosition,
  setupTtsPatch,
} from "@/app/local-runtime/setup/setup-state";
import {
  recommendedSttChoice,
  sttChoicePatch,
  availableSttChoices,
} from "@/lib/speech/stt-choices";
import { routeOfflineSpeech } from "@/lib/speech/offline-stt/routing";
import { getSttProviderOptions } from "@/lib/speech/stt-provider";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";

export const Route = createFileRoute("/setup")({
  component: LocalSetupRoute,
});

function LocalSetupRoute() {
  const { state } = useLocalRuntime();
  if (state.status !== "ready") return null;
  if (state.firstRunComplete) return <Navigate to="/" replace />;
  return <LocalSetupForm key={state.principalId} ownerId={state.principalId} />;
}

/** A step's heading and the purpose line under it (Welcome has none). */
function stepHeading(
  t: TFunction<"setup">,
  step: SetupStep,
): [heading: string, purpose: string | null] {
  switch (step) {
    case "welcome":
      return [t("welcome.heading"), null];
    case "ai":
      return [t("ai.heading"), t("ai.purpose")];
    case "voice":
      return [t("voice.heading"), t("voice.purpose")];
  }
}

/**
 * Leaving AI or Voice: continue, go back, skip the step, or finish setup
 * (from Voice, with or without its Text-to-Speech choice).
 */
type LeaveAction = "back" | "continue" | "skip" | "finish";

/**
 * Three-step first run: **Welcome** (private name) → **AI** → **Voice**. The draft holds the step and
 * nonsecret choices; keys save in place through the key panels, and leaving
 * a step with an unsaved key asks to save or discard it first. Continuing from
 * AI while no chat model can reply asks first too; Skip does not. Downloads
 * are backend-owned, so they keep running after Finish. Age confirmation
 * follows the wizard, before opening the first Anima.
 */
function LocalSetupForm({ ownerId }: { ownerId: string }) {
  const { t, i18n } = useTranslation("setup");
  const platform = useRuntimePlatform();
  const [draft, setDraft] = useState(() => readSetupDraft(ownerId));
  const updateDraft = useCallback(
    (change: Partial<SetupDraft>) =>
      setDraft((current) => {
        const next = { ...current, ...change };
        // Save during the event: a fallback restart after a failed key
        // delivery can still replace this renderer. Losing the draft only
        // means choosing again; writing it again is harmless.
        writeSetupDraft(ownerId, next);
        return next;
      }),
    [ownerId],
  );
  const { step, displayName } = draft;
  const normalizedName = normalizeLocalDisplayName(displayName);
  const welcomeDone = Boolean(normalizedName);

  const userSettings = useUserSettings();
  const savedSpeech = userSettings.data?.preferences?.speech as
    | Parameters<typeof resolveSetupTtsProvider>[1]
    | undefined;
  const ttsProvider = resolveSetupTtsProvider(draft, savedSpeech);
  // Speech-to-Text: the web recommends the browser's recognizer, desktop the
  // UI Locale's offline model (desktop has no browser recognizer), which also
  // shows a saved offline choice without an engine. Read through `i18n` so
  // the tabs follow a language switch.
  const sttEngine = routeOfflineSpeech(i18n.resolvedLanguage).engine;
  const sttBrowserOptions = getSttProviderOptions(
    null,
    platform,
    sttEngine,
  ).filter((option) => option.id !== "parakeet");
  const sttChoices = availableSttChoices(sttEngine, sttBrowserOptions);
  const sttChoice = resolveSetupSttChoice(
    draft,
    savedSpeech,
    sttEngine,
    sttChoices,
  );
  const mergePreferences = useMergeUserPreferences();

  // The mounted step's key panel: unsaved edits and an in-flight save.
  const credentials = useRef<DesktopCredentialsController>(null);
  const [keyPending, setKeyPending] = useState(0);
  const [keyBusy, setKeyBusy] = useState(false);
  const [prompt, setPrompt] = useState<LeaveAction | null>(null);
  const [promptSaving, setPromptSaving] = useState(false);
  // The AI step's report: the model Animas will chat with can reply.
  const [chatReady, setChatReady] = useState(true);
  const [confirmNoModel, setConfirmNoModel] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SetupFailure | null>(null);

  // Focus each step's heading after navigation, not on first render.
  const heading = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);
  useEffect(() => {
    if (navigated.current) heading.current?.focus();
  }, [step]);

  const goTo = (next: SetupStep) => {
    // The previous step's key panel unmounts with its (saved or discarded) edits.
    setKeyPending(0);
    setKeyBusy(false);
    setChatReady(true);
    setError(null);
    navigated.current = true;
    updateDraft({ step: next });
  };
  const onChatModelChange = useCallback(
    (id: string | null) => updateDraft({ chatModelId: id }),
    [updateDraft],
  );

  const finish = async (withVoice: boolean) => {
    if (!normalizedName) return goTo("welcome");
    setSubmitting(true);
    setError(null);
    try {
      // The Speech-to-Text tab is always saved, so the recommended model
      // applies even when untouched; an untouched Text-to-Speech default is
      // not. Only a picked offline engine is saved: an untouched one keeps
      // following the UI Locale.
      const patch = withVoice
        ? {
            ...setupTtsPatch(draft),
            ...sttChoicePatch(sttChoice, {
              saveEngine: draft.sttChoice === sttChoice,
            }),
          }
        : null;
      // Read-merge-write: other preferences are kept.
      if (patch) await mergePreferences.mutateAsync({ speech: patch });
    } catch {
      setError("voiceSettings");
      setSubmitting(false);
      return;
    }
    // This marks only the wizard as finished. The next route still blocks
    // application content until the owner confirms their age explicitly.
    updateDraft({ awaitingAgeConfirmation: true });
    setSubmitting(false);
  };

  const perform = (action: LeaveAction) => {
    if (step === "welcome") return;
    if (action === "back") return goTo(step === "voice" ? "ai" : "welcome");
    if (step === "ai") {
      // Skipping AI keeps the system default model.
      if (action === "skip") updateDraft({ chatModelId: null });
      return goTo("voice");
    }
    void finish(action === "finish");
  };
  /**
   * Leave the step, first asking about unsaved key edits. Continue from AI
   * with no model that can reply asks too; the key prompt's own choices
   * (save or discard, then continue) already answer it.
   */
  const leave = (action: LeaveAction) => {
    if (keyBusy || submitting) return;
    if (keyPending > 0) setPrompt(action);
    else if (step === "ai" && action === "continue" && !chatReady)
      setConfirmNoModel(true);
    else perform(action);
  };

  const resolvePrompt = async (choice: "save" | "discard") => {
    const action = prompt;
    if (!action) return;
    if (choice === "discard") {
      credentials.current?.discard();
    } else {
      setPromptSaving(true);
      const saved = (await credentials.current?.save()) ?? false;
      setPromptSaving(false);
      // A failed save stays on the step; incomplete connection details
      // produce no panel message of their own.
      if (!saved) {
        setPrompt(null);
        setError("keyNotSaved");
        return;
      }
    }
    setPrompt(null);
    perform(action);
  };

  const handleWelcome = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedName) {
      setError("displayName");
      return;
    }
    goTo("ai");
  };

  const busy = submitting || keyBusy;
  const [stepTitle, stepPurpose] = stepHeading(t, step);
  const keyCallbacks = {
    credentialsController: credentials,
    onKeyPendingChange: setKeyPending,
    onKeyBusyChange: setKeyBusy,
  };

  if (draft.awaitingAgeConfirmation) return <Navigate to="/" replace />;

  return (
    <main className="bg-background text-foreground min-h-app mt-(--app-titlebar-height) flex items-start justify-center px-4 py-10 sm:items-center sm:px-6 sm:py-12">
      <div className="border-border bg-card w-full max-w-2xl space-y-6 rounded-3xl border p-5 shadow-sm sm:p-9">
        <SetupProgress step={step} />
        <header className="space-y-2">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-semibold outline-none"
          >
            {stepTitle}
          </h1>
          {stepPurpose ? (
            <p className="text-muted-foreground text-sm">{stepPurpose}</p>
          ) : null}
        </header>
        {step === "welcome" ? (
          <form onSubmit={handleWelcome} className="space-y-6">
            <WelcomeStep
              displayName={displayName}
              autoFocus={!navigated.current}
              onNameChange={(value) => {
                updateDraft({ displayName: value });
                setError(null);
              }}
            />
            <SetupError error={error} />
            <StepFooter>
              <span />
              <Button type="submit" disabled={!welcomeDone}>
                {t("actions.continue")}
              </Button>
            </StepFooter>
          </form>
        ) : (
          <div className="space-y-6">
            {step === "ai" ? (
              <SetupAiStep
                location={draft.modelLocation}
                onLocationChange={(modelLocation) =>
                  updateDraft({ modelLocation })
                }
                chatModelId={draft.chatModelId}
                onChatModelChange={onChatModelChange}
                onChatReadyChange={setChatReady}
                onSetUpLater={() => leave("skip")}
                {...keyCallbacks}
              />
            ) : (
              <SetupVoiceStep
                stt={{
                  choice: sttChoice,
                  choices: sttChoices,
                  recommended: recommendedSttChoice(sttEngine, sttChoices),
                  onChoiceChange: (choice) =>
                    updateDraft({ sttChoice: choice }),
                }}
                provider={ttsProvider}
                onProviderChange={(provider) =>
                  updateDraft({ ttsProvider: provider })
                }
                {...keyCallbacks}
              />
            )}
            <SetupError error={error} />
            {keyBusy ? (
              <p className="text-muted-foreground text-sm" role="status">
                {t("keys.saving")}
              </p>
            ) : null}
            <StepFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => leave("back")}
              >
                {t("actions.back")}
              </Button>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => leave("skip")}
                >
                  {t("actions.skip")}
                </Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    leave(adjacentSetupStep(step, 1) ? "continue" : "finish")
                  }
                >
                  {step === "voice"
                    ? submitting
                      ? t("actions.finishing")
                      : t("actions.finish")
                    : t("actions.continue")}
                </Button>
              </div>
            </StepFooter>
          </div>
        )}
      </div>
      <Dialog
        open={prompt !== null}
        onOpenChange={(open) => !open && !promptSaving && setPrompt(null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("keys.unsavedPrompt.title")}</DialogTitle>
            <DialogDescription>
              {t("keys.unsavedPrompt.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={promptSaving}
              onClick={() => setPrompt(null)}
            >
              {t("keys.unsavedPrompt.keepEditing")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={promptSaving}
              onClick={() => void resolvePrompt("discard")}
            >
              {t("keys.unsavedPrompt.discard")}
            </Button>
            <Button
              type="button"
              disabled={promptSaving}
              onClick={() => void resolvePrompt("save")}
            >
              {promptSaving
                ? t("keys.unsavedPrompt.saving")
                : t("keys.unsavedPrompt.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmNoModel} onOpenChange={setConfirmNoModel}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("ai.noModelPrompt.title")}</DialogTitle>
            <DialogDescription>
              {t("ai.noModelPrompt.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setConfirmNoModel(false);
                perform("continue");
              }}
            >
              {t("ai.noModelPrompt.continue")}
            </Button>
            {/* Focus starts on staying, so Enter does not skip the model. */}
            <Button
              type="button"
              autoFocus
              onClick={() => setConfirmNoModel(false)}
            >
              {t("ai.noModelPrompt.stay")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

/** "Step 2 of 3" and the step list, with the current step marked and the skippable steps labelled optional. */
function SetupProgress({ step }: { step: SetupStep }) {
  const { t } = useTranslation("setup");
  const current = SETUP_STEPS.indexOf(step);
  return (
    <nav aria-label={t("progress.label")} className="space-y-2">
      <p className="text-muted-foreground text-xs font-medium">
        {setupStepPosition(step, t)}
      </p>
      <ol className="grid grid-cols-3 gap-2">
        {SETUP_STEPS.map((item, index) => (
          <li
            key={item}
            aria-current={item === step ? "step" : undefined}
            className={cn(
              "border-t-4 pt-1.5 text-xs",
              index <= current
                ? "border-primary text-foreground font-medium"
                : "border-muted text-muted-foreground",
            )}
          >
            {setupStepLabel(item, t)}
            {item === "welcome" ? null : (
              <span className="text-muted-foreground text-2xs ml-1 font-normal">
                {t("progress.optional")}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The private display name is the only required wizard answer. The language
 * applies and saves as soon as it is picked, so the rest of setup follows it.
 */
function WelcomeStep({
  displayName,
  autoFocus,
  onNameChange,
}: {
  displayName: string;
  autoFocus: boolean;
  onNameChange: (value: string) => void;
}) {
  const { t } = useTranslation(["setup", "settings"]);
  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="local-display-name">
            {t("welcome.displayName.label")}
          </Label>
          <span className="text-muted-foreground text-xs">
            {displayName.length}/{DISPLAY_NAME_MAX_LENGTH}
          </span>
        </div>
        <Input
          id="local-display-name"
          value={displayName}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          required
          autoComplete="name"
          autoFocus={autoFocus}
          placeholder={t("welcome.displayName.placeholder")}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="local-language">{t("settings:language.label")}</Label>
        <LanguageSelect id="local-language" className="w-full" />
      </div>
    </>
  );
}

/** A failure the current step reports below its fields. */
type SetupFailure = "displayName" | "keyNotSaved" | "voiceSettings";

function setupFailureText(t: TFunction<"setup">, failure: SetupFailure) {
  switch (failure) {
    case "displayName":
      return t("errors.displayName", { max: DISPLAY_NAME_MAX_LENGTH });
    case "keyNotSaved":
      return t("errors.keyNotSaved");
    case "voiceSettings":
      return t("errors.voiceSettings");
  }
}

function SetupError({ error }: { error: SetupFailure | null }) {
  const { t } = useTranslation("setup");
  return error ? (
    <p className="text-destructive text-sm" role="alert">
      {setupFailureText(t, error)}
    </p>
  ) : null;
}

function StepFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {children}
    </div>
  );
}
