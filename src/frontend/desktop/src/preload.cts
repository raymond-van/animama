import { contextBridge } from "electron";

import { createFullscreenBridge } from "./main-process/fullscreen/fullscreen-preload.cjs";
import { createPipBridge } from "./main-process/pip/pip-preload.cjs";
import { createQuickChatBridge } from "./main-process/quick-chat/quick-chat-preload.cjs";
import { createShortcutsBridge } from "./main-process/shortcuts/shortcuts-preload.cjs";
import { createTitleBarBridge } from "./main-process/window/title-bar-preload.cjs";
import {
  createCredentialsBridge,
  createFeaturePacksBridge,
  createLocaleBridge,
  createLoginItemBridge,
  createMenuBridge,
  createMenuEntryBridge,
  createRuntimeBridge,
  createUpdatesBridge,
} from "./main-process/runtime/runtime-preload.cjs";

const windowRole = process.argv.includes("--animama-window-role=pip")
  ? "pip"
  : process.argv.includes("--animama-window-role=quick-chat")
    ? "quick-chat"
    : process.argv.includes("--animama-window-role=recovery")
      ? "recovery"
      : "main";

contextBridge.exposeInMainWorld("animamaDesktop", {
  version: 2,
  isDesktop: true,
  platform: process.platform,
  windowRole,
  fullscreen: createFullscreenBridge(),
  pip: createPipBridge(),
  quickChat: createQuickChatBridge(),
  shortcuts: createShortcutsBridge(),
  titleBar: createTitleBarBridge(),
  runtime: createRuntimeBridge(),
  credentials: createCredentialsBridge(),
  featurePacks: createFeaturePacksBridge(),
  updates: createUpdatesBridge(),
  locale: createLocaleBridge(),
  loginItem: createLoginItemBridge(),
  menu: createMenuBridge(),
  menuEntry: createMenuEntryBridge(),
});
