import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type GlobalInputShortcut =
  | {
      type: "keyboard";
      code: string;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
      metaKey: boolean;
    }
  | {
      type: "mouse";
      button: number;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
      metaKey: boolean;
    };

export type NativeGlobalInputBinding = {
  isSupported(): boolean;
  permissionGranted(): boolean;
  requestPermission(): boolean;
  start(shortcut: GlobalInputShortcut, callback: (down: boolean) => void): void;
  stop(): void;
};

export type GlobalInputHook = {
  readonly supported: boolean;
  readonly requiresPermission: boolean;
  start(shortcut: GlobalInputShortcut, callback: (down: boolean) => void): void;
  stop(): void;
  requestPermission(): boolean;
};

/** Resolve the addon beside the bundled main process. It is first-party code,
 * and the path is fixed rather than supplied by a renderer or environment.
 */
export function nativeGlobalInputBindingPath(
  moduleUrl = import.meta.url,
): string {
  return path.join(
    path.dirname(fileURLToPath(moduleUrl)),
    "native/animama_input_hook.node",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateNativeGlobalInputBinding(
  value: unknown,
): NativeGlobalInputBinding {
  const methods = [
    "isSupported",
    "permissionGranted",
    "requestPermission",
    "start",
    "stop",
  ] as const;
  if (
    !isRecord(value) ||
    methods.some((method) => typeof value[method] !== "function")
  ) {
    throw new Error("The packaged global input hook has an invalid interface.");
  }
  return value as NativeGlobalInputBinding;
}

function loadBinding(): NativeGlobalInputBinding {
  const require = createRequire(import.meta.url);
  return validateNativeGlobalInputBinding(
    require(nativeGlobalInputBindingPath()),
  );
}

/** Keep the native surface narrow: it receives one validated binding and emits
 * only matched down/up transitions, never the user's general input stream.
 */
export function createGlobalInputHook(
  binding: NativeGlobalInputBinding = loadBinding(),
): GlobalInputHook {
  let activeSignature: string | null = null;
  let activeCallback: ((down: boolean) => void) | null = null;
  return {
    get supported() {
      return binding.isSupported();
    },
    get requiresPermission() {
      return binding.isSupported() && !binding.permissionGranted();
    },
    start(shortcut, callback) {
      const signature = JSON.stringify(shortcut);
      activeCallback = callback;
      if (activeSignature === signature) return;
      if (activeSignature !== null) {
        binding.stop();
        activeSignature = null;
      }
      binding.start(shortcut, (down) => activeCallback?.(down));
      activeSignature = signature;
    },
    stop() {
      if (activeSignature !== null) binding.stop();
      activeSignature = null;
      activeCallback = null;
    },
    requestPermission() {
      return binding.requestPermission();
    },
  };
}

/**
 * Why the native hook reports itself unsupported, for the status the renderer
 * shows. On Linux the hook exists but only for an X11 session: a Wayland
 * session does not let an app listen for a key held in another application.
 */
export function pressToTalkUnsupportedReason(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "linux"
    ? "Global Press to talk needs an X11 session on Linux. A Wayland session does not let an app listen for a held key."
    : "Global Press to talk is not available on this system.";
}
