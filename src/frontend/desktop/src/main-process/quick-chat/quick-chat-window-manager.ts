import { app, BrowserWindow, screen, type WebContents } from "electron";

import type { DesktopConfig } from "../config.js";
import {
  keepLocalizedTitle,
  type ShellLocale,
} from "../locale/shell-locale.js";
import { writeLog } from "../logging.js";
import { installWindowGuards } from "../security/guards.js";
import {
  clickThroughSupported,
  floatingWindowType,
  floatOnAllWorkspaces,
} from "../window/floating-window.js";

export type DesktopQuickChatOpenOptions = {
  animaId: string;
  chatId?: string | null;
  width?: number;
  height?: number;
};

export type DesktopQuickChatState = {
  isOpen: boolean;
  animaId: string | null;
  chatId: string | null;
};

export type DesktopQuickChatInteractiveRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopQuickChatLayoutMetrics = {
  desiredHeight: number;
};

export type DesktopQuickChatRuntimeMessage = {
  type: "ready" | "snapshot" | "command" | "request-snapshot" | "focus-input";
  sequence: number;
  sentAtMs: number;
  animaId: string;
  payload: unknown;
};

type QuickChatWindowManagerOptions = {
  config: DesktopConfig;
  /** Supplies the localized window title. */
  locale: ShellLocale;
  preloadPath: string;
  runtimeMessageChannel: string;
  stateChangedChannel: string;
};

type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Point = {
  x: number;
  y: number;
};

const DEFAULT_QUICK_CHAT_WIDTH = 900;
const DEFAULT_QUICK_CHAT_HEIGHT = 760;
const MIN_QUICK_CHAT_WIDTH = 420;
const MIN_QUICK_CHAT_HEIGHT = 420;
const MAX_QUICK_CHAT_WIDTH = 1400;
const MAX_QUICK_CHAT_HEIGHT = 1200;
const QUICK_CHAT_MOUSE_POLL_INTERVAL_MS = 50;
const QUICK_CHAT_NATIVE_PAINT_FALLBACK_MS = 500;
const QUICK_CHAT_REVEAL_DELAY_MS = 34;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readAnimaId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected Quick Chat animaId");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Expected Quick Chat animaId");
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

function normalizeOpenOptions(
  value: unknown,
): Required<DesktopQuickChatOpenOptions> {
  if (!isRecord(value)) {
    throw new Error("Expected Quick Chat open options");
  }
  return {
    animaId: readAnimaId(value.animaId),
    chatId: readOptionalNullableString(value.chatId),
    width: clampWindowSize(
      value.width,
      DEFAULT_QUICK_CHAT_WIDTH,
      MIN_QUICK_CHAT_WIDTH,
      MAX_QUICK_CHAT_WIDTH,
    ),
    height: clampWindowSize(
      value.height,
      DEFAULT_QUICK_CHAT_HEIGHT,
      MIN_QUICK_CHAT_HEIGHT,
      MAX_QUICK_CHAT_HEIGHT,
    ),
  };
}

function normalizeRuntimeMessage(
  value: unknown,
): DesktopQuickChatRuntimeMessage {
  if (!isRecord(value)) {
    throw new Error("Expected Quick Chat runtime message");
  }
  if (
    value.type !== "ready" &&
    value.type !== "snapshot" &&
    value.type !== "command" &&
    value.type !== "request-snapshot" &&
    value.type !== "focus-input"
  ) {
    throw new Error("Expected valid Quick Chat runtime message type");
  }
  if (typeof value.sequence !== "number" || !Number.isFinite(value.sequence)) {
    throw new Error("Expected finite Quick Chat runtime message sequence");
  }
  if (typeof value.sentAtMs !== "number" || !Number.isFinite(value.sentAtMs)) {
    throw new Error("Expected finite Quick Chat runtime message sentAtMs");
  }

  const normalized: DesktopQuickChatRuntimeMessage = {
    type: value.type,
    sequence: Math.max(0, Math.round(value.sequence)),
    sentAtMs: value.sentAtMs,
    animaId: readAnimaId(value.animaId),
    payload: value.payload,
  };
  try {
    structuredClone(normalized);
  } catch {
    throw new Error("Quick Chat runtime message is not cloneable");
  }
  return normalized;
}

