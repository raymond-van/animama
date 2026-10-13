import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { useLocalRuntime } from "../LocalRuntimeProvider";
import { useRuntimeAdmission } from "../../runtime/RuntimeAdmissionProvider";
import {
  clearSetupDraft,
  readSetupDraft,
  writeSetupDraft,
  type SetupDraft,
} from "../setup-draft";
import { normalizeLocalDisplayName } from "@/lib/user-profile/display-name";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import { queryKeys } from "@/query/keys";
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
  modelConfigurationErrorCode,
  modelSettingsAvailability,
} from "@/ui/settings/models/model-configuration-state";

/** Load the app behind an inert boundary while explicit confirmation is pending. */
export function FirstRunAgeConfirmation({ children }: { children: ReactNode }) {
  const { admission } = useRuntimeAdmission();
  const { state } = useLocalRuntime();
  const pending = admission.status === "ready" && admission.onboardingRequired;
  const draft =
    pending && state.status === "ready"
      ? readSetupDraft(state.principalId)
      : null;
  if (pending) {
    if (!draft) return null;
    if (
      !draft.awaitingAgeConfirmation ||
      !normalizeLocalDisplayName(draft.displayName)
    )
      return <Navigate to="/setup" replace ignoreBlocker />;
  }
  return (
    <>
      {/* Keep this boundary stable so accepting never remounts the loaded app. */}
      <div className="contents" inert={pending}>
        {children}
      </div>
      {pending && draft && state.status === "ready" ? (
        <AgeConfirmation
          key={state.principalId}
          ownerId={state.principalId}
          draft={draft}
        />
      ) : null}
    </>
  );
}

/** The app can prepare its avatar, but only this dialog completes onboarding. */
function AgeConfirmation({
  ownerId,
  draft,
}: {
  ownerId: string;
  draft: SetupDraft;
}) {
  const { completeOnboarding } = useLocalRuntime();
  const navigate = useNavigate();
  const capabilities = useRuntimeCapabilities();
  const { modelConfiguration } = modelSettingsAvailability(capabilities.data);
  const queryClient = useQueryClient();
  const [declined, setDeclined] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const backToSetup = () => {
    writeSetupDraft(ownerId, { ...draft, awaitingAgeConfirmation: false });
    void navigate({ to: "/setup", replace: true });
  };
  const confirm = async () => {
    if (submitting || !capabilities.isSuccess) return;
    setSubmitting(true);
    setError(null);
    try {
      // Only this explicit button press supplies true. A restored wizard draft
      // never supplies the attestation, even if an older draft recorded one.
      await completeOnboarding({
        displayName: normalizeLocalDisplayName(draft.displayName)!,
        adultConfirmed: true,
        ...(modelConfiguration && draft.chatModelId
          ? { chatModelProviderId: draft.chatModelId }
          : {}),
      });
      clearSetupDraft(ownerId);
      for (const queryKey of [
        queryKeys.userProfile.all(ownerId),
        queryKeys.settings.all(ownerId),
        queryKeys.animas.all(ownerId),
        queryKeys.modelConfiguration.all(ownerId),
        queryKeys.modelProviders.all(ownerId),
      ])
        void queryClient.invalidateQueries({ queryKey });
    } catch (cause) {
      setError(
        modelConfigurationErrorCode(cause) === "chat_model_unavailable"
          ? "The chosen model can no longer be used. Go back to setup and choose another, or skip AI."
          : "Setup could not be saved. Please try again.",
      );
      setSubmitting(false);
    }
  };

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Before you start</DialogTitle>
          <DialogDescription>
            Animama is for adults 18 and older. Animas are AI companions, not
            people.
          </DialogDescription>
        </DialogHeader>
        <Link
          to="/safety"
          className="text-muted-foreground text-xs underline underline-offset-2"
        >
          Safety and crisis protocol
        </Link>
        {declined ? (
          <p role="status" className="text-sm">
            Animama is only for adults 18 and older. You can&apos;t continue to
            chat.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {capabilities.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-destructive text-sm">
              AI settings could not be checked. Please try again.
            </p>
            <Button
              variant="outline"
              disabled={capabilities.isFetching}
              onClick={() => void capabilities.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        <Button
          type="button"
          variant="link"
          size="sm"
          disabled={submitting}
          onClick={backToSetup}
          className="text-muted-foreground h-auto w-fit justify-start p-0 text-xs"
        >
          Back to setup
        </Button>
        <DialogFooter>
          {declined ? (
            <Button variant="outline" onClick={() => setDeclined(false)}>
              Go back
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                disabled={submitting}
                onClick={() => setDeclined(true)}
              >
                I&apos;m under 18
              </Button>
              <Button
                disabled={submitting || !capabilities.isSuccess}
                onClick={() => void confirm()}
              >
                {submitting ? "Opening…" : "I am 18 or older"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
