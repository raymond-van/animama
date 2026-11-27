import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  CredentialsBridge,
  FeaturePacksBridge,
  LocaleBridge,
  LoginItemBridge,
  MenuBridge,
  MenuCommand,
  MenuEntryBridge,
  RuntimeBridge,
  RuntimeStatus,
  UpdatesBridge,
  FeaturePackStatus,
  UpdateStatus,
} from "../../../../shared/desktop-runtime.js";

/** Each method has a fixed channel; renderer arguments can never select one. */
export function createRuntimeBridge(): RuntimeBridge {
  return {
    status: () => ipcRenderer.invoke("animama:runtime:status"),
    retry: () => ipcRenderer.invoke("animama:runtime:retry"),
    openLogs: () => ipcRenderer.invoke("animama:runtime:open-logs"),
    openBackups: () => ipcRenderer.invoke("animama:runtime:open-backups"),
    quit: () => ipcRenderer.invoke("animama:runtime:quit"),
    acceptUnprotectedStorage: () =>
      ipcRenderer.invoke("animama:runtime:accept-unprotected-storage"),
    onStatus: (callback) => {
      const listener = (_event: IpcRendererEvent, status: RuntimeStatus) =>
        callback(status);
      ipcRenderer.on("animama:runtime:status-changed", listener);
      return () => {
        ipcRenderer.removeListener("animama:runtime:status-changed", listener);
      };
    },
  };
}
export function createCredentialsBridge(): CredentialsBridge {
  return {
    list: () => ipcRenderer.invoke("animama:credentials:list"),
    apply: (changes) =>
      ipcRenderer.invoke("animama:credentials:apply", changes),
    storage: () => ipcRenderer.invoke("animama:credentials:storage"),
  };
}
export function createFeaturePacksBridge(): FeaturePacksBridge {
  return {
    list: () => ipcRenderer.invoke("animama:feature-packs:list"),
    install: (id) => ipcRenderer.invoke("animama:feature-packs:install", id),
    cancel: (id) => ipcRenderer.invoke("animama:feature-packs:cancel", id),
    remove: (id) => ipcRenderer.invoke("animama:feature-packs:remove", id),
    onProgress: (callback) => {
      const listener = (_event: IpcRendererEvent, status: FeaturePackStatus) =>
        callback(status);
      ipcRenderer.on("animama:feature-packs:progress", listener);
      return () =>
        ipcRenderer.removeListener("animama:feature-packs:progress", listener);
    },
  };
}
export function createUpdatesBridge(): UpdatesBridge {
  return {
    status: () => ipcRenderer.invoke("animama:updates:status"),
    check: () => ipcRenderer.invoke("animama:updates:check"),
    download: () => ipcRenderer.invoke("animama:updates:download"),
    restart: () => ipcRenderer.invoke("animama:updates:restart"),
    onStatus: (callback) => {
      const listener = (_event: IpcRendererEvent, status: UpdateStatus) =>
        callback(status);
      ipcRenderer.on("animama:updates:status-changed", listener);
      return () =>
        ipcRenderer.removeListener("animama:updates:status-changed", listener);
    },
  };
}
/** How long a command taken for a subscriber that left waits for the next. */
const MENU_COMMAND_HANDOVER_MS = 5_000;

/**
 * Main announces a chosen command without naming it; the app takes it then,
 * and once on subscribing, for a command chosen while its window was closed
 * or loading. Only the two known commands reach the web app, and only its
 * one subscriber: a command that arrives after that subscriber left (React's
 * development double mount unsubscribes while the first take is in flight)
 * goes to the next one.
 */
export function createMenuBridge(): MenuBridge {
  const known: readonly MenuCommand[] = ["check-for-updates", "import-anima"];
  let deliver: ((command: MenuCommand) => void) | null = null;
  let held: { command: MenuCommand; at: number } | null = null;
  const take = () => {
    void ipcRenderer
      .invoke("animama:menu:take")
      .then((command: unknown) => {
        const match = known.find((item) => item === command);
        if (!match) return;
        if (deliver) deliver(match);
        else held = { command: match, at: Date.now() };
      })
      // Another window role, or main shutting down: nothing to run.
      .catch(() => undefined);
  };
  return {
    onCommand: (callback) => {
      deliver = callback;
      ipcRenderer.on("animama:menu:command", take);
      const waiting = held;
      held = null;
      if (waiting && Date.now() - waiting.at <= MENU_COMMAND_HANDOVER_MS)
        callback(waiting.command);
      else take();
      return () => {
        if (deliver === callback) deliver = null;
        ipcRenderer.removeListener("animama:menu:command", take);
      };
    },
  };
}
export function createLocaleBridge(): LocaleBridge {
  return {
    setApplied: (locale) => ipcRenderer.invoke("animama:locale:set", locale),
  };
}
export function createMenuEntryBridge(): MenuEntryBridge {
  return {
    status: () => ipcRenderer.invoke("animama:menu-entry:status"),
    setEnabled: (enabled) =>
      ipcRenderer.invoke("animama:menu-entry:set", enabled),
  };
}
export function createLoginItemBridge(): LoginItemBridge {
  return {
    status: () => ipcRenderer.invoke("animama:login-item:status"),
    setEnabled: (enabled) =>
      ipcRenderer.invoke("animama:login-item:set", enabled),
  };
}
