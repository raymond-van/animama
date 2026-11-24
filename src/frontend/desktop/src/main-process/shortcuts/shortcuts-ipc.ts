import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";

import { writeLog } from "../logging.js";
import {
  createGlobalInputHook,
  pressToTalkUnsupportedReason,
  type GlobalInputHook,
  type GlobalInputShortcut,
} from "./global-input-hook.js";

export const SHORTCUTS_CONFIGURE_CHANNEL = "anima:shortcuts:configure";
export const SHORTCUTS_SET_CONTEXT_CHANNEL = "anima:shortcuts:set-context";
export const SHORTCUTS_REQUEST_PERMISSIONS_CHANNEL =
  "anima:shortcuts:request-permissions";
export const SHORTCUTS_GET_STATUS_CHANNEL = "anima:shortcuts:get-status";
export const SHORTCUTS_EVENT_CHANNEL = "anima:shortcuts:event";
export const SHORTCUTS_STATUS_CHANGED_CHANNEL =
  "anima:shortcuts:status-changed";

type DesktopShortcutAction =
  | "press_to_talk"
  | "quick_chat"
  | "toggle_dictation"
  | "toggle_voice_mode"
  | "toggle_voice_mute"
  | "skip_tts"
  | "toggle_pip";

type DesktopKeyboardShortcut = {
  type?: "keyboard";
  code: string;
  key?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
};

type DesktopMouseShortcut = {
  type: "mouse";
  button: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
};

type DesktopShortcut = DesktopKeyboardShortcut | DesktopMouseShortcut;

type DesktopOneShotShortcutAction = Exclude<
  DesktopShortcutAction,
  "press_to_talk"
>;

type DesktopShortcutsConfig = {
  shortcuts: Record<DesktopShortcutAction, DesktopShortcut>;
};

type DesktopShortcutsContext = {
  quickChatAvailable: boolean;
  pipAvailable: boolean;
  voiceModeAvailable: boolean;
  voiceModeActive: boolean;
  ttsAudioActive: boolean;
  shortcutCaptureActive: boolean;
};

type DesktopShortcutEvent = {
  action: DesktopShortcutAction;
  phase: "down" | "up";
};

type DesktopShortcutsStatus = {
  platform: NodeJS.Platform;
  supported: boolean;
  enabled: boolean;
  requiresPermission: boolean;
  reason: string | null;
  error: string | null;
};

const DEFAULT_CONTEXT: DesktopShortcutsContext = {
  quickChatAvailable: false,
  pipAvailable: false,
  voiceModeAvailable: false,
  voiceModeActive: false,
  ttsAudioActive: false,
  shortcutCaptureActive: false,
};

const MODIFIER_CODES = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
]);

const ACTIONS: DesktopShortcutAction[] = [
  "press_to_talk",
  "quick_chat",
  "toggle_dictation",
  "toggle_voice_mode",
  "toggle_voice_mute",
  "skip_tts",
  "toggle_pip",
];

const ONE_SHOT_ACTIONS: DesktopOneShotShortcutAction[] = [
  "quick_chat",
  "toggle_dictation",
  "toggle_voice_mode",
  "toggle_voice_mute",
  "skip_tts",
  "toggle_pip",
];

const ONE_SHOT_SHORTCUT_COOLDOWN_MS = 100;

const CODE_TO_ACCELERATOR_KEY: Record<string, string> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Backquote: "`",
  Backslash: "\\",
  Backspace: "Backspace",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Delete: "Delete",
  End: "End",
  Enter: "Enter",
  Equal: "=",
  Escape: "Escape",
  Home: "Home",
  Insert: "Insert",
  Minus: "-",
  NumpadEnter: "Enter",
  PageDown: "PageDown",
  PageUp: "PageUp",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: "Space",
  Tab: "Tab",
};

let shortcutsIpcInstalled = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasShortcutModifier(shortcut: DesktopKeyboardShortcut): boolean {
  return (
    shortcut.ctrlKey === true ||
    shortcut.altKey === true ||
    shortcut.shiftKey === true ||
    shortcut.metaKey === true
  );
}

