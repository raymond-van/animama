import { afterEach, describe, expect, it } from "vitest";

import {
  clearAppSettingsRequest,
  requestAppSettings,
  useAppSettingsRequestStore,
} from "./app-settings-request-store";

afterEach(() => {
  useAppSettingsRequestStore.setState({ hosts: 0, request: null });
});

describe("App Settings requests", () => {
  it("refuses a request while no window part hosts App Settings", () => {
    expect(requestAppSettings("stt-provider")).toBe(false);
    expect(useAppSettingsRequestStore.getState().request).toBeNull();
  });

  it("hands the host the latest request and tells repeats apart", () => {
    useAppSettingsRequestStore.setState({ hosts: 1 });

    expect(requestAppSettings("stt-provider")).toBe(true);
    const first = useAppSettingsRequestStore.getState().request!;
    expect(first.target).toBe("stt-provider");

    expect(requestAppSettings("stt-provider")).toBe(true);
    const second = useAppSettingsRequestStore.getState().request!;
    expect(second.nonce).not.toBe(first.nonce);

    // Clearing an older request leaves the newer one for the host.
    clearAppSettingsRequest(first);
    expect(useAppSettingsRequestStore.getState().request).toBe(second);
    clearAppSettingsRequest(second);
    expect(useAppSettingsRequestStore.getState().request).toBeNull();
  });
});
