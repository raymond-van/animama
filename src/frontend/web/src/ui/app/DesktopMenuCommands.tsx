import { useDesktopMenuCommands } from "@/hooks/useDesktopMenuCommands";

/** Mounted with the app shell so the desktop menu's commands have a listener. */
export function DesktopMenuCommands() {
  useDesktopMenuCommands();
  return null;
}
