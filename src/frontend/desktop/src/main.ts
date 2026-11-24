// First: a packaged app started with a debugging switch quits here, before
// any other start-up code runs.
import "./main-process/security/debugging-guard.js";
import {
  app,
  BrowserWindow,
  dialog,
  nativeImage,
  safeStorage,
  session,
  shell,
} from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveDesktopConfig,
  type DesktopConfig,
} from "./main-process/config.js";
import {
  initializeLogging,
  installProcessErrorLogging,
  writeLog,
} from "./main-process/logging.js";
import { installFullscreenIpc } from "./main-process/fullscreen/fullscreen-ipc.js";
import { installTitleBarIpc } from "./main-process/window/title-bar.js";
import { installPipIpc } from "./main-process/pip/pip-ipc.js";
import { installQuickChatIpc } from "./main-process/quick-chat/quick-chat-ipc.js";
import { installShortcutsIpc } from "./main-process/shortcuts/shortcuts-ipc.js";
import { installSessionGuards } from "./main-process/security/guards.js";
import {
  createRendererCapability,
  installRendererCapability,
} from "./main-process/security/renderer-capability.js";
import { createWindow } from "./main-process/window/create-window.js";
import {
  ShellLocale,
  type ShellStrings,
} from "./main-process/locale/shell-locale.js";
import { installApplicationMenu } from "./main-process/ui/application-menu.js";
import {
  RuntimeError,
  runtimeErrorCode,
} from "./main-process/runtime/errors.js";
import {
  RuntimeIpcCallers,
  installRuntimeIpc,
} from "./main-process/runtime/ipc.js";
import {
  prepareDesktopIdentity,
  runtimePaths,
} from "./main-process/runtime/paths.js";
import {
  createRecoveryWindow,
  createRuntimePage,
  reloadRecoveryWindow,
} from "./main-process/runtime/recovery.js";
import { RuntimeSupervisor } from "./main-process/runtime/supervisor.js";
import {
  awaitDurableEncryptionKey,
  linuxPasswordStore,
} from "./main-process/runtime/vault.js";
import { refuseDisabledSandbox } from "./main-process/security/sandbox-guard.js";
import {
  closeProductSession,
  destroyProductWindows,
  quitWhenMainWindowCloses,
  installProductRequestGate,
  ProductSessionCleanup,
} from "./main-process/runtime/product-windows.js";
import type { RuntimeStatus } from "../../shared/desktop-runtime.js";
import { readBoundedJson } from "./main-process/feature-packs/catalog.js";
import { DesktopUpdateController } from "./main-process/updates/controller.js";
import {
  hostUpdatePlatform,
  openSealedUpdates,
  type UpdatePlatform,
  type UpdatePolicy,
} from "./main-process/updates/policy.js";
import {
  createMacUpdateAdapter,
  createWindowsUpdateAdapter,
  verifyUpdaterPublisher,
} from "./main-process/updates/electron-adapter.js";
import { LoginItem } from "./main-process/login-item/login-item.js";
import { LinuxDesktopEntries } from "./main-process/login-item/linux-desktop-entry.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(currentDir, "preload.cjs");
const embedded =
  app.isPackaged || Boolean(process.env.ANIMAMA_DESKTOP_DEV_RUNTIME_ROOT);
let identityError: unknown;
let paths: ReturnType<typeof runtimePaths>;
try {
  paths = prepareDesktopIdentity(app);
} catch (error) {
  identityError = error;
  paths = runtimePaths(app.getPath("userData"));
}
// Taskbar grouping and notifications use the ID the installer's shortcuts carry.
if (process.platform === "win32") app.setAppUserModelId("com.animama.desktop");

/**
 * Unpackaged runs launch Electron's own binary, so they would show its icon.
 * Packaged builds carry the app icon in their bundle or executable instead.
 */
function showDevelopmentIcon(): void {
  if (app.isPackaged) return;
  const build = join(app.getAppPath(), "build");
  if (process.platform === "darwin") {
    app.dock?.setIcon(nativeImage.createFromPath(join(build, "icon-mac.png")));
    return;
  }
  const icon = nativeImage.createFromPath(join(build, "icon.png"));
  app.on("browser-window-created", (_event, window) => window.setIcon(icon));
}

