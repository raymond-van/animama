import type { App } from "electron";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { url as inspectorUrl } from "node:inspector";
import path from "node:path";
import { atomicWrite, privateDirectory } from "./atomic-file.js";
import { RuntimeError } from "./errors.js";

export type RuntimePaths = ReturnType<typeof runtimePaths>;
export function runtimePaths(userData: string) {
  const base = path.resolve(userData);
  return {
    base,
    state: path.join(base, "runtime/state.json"),
    processes: path.join(base, "runtime/processes.json"),
    logs: path.join(base, "runtime/logs"),
    vault: path.join(base, "secrets/vault.bin"),
    pgData: path.join(base, "postgres/16/data"),
    localContent: path.join(base, "content/local"),
    content: path.join(base, "content"),
    data: path.join(base, "data"),
    backups: path.join(base, "backups/pre-migration"),
    packs: path.join(base, "packs"),
    downloads: path.join(base, "downloads"),
    /** The UI Locale the app last applied, for the shell's own text. */
    uiLocale: path.join(base, "ui-locale.json"),
    /** Where the PiP window was last left on this machine's displays. */
    pipPlacement: path.join(base, "pip-placement.json"),
  };
}

/** Move a legacy tree only into an absent destination. Never merge two profiles. */
export function migrateLegacyTree(
  source: string,
  destination: string,
  journal: string,
): void {
  if (!existsSync(source)) return;
  if (lstatSync(source).isSymbolicLink())
    throw new RuntimeError("legacy_profile_invalid");
  if (existsSync(destination)) {
    // An existing destination is a conflict even if a journal exists; never merge profiles.
    throw new RuntimeError("legacy_profile_conflict");
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  atomicWrite(
    journal,
    JSON.stringify({ version: 1, state: "moving", source, destination }),
  );
  renameSync(source, destination);
  try {
    atomicWrite(
      journal,
      JSON.stringify({ version: 1, state: "complete", source, destination }),
    );
  } catch (error) {
    // Failure must leave the original profile available, never a half-merged tree.
    renameSync(destination, source);
    throw error;
  }
}

/**
 * The deepest app-managed path below the data root is a staged single-file
 * model asset, `data\staging\model-assets\<id>\<sha256>\<sha256>`, 188
 * characters. A 70-character root keeps it under Windows' 259-character
 * MAX_PATH, which PostgreSQL and Python still use. `%LOCALAPPDATA%\Animama`
 * fits for profile folder names of up to 39 characters.
 */
export const MAX_WINDOWS_DATA_ROOT = 70;

export function dataRootFits(platform: string, root: string): boolean {
  return platform !== "win32" || root.length <= MAX_WINDOWS_DATA_ROOT;
}

/**
 * Where the installation owner's data lives. Windows uses the local, not the
 * roaming, profile folder. Linux uses the XDG data home, the place for a
 * database and content, not the configuration folder Electron defaults to;
 * the XDG specification makes a relative `XDG_DATA_HOME` invalid, so it is
 * ignored.
 */
export function desktopDataRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  folders: { appData: string; home: string },
): string {
  if (platform === "win32")
    return path.join(env.LOCALAPPDATA || folders.appData, "Animama");
  if (platform === "linux")
    return path.join(
      env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
        ? env.XDG_DATA_HOME
        : path.join(folders.home, ".local", "share"),
      "Animama",
    );
  return path.join(folders.appData, "Animama");
}

/**
 * Call before creating sessions, logs or safeStorage; no packaged URL overrides.
 * A packaged app takes the development profile override only while its Node
 * inspector runs, which the shipped fuse wire never allows: the release
 * smoke's inspect-enabled copy uses it for a throwaway profile.
 */
export function prepareDesktopIdentity(
  application: App,
  inspecting = inspectorUrl() !== undefined,
  platform: NodeJS.Platform = process.platform,
): RuntimePaths {
  application.setName("Animama");
  const root = desktopDataRoot(platform, process.env, {
    appData: application.getPath("appData"),
    home: application.getPath("home"),
  });
  const profileOverride = !application.isPackaged || inspecting;
  const override = profileOverride
    ? process.env.ANIMAMA_DESKTOP_DEV_USER_DATA || undefined
    : undefined;
  const paths = runtimePaths(override || root);
  if (!dataRootFits(platform, paths.base))
    throw new RuntimeError("data_path_too_long");
  if (
    application.isPackaged &&
    Object.keys(process.env).some(
      (name) =>
        (name === "ANIMAMA_DESKTOP_WEB_URL" ||
          (name.startsWith("ANIMAMA_DESKTOP_DEV_") &&
            !(profileOverride && name === "ANIMAMA_DESKTOP_DEV_USER_DATA")) ||
          name === "ANIMAMA_DESKTOP_DISABLE_CHROMIUM_SANDBOX") &&
        process.env[name],
    )
  ) {
    throw new RuntimeError("packaged_runtime_override_rejected");
  }
  // Electron requires an existing directory for setPath. Rename the legacy tree
  // before creating the destination; the instance lock still precedes services,
  // sessions, logs and safeStorage. Concurrent cold starts never merge profiles.
  // No packaged Linux build ever wrote the earlier profile, so Linux adopts
  // nothing from the configuration folder.
  if (!override && platform !== "linux")
    migrateLegacyIdentity(application, paths);
  privateDirectory(paths.base);
  application.setPath("userData", paths.base);
  return paths;
}

/**
 * Adopt an earlier release's profile into the canonical root. Run before logs
 * or Chromium can create a conflicting destination tree; an overridden
 * profile never adopts it.
 */
function migrateLegacyIdentity(application: App, paths: RuntimePaths): void {
  migrateLegacyTree(
    path.join(application.getPath("appData"), "Anima"),
    paths.base,
    `${paths.base}.migration.json`,
  );
  const legacyLogs = path.join(
    process.env.XDG_CONFIG_HOME ||
      path.join(application.getPath("home"), ".config"),
    "Anima/logs",
  );
  migrateLegacyTree(
    legacyLogs,
    paths.logs,
    `${paths.base}.logs-migration.json`,
  );
}

/** gatewayPort stores the application port; preserving it keeps the saved browser origin stable. */
export type RuntimeState = { version: 1; gatewayPort: number };
export function readRuntimeState(file: string): RuntimeState | null {
  privateDirectory(path.dirname(file));
  if (!existsSync(file)) return null;
  if (
    !lstatSync(file).isFile() ||
    lstatSync(file).isSymbolicLink() ||
    lstatSync(file).size > 4096
  )
    throw new RuntimeError("runtime_state_invalid");
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (
      state.version !== 1 ||
      !Number.isInteger(state.gatewayPort) ||
      state.gatewayPort < 1 ||
      state.gatewayPort > 65535
    )
      throw new Error();
    return state;
  } catch {
    throw new RuntimeError("runtime_state_invalid");
  }
}

/** A lost vault cannot be regenerated over an existing database. */
export function hasDatabaseData(paths: RuntimePaths): boolean {
  return existsSync(paths.pgData) && readdirSync(paths.pgData).length > 0;
}
