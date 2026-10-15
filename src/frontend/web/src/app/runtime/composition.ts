import type {
  ProductRuntimeComposition,
  RuntimeAdmission,
} from "@animama/runtime-contracts";
import type { LocalOnboardingInput } from "../local-runtime/LocalRuntimeProvider";
import type { SessionRequestScope } from "./session-requests";
import type {
  HostedLocaleInput,
  UiLocale,
} from "@animama/runtime-contracts/locale";

/**
 * Why a composition asks for readmission. `true` ends the current session;
 * `"uncertain"` reports transport doubt and retries with backoff; `"recheck"`
 * reports a server signal that admission may have ended, so the context is read
 * now and alone decides. Both suspend authority-dependent requests meanwhile.
 */
export type AdmissionRefresh = boolean | "uncertain" | "recheck";

/** Account controls a composition can offer now; they follow each admission read. */
export type AccountAffordances = {
  /** A validated central account URL is available for the Account controls. */
  readonly canOpenAccount: boolean;
  /** A requested sign-out has not finished; retrying it is the way forward. */
  readonly signOutIncomplete: boolean;
};

/** Entrypoint-owned lifecycle hooks. Feature modules consume admission, never installation policy. */
export interface AppComposition extends ProductRuntimeComposition {
  readonly kind: "local" | "hosted";
  readonly subscribe?: (
    refresh: (invalidate?: AdmissionRefresh) => void,
  ) => () => void;
  readonly bindSession?: (scope: SessionRequestScope | null) => void;
  readonly completeOnboarding?: (
    input: LocalOnboardingInput,
  ) => Promise<RuntimeAdmission>;
  /** Read whenever admission is published; compositions without accounts omit it. */
  readonly accountAffordances?: () => AccountAffordances;
  /** Optional display authority, independent of admission and session lifetime. */
  readonly localeInput?: () => HostedLocaleInput | null;
  /** Confirmed explicit preference writes also select/clear the visitor choice. */
  readonly confirmLocale?: (locale: UiLocale | null) => void;
  /** Drop account-derived display state as soon as sign-out begins. */
  readonly clearLocalePreference?: () => void;
}
