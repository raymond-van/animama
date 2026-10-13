import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  /** Enough of Node's EventEmitter to count Electron listeners. */
  class Emitter {
    private readonly listeners = new Map<string, Array<() => void>>();
    on(event: string, listener: () => void) {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
      return this;
    }
    once(event: string, listener: () => void) {
      const wrapped = () => {
        this.off(event, wrapped);
        listener();
      };
      return this.on(event, wrapped);
    }
    off(event: string, listener: () => void) {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((entry) => entry !== listener),
      );
      return this;
    }
    emit(event: string) {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }
    listenerCount(event: string) {
      return this.listeners.get(event)?.length ?? 0;
    }
  }

  let nextId = 1;
  class FakeWebContents extends Emitter {
    readonly id = nextId++;
    url = "";
    send = vi.fn();
    getURL() {
      return this.url;
    }
    isDestroyed() {
      return false;
    }
  }

  class FakeBrowserWindow extends Emitter {
    static fromWebContents() {
      return null;
    }
    readonly webContents = new FakeWebContents();
    destroyed = false;
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return false;
    }
    async loadURL(url: string) {
      this.webContents.url = url;
    }
    close() {
      this.emit("close");
      this.destroyed = true;
      this.emit("closed");
    }
    hide() {}
    show() {}
    focus() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    setBounds() {}
    setSize() {}
    getBounds() {
      return { x: 0, y: 0, width: 210, height: 280 };
    }
  }

  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  return { FakeBrowserWindow, FakeWebContents, workArea };
});

vi.mock("electron", () => ({
  BrowserWindow: fake.FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({ workArea: fake.workArea }),
    getDisplayMatching: () => ({ workArea: fake.workArea }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
}));
vi.mock("../src/main-process/security/guards.js", () => ({
  installWindowGuards: () => undefined,
}));
vi.mock("../src/main-process/logging.js", () => ({
  writeLog: () => undefined,
}));

import type { WebContents } from "electron";
import { PipWindowManager } from "../src/main-process/pip/pip-window-manager.js";

function manager() {
  return new PipWindowManager({
    config: {
      allowedWebOrigin: "http://localhost:8000",
      loadTimeoutMs: 1000,
      sessionPartition: "persist:test",
      webUrl: new URL("http://localhost:8000"),
    },
    cursorSnapshotChannel: "pip:cursor",
    preloadPath: "/preload.cjs",
    runtimeMessageChannel: "pip:runtime",
    stateChangedChannel: "pip:state",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PipWindowManager", () => {
  it("keeps one owner listener however many PiP windows open and close", async () => {
    const pip = manager();
    const owner = new fake.FakeWebContents();

    for (let cycle = 0; cycle < 12; cycle += 1) {
      await pip.open(owner as unknown as WebContents, { animaId: "annie" });
      pip.close();
    }

    expect(owner.listenerCount("destroyed")).toBe(1);
    expect(pip.getState().isOpen).toBe(false);
  });

  it("still closes an open PiP window when its owner is destroyed", async () => {
    const pip = manager();
    const owner = new fake.FakeWebContents();
    await pip.open(owner as unknown as WebContents, { animaId: "annie" });
    pip.close();
    await pip.open(owner as unknown as WebContents, { animaId: "annie" });

    owner.emit("destroyed");

    expect(pip.getState().isOpen).toBe(false);
  });

  it("closes PiP only for the window that currently owns it", async () => {
    const pip = manager();
    const former = new fake.FakeWebContents();
    const current = new fake.FakeWebContents();
    await pip.open(former as unknown as WebContents, { animaId: "annie" });
    // A second window takes over the live PiP window.
    await pip.open(current as unknown as WebContents, { animaId: "annie" });

    former.emit("destroyed");
    expect(pip.getState().isOpen).toBe(true);

    current.emit("destroyed");
    expect(pip.getState().isOpen).toBe(false);
  });
});
