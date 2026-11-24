import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  CredentialsBridge,
  FeaturePacksBridge,
  LocaleBridge,
  LoginItemBridge,
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
export function createLocaleBridge(): LocaleBridge {
  return {
    setApplied: (locale) => ipcRenderer.invoke("animama:locale:set", locale),
  };
}
export function createLoginItemBridge(): LoginItemBridge {
  return {
    status: () => ipcRenderer.invoke("animama:login-item:status"),
    setEnabled: (enabled) =>
      ipcRenderer.invoke("animama:login-item:set", enabled),
  };
}
