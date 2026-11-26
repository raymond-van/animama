import { useEffect, useId, useState } from "react";
import type { TFunction } from "i18next";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { PyChatGptPlanStatus } from "@animama/runtime-contracts/api-types";
import { matchLocale } from "@animama/runtime-contracts/locale";
import { readApiError } from "@/lib/errors/apiError";
import { cn } from "@/lib/utils";
import {
  CHATGPT_MANAGE_USAGE_URL,
  useChatGPTPlan,
} from "@/query/hooks/useChatGPTPlan";
import {
  useBeginChatGPTPlanSignIn,
  useCancelChatGPTPlanSignIn,
  useSignOutOfChatGPTPlan,
  useUpdateChatGPTPlanPreferences,
} from "@/query/mutations/useChatGPTPlan";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";
import { Switch } from "@/ui/components/switch";

/**
 * "Use your ChatGPT plan" (spec #919 R1): sign in at OpenAI in the browser,
 * then show the account, plan use, **Manage usage**, the background choice
 * and sign-out. Shared by App Settings → Models and setup's AI step.
 *
 * OpenAI's sign-in URL carries the attempt's state, so it is held in memory
 * only, by this card while the sign-in waits and by nothing once it ends
 * (the begin mutation keeps no result): opened once, offered again while
 * waiting, never logged.
 * Desktop opens it in the system browser; a browser opens a new tab. While the
 * browser is away the status is read every second, so the card moves on as
 * soon as OpenAI sends the person back.
 */
export function ChatGPTPlanCard({
  disabled = false,
  headingLevel = 4,
}: {
  disabled?: boolean;
  /** 3 where the card stands among a page's provider sections (setup). */
  headingLevel?: 3 | 4;
}) {
  const { t, i18n } = useTranslation("models");
  const headingId = useId();
  const status = useChatGPTPlan();
  const begin = useBeginChatGPTPlanSignIn();
  const cancel = useCancelChatGPTPlanSignIn();
  const signOut = useSignOutOfChatGPTPlan();
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [unconfirmedSignOut, setUnconfirmedSignOut] = useState(false);
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const pending = status.data?.sign_in_pending === true;
  // Once the browser came back or the attempt ended, its URL is spent.
  useEffect(() => {
    if (!pending) setAuthorizeUrl(null);
  }, [pending]);

  const start = async (enablePlanUse = false) => {
    setUnconfirmedSignOut(false);
    try {
      const url = await begin.mutateAsync({
        enablePlanUse,
        uiLocale: matchLocale(i18n.resolvedLanguage ?? i18n.language),
      });
      // The card holds the URL while the sign-in waits; the mutation keeps no copy.
      begin.reset();
      setAuthorizeUrl(url);
      openInBrowser(url);
    } catch (error) {
      toast.error(beginFailure(error, t));
    }
  };

  const stopWaiting = async () => {
    setAuthorizeUrl(null);
    try {
      await cancel.mutateAsync();
    } catch {
      // The attempt expires by itself; the status read decides what shows.
    }
  };

  const leave = async () => {
    try {
      const result = await signOut.mutateAsync();
      setUnconfirmedSignOut(!result.confirmed);
      if (result.confirmed) toast.success(t("chatgptPlan.signedOut"));
    } catch {
      toast.error(t("chatgptPlan.signOutFailed"));
    }
  };

  // A failed poll keeps the last status on screen; only a first read that failed has nothing to show.
  const plan = status.data;
  if (!plan)
    return status.isError ? (
      <p className="text-muted-foreground text-sm" role="status">
        {t("chatgptPlan.loadFailed")}
      </p>
    ) : null;
  const signedIn = plan.state === "signed_in";
  const busy = disabled || begin.isPending || signOut.isPending;

  /** Where a sign-in would start: the action, or why it cannot start here. */
  const signInAction = (label: string, enablePlanUse = false) =>
    plan.sign_in_available ? (
      <Button
        type="button"
        size="sm"
        disabled={busy}
        onClick={() => void start(enablePlanUse)}
        className={
          enablePlanUse
            ? undefined
            : "bg-foreground text-background hover:bg-foreground/90"
        }
      >
        {label}
      </Button>
    ) : (
      <p className="text-muted-foreground text-sm" role="status">
        {plan.unavailable_reason === "secure_storage_unavailable"
          ? t("chatgptPlan.unavailable.secureStorage")
          : t("chatgptPlan.unavailable.remoteOrigin")}
      </p>
    );
  const failure = plan.failure ? (
    <p className="text-destructive text-sm" role="alert">
      {plan.failure === "access_denied"
        ? t("chatgptPlan.failure.declined")
        : t("chatgptPlan.failure.other")}
    </p>
  ) : null;

  return (
    <section
      aria-labelledby={headingId}
      className="border-border/60 space-y-3 rounded-xl border p-4"
    >
      <div className="space-y-1">
        <Heading id={headingId} className="text-sm font-semibold">
          {t("chatgptPlan.title")}
        </Heading>
        <p className="text-muted-foreground text-xs">
          {signedIn
            ? plan.email
              ? t("chatgptPlan.signedInAs", { email: plan.email })
              : t("chatgptPlan.signedIn")
            : t("chatgptPlan.notSignedIn")}
        </p>
      </div>
      <p className="text-muted-foreground text-sm">
        {t("chatgptPlan.description")}
      </p>

      {plan.sign_in_pending ? (
        <div className="space-y-2" role="status">
          <p className="text-sm">{t("chatgptPlan.waiting")}</p>
          <div className="flex flex-wrap gap-2">
            {authorizeUrl ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => openInBrowser(authorizeUrl)}
              >
                <ExternalLink className="size-4" aria-hidden />
                {t("chatgptPlan.openAgain")}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={cancel.isPending}
              onClick={() => void stopWaiting()}
            >
              {t("actions.cancel")}
            </Button>
          </div>
        </div>
      ) : signedIn && plan.plan_use_granted ? (
        // The account's controls stay even where a new sign-in cannot start.
        <SignedIn plan={plan} disabled={busy} onSignOut={() => void leave()} />
      ) : signedIn ? (
        <div className="space-y-2">
          <p className="text-sm" role="status">
            {t("chatgptPlan.planUseOff")}
          </p>
          {failure}
          <div className="flex flex-wrap items-center gap-2">
            {signInAction(t("chatgptPlan.enablePlanUse"), true)}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void leave()}
            >
              {t("chatgptPlan.signOut")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {plan.state === "sign_in_required" ? (
            <p className="text-sm" role="status">
              {t("chatgptPlan.signInRequired")}
            </p>
          ) : null}
          {failure}
          {signInAction(t("chatgptPlan.continue"))}
          {plan.state === "sign_in_required" ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void leave()}
            >
              {t("chatgptPlan.signOut")}
            </Button>
          ) : null}
        </div>
      )}

      {unconfirmedSignOut ? (
        <p className="text-sm" role="alert">
          {t("chatgptPlan.signOutUnconfirmed")}
        </p>
      ) : null}
      {plan.confirmation_due ? <ChatGPTPlanConfirmation /> : null}
    </section>
  );
}

