import {
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import {
  featurePackIds,
  type CredentialStatus,
  type CredentialStorage,
  type RuntimeStatus,
  type FeaturePackStatus,
  type FeaturePackId,
  type LoginItemStatus,
  type MenuEntryStatus,
  type UpdateStatus,
} from "../../../../shared/desktop-runtime.js";
import { isUiLocale, type UiLocale } from "@animama/runtime-contracts/locale";
import { RuntimeError, runtimeErrorCode } from "./errors.js";
import { validateCredentialChanges } from "./vault.js";
import { packId } from "../feature-packs/catalog.js";

export type RuntimeIpcOperations = {
  status(): RuntimeStatus;
  retry(): Promise<void>;
  openLogs(): Promise<void>;
  openBackups?(): Promise<void>;
  quit(): void;
  /** The owner accepted saving keys without a secret store (Linux). */
  acceptUnprotectedStorage?(): Promise<void>;
  credentials(): CredentialStatus[];
  credentialStorage?(): CredentialStorage;
  /** Save several key changes and apply them to the running backend. */
  changeCredentials?(changes: unknown): Promise<CredentialStatus[]>;
  featurePacks?(): FeaturePackStatus[];
  changePack?(
    action: "install" | "cancel" | "remove",
    id: FeaturePackId,
  ): Promise<void> | void;
  updateStatus?(): UpdateStatus;
  checkUpdate?(): Promise<UpdateStatus>;
  downloadUpdate?(): Promise<UpdateStatus>;
  restartUpdate?(): Promise<void>;
  /** Record the UI Locale the app applied, for the shell's own text. */
  setLocale?(locale: UiLocale): void;
  loginItem?(): LoginItemStatus;
  setLoginItem?(enabled: boolean): LoginItemStatus;
  /** A Linux AppImage's application-menu entry. */
  menuEntry?(): MenuEntryStatus;
  setMenuEntry?(enabled: boolean): MenuEntryStatus;
};
type Caller = {
  contents: WebContents;
  role: "main" | "recovery";
  allowedUrl: string;
};

/** A URL alone is not IPC authority: require a registered, live top-level frame. */
export class RuntimeIpcCallers {
  private callers = new Map<number, Caller>();
  register(
    window: BrowserWindow,
    role: Caller["role"],
    allowedUrl: string,
  ): void {
    const contents = window.webContents;
    const registered = this.callers.has(contents.id);
    this.callers.set(contents.id, { contents, role, allowedUrl });
    // A re-registered window (a reloaded recovery page) keeps its one cleanup.
    if (!registered)
      contents.once("destroyed", () => this.callers.delete(contents.id));
  }
  require(event: IpcMainInvokeEvent, allowRecovery = false): void {
    const caller = this.callers.get(event.sender.id);
    if (
      !caller ||
      caller.contents !== event.sender ||
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new RuntimeError("ipc_caller_rejected");
    const url = event.senderFrame?.url;
    if (caller.role === "recovery") {
      if (!allowRecovery || url !== caller.allowedUrl)
        throw new RuntimeError("ipc_caller_rejected");
    } else {
      try {
        const parsed = new URL(url ?? "");
        if (
          parsed.origin !== caller.allowedUrl ||
          parsed.username ||
          parsed.password
        )
          throw new Error();
      } catch {
        throw new RuntimeError("ipc_caller_rejected");
      }
    }
  }
  broadcast(status: RuntimeStatus): void {
    for (const caller of this.callers.values()) {
      const url = caller.contents.getURL();
      if (
        !caller.contents.isDestroyed() &&
        (caller.role === "recovery"
          ? url === caller.allowedUrl
          : url.startsWith(`${caller.allowedUrl}/`))
      ) {
        caller.contents.send("animama:runtime:status-changed", status);
      }
    }
  }
  broadcastPack(status: FeaturePackStatus): void {
    for (const caller of this.callers.values()) {
      if (
        caller.role === "main" &&
        !caller.contents.isDestroyed() &&
        caller.contents.getURL().startsWith(`${caller.allowedUrl}/`)
      )
        caller.contents.send("animama:feature-packs:progress", status);
    }
  }
  broadcastUpdate(status: UpdateStatus): void {
    for (const caller of this.callers.values()) {
      if (
        caller.role === "main" &&
        !caller.contents.isDestroyed() &&
        caller.contents.getURL().startsWith(`${caller.allowedUrl}/`)
      )
        caller.contents.send("animama:updates:status-changed", status);
    }
  }
}

/** Expose operations, never vault values, paths, child handles, or arbitrary IPC. */
export function installRuntimeIpc(
  callers: RuntimeIpcCallers,
  operations: RuntimeIpcOperations,
): void {
  const handle = (
    channel: string,
    count: number,
    allowRecovery: boolean,
    operation: (...args: unknown[]) => unknown,
  ) => {
    ipcMain.handle(`animama:${channel}`, async (event, ...args: unknown[]) => {
      try {
        callers.require(event, allowRecovery);
        if (args.length !== count)
          throw new RuntimeError("ipc_arguments_invalid");
        return await operation(...args);
      } catch (error) {
        throw new Error(runtimeErrorCode(error));
      }
    });
  };
  handle("runtime:status", 0, true, () => operations.status());
  handle("runtime:retry", 0, true, () => operations.retry());
  handle("runtime:open-logs", 0, true, () => operations.openLogs());
  handle("runtime:open-backups", 0, true, () => {
    if (!operations.openBackups) throw new RuntimeError("backups_unavailable");
    return operations.openBackups();
  });
  handle("runtime:quit", 0, true, () => operations.quit());
  handle("runtime:accept-unprotected-storage", 0, true, () => {
    if (!operations.acceptUnprotectedStorage)
      throw new RuntimeError("embedded_runtime_unavailable");
    return operations.acceptUnprotectedStorage();
  });
  handle("credentials:list", 0, false, () => operations.credentials());
  handle("credentials:storage", 0, false, () => {
    if (!operations.credentialStorage)
      throw new RuntimeError("embedded_runtime_unavailable");
    return operations.credentialStorage();
  });
  handle("credentials:apply", 1, false, (changes) => {
    if (!operations.changeCredentials)
      throw new RuntimeError("embedded_runtime_unavailable");
    // Validate here too so a malformed batch never reaches the supervisor.
    return operations.changeCredentials(validateCredentialChanges(changes));
  });
  handle(
    "feature-packs:list",
    0,
    false,
    () =>
      operations.featurePacks?.() ??
      featurePackIds.map((id) => ({
        id,
        state: "not_installed",
        available: false,
      })),
  );
  for (const action of ["install", "cancel", "remove"] as const) {
    handle(`feature-packs:${action}`, 1, false, (id) => {
      const validId = packId(id);
      if (operations.changePack) return operations.changePack(action, validId);
      throw new RuntimeError("feature_unavailable");
    });
  }
  handle(
    "updates:status",
    0,
    false,
    () => operations.updateStatus?.() ?? { state: "unavailable" },
  );
  handle(
    "updates:check",
    0,
    false,
    () => operations.checkUpdate?.() ?? { state: "unavailable" },
  );
  handle("updates:download", 0, false, () => {
    if (!operations.downloadUpdate)
      throw new RuntimeError("feature_unavailable");
    return operations.downloadUpdate();
  });
  handle("updates:restart", 0, false, () => {
    if (!operations.restartUpdate)
      throw new RuntimeError("feature_unavailable");
    return operations.restartUpdate();
  });
  // Only the main app window applies a locale; PiP, Quick Chat and the
  // recovery page never do. Only canonical tags reach the cache and the menu.
  handle("locale:set", 1, false, (locale) => {
    if (!isUiLocale(locale)) throw new RuntimeError("locale_invalid");
    if (!operations.setLocale) throw new RuntimeError("feature_unavailable");
    return operations.setLocale(locale);
  });
  // Only the main app window reads or changes whether the OS opens the app at
  // login, and only with a plain boolean.
  handle(
    "login-item:status",
    0,
    false,
    () => operations.loginItem?.() ?? { available: false },
  );
  handle("login-item:set", 1, false, (enabled) => {
    if (typeof enabled !== "boolean")
      throw new RuntimeError("ipc_arguments_invalid");
    if (!operations.setLoginItem) throw new RuntimeError("feature_unavailable");
    return operations.setLoginItem(enabled);
  });
  // The same rule for the application-menu entry: the renderer turns it on or
  // off and never names a file; main writes it for the running AppImage.
  handle(
    "menu-entry:status",
    0,
    false,
    () => operations.menuEntry?.() ?? { available: false },
  );
  handle("menu-entry:set", 1, false, (enabled) => {
    if (typeof enabled !== "boolean")
      throw new RuntimeError("ipc_arguments_invalid");
    if (!operations.setMenuEntry) throw new RuntimeError("feature_unavailable");
    return operations.setMenuEntry(enabled);
  });
}
