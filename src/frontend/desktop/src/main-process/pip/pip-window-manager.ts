import { BrowserWindow, screen, type WebContents } from "electron";

import type { DesktopConfig } from "../config.js";
import { writeLog } from "../logging.js";
import { installWindowGuards } from "../security/guards.js";

export type DesktopPipBackgroundMode = "transparent" | "scene";

export type DesktopPipOpenOptions = {
  animaId: string;
  chatId?: string | null;
  backgroundMode?: DesktopPipBackgroundMode;
  width?: number;
  height?: number;
};

export type DesktopPipState = {
  isOpen: boolean;
  animaId: string | null;
  chatId: string | null;
  backgroundMode: DesktopPipBackgroundMode;
  isHovered: boolean;
  sizeScale: number;
};

export type DesktopPipCursorSnapshot = {
  screen: Point;
  pipWindow: Bounds;
  local: Point;
  isInsidePip: boolean;
  sentAtMs: number;
};

export type DesktopPipRuntimeMessage = {
  type: "ready" | "snapshot" | "incremental";
  sequence: number;
  sentAtMs: number;
  animaId: string;
  payload: unknown;
};

type PipWindowManagerOptions = {
  config: DesktopConfig;
  cursorSnapshotChannel: string;
  preloadPath: string;
  runtimeMessageChannel: string;
  stateChangedChannel: string;
};

type PipMouseZone = "outside" | "interactive" | "pass-through";

type Point = {
  x: number;
  y: number;
};

type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const DEFAULT_PIP_WIDTH = 420;
const DEFAULT_PIP_HEIGHT = 560;
const MIN_PIP_SIZE_SCALE = 0.275;
const MIN_PIP_WIDTH = Math.round(DEFAULT_PIP_WIDTH * MIN_PIP_SIZE_SCALE);
const MIN_PIP_HEIGHT = Math.round(DEFAULT_PIP_HEIGHT * MIN_PIP_SIZE_SCALE);
const MAX_PIP_WIDTH = 1200;
const MAX_PIP_HEIGHT = 1200;
const DEFAULT_BACKGROUND_MODE: DesktopPipBackgroundMode = "transparent";
const DEFAULT_PIP_SIZE_SCALE = 0.5;
const MAX_PIP_SIZE_SCALE = 1.6;
const PIP_DEFAULT_RIGHT_MARGIN = 24;
const PIP_DEFAULT_BOTTOM_MARGIN = 32;
const PIP_MOUSE_POLL_INTERVAL_MS = 50;
const PIP_RESIZE_HIT_ZONE_SIZE = 10;
const PIP_CLOSE_HIT_ZONE_SIZE = 20;
const PIP_DRAG_HANDLE_SIZE = 20;
const PIP_DRAG_HANDLE_LEFT = 4;
const PIP_DRAG_HANDLE_TOP = 4;
const PIP_SIZE_SLIDER_SIDE_OFFSET = 24;
const PIP_TOP_CONTROL_HIT_ZONE_HEIGHT = 20;

function readAnimaId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected PiP animaId");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Expected PiP animaId");
  }
  return trimmed;
}

function readOptionalNullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error("Expected nullable string");
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readBackgroundMode(value: unknown): DesktopPipBackgroundMode {
  return value === "scene" ? "scene" : DEFAULT_BACKGROUND_MODE;
}

function clampWindowSize(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampPipSizeScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PIP_SIZE_SCALE;
  }
  return Math.max(MIN_PIP_SIZE_SCALE, Math.min(MAX_PIP_SIZE_SCALE, value));
}

function resolveSizeScaleForWindowSize(width: number, height: number): number {
  const widthScale = width / DEFAULT_PIP_WIDTH;
  const heightScale = height / DEFAULT_PIP_HEIGHT;
  return clampPipSizeScale((widthScale + heightScale) / 2);
}

function resolveWindowSizeForScale(sizeScale: number): {
  width: number;
  height: number;
} {
  return {
    width: clampWindowSize(
      DEFAULT_PIP_WIDTH * sizeScale,
      DEFAULT_PIP_WIDTH,
      MIN_PIP_WIDTH,
      MAX_PIP_WIDTH,
    ),
    height: clampWindowSize(
      DEFAULT_PIP_HEIGHT * sizeScale,
      DEFAULT_PIP_HEIGHT,
      MIN_PIP_HEIGHT,
      MAX_PIP_HEIGHT,
    ),
  };
}

