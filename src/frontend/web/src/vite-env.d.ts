/// <reference types="vite/client" />

/** True only for the development server, never an ordinary or desktop build. */
declare const __ANIMAMA_DEV_BUILD__: boolean;
/** App version from web/package.json (or VITE_APP_VERSION), set at build time. */
declare const __ANIMAMA_APP_VERSION__: string;

declare module "*?url" {
  const url: string;
  export default url;
}

declare module "@/lib/voice/smart-turn/local-whisper-feature-extractor.mjs" {
  type AudioInput = Float32Array | Float64Array;

  export const DEFAULT_WHISPER_TINY_EN_CONFIG: Record<string, unknown>;
  export const TARGET_SMART_TURN_SAMPLES: number;

  export function prepareSmartTurnAudioWindow(
    audio: AudioInput,
    targetSamples?: number,
  ): {
    normalizedAudio: AudioInput;
    paddedLeadingSamples: number;
    truncatedLeadingSamples: number;
  };

  export function createLocalWhisperFeatureExtractor(
    config?: Record<string, unknown>,
  ): {
    config: Record<string, unknown>;
    extract(
      audio: AudioInput,
      options?: { maxLength?: number },
    ): Promise<{
      data: Float32Array;
      dims: number[];
    }>;
  };
}

interface ImportMetaEnv {
  readonly VITE_DISABLE_WEBUI_TELEMETRY?: string;
  readonly VITE_DISABLE_WEBUI_TRACES?: string;
  readonly VITE_ENABLE_DEBUG_PANEL?: string;
  readonly VITE_ENABLE_LOCAL_MODELS?: string;
  readonly VITE_ENABLE_DEEPSEEK_HUGGINGFACE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  readonly animamaDesktop?: {
    readonly version?: number;
    readonly isDesktop?: boolean;
    readonly platform?: string;
    readonly windowRole?: "main" | "pip" | "quick-chat" | "recovery";
    readonly runtime?: import("../../shared/desktop-runtime").RuntimeBridge;
    readonly credentials?: import("../../shared/desktop-runtime").CredentialsBridge;
    readonly featurePacks?: import("../../shared/desktop-runtime").FeaturePacksBridge;
    readonly updates?: import("../../shared/desktop-runtime").UpdatesBridge;
    readonly locale?: import("../../shared/desktop-runtime").LocaleBridge;
    readonly loginItem?: import("../../shared/desktop-runtime").LoginItemBridge;
    /** Linux AppImage only: the optional application-menu entry. */
    readonly menuEntry?: import("../../shared/desktop-runtime").MenuEntryBridge;
    /** Main window on Windows: colors of the window buttons over the title strip. */
    readonly titleBar?: {
      setColors(colors: { color: string; symbolColor: string }): Promise<void>;
    };
    readonly fullscreen?: {
      enter(): Promise<boolean>;
      exit(): Promise<boolean>;
      toggle(): Promise<boolean>;
      isFullscreen(): Promise<boolean>;
      onChange(callback: (isFullscreen: boolean) => void): () => void;
    };
    readonly pip?: {
      open(options: DesktopPipOpenOptions): Promise<DesktopPipState>;
      close(): Promise<DesktopPipState>;
      toggle(options: DesktopPipOpenOptions): Promise<DesktopPipState>;
      isOpen(): Promise<boolean>;
      getState(): Promise<DesktopPipState>;
      setBackgroundMode(
        mode: DesktopPipBackgroundMode,
      ): Promise<DesktopPipState>;
      setSizeScale(sizeScale: number): Promise<DesktopPipState>;
      /** PiP renderer only: the resize grip is held (true) or released. */
      setGripResizing?(active: boolean): Promise<void>;
      onStateChange(callback: (state: DesktopPipState) => void): () => void;
      publishRuntimeMessage(message: DesktopPipRuntimeMessage): Promise<void>;
      onRuntimeMessage(
        callback: (message: DesktopPipRuntimeMessage) => void,
      ): () => void;
      onCursorSnapshot?(
        callback: (snapshot: DesktopPipCursorSnapshot) => void,
      ): () => void;
    };
    readonly quickChat?: {
      open(
        options: DesktopQuickChatOpenOptions,
      ): Promise<DesktopQuickChatState>;
      prepare(
        options: DesktopQuickChatOpenOptions,
      ): Promise<DesktopQuickChatState>;
      close(): Promise<DesktopQuickChatState>;
      toggle(
        options: DesktopQuickChatOpenOptions,
      ): Promise<DesktopQuickChatState>;
      getState(): Promise<DesktopQuickChatState>;
      publishRuntimeMessage(
        message: DesktopQuickChatRuntimeMessage,
      ): Promise<void>;
      onRuntimeMessage(
        callback: (message: DesktopQuickChatRuntimeMessage) => void,
      ): () => void;
      onStateChange(
        callback: (state: DesktopQuickChatState) => void,
      ): () => void;
      setInteractiveRegions(
        regions: DesktopQuickChatInteractiveRegion[],
      ): Promise<void>;
      setLayoutMetrics(metrics: DesktopQuickChatLayoutMetrics): Promise<void>;
    };
    readonly shortcuts?: {
      configure(
        config: DesktopShortcutsConfig,
      ): Promise<DesktopShortcutsStatus>;
      setContext(
        context: Partial<DesktopShortcutsContext>,
      ): Promise<DesktopShortcutsStatus>;
      requestPermissions(): Promise<DesktopShortcutsStatus>;
      getStatus(): Promise<DesktopShortcutsStatus>;
      onEvent(callback: (event: DesktopShortcutEvent) => void): () => void;
      onStatusChange(
        callback: (status: DesktopShortcutsStatus) => void,
      ): () => void;
    };
  };
}

type DesktopPipBackgroundMode = "transparent" | "scene";

type DesktopPipOpenOptions = {
  animaId: string;
  chatId?: string | null;
  backgroundMode?: DesktopPipBackgroundMode;
  width?: number;
  height?: number;
};

type DesktopPipState = {
  isOpen: boolean;
  animaId: string | null;
  chatId: string | null;
  backgroundMode: DesktopPipBackgroundMode;
  isHovered: boolean;
  sizeScale: number;
};

type DesktopPipCursorSnapshot = {
  screen: { x: number; y: number };
  pipWindow: { x: number; y: number; width: number; height: number };
  local: { x: number; y: number };
  isInsidePip: boolean;
  sentAtMs: number;
};

type DesktopPipRuntimeMessage = {
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
  platform: string;
  supported: boolean;
  enabled: boolean;
  requiresPermission: boolean;
  reason: string | null;
  error: string | null;
};

type DesktopQuickChatOpenOptions = {
  animaId: string;
  chatId?: string | null;
  width?: number;
  height?: number;
};

type DesktopQuickChatState = {
  isOpen: boolean;
  animaId: string | null;
  chatId: string | null;
};

type DesktopQuickChatInteractiveRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DesktopQuickChatLayoutMetrics = {
  desiredHeight: number;
};

type DesktopQuickChatRuntimeMessage = {
  type: "ready" | "snapshot" | "command" | "request-snapshot" | "focus-input";
  sequence: number;
  sentAtMs: number;
  animaId: string;
  payload: unknown;
};
