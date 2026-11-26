/**
 * Public IPC contracts contain status only; credentials and host paths stay in
 * main. Built-in provider keys, in the order App Settings → API Keys lists them.
 */
export const credentialProviders = [
  "openai",
  "anthropic",
  "elevenlabs",
  "gemini",
] as const;
export type CredentialProvider = (typeof credentialProviders)[number];
/**
 * Environment name the backend reads for a model connection's managed key
 * (`ANIMAMA_CONNECTION_<ID>_API_KEY`); main stores at most
 * `maxConnectionCredentials` of them.
 */
export const connectionCredentialPattern =
  /^ANIMAMA_CONNECTION_[A-Z0-9_]{1,64}_API_KEY$/u;
export const maxConnectionCredentials = 32;
/**
 * The variable a connection key's origin travels under, beside the key:
 * `ANIMAMA_CONNECTION_<NAME>_ORIGIN` for `ANIMAMA_CONNECTION_<NAME>_API_KEY`.
 */
export function connectionOriginVariable(connection: string): string {
  return connection.replace(/_API_KEY$/u, "_ORIGIN");
}
/**
 * The origin (`scheme://host[:port]`) of an http(s) URL as `URL.origin` gives
 * it, or `null` for anything else. A connection key is saved with the origin
 * of its address, and the backend sends it nowhere else.
 */
export function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
/** Largest renderer batch: every provider plus several connection keys. */
export const maxCredentialChanges = 8;
type CredentialState = {
  configured: boolean;
  updatedAt: string | null;
  restartRequired: boolean;
  error?: string;
};
export type ProviderCredentialStatus = CredentialState & {
  provider: CredentialProvider;
};
/** A saved model-connection key, named by its environment variable. */
export type ConnectionCredentialStatus = CredentialState & {
  connection: string;
};
export type CredentialStatus =
  | ProviderCredentialStatus
  | ConnectionCredentialStatus;
/** Narrow a status to a built-in provider key. */
export function isProviderCredential(
  status: CredentialStatus,
): status is ProviderCredentialStatus {
  return "provider" in status;
}
export type RuntimeStage =
  | "validating"
  | "vault"
  | "application"
  | "database"
  | "migrations"
  | "backend";
export type RuntimeStatus =
  | { state: "external" }
  | { state: "starting"; stage: RuntimeStage }
  | { state: "ready"; origin: string }
  | { state: "error"; code: string; backup?: string }
  | { state: "stopping" }
  | { state: "updating" }
  | { state: "stopped" };
export type RuntimeBridge = {
  status(): Promise<RuntimeStatus>;
  retry(): Promise<void>;
  openLogs(): Promise<void>;
  openBackups(): Promise<void>;
  quit(): Promise<void>;
  /**
   * The owner's Continue when startup stops with
   * `unprotected_storage_consent_required` (Linux without a secret store):
   * save keys without system protection and carry on starting.
   */
  acceptUnprotectedStorage(): Promise<void>;
  onStatus(callback: (status: RuntimeStatus) => void): () => void;
};
/**
 * What protects saved keys: the operating system's secret store, or, on a
 * Linux desktop without one, only the vault file's permissions.
 */
export type CredentialStorage = { protection: "system" | "unprotected" };
/**
 * One key change in a batch, for a built-in provider or a model connection;
 * an omitted value removes the saved key. A connection key is saved with the
 * origin (`scheme://host[:port]`) of the address it was entered for; the
 * backend sends it nowhere else.
 */
export type CredentialChange =
  | { provider: CredentialProvider; value?: string }
  | { connection: string; value?: string; origin?: string };