function normalizeInteractiveRegions(
  value: unknown,
): DesktopQuickChatInteractiveRegion[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected Quick Chat interactive regions");
  }
  return value
    .filter(isRecord)
    .map((region) => ({
      x: clampWindowSize(region.x, 0, 0, MAX_QUICK_CHAT_WIDTH),
      y: clampWindowSize(region.y, 0, 0, MAX_QUICK_CHAT_HEIGHT),
      width: clampWindowSize(region.width, 0, 0, MAX_QUICK_CHAT_WIDTH),
      height: clampWindowSize(region.height, 0, 0, MAX_QUICK_CHAT_HEIGHT),
    }))
    .filter((region) => region.width > 0 && region.height > 0);
}

function normalizeLayoutMetrics(value: unknown): DesktopQuickChatLayoutMetrics {
  if (!isRecord(value)) {
    throw new Error("Expected Quick Chat layout metrics");
  }
  return {
    desiredHeight: clampWindowSize(
      value.desiredHeight,
      DEFAULT_QUICK_CHAT_HEIGHT,
      DEFAULT_QUICK_CHAT_HEIGHT,
      MAX_QUICK_CHAT_HEIGHT,
    ),
  };
}

/**
 * Quick Chat commands whose result appears in the main window, such as opening
 * a memory cue's file in the Memory workspace. The owner renderer validates
 * the payload; the manager only reads its type to reveal that window.
 */
const OWNER_WINDOW_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "open-memory-entry",
]);

/** Exported for tests. */
export function isOwnerWindowCommand(
  message: DesktopQuickChatRuntimeMessage,
): boolean {
  return (
    message.type === "command" &&
    isRecord(message.payload) &&
    typeof message.payload.type === "string" &&
    OWNER_WINDOW_COMMAND_TYPES.has(message.payload.type)
  );
}

function isLiveWebContents(
  contents: WebContents | null,
): contents is WebContents {
  return Boolean(contents && !contents.isDestroyed());
}

function isQuickChatRouteUrl(value: string, allowedWebOrigin: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === allowedWebOrigin &&
      url.pathname.startsWith("/desktop/quick-chat/")
    );
  } catch {
    return false;
  }
}

function isQuickChatRouteForAnima(
  value: string,
  allowedWebOrigin: string,
  animaId: string,
): boolean {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/");
    return (
      url.origin === allowedWebOrigin &&
      parts[1] === "desktop" &&
      parts[2] === "quick-chat" &&
      decodeURIComponent(parts[3] ?? "") === animaId
    );
  } catch {
    return false;
  }
}

function resolveCenteredBounds(
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
    x: Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2)),
    y: Math.round(workArea.y + Math.max(0, (workArea.height - height) / 2)),
    width,
    height,
  };
}

