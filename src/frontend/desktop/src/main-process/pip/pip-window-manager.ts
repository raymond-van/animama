import { app, BrowserWindow, screen, type WebContents } from "electron";

import type { DesktopConfig } from "../config.js";
import {
  keepLocalizedTitle,
  type ShellLocale,
} from "../locale/shell-locale.js";
import { writeLog } from "../logging.js";
import { installWindowGuards } from "../security/guards.js";
import {
  movePipBoundsInside,
  readPipPlacement,
  resolveCornerPipBounds,
  resolveSavedPipBounds,
  writePipPlacement,
  type PipPlacement,
} from "./pip-placement.js";
import {
  clickThroughSupported,
  floatingWindowType,
  floatOnAllWorkspaces,
} from "../window/floating-window.js";

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

/**
 * Messages between the owner window and PiP. PiP sends `ready`,
 * `camera-preset`, `planner-events-consumed` and `voice-command`; the owner
 * sends Avatar `snapshot` / `incremental` state and `voice` state.
 */
export type DesktopPipRuntimeMessage = {
  type:
    | "ready"
    | "snapshot"
    | "incremental"
    | "camera-preset"
    | "planner-events-consumed"
    | "voice"
    | "voice-command";
  sequence: number;
  sentAtMs: number;
  animaId: string;
  payload: unknown;
};

type PipWindowManagerOptions = {
  config: DesktopConfig;
  /** Supplies the localized window title. */
  locale: ShellLocale;
  cursorSnapshotChannel: string;
  /** Where this machine remembers the PiP window's position and size. */
  placementFile: string;
  preloadPath: string;
  runtimeMessageChannel: string;
  stateChangedChannel: string;
};

export type PipMouseZone = "outside" | "interactive" | "pass-through";

type Point = {
  x: number;
  y: number;
};

type Size = {
  width: number;
  height: number;
};

type Bounds = Point & Size;

/** The window at size scale 1 before the owner gives it another shape. */
const DEFAULT_PIP_WIDTH = 420;
const DEFAULT_PIP_HEIGHT = 560;
const DEFAULT_PIP_ASPECT_RATIO = DEFAULT_PIP_WIDTH / DEFAULT_PIP_HEIGHT;
const MIN_PIP_SIZE_SCALE = 0.275;
const MAX_PIP_SIZE_SCALE = 1.6;
const MIN_PIP_WIDTH = Math.round(DEFAULT_PIP_WIDTH * MIN_PIP_SIZE_SCALE);
const MIN_PIP_HEIGHT = Math.round(DEFAULT_PIP_HEIGHT * MIN_PIP_SIZE_SCALE);
const MAX_PIP_WIDTH = 1200;
/** The size scale follows the height, so the height spans the scale range. */
const MAX_PIP_HEIGHT = Math.round(DEFAULT_PIP_HEIGHT * MAX_PIP_SIZE_SCALE);
const DEFAULT_BACKGROUND_MODE: DesktopPipBackgroundMode = "transparent";
const DEFAULT_PIP_SIZE_SCALE = 0.5;
const PIP_MOUSE_POLL_INTERVAL_MS = 50;
/** Moves and resizes arrive continuously; save once the window settles. */
const PIP_PLACEMENT_SAVE_DELAY_MS = 500;
/** The route's hover toolbar spans the top of the window, about 33px tall. */
const PIP_TOOLBAR_HIT_ZONE_HEIGHT = 40;
/** The route's resize grip sits in the bottom-right corner. */
const PIP_RESIZE_GRIP_HIT_ZONE_SIZE = 24;
const PIP_RESIZE_INTERVAL_MS = 16;

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

/**
 * The size scale of a window `height` pixels tall. The PiP camera's field of
 * view is vertical, so the Avatar's size on screen follows the window's
 * height; its width only sets how much room the Avatar has at its sides.
 */
function resolveSizeScaleForHeight(height: number): number {
  return clampPipSizeScale(height / DEFAULT_PIP_HEIGHT);
}

/**
 * The size scale that brings the window's bottom-right corner closest to the
 * cursor after it moved `dx`/`dy` from where a grip drag began. The window
 * keeps its shape (`aspectRatio`, width ÷ height), so the corner follows the
 * cursor's movement along the window's diagonal.
 */
export function resolveCornerResizeScale(
  startScale: number,
  dx: number,
  dy: number,
  aspectRatio: number,
): number {
  // The window's size at scale 1 in this shape.
  const width = DEFAULT_PIP_HEIGHT * aspectRatio;
  const height = DEFAULT_PIP_HEIGHT;
  const diagonalScale = (dx * width + dy * height) / (width ** 2 + height ** 2);
  return clampPipSizeScale(startScale + diagonalScale);
}

