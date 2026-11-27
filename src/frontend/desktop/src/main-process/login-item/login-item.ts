import type { LoginItemSettings } from "electron";
import type { LoginItemStatus } from "../../../../shared/desktop-runtime.js";
import { RuntimeError } from "../runtime/errors.js";

/** The parts of Electron's `app` that read and change the login item. */
export type LoginItemHost = {
  readonly isPackaged: boolean;
  getLoginItemSettings(): Pick<
    LoginItemSettings,
    "openAtLogin" | "status" | "executableWillLaunchAtLogin"
  >;
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
};

/**
 * Open-at-login for the packaged macOS and Windows apps, through the OS's own
 * login-item API. An unpackaged run would register the bare Electron binary,
 * so it reports the setting unavailable. Linux has no such API: its AppImage
 * uses an XDG autostart entry instead (`linux-desktop-entry.ts`).
 */
export class LoginItem {
  constructor(
    private readonly host: LoginItemHost,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  status(): LoginItemStatus {
    if (
      !this.host.isPackaged ||
      (this.platform !== "darwin" && this.platform !== "win32")
    )
      return { available: false };
    const settings = this.host.getLoginItemSettings();
    if (this.platform === "darwin") {
      // macOS registers the app with SMAppService; the user may still have to
      // allow it in System Settings before it opens at login.
      const blockedBySystem = settings.status === "requires-approval";
      return {
        available: true,
        enabled: settings.status === "enabled" || blockedBySystem,
        blockedBySystem,
      };
    }
    // Windows keeps the Run entry when the user turns the app off in Startup
    // apps; it then no longer launches.
    return {
      available: true,
      enabled: settings.openAtLogin,
      blockedBySystem:
        settings.openAtLogin && !settings.executableWillLaunchAtLogin,
    };
  }

  /** Change the OS setting and report the state the OS now holds. */
  setEnabled(enabled: boolean): LoginItemStatus {
    if (!this.status().available) throw new RuntimeError("feature_unavailable");
    this.host.setLoginItemSettings({ openAtLogin: enabled });
    const status = this.status();
    // Electron does not throw when the OS refuses the change.
    if (status.available && status.enabled !== enabled)
      throw new RuntimeError("login_item_unchanged");
    return status;
  }
}
