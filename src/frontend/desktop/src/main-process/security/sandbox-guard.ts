import type { ShellKey } from "../locale/shell-locale.js";

/** Chromium switches that turn all or part of its sandbox off. */
const SANDBOX_SWITCHES = [
  "no-sandbox",
  "disable-gpu-sandbox",
  "disable-seccomp-filter-sandbox",
];

type Launch = {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** Chromium's own switch parser, which also covers Electron's environment switch. */
  hasSwitch(name: string): boolean;
};

/**
 * Whether a packaged Linux app was started with the sandbox off. The AppImage
 * launcher adds `--no-sandbox` by itself on a system that blocks unprivileged
 * user namespaces, so this is how such a system is noticed. Unpackaged
 * development keeps its explicit diagnostic switch, and macOS and Windows are
 * left as they were.
 */
export function sandboxDisabled({
  isPackaged,
  platform,
  hasSwitch,
}: Launch): boolean {
  return isPackaged && platform === "linux" && SANDBOX_SWITCHES.some(hasSwitch);
}

/**
 * Refuse to run unsandboxed: say why in the shell locale, then exit. Returns
 * true when the launch was refused, so the caller starts nothing.
 */
export function refuseDisabledSandbox({
  text,
  show,
  exit,
  ...launch
}: Launch & {
  text(key: ShellKey): string;
  show(title: string, message: string): void;
  exit(code: number): void;
}): boolean {
  if (!sandboxDisabled(launch)) return false;
  show(text("startup.sandbox.title"), text("startup.sandbox.message"));
  exit(1);
  return true;
}
