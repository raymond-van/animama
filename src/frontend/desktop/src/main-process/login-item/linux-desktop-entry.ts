import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  LoginItemStatus,
  MenuEntryStatus,
} from "../../../../shared/desktop-runtime.js";
import { RuntimeError } from "../runtime/errors.js";

/** The desktop file ID of both entries; it matches the app ID. */
export const DESKTOP_ENTRY_ID = "com.animama.desktop";

const XDG_DEFAULTS = {
  XDG_CONFIG_HOME: [".config"],
  XDG_DATA_HOME: [".local", "share"],
} as const;

/**
 * A per-user XDG base folder. The specification makes a relative value
 * invalid, so it is ignored in favour of the default below the home folder.
 */
export function xdgFolder(
  env: NodeJS.ProcessEnv,
  name: keyof typeof XDG_DEFAULTS,
  home: string,
): string {
  const value = env[name];
  return value && path.isAbsolute(value)
    ? value
    : path.join(home, ...XDG_DEFAULTS[name]);
}

/**
 * One desktop entry that runs exactly `exec`, an absolute path, with no
 * arguments. The path is one quoted `Exec` argument: inside the quotes the
 * Desktop Entry Specification reserves `"`, `` ` ``, `$` and `\`; a literal `%`
 * is doubled because `Exec` reads `%` as a field code; and every backslash is
 * doubled again as in any desktop-entry string. The entry never carries a
 * switch, so it can never turn the sandbox off.
 */