function resolveDefaultWindowSize(): {
  width: number;
  height: number;
} {
  return resolveWindowSizeForScale(DEFAULT_PIP_SIZE_SCALE);
}

function isLiveWebContents(
  contents: WebContents | null,
): contents is WebContents {
  return Boolean(contents && !contents.isDestroyed());
}

function isPipRouteUrl(value: string, allowedWebOrigin: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === allowedWebOrigin &&
      url.pathname.startsWith("/desktop/pip/")
    );
  } catch {
    return false;
  }
}

function resolveDefaultPipBounds(
  ownerContents: WebContents,
  width: number,
  height: number,
): Bounds {
  const ownerWindow = BrowserWindow.fromWebContents(ownerContents);
  const display =
    ownerWindow && !ownerWindow.isDestroyed()
      ? screen.getDisplayMatching(ownerWindow.getBounds())
      : screen.getPrimaryDisplay();
  const { workArea } = display;

  return {
    x: Math.max(
      workArea.x,
      Math.round(
        workArea.x + workArea.width - width - PIP_DEFAULT_RIGHT_MARGIN,
      ),
    ),
    y: Math.max(
      workArea.y,
      Math.round(
        workArea.y + workArea.height - height - PIP_DEFAULT_BOTTOM_MARGIN,
      ),
    ),
    width,
    height,
  };
}

function syncPipWindowVisibility(
  window: BrowserWindow,
  allowedWebOrigin: string,
  allowShow: boolean,
  beforeHide?: () => void,
): void {
  if (window.isDestroyed()) return;
  if (
    isPipRouteUrl(window.webContents.getURL(), allowedWebOrigin) &&
    allowShow
  ) {
    if (!window.isVisible()) {
      window.show();
    }
    return;
  }
  if (window.isVisible()) {
    beforeHide?.();
    window.hide();
  }
}

function isPointInsideBounds(point: Point, bounds: Bounds): boolean {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

function isInResizeZone(
  localX: number,
  localY: number,
  bounds: Bounds,
): boolean {
  return (
    localX < PIP_RESIZE_HIT_ZONE_SIZE ||
    localX >= bounds.width - PIP_RESIZE_HIT_ZONE_SIZE ||
    localY < PIP_RESIZE_HIT_ZONE_SIZE ||
    localY >= bounds.height - PIP_RESIZE_HIT_ZONE_SIZE
  );
}

function isInCloseZone(
  localX: number,
  localY: number,
  bounds: Bounds,
): boolean {
  return (
    localX >= bounds.width - PIP_CLOSE_HIT_ZONE_SIZE &&
    localY < PIP_CLOSE_HIT_ZONE_SIZE
  );
}

function isInDragHandleZone(
  localX: number,
  localY: number,
  bounds: Bounds,
): boolean {
  const dragHandleLeft = PIP_DRAG_HANDLE_LEFT;
  const dragHandleRight = Math.min(
    bounds.width,
    dragHandleLeft + PIP_DRAG_HANDLE_SIZE,
  );

  return (
    localX >= dragHandleLeft &&
    localX < dragHandleRight &&
    localY >= PIP_DRAG_HANDLE_TOP &&
    localY < PIP_DRAG_HANDLE_TOP + PIP_DRAG_HANDLE_SIZE
  );
}

function isInSizeSliderZone(
  localX: number,
  localY: number,
  bounds: Bounds,
): boolean {
  return (
    localX >= PIP_SIZE_SLIDER_SIDE_OFFSET &&
    localX < bounds.width - PIP_SIZE_SLIDER_SIDE_OFFSET &&
    localY < PIP_TOP_CONTROL_HIT_ZONE_HEIGHT
  );
}

function classifyPipMouseZone(cursor: Point, bounds: Bounds): PipMouseZone {
  if (!isPointInsideBounds(cursor, bounds)) {
    return "outside";
  }

  const localX = cursor.x - bounds.x;
  const localY = cursor.y - bounds.y;
  if (
    isInResizeZone(localX, localY, bounds) ||
    isInCloseZone(localX, localY, bounds) ||
    isInDragHandleZone(localX, localY, bounds) ||
    isInSizeSliderZone(localX, localY, bounds)
  ) {
    return "interactive";
  }

  return "pass-through";
}

function canCloneRuntimeMessage(message: DesktopPipRuntimeMessage): boolean {
  try {
    structuredClone(message);
    return true;
  } catch {
    return false;
  }
}

function normalizeOpenOptions(value: unknown): Required<DesktopPipOpenOptions> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected PiP open options");
  }
  const options = value as Record<string, unknown>;
  const defaultSize = resolveDefaultWindowSize();
  return {
    animaId: readAnimaId(options.animaId),
    chatId: readOptionalNullableString(options.chatId),
    backgroundMode: readBackgroundMode(options.backgroundMode),
    width: clampWindowSize(
      options.width,
      defaultSize.width,
      MIN_PIP_WIDTH,
      MAX_PIP_WIDTH,
    ),
    height: clampWindowSize(
      options.height,
      defaultSize.height,
      MIN_PIP_HEIGHT,
      MAX_PIP_HEIGHT,
    ),
  };
}