/** The provider name or connection variable a change or status refers to. */
export function credentialTarget(
  item: CredentialChange | CredentialStatus,
): string {
  return "provider" in item ? item.provider : item.connection;
}
export type CredentialsBridge = {
  /** Every provider's status, then each saved or failed connection key. */
  list(): Promise<CredentialStatus[]>;
  /**
   * Save or remove several keys and apply them to the running backend without
   * a restart. Returns every status; failed entries carry their own `error`.
   */
  apply(changes: CredentialChange[]): Promise<CredentialStatus[]>;
  /** How saved keys are protected, for a notice where keys are entered. */
  storage(): Promise<CredentialStorage>;
};
export const featurePackIds = ["expanded-included-content"] as const;
export type FeaturePackId = (typeof featurePackIds)[number];
export type FeaturePackStatus = {
  id: FeaturePackId;
  state:
    | "not_installed"
    | "downloading"
    | "verifying"
    | "installing"
    | "installed"
    | "failed"
    | "update_available";
  available: boolean;
  version?: string;
  activeVersion?: string;
  hasInstalledFiles?: boolean;
  assetVersion?: string;
  downloadBytes?: number;
  installedBytes?: number;
  minimumFreeBytes?: number;
  transferredBytes?: number;
  progress?: number;
  error?: string;
  blockers?: { kind: string; id: string; label: string }[];
};
export type FeaturePacksBridge = {
  list(): Promise<FeaturePackStatus[]>;
  install(id: FeaturePackId): Promise<void>;
  cancel(id: FeaturePackId): Promise<void>;
  remove(id: FeaturePackId): Promise<void>;
  onProgress(callback: (value: FeaturePackStatus) => void): () => void;
};
/** Main-window only: the shell follows the UI Locale the app applied. */
export type LocaleBridge = {
  /**
   * Report the applied UI Locale (a canonical tag from
   * `@animama/runtime-contracts/locale`, never the pseudo-locale). The shell
   * caches it for its startup page and relabels its menu and window titles;
   * main rejects other tags and other windows.
   */
  setApplied(locale: string): Promise<void>;
};
/**
 * Whether the OS opens the app at login. Packaged macOS and Windows apps and
 * a Linux AppImage offer it. `blockedBySystem` means the app asked to open at
 * login but that will not happen yet: the OS waits for the user to allow it,
 * or, on Linux, the AppImage has moved since the setting was turned on.
 */
export type LoginItemStatus =
  | { available: false }
  | { available: true; enabled: boolean; blockedBySystem: boolean };
/** Main-window only: the OS keeps the setting, so the shell stores nothing. */
export type LoginItemBridge = {
  status(): Promise<LoginItemStatus>;
  setEnabled(enabled: boolean): Promise<LoginItemStatus>;
};
/**
 * A Linux AppImage's application-menu entry, which exists only if the owner
 * turns it on. `stale` means the entry names a file that is no longer the
 * running AppImage; turning it on again repoints it.
 */
export type MenuEntryStatus =
  | { available: false }
  | { available: true; enabled: boolean; stale: boolean };
/** Main-window only: the entry file itself is the stored state. */
export type MenuEntryBridge = {
  status(): Promise<MenuEntryStatus>;
  setEnabled(enabled: boolean): Promise<MenuEntryStatus>;
};
/** Application-menu items that act in the main window's web app. */
export type MenuCommand = "check-for-updates" | "import-anima";
/** Commands chosen from the application menu; main sends them to the main window only. */
export type MenuBridge = {
  onCommand(callback: (command: MenuCommand) => void): () => void;
};
export type UpdatesBridge = {
  status(): Promise<UpdateStatus>;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  restart(): Promise<void>;
  onStatus(callback: (status: UpdateStatus) => void): () => void;
};
export type UpdateStatus =
  | { state: "unavailable" | "idle" | "checking" | "up_to_date" }
  | {
      state: "available" | "downloaded";
      version: string;
      downloadBytes: number;
      minimumFreeBytes: number;
    }
  | {
      state: "downloading";
      version: string;
      downloadBytes: number;
      minimumFreeBytes: number;
      progress: number;
    }
  | { state: "restarting"; version: string }
  | {
      state: "error";
      code: string;
      retry: "check" | "download" | "restart";
      version?: string;
    };