/** `size` rounded to whole pixels within the window's size limits. */
function clampPipWindowSize(size: Size): Size {
  return {
    width: clampWindowSize(
      size.width,
      DEFAULT_PIP_WIDTH,
      MIN_PIP_WIDTH,
      MAX_PIP_WIDTH,
    ),
    height: clampWindowSize(
      size.height,
      DEFAULT_PIP_HEIGHT,
      MIN_PIP_HEIGHT,
      MAX_PIP_HEIGHT,
    ),
  };
}

/** The window size for `sizeScale` in the shape `aspectRatio` (width ÷ height). */
function resolveWindowSizeForScale(
  sizeScale: number,
  aspectRatio: number,
): Size {
  const height = DEFAULT_PIP_HEIGHT * sizeScale;
  return clampPipWindowSize({ width: height * aspectRatio, height });
}

function resolveDefaultWindowSize(): Size {
  return resolveWindowSizeForScale(
    DEFAULT_PIP_SIZE_SCALE,
    DEFAULT_PIP_ASPECT_RATIO,
  );
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

/** Flush with the bottom-right corner of the owner window's display. */
function resolveDefaultPipBounds(
  ownerContents: WebContents,
  size: Size,
): Bounds {
  const ownerWindow = BrowserWindow.fromWebContents(ownerContents);
  const display =
    ownerWindow && !ownerWindow.isDestroyed()
      ? screen.getDisplayMatching(ownerWindow.getBounds())
      : screen.getPrimaryDisplay();
  return resolveCornerPipBounds(display.workArea, size);
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

function isInResizeGripZone(
  localX: number,
  localY: number,
  bounds: Bounds,
): boolean {
  return (
    localX >= bounds.width - PIP_RESIZE_GRIP_HIT_ZONE_SIZE &&
    localY >= bounds.height - PIP_RESIZE_GRIP_HIT_ZONE_SIZE
  );
}

/**
 * Where the cursor is relative to the PiP window. Only the hover toolbar and
 * the resize grip take mouse input; the rest of the window passes clicks to
 * the app underneath.
 */
export function classifyPipMouseZone(
  cursor: Point,
  bounds: Bounds,
): PipMouseZone {
  if (!isPointInsideBounds(cursor, bounds)) {
    return "outside";
  }

  const localX = cursor.x - bounds.x;
  const localY = cursor.y - bounds.y;
  if (
    localY < PIP_TOOLBAR_HIT_ZONE_HEIGHT ||
    isInResizeGripZone(localX, localY, bounds)
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
    message.type !== "incremental" &&
    message.type !== "camera-preset" &&
    message.type !== "planner-events-consumed" &&
    message.type !== "voice" &&
    message.type !== "voice-command"
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
  private readonly locale: ShellLocale;
  private readonly cursorSnapshotChannel: string;
  private readonly placementFile: string;
  /** The saved placement; undefined until the file is first read. */
  private placement: PipPlacement | null | undefined;
  private placementSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly preloadPath: string;
  private readonly runtimeMessageChannel: string;
  private readonly stateChangedChannel: string;
  private readonly clickThroughSupported = clickThroughSupported();
  private ownerContents: WebContents | null = null;
  /** Owners already watched for destruction; each needs one listener, not one per PiP window. */
  private readonly ownersWatchedForDestroy = new Set<number>();
  private mousePoll: ReturnType<typeof setInterval> | null = null;
  private pipMouseEventsIgnored = false;
  private pipWindow: BrowserWindow | null = null;
  private pipRuntimeStateReady = false;
  private pipRendererReady = false;
  /** Follows the cursor while the route's resize grip is held. */
  private gripResizeTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The window's shape (width ÷ height), which the size scale keeps. The owner
   * changes it by dragging the window's edges. A scale that reaches a size
   * limit does not, so the shape returns once the scale moves back while PiP
   * stays open; reopening starts from the size that was saved.
   */
  private aspectRatio = DEFAULT_PIP_ASPECT_RATIO;
  /**
   * The window size this manager last gave the window, as the OS reported it,
   * or took on from the owner. A `resize` to any other size came from the
   * owner dragging the window's edges.
   */
  private windowSize: Size | null = null;
  /** True while this manager sizes the window; those resizes are its own. */
  private applyingWindowBounds = false;
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
    this.locale = options.locale;
    this.cursorSnapshotChannel = options.cursorSnapshotChannel;
    this.placementFile = options.placementFile;
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

    // PiP reopens where the owner last left it on this machine, at the size
    // and shape they left it.
    const placement = this.savedPlacement();
    const initialBounds = this.resolveOpenBounds(
      ownerContents,
      placement,
      clampPipWindowSize(placement ?? options),
    );
    this.aspectRatio = initialBounds.width / initialBounds.height;
    this.state = {
      isOpen: true,
      animaId: options.animaId,
      chatId: options.chatId,
      backgroundMode: options.backgroundMode,
      isHovered: false,
      sizeScale: resolveSizeScaleForHeight(initialBounds.height),
    };

    const openWindow = this.pipWindow;
    if (openWindow?.isDestroyed() === false) {
      this.startMouseTracking(openWindow);
      this.resetPipReadiness();
      this.setPipMouseEventsIgnored(openWindow, false);
      openWindow.hide();
      this.applyWindowBounds(openWindow, () =>
        openWindow.setBounds(initialBounds),
      );
      await this.loadPipRoute(openWindow, options.animaId, options.chatId);
      this.syncPipWindowVisibility(openWindow);
      if (openWindow.isVisible()) {
        openWindow.focus();
      }
      this.sendStateChanged();
      return this.getState();
    }

    const pipWindow = new BrowserWindow({
      ...initialBounds,
      // Edge drags stay within the sizes the size scale can describe.
      minWidth: MIN_PIP_WIDTH,
      minHeight: MIN_PIP_HEIGHT,
      maxWidth: MAX_PIP_WIDTH,
      maxHeight: MAX_PIP_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      type: floatingWindowType(),
      title: this.locale.strings.text("windows.pip"),
      webPreferences: {
        preload: this.preloadPath,
        additionalArguments: ["--animama-window-role=pip"],
        partition: this.config.sessionPartition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // Packaged builds open no DevTools.
        devTools: !app.isPackaged,
      },
    });
    this.pipWindow = pipWindow;
    this.rememberWindowSize(pipWindow);
    keepLocalizedTitle(pipWindow, this.locale, "windows.pip");
    installWindowGuards(pipWindow, this.config.allowedWebOrigin);
    pipWindow.setAlwaysOnTop(true, "floating");
    floatOnAllWorkspaces(pipWindow);
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
      this.stopGripResize();
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
      this.stopGripResize();
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

    pipWindow.on("move", () => this.schedulePlacementSave(pipWindow));
    pipWindow.on("resize", () => {
      this.adoptOwnerResize(pipWindow);
      this.schedulePlacementSave(pipWindow);
    });
    pipWindow.on("close", () => {
      this.setPipMouseEventsIgnored(pipWindow, false);
    });
    pipWindow.on("closed", () => {
      // Keep a move made just before closing; quitting destroys the window
      // without a `close` event, but `closed` follows both.
      this.flushPlacementSave();
      handleClosed();
    });
    pipWindow.on("hide", () => {
      this.stopGripResize();
      this.setPipMouseEventsIgnored(pipWindow, false);
    });
    // A release outside the window after it lost focus never reaches the grip.
    pipWindow.on("blur", () => this.stopGripResize());
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
    this.stopGripResize();
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

  /**
   * Starts or ends a drag of the PiP route's bottom-right resize grip. While
   * it lasts, the window keeps its top-left corner and scales so its
   * bottom-right corner follows the cursor, and mouse input stays on so the
   * release reaches the grip wherever the cursor is.
   */
  setGripResizing(sender: WebContents, rawActive: unknown): void {
    const window = this.pipWindow;
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.id !== sender.id
    ) {
      writeLog("info", "Ignored PiP resize from a renderer other than PiP");
      return;
    }
    this.stopGripResize();
    if (rawActive !== true) return;

    this.setPipMouseEventsIgnored(window, false);
    const startCursor = screen.getCursorScreenPoint();
    const startScale = this.state.sizeScale;
    const aspectRatio = this.aspectRatio;
    this.gripResizeTimer = setInterval(() => {
      if (window.isDestroyed()) {
        this.stopGripResize();
        return;
      }
      const cursor = screen.getCursorScreenPoint();
      const sizeScale = resolveCornerResizeScale(
        startScale,
        cursor.x - startCursor.x,
        cursor.y - startCursor.y,
        aspectRatio,
      );
      if (sizeScale === this.state.sizeScale) return;
      this.state = { ...this.state, sizeScale };
      this.setPipWindowSizeScale(window, sizeScale, false);
      this.sendStateChanged();
    }, PIP_RESIZE_INTERVAL_MS);
  }

  private stopGripResize(): void {
    if (this.gripResizeTimer === null) return;
    clearInterval(this.gripResizeTimer);
    this.gripResizeTimer = null;
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
    // PiP sends readiness, camera preset requests, the planner events its
    // Avatar consumed and voice commands; the owner sends state.
    const fromPipOnly =
      message.type === "ready" ||
      message.type === "camera-preset" ||
      message.type === "planner-events-consumed" ||
      message.type === "voice-command";
    if (fromPipOnly && !isPipSender) {
      writeLog(
        "info",
        `Ignored PiP ${message.type} message from owner renderer`,
      );
      return;
    }
    if (!fromPipOnly && !isOwnerSender) {
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
      // Only Avatar state can make PiP visible; voice state may arrive first.
      const isAvatarState =
        message.type === "snapshot" || message.type === "incremental";
      if (isAvatarState && this.pipRendererReady) {
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

  /**
   * Take on a size the owner gave the window by dragging its edges: its shape
   * becomes the one the size scale keeps, and its height sets the scale.
   * Sizes this manager set itself are already accounted for.
   */
  private adoptOwnerResize(window: BrowserWindow): void {
    if (window.isDestroyed() || this.applyingWindowBounds) return;
    const { width, height } = window.getBounds();
    if (this.windowSize?.width === width && this.windowSize.height === height) {
      return;
    }
    this.windowSize = { width, height };
    this.aspectRatio = width / height;
    const sizeScale = resolveSizeScaleForHeight(height);
    if (sizeScale === this.state.sizeScale) return;
    this.state = { ...this.state, sizeScale };
    this.sendStateChanged();
  }

  /**
   * Size or place the window as this manager decides. The `resize` events
   * this causes are not the owner's, and the size is read back afterwards
   * because the OS may round it, for example at fractional display scaling
   * on Windows. The shape stays the one asked for, so rounding never adds up.
   */
  private applyWindowBounds(window: BrowserWindow, apply: () => void): void {
    this.applyingWindowBounds = true;
    try {
      apply();
    } finally {
      this.applyingWindowBounds = false;
    }
    this.rememberWindowSize(window);
  }

  private rememberWindowSize(window: BrowserWindow): void {
    const { width, height } = window.getBounds();
    this.windowSize = { width, height };
  }

  /**
   * Resize the window for a new size scale, in its current shape, and
   * remember it. The slider and wheel keep the window's center where the
   * work area allows; the grip keeps its top-left corner, so no `move` event
   * follows, and a programmatic `setSize` is not reliably reported as
   * `resize`; the placement is saved here rather than left to window events.
   */
  private setPipWindowSizeScale(
    window: BrowserWindow,
    sizeScale: number,
    preserveCenter: boolean,
  ): void {
    const nextSize = resolveWindowSizeForScale(sizeScale, this.aspectRatio);
    const bounds = window.getBounds();
    this.applyWindowBounds(window, () => {
      if (!preserveCenter) {
        window.setSize(nextSize.width, nextSize.height);
        return;
      }
      // Grow away from the work area's edges rather than past them, so PiP
      // left in a corner stays flush with it.
      window.setBounds(
        movePipBoundsInside(
          {
            x: Math.round(bounds.x + (bounds.width - nextSize.width) / 2),
            y: Math.round(bounds.y + (bounds.height - nextSize.height) / 2),
            width: nextSize.width,
            height: nextSize.height,
          },
          screen.getDisplayMatching(bounds).workArea,
        ),
      );
    });
    this.schedulePlacementSave(window);
  }

  /**
   * `size` at the saved position when its display is still connected, else at
   * the bottom-right corner of the owner window's display; either way fitted
   * to that display's work area.
   */
  private resolveOpenBounds(
    ownerContents: WebContents,
    placement: PipPlacement | null,
    size: Size,
  ): Bounds {
    const saved = placement
      ? resolveSavedPipBounds(placement, screen.getAllDisplays(), size)
      : null;
    return saved ?? resolveDefaultPipBounds(ownerContents, size);
  }

  private savedPlacement(): PipPlacement | null {
    if (this.placement === undefined) {
      this.placement = readPipPlacement(this.placementFile);
    }
    return this.placement;
  }

  /**
   * Remember the window's position and size now, and write them once moves
   * and resizes settle. The placement is read here, while the window is live,
   * so a pending write still lands after the window is destroyed.
   */
  private schedulePlacementSave(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    const bounds = window.getBounds();
    this.placement = {
      displayId: screen.getDisplayMatching(bounds).id,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
    if (this.placementSaveTimer !== null) {
      clearTimeout(this.placementSaveTimer);
    }
    this.placementSaveTimer = setTimeout(
      () => this.flushPlacementSave(),
      PIP_PLACEMENT_SAVE_DELAY_MS,
    );
  }

  /**
   * Write a pending placement. A failed write is logged; it only costs the
   * next launch its placement.
   */
  private flushPlacementSave(): void {
    if (this.placementSaveTimer === null) return;
    clearTimeout(this.placementSaveTimer);
    this.placementSaveTimer = null;
    const placement = this.placement;
    if (!placement) return;
    try {
      writePipPlacement(this.placementFile, placement);
    } catch (error) {
      writeLog(
        "error",
        `Could not save the PiP window placement: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
      const resizing = this.gripResizeTimer !== null;
      this.setHovered(resizing || mouseZone !== "outside");
      this.setPipMouseEventsIgnored(
        window,
        !resizing && mouseZone === "pass-through",
      );
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