function normalizeRuntimeMessage(value: unknown): DesktopPipRuntimeMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected PiP runtime message");
  }
  const message = value as Record<string, unknown>;
  if (
    message.type !== "ready" &&
    message.type !== "snapshot" &&
    message.type !== "incremental"
  ) {
    throw new Error("Expected valid PiP runtime message type");
  }
  if (
    typeof message.sequence !== "number" ||
    !Number.isFinite(message.sequence)
  ) {
    throw new Error("Expected finite PiP runtime message sequence");
  }
  if (
    typeof message.sentAtMs !== "number" ||
    !Number.isFinite(message.sentAtMs)
  ) {
    throw new Error("Expected finite PiP runtime message sentAtMs");
  }
  const normalized: DesktopPipRuntimeMessage = {
    type: message.type,
    sequence: Math.max(0, Math.round(message.sequence)),
    sentAtMs: message.sentAtMs,
    animaId: readAnimaId(message.animaId),
    payload: message.payload,
  };
  if (!canCloneRuntimeMessage(normalized)) {
    throw new Error("PiP runtime message is not cloneable");
  }
  return normalized;
}

export class PipWindowManager {
  private readonly config: DesktopConfig;
  private readonly cursorSnapshotChannel: string;
  private readonly preloadPath: string;
  private readonly runtimeMessageChannel: string;
  private readonly stateChangedChannel: string;
  private readonly clickThroughSupported = process.platform !== "linux";
  private ownerContents: WebContents | null = null;
  /** Owners already watched for destruction; each needs one listener, not one per PiP window. */
  private readonly ownersWatchedForDestroy = new Set<number>();
  private mousePoll: ReturnType<typeof setInterval> | null = null;
  private pipMouseEventsIgnored = false;
  private pipWindow: BrowserWindow | null = null;
  private pipRuntimeStateReady = false;
  private pipRendererReady = false;
  private state: DesktopPipState = {
    isOpen: false,
    animaId: null,
    chatId: null,
    backgroundMode: DEFAULT_BACKGROUND_MODE,
    isHovered: false,
    sizeScale: DEFAULT_PIP_SIZE_SCALE,
  };

  constructor(options: PipWindowManagerOptions) {
    this.config = options.config;
    this.cursorSnapshotChannel = options.cursorSnapshotChannel;
    this.preloadPath = options.preloadPath;
    this.runtimeMessageChannel = options.runtimeMessageChannel;
    this.stateChangedChannel = options.stateChangedChannel;
  }

  getState(): DesktopPipState {
    return { ...this.state };
  }