// The lock precedes database migrations, sessions, safeStorage, logs and services.
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
else {
  if (!identityError) {
    try {
      initializeLogging(app);
    } catch (error) {
      identityError = error;
    }
  }
  installProcessErrorLogging();
  if (
    !app.isPackaged &&
    process.env.ANIMAMA_DESKTOP_DISABLE_CHROMIUM_SANDBOX === "1"
  ) {
    app.commandLine.appendSwitch("no-sandbox");
    writeLog(
      "info",
      "Chromium sandbox disabled for explicit development launch",
    );
  }
  if (process.platform === "linux")
    app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
  // Before `ready`, when Electron chooses where its encryption key lives.
  const passwordStore = linuxPasswordStore(
    process.platform,
    process.env,
    (name) => app.commandLine.hasSwitch(name),
  );
  if (passwordStore)
    app.commandLine.appendSwitch("password-store", passwordStore);

  const callers = new RuntimeIpcCallers();
  // Shell text follows the locale the app last applied, else the OS languages.
  const shellLocale = new ShellLocale(paths.uiLocale, () =>
    app.getPreferredSystemLanguages(),
  );
  let supervisor: RuntimeSupervisor | undefined;
  let currentStatus: RuntimeStatus = { state: "starting", stage: "validating" };
  let desktopConfig: DesktopConfig | undefined;
  let mainWindow: BrowserWindow | undefined;
  let recoveryWindow: BrowserWindow | undefined;
  let mainTask: Promise<void> | undefined;
  let recoveryTask: Promise<void> | undefined;
  let windowGeneration = 0;
  let applicationRoute = "/";
  const sessionCleanup = new ProductSessionCleanup(async () => {
    if (desktopConfig)
      await closeProductSession(
        session.fromPartition(desktopConfig.sessionPartition),
        desktopConfig.allowedWebOrigin,
      );
  });
  let allowQuit = false;
  let quitting = false;
  let updates: DesktopUpdateController | undefined;
  let updateInitialization: Promise<void> | undefined;

  /** Updates are optional, packaged-only infrastructure and never delay application readiness. */
  function initializeUpdates(): Promise<void> {
    const platform = hostUpdatePlatform(process.platform, process.arch);
    if (!app.isPackaged || !platform || !supervisor) return Promise.resolve();
    updateInitialization ??= (async () => {
      // A build that seals updates off (the final release) opens nothing, so
      // the status stays "unavailable".
      const controller = await openSealedUpdates({
        platform,
        readPolicy: () =>
          readBoundedJson(
            join(process.resourcesPath, "runtime/update-policy.json"),
            4096,
          ),
        // The signed app bundle on macOS; the signed Animama.exe on Windows.
        verifyPublisher: (policy) =>
          verifyUpdaterPublisher(
            platform === "darwin"
              ? resolve(process.resourcesPath, "../..")
              : process.execPath,
            policy,
          ),
        cancelled: () => quitting,
        create: (policy) => createUpdateController(policy, platform),
      });
      if (!controller) return;
      updates = controller;
      callers.broadcastUpdate(updates.status());
      updates.start();
    })().catch(() => {
      callers.broadcastUpdate({ state: "unavailable" });
    });
    return updateInitialization;
  }

  /** The update transaction for a build whose sealed policy offers updates. */
  function createUpdateController(
    policy: UpdatePolicy,
    platform: UpdatePlatform,
  ): DesktopUpdateController {
    const permitQuit = () => {
      allowQuit = true;
      quitting = true;
    };
    const adapter =
      platform === "darwin"
        ? createMacUpdateAdapter(policy, app.getVersion(), permitQuit)
        : createWindowsUpdateAdapter(policy, app.getVersion(), permitQuit);
    return new DesktopUpdateController({
      version: app.getVersion(),
      distribution: policy.distribution,
      platform,
      adapter,
      disk: () => supervisor!.updateDisk(),
      preflight: (candidate) => supervisor!.preflightUpdate(candidate),
      stopAndInstall: async (candidate, install) => {
        await supervisor!.stopForUpdate(candidate);
        try {
          await install();
        } catch (error) {
          if (
            error instanceof RuntimeError &&
            error.code === "update_install_failed"
          )
            await supervisor!.recoverFailedUpdate();
          else updateStatus({ state: "error", code: runtimeErrorCode(error) });
          throw error;
        }
      },
      onStatus: (status) => callers.broadcastUpdate(status),
    });
  }

  /** A single independent recovery window survives even when no HTTP listener exists. */
  async function showRecovery(): Promise<void> {
    if (quitting) return;
    if (recoveryWindow && !recoveryWindow.isDestroyed()) {
      recoveryWindow.show();
      recoveryWindow.focus();
      return;
    }
    recoveryTask ??= createRecoveryWindow(
      preloadPath,
      createRuntimePage(shellLocale.strings),
      callers,
    )
      .then((window) => {
        recoveryWindow = window;
        window.on("closed", () => {
          recoveryWindow = undefined;
        });
      })
      .finally(() => {
        recoveryTask = undefined;
      });
    await recoveryTask;
  }

  /** Invalidate pending loads before destroying every product document and worker. */
  function quiesceProductWindows(): Promise<void> {
    windowGeneration++;
    applicationRoute =
      destroyProductWindows(
        BrowserWindow.getAllWindows(),
        mainWindow,
        recoveryWindow,
        desktopConfig?.allowedWebOrigin,
      ) ?? applicationRoute;
    return sessionCleanup.close();
  }

  /** Install the HttpOnly capability before the first main/PiP/quick-chat load. */
  async function showApplication(origin?: string): Promise<void> {
    if (
      quitting ||
      (embedded &&
        (currentStatus.state !== "ready" || currentStatus.origin !== origin))
    )
      return;
    if (mainTask) {
      await mainTask;
      if (!mainWindow || mainWindow.isDestroyed())
        await showApplication(origin);
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      recoveryWindow?.hide();
      return;
    }
    const generation = windowGeneration;
    const current = () =>
      !quitting &&
      generation === windowGeneration &&
      (!embedded ||
        (currentStatus.state === "ready" && currentStatus.origin === origin));
    mainTask = (async () => {
      await sessionCleanup.close();
      if (!current()) return;
      if (!desktopConfig) {
        desktopConfig = resolveDesktopConfig(origin);
        const desktopSession = session.fromPartition(
          desktopConfig.sessionPartition,
        );
        if (embedded)
          installProductRequestGate(
            desktopSession,
            desktopConfig.allowedWebOrigin,
            () =>
              !quitting &&
              !sessionCleanup.blocked &&
              currentStatus.state === "ready" &&
              supervisor?.status().state === "ready",
          );
        installSessionGuards(desktopConfig.allowedWebOrigin, desktopSession);
        installFullscreenIpc();
        installTitleBarIpc();
        installPipIpc({
          config: desktopConfig,
          locale: shellLocale,
          placementFile: paths.pipPlacement,
          preloadPath,
        });
        installQuickChatIpc({
          config: desktopConfig,
          locale: shellLocale,
          preloadPath,
        });
        installShortcutsIpc();
      }
      const desktopSession = session.fromPartition(
        desktopConfig.sessionPartition,
      );
      sessionCleanup.markActive();
      await installRendererCapability(
        desktopSession,
        desktopConfig.allowedWebOrigin,
        supervisor?.rendererCapability ?? createRendererCapability(),
      );
      if (!current()) {
        // A status change may have raced the asynchronous cookie write.
        sessionCleanup.markActive();
        await quiesceProductWindows();
        return;
      }
      await createWindow({
        config: {
          ...desktopConfig,
          webUrl: embedded
            ? new URL(applicationRoute, desktopConfig.allowedWebOrigin)
            : desktopConfig.webUrl,
        },
        preloadPath,
        failOnLoadError: embedded,
        onCreated: (window) => {
          mainWindow = window;
          callers.register(window, "main", desktopConfig!.allowedWebOrigin);
          window.webContents.on("render-process-gone", () => {
            if (mainWindow === window && currentStatus.state === "ready")
              updateStatus({ state: "error", code: "renderer_load_failed" });
          });
          window.on("closed", () => {
            if (mainWindow === window) mainWindow = undefined;
          });
          quitWhenMainWindowCloses(window, app);
        },
      });
      if (currentStatus.state === "ready" || currentStatus.state === "external")
        recoveryWindow?.hide();
    })()
      .catch((error) => {
        if (current()) throw error;
      })
      .finally(() => {
        mainTask = undefined;
      });
    await mainTask;
  }

  function updateStatus(status: RuntimeStatus): void {
    currentStatus = status;
    if (embedded && status.state !== "ready") {
      void quiesceProductWindows().catch(() =>
        writeLog("error", "renderer_cleanup_failed"),
      );
      if (status.state !== "stopped")
        void showRecovery().catch(() =>
          writeLog("error", "recovery_window_failed"),
        );
    }
    callers.broadcast(status);
    // Support and the Windows termination harness follow these lines. Stage
    // names, error codes and the loopback origin are not secret.
    const detail =
      status.state === "error"
        ? status.code
        : status.state === "starting"
          ? status.stage
          : status.state === "ready"
            ? status.origin
            : undefined;
    writeLog("info", `Runtime ${status.state}${detail ? `: ${detail}` : ""}`);
    if (status.state === "ready") {
      void initializeUpdates();
      void showApplication(status.origin).catch((error) =>
        updateStatus({ state: "error", code: runtimeErrorCode(error) }),
      );
    } else if (status.state === "error") {
      void showRecovery().catch(() =>
        writeLog("error", "recovery_window_failed"),
      );
    }
  }

  const loginItem = new LoginItem(app);
  // A Linux AppImage keeps Launch at login and its menu entry as desktop
  // entries naming the file the launcher reports in APPIMAGE.
  const linuxEntries =
    process.platform === "linux"
      ? new LinuxDesktopEntries({
          isPackaged: app.isPackaged,
          appImage: process.env.APPIMAGE,
          env: process.env,
          home: app.getPath("home"),
          iconSource: join(process.resourcesPath, "icon.png"),
        })
      : undefined;
  installRuntimeIpc(callers, {
    status: () => currentStatus,
    retry: async () => {
      if (identityError) throw identityError;
      if (!supervisor) throw new RuntimeError("embedded_runtime_unavailable");
      await supervisor.start();
      // A renderer load can fail after services become ready. Retry that window
      // without resetting a healthy database or changing the stable origin.
      if (supervisor.status().state === "ready")
        updateStatus(supervisor.status());
    },
    openLogs: async () => {
      if (await shell.openPath(paths.logs))
        throw new RuntimeError("logs_unavailable");
    },
    openBackups: async () => {
      if (await shell.openPath(paths.backups))
        throw new RuntimeError("backups_unavailable");
    },
    quit: () => app.quit(),
    acceptUnprotectedStorage: async () => {
      if (!supervisor) throw new RuntimeError("embedded_runtime_unavailable");
      await supervisor.acceptUnprotectedStorage();
    },
    credentialStorage: () => {
      if (!supervisor) throw new RuntimeError("embedded_runtime_unavailable");
      return supervisor.credentialStorage();
    },
    credentials: () => {
      if (!supervisor) throw new RuntimeError("embedded_runtime_unavailable");
      return supervisor.credentials();
    },
    changeCredentials: (changes) => {
      if (!supervisor) throw new RuntimeError("embedded_runtime_unavailable");
      return supervisor.changeCredentials(changes);
    },
    featurePacks: () => supervisor?.featurePacks().list() ?? [],
    changePack: (action, id) => {
      if (!supervisor) throw new RuntimeError("embedded_runtime_unavailable");
      return supervisor.changePack(action, id);
    },
    updateStatus: () => updates?.status() ?? { state: "unavailable" },
    checkUpdate: async () => {
      await initializeUpdates();
      return updates?.check() ?? { state: "unavailable" };
    },
    downloadUpdate: async () => {
      if (!updates) throw new RuntimeError("updates_not_configured");
      return updates.download();
    },
    restartUpdate: async () => {
      if (!updates) throw new RuntimeError("updates_not_configured");
      return updates.restart();
    },
    setLocale: (locale) => shellLocale.apply(locale),
    loginItem: () => linuxEntries?.loginItem() ?? loginItem.status(),
    setLoginItem: (enabled) =>
      linuxEntries
        ? linuxEntries.setLoginItem(enabled)
        : loginItem.setEnabled(enabled),
    menuEntry: () => linuxEntries?.menuEntry() ?? { available: false },
    setMenuEntry: (enabled) => {
      if (!linuxEntries) throw new RuntimeError("feature_unavailable");
      return linuxEntries.setMenuEntry(enabled);
    },
  });

  /** A menu failure must never block startup or recovery. */
  function applyApplicationMenu(strings: ShellStrings): void {
    try {
      installApplicationMenu(strings, app.name, app.isPackaged);
    } catch {
      writeLog("error", "application_menu_failed");
    }
  }

  // PiP and Quick Chat retitle themselves; the menu and the hidden recovery
  // page are rebuilt so a later failure is explained in the new locale.
  shellLocale.onChange((strings) => {
    applyApplicationMenu(strings);
    if (recoveryWindow && !recoveryWindow.isDestroyed())
      void reloadRecoveryWindow(
        recoveryWindow,
        createRuntimePage(strings),
        callers,
      ).catch(() => writeLog("error", "recovery_window_failed"));
  });

  app.on("second-instance", () => {
    const window =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow : recoveryWindow;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    updates?.close();
    void (supervisor?.stop() ?? Promise.resolve())
      .then(() => {
        allowQuit = true;
        app.quit();
      })
      .catch((error) => {
        quitting = false;
        updateStatus({ state: "error", code: runtimeErrorCode(error) });
      });
  });
  app.on("activate", () => {
    const task =
      currentStatus.state === "ready"
        ? showApplication(currentStatus.origin)
        : currentStatus.state === "external"
          ? showApplication()
          : showRecovery();
    void task.catch(() => writeLog("error", "window_reopen_failed"));
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  void app
    .whenReady()
    .then(async () => {
      // Nothing opens or starts in a packaged Linux app whose sandbox is off.
      if (
        refuseDisabledSandbox({
          isPackaged: app.isPackaged,
          platform: process.platform,
          hasSwitch: (name) => app.commandLine.hasSwitch(name),
          text: shellLocale.strings.text,
          show: (title, message) => {
            writeLog("error", "chromium_sandbox_disabled_refused");
            dialog.showMessageBoxSync({
              type: "error",
              title: app.name,
              message: title,
              detail: message,
            });
          },
          exit: (code) => {
            allowQuit = true;
            app.exit(code);
          },
        })
      )
        return;
      showDevelopmentIcon();
      // Replaces Electron's English default menu before any window opens.
      applyApplicationMenu(shellLocale.strings);
      if (identityError) {
        await showRecovery();
        updateStatus({ state: "error", code: runtimeErrorCode(identityError) });
        return;
      }
      if (!embedded) {
        currentStatus = { state: "external" };
        await showApplication();
        return;
      }
      await showRecovery();
      supervisor = new RuntimeSupervisor({
        runtimeRoot: app.isPackaged
          ? join(process.resourcesPath, "runtime")
          : resolve(process.env.ANIMAMA_DESKTOP_DEV_RUNTIME_ROOT!),
        appVersion: app.getVersion(),
        paths,
        encryption: safeStorage,
        beforeNewVault: () =>
          awaitDurableEncryptionKey(paths.base, paths.vault),
        onStatus: updateStatus,
        isPackaged: app.isPackaged,
        packCatalogPath: process.env.ANIMAMA_DESKTOP_DEV_PACK_CATALOG_PATH,
        onPackProgress: (status) => callers.broadcastPack(status),
        quiesceRenderers: quiesceProductWindows,
      });
      await supervisor.start();
    })
    .catch((error) =>
      updateStatus({ state: "error", code: runtimeErrorCode(error) }),
    );
}