export function desktopEntry({
  name,
  exec,
  icon,
  extra = {},
}: {
  name: string;
  exec: string;
  icon?: string;
  extra?: Record<string, string>;
}): string {
  // A control character cannot be written on one line of a desktop entry.
  if (
    !path.isAbsolute(exec) ||
    [exec, icon ?? ""].some((value) => /[\x00-\x1f\x7f]/u.test(value))
  )
    throw new RuntimeError("desktop_entry_path_invalid");
  const quoted = `"${exec.replace(/%/gu, "%%").replace(/["`$\\]/gu, "\\$&")}"`;
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${name}`,
    `Exec=${quoted.replace(/\\/gu, "\\\\")}`,
    ...(icon ? [`Icon=${icon.replace(/\\/gu, "\\\\")}`] : []),
    "Terminal=false",
    ...Object.entries(extra).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
}

/**
 * The file an entry written by `desktopEntry` runs; null for anything else,
 * including another program's entry or a command with arguments.
 */
export function entryTarget(text: string): string | null {
  const line = text.split("\n").find((entry) => entry.startsWith("Exec="));
  if (!line) return null;
  const value = line.slice("Exec=".length).replace(/\\\\/gu, "\\");
  const quoted = /^"((?:[^"`$\\]|\\["`$\\])*)"$/u.exec(value);
  if (!quoted) return null;
  const argument = quoted[1]!.replace(/\\(["`$\\])/gu, "$1");
  // A lone percent would be a field code, which this module never writes.
  if (/%(?!%)/u.test(argument.replace(/%%/gu, ""))) return null;
  return argument.replace(/%%/gu, "%");
}

/** Whether an entry file is missing, runs this AppImage, or runs something else. */
export function entryState(
  file: string,
  appImage: string,
): "absent" | "current" | "stale" {
  if (!existsSync(file)) return "absent";
  let target: string | null = null;
  try {
    target = entryTarget(readFileSync(file, "utf8"));
  } catch {
    // Unreadable: treat like an entry that no longer works.
  }
  return target === appImage ? "current" : "stale";
}

/** Replace a small public file in one step; a session may read it at any time. */
function writeEntry(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.tmp`;
  writeFileSync(pending, text, { mode: 0o644 });
  // The process umask may have narrowed the mode.
  chmodSync(pending, 0o644);
  renameSync(pending, file);
}

/**
 * Launch at login and the application-menu entry of a Linux AppImage. Both are
 * plain desktop entries naming the AppImage's own path, which the launcher
 * gives in `APPIMAGE`; nothing is installed. Each is available only to a
 * packaged app that runs from inside the launcher's mount (`APPDIR`): child
 * processes inherit both variables, so an unpacked build started from another
 * AppImage must not write an entry for that other file. Each shows when the
 * file it names is no longer the running one.
 */
export class LinuxDesktopEntries {
  private readonly appImage: string | undefined;
  private readonly autostartFile: string;
  private readonly menuFile: string;
  private readonly iconFile: string;
  private readonly iconSource: string;

  constructor({
    isPackaged,
    appImage,
    appDir,
    execPath,
    env,
    home,
    iconSource,
  }: {
    isPackaged: boolean;
    /** The running AppImage, from the launcher's `APPIMAGE` variable. */
    appImage: string | undefined;
    /** Where the launcher mounted it, from `APPDIR`. */
    appDir: string | undefined;
    /** This process's executable, which a real AppImage run has inside `appDir`. */
    execPath: string;
    env: NodeJS.ProcessEnv;
    home: string;
    /** The app icon shipped in the packaged resources. */
    iconSource: string;
  }) {
    this.appImage =
      isPackaged &&
      appImage &&
      path.isAbsolute(appImage) &&
      appDir &&
      path.isAbsolute(appDir) &&
      execPath.startsWith(`${appDir.replace(/\/+$/u, "")}/`)
        ? appImage
        : undefined;
    const name = `${DESKTOP_ENTRY_ID}.desktop`;
    const data = xdgFolder(env, "XDG_DATA_HOME", home);
    this.autostartFile = path.join(
      xdgFolder(env, "XDG_CONFIG_HOME", home),
      "autostart",
      name,
    );
    this.menuFile = path.join(data, "applications", name);
    // Named by its path in the entry, so no theme size folder has to match.
    this.iconFile = path.join(data, "icons", `${DESKTOP_ENTRY_ID}.png`);
    this.iconSource = iconSource;
  }

  private required(): string {
    if (!this.appImage) throw new RuntimeError("feature_unavailable");
    return this.appImage;
  }

  /**
   * Launch at login through an XDG autostart entry. `blockedBySystem` here
   * means the entry names a file that is no longer the running AppImage, so
   * it will not take effect until it is turned on again.
   */
  loginItem(): LoginItemStatus {
    if (!this.appImage) return { available: false };
    const state = entryState(this.autostartFile, this.appImage);
    return {
      available: true,
      enabled: state !== "absent",
      blockedBySystem: state === "stale",
    };
  }

  setLoginItem(enabled: boolean): LoginItemStatus {
    const appImage = this.required();
    if (enabled)
      writeEntry(
        this.autostartFile,
        desktopEntry({ name: "Animama", exec: appImage }),
      );
    else rmSync(this.autostartFile, { force: true });
    return this.loginItem();
  }

  /** The application-menu entry; `stale` when the AppImage has moved. */
  menuEntry(): MenuEntryStatus {
    if (!this.appImage) return { available: false };
    const state = entryState(this.menuFile, this.appImage);
    return {
      available: true,
      enabled: state !== "absent",
      stale: state === "stale",
    };
  }

  /** Turning it on again repoints an entry left behind by a moved AppImage. */
  setMenuEntry(enabled: boolean): MenuEntryStatus {
    const appImage = this.required();
    if (enabled) {
      // A missing icon still leaves a working entry with a generic icon.
      if (existsSync(this.iconSource)) {
        mkdirSync(path.dirname(this.iconFile), { recursive: true });
        copyFileSync(this.iconSource, this.iconFile);
      }
      writeEntry(
        this.menuFile,
        desktopEntry({
          name: "Animama",
          exec: appImage,
          icon: this.iconFile,
          extra: { Categories: "Utility;", StartupWMClass: "Animama" },
        }),
      );
    } else {
      rmSync(this.menuFile, { force: true });
      rmSync(this.iconFile, { force: true });
    }
    return this.menuEntry();
  }
}