  async open(
    ownerContents: WebContents,
    rawOptions: unknown,
  ): Promise<DesktopPipState> {
    const options = normalizeOpenOptions(rawOptions);
    this.ownerContents = ownerContents;
    this.closePipWhenOwnerDestroyed(ownerContents);

    this.state = {
      isOpen: true,
      animaId: options.animaId,
      chatId: options.chatId,
      backgroundMode: options.backgroundMode,
      isHovered: false,
      sizeScale: resolveSizeScaleForWindowSize(options.width, options.height),
    };

    if (this.pipWindow?.isDestroyed() === false) {
      this.startMouseTracking(this.pipWindow);
      this.resetPipReadiness();
      this.setPipMouseEventsIgnored(this.pipWindow, false);
      this.pipWindow.hide();
      this.setPipWindowDefaultBounds(
        this.pipWindow,
        ownerContents,
        this.state.sizeScale,
      );
      await this.loadPipRoute(this.pipWindow, options.animaId, options.chatId);
      this.syncPipWindowVisibility(this.pipWindow);
      if (this.pipWindow.isVisible()) {
        this.pipWindow.focus();
      }
      this.sendStateChanged();
      return this.getState();
    }

    const initialBounds = resolveDefaultPipBounds(
      ownerContents,
      options.width,
      options.height,
    );

    const pipWindow = new BrowserWindow({
      x: initialBounds.x,
      y: initialBounds.y,
      width: options.width,
      height: options.height,
      minWidth: MIN_PIP_WIDTH,
      minHeight: MIN_PIP_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      type: "toolbar",
      title: "Anima PiP",
      webPreferences: {
        preload: this.preloadPath,
        additionalArguments: ["--animama-window-role=pip"],
        partition: this.config.sessionPartition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.pipWindow = pipWindow;
    installWindowGuards(pipWindow, this.config.allowedWebOrigin);
    pipWindow.setAlwaysOnTop(true, "floating");
    pipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.startMouseTracking(pipWindow);

    const syncVisibility = () => {
      if (
        !isPipRouteUrl(
          pipWindow.webContents.getURL(),
          this.config.allowedWebOrigin,
        )
      ) {
        this.resetPipReadiness();
      }
      this.syncPipWindowVisibility(pipWindow);
    };

    pipWindow.webContents.on("will-navigate", () => {
      this.resetPipReadiness();
      if (!pipWindow.isDestroyed() && pipWindow.isVisible()) {
        this.setPipMouseEventsIgnored(pipWindow, false);
        pipWindow.hide();
      }
    });
    pipWindow.webContents.on("did-finish-load", syncVisibility);
    pipWindow.webContents.on("did-navigate", syncVisibility);
    pipWindow.webContents.on("did-navigate-in-page", syncVisibility);

    const handleClosed = () => {
      if (this.pipWindow !== pipWindow) return;
      this.pipWindow = null;
      this.pipMouseEventsIgnored = false;
      this.stopMouseTracking();
      this.resetPipReadiness();
      this.state = {
        ...this.state,
        isOpen: false,
        isHovered: false,
      };
      this.sendStateChanged();
    };

    pipWindow.on("close", () => {
      this.setPipMouseEventsIgnored(pipWindow, false);
    });
    pipWindow.on("closed", handleClosed);
    pipWindow.on("hide", () => {
      this.setPipMouseEventsIgnored(pipWindow, false);
    });
    await this.loadPipRoute(pipWindow, options.animaId, options.chatId);
    this.sendStateChanged();
    return this.getState();
  }

  async toggle(
    ownerContents: WebContents,
    rawOptions: unknown,
  ): Promise<DesktopPipState> {
    if (this.state.isOpen && this.pipWindow && !this.pipWindow.isDestroyed()) {
      return this.close();
    }
    return this.open(ownerContents, rawOptions);
  }

  close(): DesktopPipState {
    const window = this.pipWindow;
    if (window && !window.isDestroyed()) {
      this.setPipMouseEventsIgnored(window, false);
      window.close();
    } else {
      this.pipWindow = null;
      this.pipMouseEventsIgnored = false;
      this.stopMouseTracking();
      this.resetPipReadiness();
      this.state = {
        ...this.state,
        isOpen: false,
        isHovered: false,
      };
      this.sendStateChanged();
    }
    return this.getState();
  }

  setBackgroundMode(rawMode: unknown): DesktopPipState {
    const backgroundMode = readBackgroundMode(rawMode);
    this.state = {
      ...this.state,
      backgroundMode,
    };
    this.sendStateChanged();
    return this.getState();
  }

  setSizeScale(rawScale: unknown): DesktopPipState {
    const sizeScale = clampPipSizeScale(rawScale);
    this.state = {
      ...this.state,
      sizeScale,
    };

    if (this.pipWindow && !this.pipWindow.isDestroyed()) {
      this.setPipWindowSizeScale(this.pipWindow, sizeScale, true);
    }

    this.sendStateChanged();
    return this.getState();
  }

  publishRuntimeMessage(sender: WebContents, rawMessage: unknown): void {
    const message = normalizeRuntimeMessage(rawMessage);
    if (!this.state.isOpen || !this.state.animaId) {
      return;
    }
    if (message.animaId !== this.state.animaId) {
      throw new Error("PiP runtime message anima mismatch");
    }

    const isOwnerSender = this.ownerContents?.id === sender.id;
    const isPipSender = this.pipWindow?.webContents.id === sender.id;
    if (!isOwnerSender && !isPipSender) {
      throw new Error("PiP runtime message came from an unknown renderer");
    }
    if (message.type === "ready" && !isPipSender) {
      writeLog("info", "Ignored PiP ready message from owner renderer");
      return;
    }
    if (message.type !== "ready" && !isOwnerSender) {
      writeLog("info", "Ignored PiP runtime state from PiP renderer");
      return;
    }
    if (message.type === "ready") {
      if (!this.pipRendererReady) {
        writeLog("info", "PiP renderer ready");
      }
      this.pipRendererReady = true;
      if (this.pipWindow && !this.pipWindow.isDestroyed()) {
        this.syncPipWindowVisibility(this.pipWindow);
      }
    }

    const target = isPipSender
      ? this.ownerContents
      : (this.pipWindow?.webContents ?? null);
    if (isLiveWebContents(target)) {
      target.send(this.runtimeMessageChannel, message);
      if (!isPipSender && this.pipRendererReady) {
        if (!this.pipRuntimeStateReady) {
          writeLog("info", "PiP initial runtime state received");
        }
        this.pipRuntimeStateReady = true;
        if (this.pipWindow && !this.pipWindow.isDestroyed()) {
          this.syncPipWindowVisibility(this.pipWindow);
        }
      }
    }
  }

  /**
   * Close PiP if the window that opened it goes away. The listener reads the
   * current PiP window when it fires, so closed PiP windows are not retained.
   */
  private closePipWhenOwnerDestroyed(ownerContents: WebContents): void {
    const ownerId = ownerContents.id;
    if (this.ownersWatchedForDestroy.has(ownerId)) return;
    this.ownersWatchedForDestroy.add(ownerId);
    ownerContents.once("destroyed", () => {
      this.ownersWatchedForDestroy.delete(ownerId);
      const pipWindow = this.pipWindow;
      if (this.ownerContents !== ownerContents || !pipWindow) return;
      if (!pipWindow.isDestroyed()) {
        this.setPipMouseEventsIgnored(pipWindow, false);
        pipWindow.close();
      }
    });
  }

  private async loadPipRoute(
    window: BrowserWindow,
    animaId: string,
    chatId: string | null,
  ): Promise<void> {
    const pipUrl = new URL(
      `/desktop/pip/${encodeURIComponent(animaId)}`,
      this.config.webUrl.origin,
    );
    pipUrl.searchParams.set("desktopPip", "1");
    if (chatId) {
      pipUrl.searchParams.set("chatId", chatId);
    }

    writeLog("info", `Loading PiP ${pipUrl.href}`);
    this.resetPipReadiness();
    if (!window.isDestroyed()) {
      this.setPipMouseEventsIgnored(window, false);
      window.hide();
    }
    await window.loadURL(pipUrl.href);
  }

  private syncPipWindowVisibility(window: BrowserWindow): void {
    syncPipWindowVisibility(
      window,
      this.config.allowedWebOrigin,
      this.canShowPipWindow(),
      () => this.setPipMouseEventsIgnored(window, false),
    );
  }

  private canShowPipWindow(): boolean {
    return this.pipRendererReady && this.pipRuntimeStateReady;
  }

  private resetPipReadiness(): void {
    this.pipRendererReady = false;
    this.pipRuntimeStateReady = false;
  }

  private setHovered(isHovered: boolean): void {
    if (this.state.isHovered === isHovered) return;
    this.state = {
      ...this.state,
      isHovered,
    };
    this.sendStateChanged();
  }

  private setPipWindowSizeScale(
    window: BrowserWindow,
    sizeScale: number,
    preserveCenter: boolean,
  ): void {
    const nextSize = resolveWindowSizeForScale(sizeScale);
    if (!preserveCenter) {
      window.setSize(nextSize.width, nextSize.height);
      return;
    }

    const bounds = window.getBounds();
    window.setBounds({
      x: Math.round(bounds.x + (bounds.width - nextSize.width) / 2),
      y: Math.round(bounds.y + (bounds.height - nextSize.height) / 2),
      width: nextSize.width,
      height: nextSize.height,
    });
  }

  private setPipWindowDefaultBounds(
    window: BrowserWindow,
    ownerContents: WebContents,
    sizeScale: number,
  ): void {
    const nextSize = resolveWindowSizeForScale(sizeScale);
    window.setBounds(
      resolveDefaultPipBounds(ownerContents, nextSize.width, nextSize.height),
    );
  }

  private setPipMouseEventsIgnored(
    window: BrowserWindow,
    ignoreMouseEvents: boolean,
  ): void {
    if (window.isDestroyed()) {
      this.pipMouseEventsIgnored = false;
      return;
    }
    if (this.pipMouseEventsIgnored === ignoreMouseEvents) return;

    if (!this.clickThroughSupported && ignoreMouseEvents) return;

    if (ignoreMouseEvents) {
      window.setIgnoreMouseEvents(true, { forward: true });
    } else {
      window.setIgnoreMouseEvents(false);
    }
    this.pipMouseEventsIgnored = ignoreMouseEvents;
  }

  private startMouseTracking(window: BrowserWindow): void {
    if (this.mousePoll !== null) return;
    this.mousePoll = setInterval(() => {
      if (window.isDestroyed() || this.pipWindow !== window) {
        if (!window.isDestroyed()) {
          this.setPipMouseEventsIgnored(window, false);
        } else {
          this.pipMouseEventsIgnored = false;
        }
        this.stopMouseTracking();
        return;
      }
      if (!window.isVisible()) {
        this.setPipMouseEventsIgnored(window, false);
        this.setHovered(false);
        return;
      }

      const cursor = screen.getCursorScreenPoint();
      const bounds = window.getBounds();
      const mouseZone = classifyPipMouseZone(cursor, bounds);
      this.sendCursorSnapshot(window, cursor, bounds);
      this.setHovered(mouseZone !== "outside");
      this.setPipMouseEventsIgnored(window, mouseZone === "pass-through");
    }, PIP_MOUSE_POLL_INTERVAL_MS);
  }

  private stopMouseTracking(): void {
    if (this.mousePoll === null) return;
    clearInterval(this.mousePoll);
    this.mousePoll = null;
  }

  private sendStateChanged(): void {
    const state = this.getState();
    for (const contents of [
      this.ownerContents,
      this.pipWindow?.webContents ?? null,
    ]) {
      if (isLiveWebContents(contents)) {
        contents.send(this.stateChangedChannel, state);
      }
    }
  }

  private sendCursorSnapshot(
    window: BrowserWindow,
    cursor: Point,
    bounds: Bounds,
  ): void {
    if (window.isDestroyed() || !isLiveWebContents(window.webContents)) {
      return;
    }

    const snapshot: DesktopPipCursorSnapshot = {
      screen: {
        x: cursor.x,
        y: cursor.y,
      },
      pipWindow: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
      local: {
        x: cursor.x - bounds.x,
        y: cursor.y - bounds.y,
      },
      isInsidePip: isPointInsideBounds(cursor, bounds),
      sentAtMs: Date.now(),
    };
    window.webContents.send(this.cursorSnapshotChannel, snapshot);
  }
}
