import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMenuBridge } from "../src/main-process/runtime/runtime-preload.cjs";

/** A stand-in for main: `menu:take` answers are resolved by the test. */
const main = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  takes: [] as Array<(command: unknown) => void>,
}));
vi.mock("electron", () => ({
  ipcRenderer: {
    on: (_channel: string, listener: () => void) =>
      main.listeners.add(listener),
    removeListener: (_channel: string, listener: () => void) =>
      main.listeners.delete(listener),
    invoke: (channel: string) => {
      expect(channel).toBe("animama:menu:take");
      return new Promise((resolve) => main.takes.push(resolve));
    },
  },
}));

/** Answer the oldest pending `menu:take` and let its handlers run. */
async function answer(command: unknown) {
  main.takes.shift()!(command);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  main.listeners.clear();
  main.takes.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the menu bridge in the main window", () => {
  it("takes the waiting command on subscribing and whenever main announces one", async () => {
    const received: string[] = [];
    const stop = createMenuBridge().onCommand((command) =>
      received.push(command),
    );

    // Nothing was chosen while the window loaded.
    await answer(null);
    expect(received).toEqual([]);

    for (const listener of main.listeners) listener();
    await answer("import-anima");
    expect(received).toEqual(["import-anima"]);

    // Only the two known commands ever reach the web app.
    for (const listener of main.listeners) listener();
    await answer("open-devtools");
    expect(received).toEqual(["import-anima"]);

    stop();
    expect(main.listeners.size).toBe(0);
  });

  it("gives a command taken for a subscriber that left to the next one", async () => {
    const bridge = createMenuBridge();
    const first: string[] = [];
    const second: string[] = [];

    // React's development double mount: subscribe, unsubscribe, subscribe.
    bridge.onCommand((command) => first.push(command))();
    bridge.onCommand((command) => second.push(command));
    await answer("check-for-updates");
    await answer(null);

    expect(first).toEqual([]);
    expect(second).toEqual(["check-for-updates"]);
  });

  it("holds an unclaimed command only briefly", async () => {
    vi.useFakeTimers();
    const bridge = createMenuBridge();
    const received: string[] = [];

    bridge.onCommand(() => undefined)();
    await answer("import-anima");
    vi.advanceTimersByTime(5_001);
    bridge.onCommand((command) => received.push(command));
    await answer(null);

    expect(received).toEqual([]);
  });
});