function isMouseShortcut(
  shortcut: DesktopShortcut,
): shortcut is DesktopMouseShortcut {
  return shortcut.type === "mouse";
}

function normalizeKeyboardShortcut(
  value: unknown,
): DesktopKeyboardShortcut | null {
  if (!isRecord(value) || typeof value.code !== "string") return null;
  const code = value.code.trim();
  const shortcut: DesktopKeyboardShortcut = {
    code,
    ...(typeof value.key === "string" && value.key ? { key: value.key } : {}),
    ...(value.ctrlKey === true ? { ctrlKey: true } : {}),
    ...(value.altKey === true ? { altKey: true } : {}),
    ...(value.shiftKey === true ? { shiftKey: true } : {}),
    ...(value.metaKey === true ? { metaKey: true } : {}),
  };
  if (!code || MODIFIER_CODES.has(code) || !hasShortcutModifier(shortcut)) {
    return null;
  }
  if (!keyToAccelerator(shortcut)) return null;
  return shortcut;
}

function normalizeMouseShortcut(value: unknown): DesktopMouseShortcut | null {
  if (!isRecord(value) || value.type !== "mouse") return null;
  if (
    typeof value.button !== "number" ||
    !Number.isSafeInteger(value.button) ||
    value.button <= 0 ||
    value.button > 32
  ) {
    return null;
  }
  return {
    type: "mouse",
    button: value.button,
    ...(value.ctrlKey === true ? { ctrlKey: true } : {}),
    ...(value.altKey === true ? { altKey: true } : {}),
    ...(value.shiftKey === true ? { shiftKey: true } : {}),
    ...(value.metaKey === true ? { metaKey: true } : {}),
  };
}

function normalizeShortcut(
  action: DesktopShortcutAction,
  value: unknown,
): DesktopShortcut | null {
  if (action === "press_to_talk") {
    return normalizeMouseShortcut(value) ?? normalizeKeyboardShortcut(value);
  }
  return normalizeKeyboardShortcut(value);
}

function normalizeConfig(value: unknown): DesktopShortcutsConfig {
  if (!isRecord(value)) {
    throw new Error("Expected desktop shortcuts config object");
  }
  const shortcutsValue = isRecord(value.shortcuts) ? value.shortcuts : {};
  const shortcuts: Partial<Record<DesktopShortcutAction, DesktopShortcut>> = {};

  for (const action of ACTIONS) {
    const shortcut = normalizeShortcut(action, shortcutsValue[action]);
    if (!shortcut) {
      throw new Error(`Missing shortcut for ${action}`);
    }
    shortcuts[action] = shortcut;
  }

  return {
    shortcuts: shortcuts as Record<DesktopShortcutAction, DesktopShortcut>,
  };
}

function keyToAccelerator(shortcut: DesktopKeyboardShortcut): string | null {
  if (/^Key[A-Z]$/.test(shortcut.code)) return shortcut.code.slice(3);
  if (/^Digit[0-9]$/.test(shortcut.code)) return shortcut.code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(shortcut.code)) return shortcut.code;
  return CODE_TO_ACCELERATOR_KEY[shortcut.code] ?? null;
}

function toAccelerator(shortcut: DesktopKeyboardShortcut): string | null {
  const key = keyToAccelerator(shortcut);
  if (!key) return null;

  return [
    shortcut.ctrlKey === true ? "Ctrl" : "",
    shortcut.altKey === true ? "Alt" : "",
    shortcut.shiftKey === true ? "Shift" : "",
    shortcut.metaKey === true ? "Meta" : "",
    key,
  ]
    .filter(Boolean)
    .join("+");
}

function toGlobalInputShortcut(shortcut: DesktopShortcut): GlobalInputShortcut {
  const modifiers = {
    ctrlKey: shortcut.ctrlKey === true,
    altKey: shortcut.altKey === true,
    shiftKey: shortcut.shiftKey === true,
    metaKey: shortcut.metaKey === true,
  };
  return isMouseShortcut(shortcut)
    ? { type: "mouse", button: shortcut.button, ...modifiers }
    : { type: "keyboard", code: shortcut.code, ...modifiers };
}