function isPointInsideBounds(point: Point, bounds: Bounds): boolean {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

function isPointInsideRegion(
  localPoint: Point,
  region: DesktopQuickChatInteractiveRegion,
): boolean {
  return (
    localPoint.x >= region.x &&
    localPoint.x < region.x + region.width &&
    localPoint.y >= region.y &&
    localPoint.y < region.y + region.height
  );
}

export class QuickChatWindowManager {
  private readonly config: DesktopConfig;
  private readonly locale: ShellLocale;
  private readonly preloadPath: string;
  private readonly runtimeMessageChannel: string;
  private readonly stateChangedChannel: string;
  private readonly clickThroughSupported = clickThroughSupported();
  private interactiveRegions: DesktopQuickChatInteractiveRegion[] = [];
  private latestSnapshotMessage: DesktopQuickChatRuntimeMessage | null = null;
  private mouseEventsIgnored = false;
  private mousePoll: ReturnType<typeof setInterval> | null = null;
  private nativePaintFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private ownerContents: WebContents | null = null;
  private ownerDestroyedBindingId: number | null = null;
  private quickChatAnchorBottomY: number | null = null;
  private quickChatNativePaintReady = false;
  private quickChatRendererReady = false;
  private quickChatWindow: BrowserWindow | null = null;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeSequence = 0;
  private state: DesktopQuickChatState = {
    isOpen: false,
    animaId: null,
    chatId: null,
  };

  constructor(options: QuickChatWindowManagerOptions) {
    this.config = options.config;
    this.locale = options.locale;
    this.preloadPath = options.preloadPath;
    this.runtimeMessageChannel = options.runtimeMessageChannel;
    this.stateChangedChannel = options.stateChangedChannel;
  }

  getState(): DesktopQuickChatState {
    return { ...this.state };
  }

  async open(
    ownerContents: WebContents,
    rawOptions: unknown,
  ): Promise<DesktopQuickChatState> {
    return this.openOrPrepare(ownerContents, rawOptions, true);
  }

  async prepare(
    ownerContents: WebContents,
    rawOptions: unknown,
  ): Promise<DesktopQuickChatState> {
    return this.openOrPrepare(ownerContents, rawOptions, false);
  }

  private async openOrPrepare(
    ownerContents: WebContents,
    rawOptions: unknown,
    shouldShow: boolean,
  ): Promise<DesktopQuickChatState> {
    const options = normalizeOpenOptions(rawOptions);
    const existingWindow =
      this.quickChatWindow?.isDestroyed() === false
        ? this.quickChatWindow
        : null;
    const sameAnima = this.state.animaId === options.animaId;

    if (!shouldShow && existingWindow && this.state.isOpen) {
      if (sameAnima) {
        this.state = {
          ...this.state,
          chatId: options.chatId,
        };
        this.sendStateChanged();
      }
      return this.getState();
    }

    this.ownerContents = ownerContents;
    const nextState: DesktopQuickChatState = {
      isOpen: shouldShow,
      animaId: options.animaId,
      chatId: options.chatId,
    };

    if (existingWindow) {
      this.bindOwnerDestroyed(ownerContents, existingWindow);
      this.state = nextState;

      if (
        isQuickChatRouteForAnima(
          existingWindow.webContents.getURL(),
          this.config.allowedWebOrigin,
          options.animaId,
        )
      ) {
        this.sendLatestSnapshotToQuickChat();
        if (shouldShow) {
          this.centerExistingWindow(ownerContents, existingWindow);
          this.syncQuickChatWindowVisibility(existingWindow);
        } else {
          this.hideQuickChatWindow(existingWindow);
        }
        this.sendStateChanged();
        return this.getState();
      }

      this.interactiveRegions = [];
      this.hideQuickChatWindow(existingWindow);
      existingWindow.setBounds(
        resolveCenteredBounds(ownerContents, options.width, options.height),
      );
      await this.loadQuickChatRoute(
        existingWindow,
        options.animaId,
        options.chatId,
      );
      if (shouldShow) {
        this.centerExistingWindow(ownerContents, existingWindow);
        this.syncQuickChatWindowVisibility(existingWindow);
      }
      this.sendStateChanged();
      return this.getState();
    }

    this.state = nextState;
    const initialBounds = resolveCenteredBounds(
      ownerContents,
      options.width,
      options.height,
    );
    const quickChatWindow = new BrowserWindow({
      x: initialBounds.x,
      y: initialBounds.y,
      width: initialBounds.width,
      height: initialBounds.height,
      minWidth: MIN_QUICK_CHAT_WIDTH,
      minHeight: MIN_QUICK_CHAT_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      paintWhenInitiallyHidden: true,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      type: floatingWindowType(),
      title: this.locale.strings.text("windows.quickChat"),
      webPreferences: {
        preload: this.preloadPath,
        additionalArguments: ["--animama-window-role=quick-chat"],
        partition: this.config.sessionPartition,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // Packaged builds open no DevTools.
        devTools: !app.isPackaged,
      },
    });

    this.quickChatWindow = quickChatWindow;
    this.quickChatAnchorBottomY = initialBounds.y + initialBounds.height;
    this.setWindowOpacity(quickChatWindow, 0);
    keepLocalizedTitle(quickChatWindow, this.locale, "windows.quickChat");
    installWindowGuards(quickChatWindow, this.config.allowedWebOrigin);
    quickChatWindow.setAlwaysOnTop(true, "floating");
    floatOnAllWorkspaces(quickChatWindow);
    this.startMouseTracking(quickChatWindow);

    const syncVisibility = () => {
      if (
        !isQuickChatRouteUrl(
          quickChatWindow.webContents.getURL(),
          this.config.allowedWebOrigin,
        )
      ) {
        this.resetReadiness();
      }
      this.syncQuickChatWindowVisibility(quickChatWindow);
    };
    const handleDidFinishLoad = () => {
      syncVisibility();
      this.scheduleNativePaintFallback(quickChatWindow);
    };

    quickChatWindow.webContents.on("will-navigate", () => {
      this.resetReadiness();
      this.interactiveRegions = [];
      if (!quickChatWindow.isDestroyed() && quickChatWindow.isVisible()) {
        this.hideQuickChatWindow(quickChatWindow);
      }
    });
    quickChatWindow.webContents.on("did-finish-load", handleDidFinishLoad);
    quickChatWindow.webContents.on("did-navigate", syncVisibility);
    quickChatWindow.webContents.on("did-navigate-in-page", syncVisibility);
    quickChatWindow.on("ready-to-show", () => {
      if (this.quickChatWindow !== quickChatWindow) return;
      this.markNativePaintReady(quickChatWindow);
    });

    quickChatWindow.on("close", () => {
      this.clearRevealTimer();
      this.setMouseEventsIgnored(quickChatWindow, false);
      this.setWindowOpacity(quickChatWindow, 1);
    });
    quickChatWindow.on("closed", () => {
      if (this.quickChatWindow !== quickChatWindow) return;
      this.quickChatWindow = null;
      this.mouseEventsIgnored = false;
      this.interactiveRegions = [];
      this.ownerDestroyedBindingId = null;
      this.quickChatAnchorBottomY = null;
      this.clearRevealTimer();
      this.clearNativePaintFallbackTimer();
      this.stopMouseTracking();
      this.resetReadiness();
      this.state = {
        ...this.state,
        isOpen: false,
      };
      this.sendStateChanged();
    });
    quickChatWindow.on("hide", () => {
      this.setMouseEventsIgnored(quickChatWindow, false);
    });
    this.bindOwnerDestroyed(ownerContents, quickChatWindow);

    await this.loadQuickChatRoute(
      quickChatWindow,
      options.animaId,
      options.chatId,
    );
    if (shouldShow) {
      this.centerExistingWindow(ownerContents, quickChatWindow);
      this.syncQuickChatWindowVisibility(quickChatWindow);
    }
    this.sendStateChanged();
    return this.getState();
  }

  async toggle(
    ownerContents: WebContents,
    rawOptions: unknown,
  ): Promise<DesktopQuickChatState> {
    const options = normalizeOpenOptions(rawOptions);
    if (
      this.state.isOpen &&
      this.quickChatWindow &&
      !this.quickChatWindow.isDestroyed() &&
      this.state.animaId === options.animaId &&
      this.state.chatId === options.chatId
    ) {
      return this.close();
    }
    return this.open(ownerContents, options);
  }

  close(): DesktopQuickChatState {
    const window = this.quickChatWindow;
    if (window && !window.isDestroyed()) {
      this.hideQuickChatWindow(window);
      this.state = {
        ...this.state,
        isOpen: false,
      };
      this.sendStateChanged();
    } else {
      this.quickChatWindow = null;
      this.mouseEventsIgnored = false;
      this.interactiveRegions = [];
      this.stopMouseTracking();
      this.resetReadiness();
      this.state = {
        ...this.state,
        isOpen: false,
      };
      this.sendStateChanged();
    }
    return this.getState();
  }

  publishRuntimeMessage(sender: WebContents, rawMessage: unknown): void {
    const message = normalizeRuntimeMessage(rawMessage);
    const isOwnerSender = this.ownerContents?.id === sender.id;
    const isQuickChatSender =
      this.quickChatWindow?.webContents.id === sender.id;

    if (message.type === "snapshot" && !isQuickChatSender) {
      if (this.ownerContents && !isLiveWebContents(this.ownerContents)) {
        this.ownerContents = null;
      }
      if (this.ownerContents && !isOwnerSender) {
        throw new Error("Quick Chat snapshot came from an unknown renderer");
      }
      this.ownerContents = sender;
      this.latestSnapshotMessage = message;
      if (this.state.animaId === message.animaId) {
        this.sendRuntimeMessageToQuickChat(message);
      }
      return;
    }

    if (!this.state.animaId) {
      return;
    }
    if (message.animaId !== this.state.animaId) {
      throw new Error("Quick Chat runtime message anima mismatch");
    }

    if (!isOwnerSender && !isQuickChatSender) {
      throw new Error(
        "Quick Chat runtime message came from an unknown renderer",
      );
    }
    if (message.type === "ready" && !isQuickChatSender) {
      writeLog("info", "Ignored Quick Chat ready message from owner renderer");
      return;
    }
    if (message.type === "snapshot") {
      writeLog("info", "Ignored Quick Chat snapshot from quick renderer");
      return;
    }
    if (
      (message.type === "command" || message.type === "request-snapshot") &&
      !isQuickChatSender
    ) {
      writeLog("info", "Ignored Quick Chat command from owner renderer");
      return;
    }

    if (message.type === "ready") {
      if (!this.quickChatRendererReady) {
        writeLog("info", "Quick Chat renderer ready");
      }
      this.quickChatRendererReady = true;
      if (this.quickChatWindow && !this.quickChatWindow.isDestroyed()) {
        this.syncQuickChatWindowVisibility(this.quickChatWindow);
      }
      return;
    }

    if (message.type === "request-snapshot") {
      if (this.sendLatestSnapshotToQuickChat()) {
        return;
      }
    }

    const target = isQuickChatSender
      ? this.ownerContents
      : (this.quickChatWindow?.webContents ?? null);
    if (isLiveWebContents(target)) {
      target.send(this.runtimeMessageChannel, message);
      if (isQuickChatSender && isOwnerWindowCommand(message)) {
        this.revealOwnerWindow(target);
      }
    }
  }

  /**
   * Hides Quick Chat and brings the owner window forward. The owner navigates
   * away from its chat, so the mirrored Quick Chat surface would go stale.
   */
  private revealOwnerWindow(ownerContents: WebContents): void {
    this.close();
    const ownerWindow = BrowserWindow.fromWebContents(ownerContents);
    if (!ownerWindow || ownerWindow.isDestroyed()) return;
    if (ownerWindow.isMinimized()) ownerWindow.restore();
    ownerWindow.show();
    ownerWindow.focus();
  }

  setInteractiveRegions(sender: WebContents, rawRegions: unknown): void {
    const isQuickChatSender =
      this.quickChatWindow?.webContents.id === sender.id;
    if (!isQuickChatSender) {
      throw new Error(
        "Quick Chat interactive regions must come from quick renderer",
      );
    }
    this.interactiveRegions = normalizeInteractiveRegions(rawRegions);
  }

  setLayoutMetrics(sender: WebContents, rawMetrics: unknown): void {
    const isQuickChatSender =
      this.quickChatWindow?.webContents.id === sender.id;
    if (!isQuickChatSender) {
      throw new Error(
        "Quick Chat layout metrics must come from quick renderer",
      );
    }
    this.applyLayoutMetrics(normalizeLayoutMetrics(rawMetrics));
  }

  private async loadQuickChatRoute(
    window: BrowserWindow,
    animaId: string,
    chatId: string | null,
  ): Promise<void> {
    const quickChatUrl = new URL(
      `/desktop/quick-chat/${encodeURIComponent(animaId)}`,
      this.config.webUrl.origin,
    );
    quickChatUrl.searchParams.set("desktopQuickChat", "1");
    if (chatId) {
      quickChatUrl.searchParams.set("chatId", chatId);
    }

    writeLog("info", `Loading Quick Chat ${quickChatUrl.href}`);
    this.resetReadiness();
    this.interactiveRegions = [];
    if (!window.isDestroyed()) {
      this.hideQuickChatWindow(window);
    }
    await window.loadURL(quickChatUrl.href);
  }

  private syncQuickChatWindowVisibility(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    if (
      this.state.isOpen &&
      isQuickChatRouteUrl(
        window.webContents.getURL(),
        this.config.allowedWebOrigin,
      ) &&
      this.canShowQuickChatWindow()
    ) {
      if (!window.isVisible()) {
        this.setWindowOpacity(window, 0);
        window.show();
        this.centerVisibleWindow(window);
        this.scheduleWindowReveal(window);
      }
      window.focus();
      this.sendFocusInput(window);
      return;
    }
    if (window.isVisible()) {
      this.hideQuickChatWindow(window);
    }
  }

  private canShowQuickChatWindow(): boolean {
    return this.quickChatRendererReady && this.quickChatNativePaintReady;
  }

  private centerExistingWindow(
    ownerContents: WebContents,
    window: BrowserWindow,
  ): void {
    if (window.isDestroyed()) return;
    const bounds = window.getBounds();
    const defaultBounds = resolveCenteredBounds(
      ownerContents,
      bounds.width,
      DEFAULT_QUICK_CHAT_HEIGHT,
    );
    this.quickChatAnchorBottomY = defaultBounds.y + defaultBounds.height;
    window.setBounds(
      this.resolveBottomAnchoredBounds(
        window,
        bounds.width,
        bounds.height,
        this.quickChatAnchorBottomY,
      ),
    );
  }

  private centerVisibleWindow(window: BrowserWindow): void {
    if (!this.ownerContents || !isLiveWebContents(this.ownerContents)) return;
    this.centerExistingWindow(this.ownerContents, window);
  }

  private applyLayoutMetrics(metrics: DesktopQuickChatLayoutMetrics): void {
    const window = this.quickChatWindow;
    if (!window || window.isDestroyed()) return;

    const bounds = window.getBounds();
    const nextBounds = this.resolveBottomAnchoredBounds(
      window,
      bounds.width,
      metrics.desiredHeight,
      this.quickChatAnchorBottomY ?? bounds.y + bounds.height,
    );

    if (Math.abs(nextBounds.height - bounds.height) < 4) return;
    window.setBounds(nextBounds);
  }

  private resolveBottomAnchoredBounds(
    window: BrowserWindow,
    width: number,
    desiredHeight: number,
    anchorBottomY: number,
  ): Bounds {
    const { workArea } = screen.getDisplayMatching(window.getBounds());
    const bottom = Math.max(
      workArea.y + MIN_QUICK_CHAT_HEIGHT,
      Math.min(workArea.y + workArea.height, Math.round(anchorBottomY)),
    );
    const height = Math.max(
      MIN_QUICK_CHAT_HEIGHT,
      Math.min(
        MAX_QUICK_CHAT_HEIGHT,
        Math.round(desiredHeight),
        bottom - workArea.y,
      ),
    );
    return {
      x: Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2)),
      y: bottom - height,
      width,
      height,
    };
  }

  private resetReadiness(): void {
    this.clearNativePaintFallbackTimer();
    this.clearRevealTimer();
    this.quickChatRendererReady = false;
    this.quickChatNativePaintReady = false;
  }

  private bindOwnerDestroyed(
    ownerContents: WebContents,
    window: BrowserWindow,
  ): void {
    if (this.ownerDestroyedBindingId === ownerContents.id) return;
    this.ownerDestroyedBindingId = ownerContents.id;
    ownerContents.once("destroyed", () => {
      if (this.ownerDestroyedBindingId === ownerContents.id) {
        this.ownerDestroyedBindingId = null;
      }
      if (this.ownerContents !== ownerContents) return;
      if (!window.isDestroyed()) {
        this.setMouseEventsIgnored(window, false);
        window.close();
      }
    });
  }

  private sendFocusInput(window: BrowserWindow): void {
    const animaId = this.state.animaId;
    if (!animaId || window.isDestroyed()) return;
    const message: DesktopQuickChatRuntimeMessage = {
      type: "focus-input",
      sequence: ++this.runtimeSequence,
      sentAtMs: Date.now(),
      animaId,
      payload: null,
    };
    window.webContents.send(this.runtimeMessageChannel, message);
  }

  private sendLatestSnapshotToQuickChat(): boolean {
    const snapshot = this.latestSnapshotMessage;
    if (!snapshot || snapshot.animaId !== this.state.animaId) {
      return false;
    }
    return this.sendRuntimeMessageToQuickChat(snapshot);
  }

  private sendRuntimeMessageToQuickChat(
    message: DesktopQuickChatRuntimeMessage,
  ): boolean {
    const contents = this.quickChatWindow?.webContents ?? null;
    if (!isLiveWebContents(contents)) return false;
    contents.send(this.runtimeMessageChannel, message);
    return true;
  }

  private clearRevealTimer(): void {
    if (this.revealTimer === null) return;
    clearTimeout(this.revealTimer);
    this.revealTimer = null;
  }

  private clearNativePaintFallbackTimer(): void {
    if (this.nativePaintFallbackTimer === null) return;
    clearTimeout(this.nativePaintFallbackTimer);
    this.nativePaintFallbackTimer = null;
  }

  private markNativePaintReady(window: BrowserWindow): void {
    if (window.isDestroyed() || this.quickChatWindow !== window) return;
    this.clearNativePaintFallbackTimer();
    this.quickChatNativePaintReady = true;
    this.syncQuickChatWindowVisibility(window);
  }

  private scheduleNativePaintFallback(window: BrowserWindow): void {
    if (this.quickChatNativePaintReady) return;
    this.clearNativePaintFallbackTimer();
    this.nativePaintFallbackTimer = setTimeout(() => {
      this.nativePaintFallbackTimer = null;
      this.markNativePaintReady(window);
    }, QUICK_CHAT_NATIVE_PAINT_FALLBACK_MS);
  }

  private hideQuickChatWindow(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    this.clearRevealTimer();
    this.setMouseEventsIgnored(window, false);
    this.setWindowOpacity(window, 0);
    if (window.isVisible()) {
      window.hide();
    }
  }

  private scheduleWindowReveal(window: BrowserWindow): void {
    this.clearRevealTimer();
    this.revealTimer = setTimeout(() => {
      this.revealTimer = null;
      if (window.isDestroyed() || this.quickChatWindow !== window) return;
      if (!window.isVisible() || !this.canShowQuickChatWindow()) return;
      this.setWindowOpacity(window, 1);
      this.sendFocusInput(window);
    }, QUICK_CHAT_REVEAL_DELAY_MS);
  }

  private setWindowOpacity(window: BrowserWindow, opacity: number): void {
    try {
      window.setOpacity(opacity);
    } catch {
      // Some Linux window managers ignore opacity changes for transparent windows.
    }
  }

  private setMouseEventsIgnored(
    window: BrowserWindow,
    ignoreMouseEvents: boolean,
  ): void {
    if (window.isDestroyed()) {
      this.mouseEventsIgnored = false;
      return;
    }
    if (this.mouseEventsIgnored === ignoreMouseEvents) return;

    if (!this.clickThroughSupported && ignoreMouseEvents) return;

    if (ignoreMouseEvents) {
      window.setIgnoreMouseEvents(true, { forward: true });
    } else {
      window.setIgnoreMouseEvents(false);
    }
    this.mouseEventsIgnored = ignoreMouseEvents;
  }

  private startMouseTracking(window: BrowserWindow): void {
    if (this.mousePoll !== null) return;
    this.mousePoll = setInterval(() => {
      if (window.isDestroyed() || this.quickChatWindow !== window) {
        if (!window.isDestroyed()) {
          this.setMouseEventsIgnored(window, false);
        } else {
          this.mouseEventsIgnored = false;
        }
        this.stopMouseTracking();
        return;
      }
      if (!window.isVisible()) {
        this.setMouseEventsIgnored(window, false);
        return;
      }

      const cursor = screen.getCursorScreenPoint();
      const bounds = window.getBounds();
      if (!isPointInsideBounds(cursor, bounds)) {
        this.setMouseEventsIgnored(window, false);
        return;
      }

      const localPoint = {
        x: cursor.x - bounds.x,
        y: cursor.y - bounds.y,
      };
      const isInteractive = this.interactiveRegions.some((region) =>
        isPointInsideRegion(localPoint, region),
      );
      this.setMouseEventsIgnored(window, !isInteractive);
    }, QUICK_CHAT_MOUSE_POLL_INTERVAL_MS);
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
      this.quickChatWindow?.webContents ?? null,
    ]) {
      if (isLiveWebContents(contents)) {
        contents.send(this.stateChangedChannel, state);
      }
    }
  }
}