/** The signed-in state: plan use, usage, the background choice and sign-out. */
function SignedIn({
  plan,
  disabled,
  onSignOut,
}: {
  plan: PyChatGptPlanStatus;
  disabled: boolean;
  onSignOut: () => void;
}) {
  const { t } = useTranslation("models");
  const backgroundId = useId();
  const backgroundHintId = useId();
  const preferences = useUpdateChatGPTPlanPreferences();
  const setBackground = async (agreed: boolean) => {
    try {
      await preferences.mutateAsync({ background_agreed: agreed });
    } catch {
      toast.error(t("chatgptPlan.preferencesFailed"));
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">{t("chatgptPlan.planUseOn")}</p>
        <ManageUsageLink />
      </div>
      {plan.paused ? (
        <p className="text-sm" role="status">
          {t("chatgptPlan.paused")}
        </p>
      ) : null}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <label htmlFor={backgroundId} className="text-sm font-medium">
            {t("chatgptPlan.background.label")}
          </label>
          <p id={backgroundHintId} className="text-muted-foreground text-xs">
            {t("chatgptPlan.background.description")}
          </p>
        </div>
        <Switch
          id={backgroundId}
          aria-describedby={backgroundHintId}
          checked={plan.background_agreed}
          disabled={disabled || preferences.isPending}
          onCheckedChange={(checked) => void setBackground(checked)}
        />
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={onSignOut}
      >
        {t("chatgptPlan.signOut")}
      </Button>
    </div>
  );
}

/** **Manage usage**: ChatGPT's own usage settings, in the browser. */
export function ManageUsageLink({ className }: { className?: string }) {
  const { t } = useTranslation("models");
  return (
    <a
      href={CHATGPT_MANAGE_USAGE_URL}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "text-foreground decoration-foreground/40 hover:decoration-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm text-sm font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none",
        className,
      )}
    >
      {t("chatgptPlan.manageUsage")}
      <ExternalLink className="size-3" aria-hidden />
      <span className="sr-only"> {t("chatgptPlan.opensInBrowser")}</span>
    </a>
  );
}

/**
 * The one-time "You're using your ChatGPT plan" confirmation (R1.3), shown
 * once after the first sign-in with plan use. It names what uses the plan
 * and asks, unchecked, whether automatic memory updates may (R4.1).
 */
function ChatGPTPlanConfirmation() {
  const { t } = useTranslation("models");
  const checkboxId = useId();
  const [background, setBackground] = useState(false);
  const preferences = useUpdateChatGPTPlanPreferences();
  const confirm = async () => {
    try {
      await preferences.mutateAsync({
        confirmed: true,
        background_agreed: background,
      });
    } catch {
      toast.error(t("chatgptPlan.preferencesFailed"));
    }
  };
  return (
    <Dialog open>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("chatgptPlan.confirmation.title")}</DialogTitle>
          <DialogDescription>
            {t("chatgptPlan.confirmation.description")}
          </DialogDescription>
        </DialogHeader>
        <ManageUsageLink />
        <div className="flex items-start gap-2">
          <Checkbox
            id={checkboxId}
            checked={background}
            onCheckedChange={(checked) => setBackground(checked === true)}
          />
          <label htmlFor={checkboxId} className="space-y-0.5 text-sm">
            <span className="block font-medium">
              {t("chatgptPlan.confirmation.background")}
            </span>
            <span className="text-muted-foreground block text-xs">
              {t("chatgptPlan.confirmation.backgroundHint")}
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button
            type="button"
            autoFocus
            disabled={preferences.isPending}
            onClick={() => void confirm()}
          >
            {t("chatgptPlan.confirmation.gotIt")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Open the sign-in page in the browser without giving it a handle on this
 * page. Desktop's window-open handler hands it to the system browser.
 */
function openInBrowser(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Why a sign-in could not start, worded from the backend's code. */
function beginFailure(error: unknown, t: TFunction<"models">): string {
  const failure = readApiError(error);
  if (failure.reason === "secure_storage_unavailable")
    return t("chatgptPlan.unavailable.secureStorage");
  if (failure.reason === "remote_origin")
    return t("chatgptPlan.unavailable.remoteOrigin");
  return t("chatgptPlan.beginFailed");
}
