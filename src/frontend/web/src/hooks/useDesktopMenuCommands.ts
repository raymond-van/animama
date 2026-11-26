import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import { requestAppSettings } from "@/stores/app-settings-request-store";
import { requestLibraryImport } from "@/stores/library-import-request-store";

/**
 * Runs the desktop application menu's commands in the main window. **Check
 * for Updates…** opens App Settings at the update panel, where the check main
 * has already started reports its progress and result; **Import Anima…**
 * opens the Library's Import dialog. Other windows and the web receive none.
 */
export function useDesktopMenuCommands(): void {
  const platform = useRuntimePlatform();
  const navigate = useNavigate();
  const desktop = platform.kind === "desktop" ? platform.desktopBridge : null;
  const menu = desktop?.windowRole === "main" ? desktop.menu : undefined;
  useEffect(() => {
    if (!menu) return;
    return menu.onCommand((command) => {
      switch (command) {
        case "check-for-updates":
          requestAppSettings("updates");
          break;
        case "import-anima":
          requestLibraryImport();
          void navigate({ to: "/library" });
          break;
      }
    });
  }, [menu, navigate]);
}
