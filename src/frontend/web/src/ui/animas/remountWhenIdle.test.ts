import { afterEach, describe, expect, it, vi } from "vitest";

import { useAvatarRuntimeStore } from "@/stores/avatar-runtime-store";
import { remountWhenIdle } from "./remountWhenIdle";

const idle = {
  animaId: "anima-a",
  activeRunId: null,
  activeSpeechRunId: null,
};

afterEach(() => useAvatarRuntimeStore.setState(idle));

describe("remountWhenIdle", () => {
  it("remounts an idle chat at once", () => {
    useAvatarRuntimeStore.setState(idle);
    const remount = vi.fn();
    remountWhenIdle("anima-a", remount);
    expect(remount).toHaveBeenCalledTimes(1);
  });

  it("waits for the reply and its speech to end, then remounts once", () => {
    useAvatarRuntimeStore.setState({ ...idle, activeRunId: "run-1" });
    const remount = vi.fn();
    remountWhenIdle("anima-a", remount);
    expect(remount).not.toHaveBeenCalled();

    // The text is done but the reply is still being spoken.
    useAvatarRuntimeStore.setState({ ...idle, activeSpeechRunId: "run-1" });
    expect(remount).not.toHaveBeenCalled();

    useAvatarRuntimeStore.setState(idle);
    expect(remount).toHaveBeenCalledTimes(1);
    // Later turns never remount again.
    useAvatarRuntimeStore.setState({ ...idle, activeRunId: "run-2" });
    useAvatarRuntimeStore.setState(idle);
    expect(remount).toHaveBeenCalledTimes(1);
  });

  it("drops a waiting remount when the chat moves to another Anima", () => {
    useAvatarRuntimeStore.setState({ ...idle, activeRunId: "run-1" });
    const remount = vi.fn();
    remountWhenIdle("anima-a", remount);

    // Opening Anima B resets the runtime store for B, clearing the run.
    useAvatarRuntimeStore.getState().resetForAnima("anima-b");
    useAvatarRuntimeStore.setState({ animaId: "anima-a" });
    expect(remount).not.toHaveBeenCalled();
  });

  it("keeps only the newest change made during one reply", () => {
    useAvatarRuntimeStore.setState({ ...idle, activeRunId: "run-1" });
    const first = vi.fn();
    const second = vi.fn();
    remountWhenIdle("anima-a", first);
    remountWhenIdle("anima-a", second);

    useAvatarRuntimeStore.setState(idle);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled", () => {
    useAvatarRuntimeStore.setState({ ...idle, activeRunId: "run-1" });
    const remount = vi.fn();
    const cancel = remountWhenIdle("anima-a", remount);
    cancel();
    useAvatarRuntimeStore.setState(idle);
    expect(remount).not.toHaveBeenCalled();
  });
});