function assertMainWindowSender(event: IpcMainInvokeEvent): WebContents {
  if (event.sender.isDestroyed()) {
    throw new Error("Shortcut IPC request did not come from a live renderer");
  }
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) {
    throw new Error("Shortcut IPC request did not come from a live window");
  }
  const url = event.sender.getURL();
  if (url.includes("/desktop/pip/")) {
    throw new Error("PiP windows cannot configure desktop shortcuts");
  }
  if (url.includes("/desktop/quick-chat/")) {
    throw new Error("Quick Chat windows cannot configure desktop shortcuts");
  }
  return event.sender;
}

class DesktopShortcutManager {
  private config: DesktopShortcutsConfig | null = null;
  private context: DesktopShortcutsContext = DEFAULT_CONTEXT;
  private owner: WebContents | null = null;
  private registeredAccelerators = new Map<
    DesktopOneShotShortcutAction,
    string
  >();
  private oneShotCooldownTimers = new Map<
    DesktopOneShotShortcutAction,
    ReturnType<typeof setTimeout>
  >();
  private registrationError: string | null = null;
  private pressToTalkError: string | null = null;
  private pressToTalkListening = false;
  private globalInputHook: GlobalInputHook | null = null;
  private pressToTalkDown = false;
  private refreshSequence = 0;

  private readonly handleGlobalInput = (down: boolean) => {
    if (down) this.pressToTalkDownEvent();
    else this.releasePressToTalkIfHeld();
  };

  async configure(
    owner: WebContents,
    value: unknown,
  ): Promise<DesktopShortcutsStatus> {
    this.setOwner(owner);
    this.config = normalizeConfig(value);
    this.releasePressToTalkIfHeld();
    await this.refreshRegistrations();
    return this.getStatus();
  }

  async setContext(
    owner: WebContents,
    value: unknown,
  ): Promise<DesktopShortcutsStatus> {
    this.setOwner(owner);
    if (!isRecord(value)) {
      throw new Error("Expected shortcut context object");
    }
    this.context = {
      ...this.context,
      ...(typeof value.voiceModeAvailable === "boolean"
        ? { voiceModeAvailable: value.voiceModeAvailable }
        : {}),
      ...(typeof value.quickChatAvailable === "boolean"
        ? { quickChatAvailable: value.quickChatAvailable }
        : {}),
      ...(typeof value.pipAvailable === "boolean"
        ? { pipAvailable: value.pipAvailable }
        : {}),
      ...(typeof value.voiceModeActive === "boolean"
        ? { voiceModeActive: value.voiceModeActive }
        : {}),
      ...(typeof value.ttsAudioActive === "boolean"
        ? { ttsAudioActive: value.ttsAudioActive }
        : {}),
      ...(typeof value.shortcutCaptureActive === "boolean"
        ? { shortcutCaptureActive: value.shortcutCaptureActive }
        : {}),
    };
    if (!this.actionApplicable("press_to_talk")) {
      this.releasePressToTalkIfHeld();
    }
    await this.refreshRegistrations();
    return this.getStatus();
  }

  async requestPermissions(): Promise<DesktopShortcutsStatus> {
    try {
      this.ensureGlobalInputHook().requestPermission();
      await this.refreshRegistrations();
    } catch (error) {
      this.pressToTalkError = `Failed to request global input permission: ${
        error instanceof Error ? error.message : "Unknown native input error."
      }`;
      writeLog("error", this.pressToTalkError);
    }
    return this.broadcastStatus();
  }

  getStatus(): DesktopShortcutsStatus {
    const enabled =
      this.registeredAccelerators.size > 0 ||
      (this.pressToTalkListening && this.actionApplicable("press_to_talk"));
    return {
      platform: process.platform,
      supported: true,
      enabled,
      requiresPermission: this.globalInputHook?.requiresPermission ?? false,
      reason: enabled ? null : this.statusReason(),
      error: this.statusError(),
    };
  }

