import { useEffect } from "react";
import { create } from "zustand";

/**
 * Settings another surface may open App Settings at. Each is the ID of a
 * setting entry in the dialog, so the dialog reveals it like a search result.
 */
export type AppSettingsTarget =
  | "model-connections"
  | "stt-provider"
  | "updates";

/** One request to open App Settings; `nonce` tells repeats of a target apart. */
export type AppSettingsRequest = { target: AppSettingsTarget; nonce: number };

type AppSettingsRequestState = {
  /** Mounted App Settings hosts; without one a request has nowhere to open. */
  hosts: number;
  /** The request the host has not yet shown. */
  request: AppSettingsRequest | null;
};

/**
 * Requests to open App Settings at one setting, from surfaces that do not own
 * the dialog (a composer hint, the desktop application menu). The sidebar's
 * user menu hosts the dialog and consumes them.
 */
export const useAppSettingsRequestStore = create<AppSettingsRequestState>(
  () => ({ hosts: 0, request: null }),
);

let lastNonce = 0;

/** Ask the host to open App Settings at `target`; false when no host is mounted. */
export function requestAppSettings(target: AppSettingsTarget): boolean {
  if (useAppSettingsRequestStore.getState().hosts === 0) return false;
  useAppSettingsRequestStore.setState({
    request: { target, nonce: ++lastNonce },
  });
  return true;
}

/** Drop `request` once the dialog has shown it (or closed without it). */
export function clearAppSettingsRequest(request: AppSettingsRequest): void {
  if (useAppSettingsRequestStore.getState().request?.nonce !== request.nonce)
    return;
  useAppSettingsRequestStore.setState({ request: null });
}

/**
 * The opener for surfaces outside the dialog, or null where this window has
 * no App Settings (Quick Chat, Picture-in-Picture), so they can offer nothing.
 */
export function useAppSettingsOpener():
  | ((target: AppSettingsTarget) => void)
  | null {
  const hosted = useAppSettingsRequestStore((state) => state.hosts > 0);
  return hosted ? requestAppSettings : null;
}

/** Register the calling component as an App Settings host; returns the pending request. */
export function useAppSettingsHost(): AppSettingsRequest | null {
  useEffect(() => {
    useAppSettingsRequestStore.setState((state) => ({
      hosts: state.hosts + 1,
    }));
    return () =>
      useAppSettingsRequestStore.setState((state) => ({
        hosts: state.hosts - 1,
        // A request nobody can show any more is dropped with its last host.
        request: state.hosts > 1 ? state.request : null,
      }));
  }, []);
  return useAppSettingsRequestStore((state) => state.request);
}
