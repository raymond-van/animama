import type { MenuEntryStatus } from "../../../shared/desktop-runtime";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import { useDesktopSwitchSetting } from "./useDesktopSwitchSetting";

const UNAVAILABLE: MenuEntryStatus = { available: false };

/**
 * A Linux AppImage's application-menu entry. Only the main embedded window
 * may read or change it; elsewhere it is unavailable. The entry file may be
 * changed or removed outside the app while it runs, so the state is read
 * again on focus while the setting is `shown`. A moved AppImage shows as
 * stale from its next launch: the running app keeps the path it started from.
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