  dispose(): void {
    this.releasePressToTalkIfHeld();
    this.clearOneShotCooldowns();
    this.unregisterOneShotAccelerators();
    this.stopPressToTalkHook();
  }

  private setOwner(owner: WebContents): void {
    if (this.owner === owner) return;
    this.owner = owner;
    owner.once("destroyed", () => {
      if (this.owner === owner) {
        this.owner = null;
        this.context = DEFAULT_CONTEXT;
        this.pressToTalkDown = false;
        this.clearOneShotCooldowns();
        this.unregisterOneShotAccelerators();
        this.stopPressToTalkHook();
      }
    });
  }

  private actionApplicable(action: DesktopShortcutAction): boolean {
    if (
      !this.owner ||
      this.owner.isDestroyed() ||
      !this.config ||
      this.context.shortcutCaptureActive
    ) {
      return false;
    }

    switch (action) {
      case "press_to_talk":
        return this.context.voiceModeActive;
      case "quick_chat":
        return this.context.quickChatAvailable;
      case "toggle_dictation":
        // Dictation and Voice Mode share the microphone; one runs at a time.
        return this.context.voiceModeAvailable && !this.context.voiceModeActive;
      case "toggle_voice_mode":
        return this.context.voiceModeAvailable;
      case "toggle_voice_mute":
        return this.context.voiceModeActive;
      case "skip_tts":
        return this.context.ttsAudioActive;
      case "toggle_pip":
        return this.context.pipAvailable;
    }
  }

  private statusReason(): string | null {
    if (!this.config) return "No desktop shortcuts are configured.";
    if (this.context.shortcutCaptureActive) {
      return "Desktop shortcuts are paused while recording a shortcut.";
    }
    if (!this.context.voiceModeAvailable) {
      return "Voice Mode is not available in the current chat.";
    }
    return null;
  }

  private statusError(): string | null {
    const errors = [this.registrationError, this.pressToTalkError].filter(
      (error): error is string => typeof error === "string" && error.length > 0,
    );
    return errors.length > 0 ? errors.join(" ") : null;
  }

  private sendEvent(
    action: DesktopShortcutAction,
    phase: DesktopShortcutEvent["phase"] = "down",
  ): void {
    if (!this.owner || this.owner.isDestroyed()) return;
    this.owner.send(SHORTCUTS_EVENT_CHANNEL, { action, phase });
  }

  private unregisterOneShotAccelerators(): void {
    for (const accelerator of this.registeredAccelerators.values()) {
      globalShortcut.unregister(accelerator);
    }
    this.registeredAccelerators.clear();
  }

  private clearOneShotCooldowns(): void {
    for (const timer of this.oneShotCooldownTimers.values()) {
      clearTimeout(timer);
    }
    this.oneShotCooldownTimers.clear();
  }

