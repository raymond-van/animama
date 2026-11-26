import { afterEach, describe, expect, it, vi } from "vitest";

import { useAvatarRuntimeStore } from "@/stores/avatar-runtime-store";
import { remountWhenIdle } from "./remountWhenIdle";

const idle = {
  activeRunId: null,
  activeSpeechRunId: null,
  activeVoiceTurn: null,
};

afterEach(() => useAvatarRuntimeStore.setState(idle));

describe("remountWhenIdle", () => {
  it("remounts an idle chat at once", () => {
    useAvatarRuntimeStore.setState(idle);
    const remount = vi.fn();
    remountWhenIdle(remount);
    expect(remount).toHaveBeenCalledTimes(1);
  });

  it("waits for the reply and its speech to end", () => {
    useAvatarRuntimeStore.setState({ ...idle, activeRunId: "run-1" });
    const remount = vi.fn();
    remountWhenIdle(remount);
    expect(remount).not.toHaveBeenCalled();

    // The text is done but the reply is still being spoken.
    useAvatarRuntimeStore.setState({
      ...idle,
      activeSpeechRunId: "run-1",
    });
    expect(remount).not.toHaveBeenCalled();

    useAvatarRuntimeStore.setState(idle);
    expect(remount).toHaveBeenCalledTimes(1);
    // Later turns never remount again.
    useAvatarRuntimeStore.setState({ ...idle, activeRunId: "run-2" });
    useAvatarRuntimeStore.setState(idle);
    expect(remount).toHaveBeenCalledTimes(1);
  });

  it("waits for a voice turn, and can be cancelled", () => {
    useAvatarRuntimeStore.setState({
      ...idle,
      activeVoiceTurn: { turnId: "voice-1" } as never,
    });
    const remount = vi.fn();
    const cancel = remountWhenIdle(remount);
    cancel();
    useAvatarRuntimeStore.setState(idle);
    expect(remount).not.toHaveBeenCalled();
  });
});
