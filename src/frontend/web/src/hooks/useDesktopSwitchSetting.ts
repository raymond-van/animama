import { useCallback, useEffect, useState } from "react";

/** A main-window bridge for one on/off setting that the OS or a file holds. */
type SwitchSettingBridge<Status> = {
  status(): Promise<Status>;
  setEnabled(enabled: boolean): Promise<Status>;
};

/**
 * State for a desktop setting kept outside the app (the OS login item, a
 * desktop entry file). `shown` is whether the setting is on screen: only then
 * is the state read again when the window regains focus, since it may have
 * been changed outside the app meanwhile.
 */
export function useDesktopSwitchSetting<Status>(
  bridge: SwitchSettingBridge<Status> | undefined,
  unavailable: Status,
  shown: boolean,
) {
  const [status, setStatus] = useState<Status>(unavailable);
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

  /** Change the setting; rejects when it keeps its current state. */
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
