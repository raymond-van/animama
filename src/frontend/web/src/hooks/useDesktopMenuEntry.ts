import type { MenuEntryStatus } from "../../../shared/desktop-runtime";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import { useDesktopSwitchSetting } from "./useDesktopSwitchSetting";

const UNAVAILABLE: MenuEntryStatus = { available: false };

/**
 * A Linux AppImage's application-menu entry. Only the main embedded window
 * may read or change it; elsewhere it is unavailable. The AppImage may be
 * moved while the app runs, so the state is read again on focus while the
 * setting is `shown`.
 */
export function useDesktopMenuEntry(shown = true) {
  const platform = useRuntimePlatform();
  const desktop = platform.kind === "desktop" ? platform.desktopBridge : null;
  return useDesktopSwitchSetting(
    desktop?.windowRole === "main" ? desktop.menuEntry : undefined,
    UNAVAILABLE,
    shown,
  );
}
