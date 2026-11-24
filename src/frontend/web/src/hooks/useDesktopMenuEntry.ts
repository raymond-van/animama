import { useCallback, useEffect, useState } from "react";
import type { MenuEntryStatus } from "../../../shared/desktop-runtime";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";

/**
 * A Linux AppImage's application-menu entry. Only the main embedded window
 * may read or change it; elsewhere it is unavailable. `shown` is whether the
 * setting is on screen: only then is the state read again when the window
 * regains focus, since the file may have been moved or removed meanwhile.
 */
export function useDesktopMenuEntry(shown = true) {
  const platform = useRuntimePlatform();
  const desktop = platform.kind === "desktop" ? platform.desktopBridge : null;
  const bridge = desktop?.windowRole === "main" ? desktop.menuEntry : undefined;
  const [status, setStatus] = useState<MenuEntryStatus>({ available: false });
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setStatus(await bridge.status());
    } catch {
      // Keep the last known state; the setting stays usable.
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    void refresh();
    if (!shown) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [bridge, refresh, shown]);

  /** Add, repoint or remove the entry; rejects when the files cannot change. */
  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (!bridge) return;
      setPending(true);
      try {
        setStatus(await bridge.setEnabled(enabled));
      } catch (error) {
        await refresh();
        throw error;
      } finally {
        setPending(false);
      }
    },
    [bridge, refresh],
  );

  return { status, pending, setEnabled };
}
