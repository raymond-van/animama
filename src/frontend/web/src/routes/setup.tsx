import { Navigate, createFileRoute } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { useLocalRuntime } from "@web/app/local-runtime/LocalRuntimeProvider";
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
import { SetupAiStep } from "@/app/local-runtime/setup/SetupAiStep";
import { SetupVoiceStep } from "@/app/local-runtime/setup/SetupVoiceStep";
import {
  adjacentSetupStep,
  resolveSetupTtsProvider,
  SETUP_STEP_LABELS,
  setupStepPosition,
  setupTtsPatch,
} from "@/app/local-runtime/setup/setup-state";

export const Route = createFileRoute("/setup")({
  component: LocalSetupRoute,
});

function LocalSetupRoute() {
  const { state } = useLocalRuntime();
  if (state.status !== "ready") return null;
  if (state.firstRunComplete) return <Navigate to="/" replace />;
  return <LocalSetupForm key={state.principalId} ownerId={state.principalId} />;
}

const STEP_HEADINGS: Record<SetupStep, string> = {
  welcome: "What should Animama call you?",
  ai: "Choose your AI",
  voice: "Set up voice",
};

const STEP_PURPOSE: Record<SetupStep, string | null> = {
  welcome: null,
  ai: "Pick the model your Animas chat with.",
  voice: "Talk to your Animas and hear them reply.",
};

/**
 * Leaving AI or Voice: continue, go back, skip the step, or finish setup
 * (from Voice, with or without its Text-to-Speech choice).
 */
type LeaveAction = "back" | "continue" | "skip" | "finish";

/**
 * Three-step first run: **Welcome** (private name) → **AI** → **Voice**. The draft holds the step and
 * nonsecret choices; keys save in place through the key panels, and leaving
 * a step with an unsaved key asks to save or discard it first. Downloads are
 * backend-owned, so they keep running after Finish. Age confirmation follows
 * the wizard, before opening the first Anima.
 */
function LocalSetupForm({ ownerId }: { ownerId: string }) {
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
  const mergePreferences = useMergeUserPreferences();

  // The mounted step's key panel: unsaved edits and an in-flight save.
  const credentials = useRef<DesktopCredentialsController>(null);
  const [keyPending, setKeyPending] = useState(0);
  const [keyBusy, setKeyBusy] = useState(false);
  const [prompt, setPrompt] = useState<LeaveAction | null>(null);
  const [promptSaving, setPromptSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const patch = withVoice ? setupTtsPatch(draft) : null;
      // Read-merge-write: other preferences are kept.
      if (patch) await mergePreferences.mutateAsync({ speech: patch });
    } catch {
      setError(
        "Voice settings could not be saved. Try again, or skip this step.",
      );
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
  /** Leave the step, first asking about unsaved key edits. */
  const leave = (action: LeaveAction) => {
    if (keyBusy || submitting) return;
    if (keyPending > 0) setPrompt(action);
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
        setError(
          "Your key wasn't saved. Complete the details on this step, or discard the key.",
        );
        return;
      }
    }
    setPrompt(null);
    perform(action);
  };

  const handleWelcome = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedName) {
      setError("Enter a display name between 1 and 80 characters.");
      return;
    }
    goTo("ai");
  };

  const busy = submitting || keyBusy;
  const keyCallbacks = {
    credentialsController: credentials,
    onKeyPendingChange: setKeyPending,
    onKeyBusyChange: setKeyBusy,
  };

  if (draft.awaitingAgeConfirmation) return <Navigate to="/" replace />;

  return (
    <main className="bg-background text-foreground flex min-h-screen items-start justify-center px-4 py-10 sm:items-center sm:px-6 sm:py-12">
      <div className="border-border bg-card w-full max-w-2xl space-y-6 rounded-3xl border p-5 shadow-sm sm:p-9">
        <SetupProgress step={step} />
        <header className="space-y-2">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-semibold outline-none"
          >
            {STEP_HEADINGS[step]}
          </h1>
          {STEP_PURPOSE[step] ? (
            <p className="text-muted-foreground text-sm">
              {STEP_PURPOSE[step]}
            </p>
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
                Continue
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
                onSetUpLater={() => leave("skip")}
                {...keyCallbacks}
              />
            ) : (
              <SetupVoiceStep
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
                Saving your key…
              </p>
            ) : null}
            <StepFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => leave("back")}
              >
                Back
              </Button>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => leave("skip")}
                >
                  Skip for now
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
                      ? "Finishing…"
                      : "Finish"
                    : "Continue"}
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
            <DialogTitle>Save your API key?</DialogTitle>
            <DialogDescription>
              You entered a key that isn&apos;t saved yet. Save it now, or
              discard it and continue.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={promptSaving}
              onClick={() => setPrompt(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={promptSaving}
              onClick={() => void resolvePrompt("discard")}
            >
              Discard
            </Button>
            <Button
              type="button"
              disabled={promptSaving}
              onClick={() => void resolvePrompt("save")}
            >
              {promptSaving ? "Saving…" : "Save key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

/** "Step 2 of 3" and the step list, with the current step marked and the skippable steps labelled optional. */
function SetupProgress({ step }: { step: SetupStep }) {
  const current = SETUP_STEPS.indexOf(step);
  return (
    <nav aria-label="Setup progress" className="space-y-2">
      <p className="text-muted-foreground text-xs font-medium">
        {setupStepPosition(step)}
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
            {SETUP_STEP_LABELS[item]}
            {item === "welcome" ? null : (
              <span className="text-muted-foreground text-2xs ml-1 font-normal">
                (optional)
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The private display name is the only required wizard answer. */
function WelcomeStep({
  displayName,
  autoFocus,
  onNameChange,
}: {
  displayName: string;
  autoFocus: boolean;
  onNameChange: (value: string) => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="local-display-name">Display name</Label>
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
          placeholder="Your name"
          onChange={(event) => onNameChange(event.target.value)}
        />
      </div>
    </>
  );
}

function SetupError({ error }: { error: string | null }) {
  return error ? (
    <p className="text-destructive text-sm" role="alert">
      {error}
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
