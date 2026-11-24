import type { LoginItemStatus } from "../../../shared/desktop-runtime";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import { useDesktopSwitchSetting } from "./useDesktopSwitchSetting";

const UNAVAILABLE: LoginItemStatus = { available: false };

/**
 * Whether the OS opens the packaged desktop app at login. Only the main
 * embedded window may read or change it; elsewhere it is unavailable. The
 * user may allow or remove the login item in the OS settings and come back,
 * so the state is read again on focus while the setting is `shown`.
 */
export function useDesktopLoginItem(shown = true) {
  const platform = useRuntimePlatform();
  const desktop = platform.kind === "desktop" ? platform.desktopBridge : null;
  return useDesktopSwitchSetting(
    desktop?.windowRole === "main" ? desktop.loginItem : undefined,
    UNAVAILABLE,
    shown,
  );
}
