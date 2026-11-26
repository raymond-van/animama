import { Menu, type MenuItemConstructorOptions } from "electron";

import type { MenuCommand } from "../../../../shared/desktop-runtime.js";
import type { ShellStrings } from "../locale/shell-locale.js";

type MenuRole = NonNullable<MenuItemConstructorOptions["role"]>;

const separator: MenuItemConstructorOptions = { type: "separator" };
const item = (role: MenuRole, label: string): MenuItemConstructorOptions => ({
  role,
  label,
});
/** An item of Animama's own, which runs `click` instead of an Electron role. */
const command = (
  label: string,
  click: () => void,
): MenuItemConstructorOptions => ({ label, click: () => click() });

/**
 * Menu items that act in the main window's web app. An item is offered only
 * while its command is supplied: a build that cannot update has no check.
 */
export type ApplicationMenuCommands = {
  checkForUpdates?: () => void;
  importAnima?: () => void;
};

/** How long a chosen command waits for the main window's app to take it. */
export const MENU_COMMAND_TTL_MS = 20_000;

/**
 * The menu command waiting for the main window's web app. The app takes it
 * when told one was chosen and when it starts, which covers a window that was
 * closed (macOS) or still loading. It is handed over once and only while
 * fresh, so a command chosen during first-run setup does not fire when setup
 * ends minutes later.
 */
export class PendingMenuCommand {
  private pending: { command: MenuCommand; at: number } | null = null;
  constructor(private readonly now: () => number = Date.now) {}
  set(command: MenuCommand): void {
    this.pending = { command, at: this.now() };
  }
  take(): MenuCommand | null {
    const pending = this.pending;
    this.pending = null;
    return pending && this.now() - pending.at <= MENU_COMMAND_TTL_MS
      ? pending.command
      : null;
  }
}

/**
 * Electron's default application menu (`lib/browser/default-menu.ts` and its
 * role submenus in `menu-item-roles.ts`), spelled out so every label comes from
 * the shell catalog. Roles, and with them each item's behavior, accelerator
 * and native macOS action, stay exactly as Electron defines them. Packaged
 * builds always had an empty Help menu; unpackaged runs drop Electron's own
 * documentation links from it. Packaged builds also leave out the View menu's
 * DevTools item.
 *
 * Two items are Animama's own (`commands`): **Check for Updates…** under About
 * on macOS and in Help elsewhere, where there is no application menu, and
 * **Import Anima…** at the top of File. The Windows main window hides its
 * title bar and so shows no menu bar; there the items are unreachable, and the
 * sidebar user menu's update check, App Settings and the Library are the way in.
 */
export function applicationMenuTemplate(
  { text }: ShellStrings,
  platform: NodeJS.Platform,
  appName: string,
  packaged = false,
  commands: ApplicationMenuCommands = {},
): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const name = { name: appName };
  const checkForUpdates = commands.checkForUpdates
    ? [command(text("menu.checkForUpdates"), commands.checkForUpdates)]
    : [];
  const importAnima = commands.importAnima
    ? [command(text("menu.importAnima"), commands.importAnima), separator]
    : [];
  const quit = item(
    "quit",
    mac
      ? text("menu.quitApp", name)
      : text(platform === "win32" ? "menu.exit" : "menu.quit"),
  );
  const appMenu: MenuItemConstructorOptions = {
    role: "appMenu",
    // macOS always titles this menu with the bundle name.
    label: appName,
    submenu: [
      item("about", text("menu.about", name)),
      ...checkForUpdates,
      separator,
      item("services", text("menu.services")),
      separator,
      item("hide", text("menu.hide", name)),
      item("hideOthers", text("menu.hideOthers")),
      item("unhide", text("menu.showAll")),
      separator,
      quit,
    ],
  };
  const macEditing: MenuItemConstructorOptions[] = [
    item("pasteAndMatchStyle", text("menu.pasteAndMatchStyle")),
    item("delete", text("menu.delete")),
    item("selectAll", text("menu.selectAll")),
    separator,
    {
      label: text("menu.substitutions"),
      submenu: [
        item("showSubstitutions", text("menu.showSubstitutions")),
        separator,
        item("toggleSmartQuotes", text("menu.smartQuotes")),
        item("toggleSmartDashes", text("menu.smartDashes")),
        item("toggleTextReplacement", text("menu.textReplacement")),
      ],
    },
    {
      label: text("menu.speech"),
      submenu: [
        item("startSpeaking", text("menu.startSpeaking")),
        item("stopSpeaking", text("menu.stopSpeaking")),
      ],
    },
  ];
  return [
    ...(mac ? [appMenu] : []),
    {
      role: "fileMenu",
      label: text("menu.file"),
      submenu: [
        ...importAnima,
        mac ? item("close", text("menu.closeWindow")) : quit,
      ],
    },
    {
      role: "editMenu",
      label: text("menu.edit"),
      submenu: [
        item("undo", text("menu.undo")),
        item("redo", text("menu.redo")),
        separator,
        item("cut", text("menu.cut")),
        item("copy", text("menu.copy")),
        item("paste", text("menu.paste")),
        ...(mac
          ? macEditing
          : [
              item("delete", text("menu.delete")),
              separator,
              item("selectAll", text("menu.selectAll")),
            ]),
      ],
    },
    {
      role: "viewMenu",
      label: text("menu.view"),
      submenu: [
        item("reload", text("menu.reload")),
        item("forceReload", text("menu.forceReload")),
        // Packaged builds open no DevTools, so they offer no item for it.
        ...(packaged
          ? []
          : [item("toggleDevTools", text("menu.toggleDevTools"))]),
        separator,
        item("resetZoom", text("menu.actualSize")),
        item("zoomIn", text("menu.zoomIn")),
        item("zoomOut", text("menu.zoomOut")),
        separator,
        item("togglefullscreen", text("menu.toggleFullScreen")),
      ],
    },
    {
      // The role keeps macOS's window list and window-management items.
      role: "windowMenu",
      label: text("menu.window"),
      submenu: [
        item("minimize", text("menu.minimize")),
        item("zoom", text("menu.zoom")),
        ...(mac
          ? [separator, item("front", text("menu.bringAllToFront"))]
          : [item("close", text("menu.close"))]),
      ],
    },
    // The role gives macOS its Help search field.
    {
      role: "help",
      label: text("menu.help"),
      submenu: mac ? [] : checkForUpdates,
    },
  ];
}

/** Install (or rebuild, after a locale change) the menu on every platform's menu bar. */
export function installApplicationMenu(
  strings: ShellStrings,
  appName: string,
  packaged: boolean,
  commands: ApplicationMenuCommands = {},
): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate(
        strings,
        process.platform,
        appName,
        packaged,
        commands,
      ),
    ),
  );
}