  private restartOneShotCooldown(action: DesktopOneShotShortcutAction): void {
    const existingTimer = this.oneShotCooldownTimers.get(action);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      this.oneShotCooldownTimers.delete(action);
    }, ONE_SHOT_SHORTCUT_COOLDOWN_MS);
    this.oneShotCooldownTimers.set(action, timer);
  }

  private handleOneShotShortcut(action: DesktopOneShotShortcutAction): void {
    if (this.oneShotCooldownTimers.has(action)) {
      this.restartOneShotCooldown(action);
      return;
    }
    if (!this.actionApplicable(action)) return;
    this.restartOneShotCooldown(action);
    this.sendEvent(action);
  }

  private async refreshRegistrations(): Promise<void> {
    const sequence = ++this.refreshSequence;
    this.unregisterOneShotAccelerators();
    this.registrationError = null;
    if (!this.config) return;

    const failures: string[] = [];
    for (const action of ONE_SHOT_ACTIONS) {
      if (!this.actionApplicable(action)) continue;
      const shortcut = this.config.shortcuts[action];
      if (isMouseShortcut(shortcut)) {
        failures.push(`${action}: mouse shortcuts are not supported`);
        continue;
      }
      const accelerator = toAccelerator(shortcut);
      if (!accelerator) {
        failures.push(`${action}: unsupported key ${shortcut.code}`);
        continue;
      }

      const registered = globalShortcut.register(accelerator, () => {
        this.handleOneShotShortcut(action);
      });

      if (registered) {
        this.registeredAccelerators.set(action, accelerator);
        continue;
      }
      failures.push(`${action}: ${accelerator}`);
    }

    this.registrationError =
      failures.length > 0
        ? `Failed to register desktop shortcuts: ${failures.join(", ")}`
        : null;
    if (this.registrationError) {
      writeLog("error", this.registrationError);
    }
    await this.refreshPressToTalkHook(sequence);
    if (sequence !== this.refreshSequence) return;
    this.broadcastStatus();
  }

  private async refreshPressToTalkHook(sequence: number): Promise<void> {
    if (!this.config) {
      this.pressToTalkListening = false;
      this.pressToTalkError = null;
      return;
    }
    if (
      !this.owner ||
      this.owner.isDestroyed() ||
      this.context.shortcutCaptureActive
    ) {
      this.pressToTalkListening = false;
      return;
    }

    try {
      const hook = this.ensureGlobalInputHook();
      if (!hook.supported) {
        this.pressToTalkListening = false;
        this.pressToTalkError = pressToTalkUnsupportedReason();
        return;
      }
      if (hook.requiresPermission) {
        this.pressToTalkListening = false;
        this.pressToTalkError = null;
        return;
      }
      hook.start(
        toGlobalInputShortcut(this.config.shortcuts.press_to_talk),
        this.handleGlobalInput,
      );
      if (sequence !== this.refreshSequence) return;
      this.pressToTalkError = null;
      this.pressToTalkListening = true;
    } catch (error) {
      if (sequence !== this.refreshSequence) return;
      const message =
        error instanceof Error
          ? error.message
          : "Unknown native input startup error.";
      this.pressToTalkListening = false;
      this.pressToTalkError = `Failed to start Press to talk shortcut hook: ${message}`;
      writeLog("error", this.pressToTalkError);
    }
  }

  private ensureGlobalInputHook(): GlobalInputHook {
    this.globalInputHook ??= createGlobalInputHook();
    return this.globalInputHook;
  }

  private stopPressToTalkHook(): void {
    this.globalInputHook?.stop();
    this.pressToTalkListening = false;
  }

  private pressToTalkDownEvent(): void {
    if (this.pressToTalkDown || !this.actionApplicable("press_to_talk")) {
      return;
    }
    this.pressToTalkDown = true;
    this.sendEvent("press_to_talk", "down");
  }

  private releasePressToTalkIfHeld(): void {
    if (!this.pressToTalkDown) return;
    this.pressToTalkDown = false;
    this.sendEvent("press_to_talk", "up");
  }

  private broadcastStatus(): DesktopShortcutsStatus {
    const status = this.getStatus();
    if (this.owner && !this.owner.isDestroyed()) {
      this.owner.send(SHORTCUTS_STATUS_CHANGED_CHANNEL, status);
    }
    return status;
  }
}

const manager = new DesktopShortcutManager();

export function installShortcutsIpc(): void {
  if (shortcutsIpcInstalled) return;
  shortcutsIpcInstalled = true;

  ipcMain.handle(
    SHORTCUTS_CONFIGURE_CHANNEL,
    (event: IpcMainInvokeEvent, config: unknown) =>
      manager.configure(assertMainWindowSender(event), config),
  );

  ipcMain.handle(
    SHORTCUTS_SET_CONTEXT_CHANNEL,
    (event: IpcMainInvokeEvent, context: unknown) =>
      manager.setContext(assertMainWindowSender(event), context),
  );

  ipcMain.handle(SHORTCUTS_REQUEST_PERMISSIONS_CHANNEL, () =>
    manager.requestPermissions(),
  );

  ipcMain.handle(SHORTCUTS_GET_STATUS_CHANNEL, () => manager.getStatus());

  app.on("will-quit", () => {
    manager.dispose();
  });
}
