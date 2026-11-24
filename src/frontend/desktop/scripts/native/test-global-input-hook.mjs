import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This explicit native check must fail on unsupported hosts, rather than report
// a skipped native test as acceptance. Ordinary wrapper tests remain portable.
if (process.platform === "win32" && process.arch === "x64") {
  testPackagedWindowsAddon();
} else if (process.platform === "linux" && process.arch === "x64") {
  testLinuxMatcher("c++");
} else if (
  process.platform !== "darwin" ||
  process.arch !== "arm64" ||
  Number.parseInt(release(), 10) < 24
) {
  throw new Error(
    "Native input tests require macOS 15+ on Apple silicon, Windows x64 or Linux x64.",
  );
} else {
  testMacHook();
  // The Linux hook's key table and matcher are plain C++ and run anywhere.
  testLinuxMatcher("xcrun", ["clang++"]);
}

/**
 * Build and run the Linux hook's portable decisions: its key table, button
 * mapping, session check and press/release matching. It includes no X11
 * header and starts no hook, so it also runs on macOS.
 */
function testLinuxMatcher(compiler, prefix = []) {
  const source = fileURLToPath(
    new URL(
      "../../native/global-input-hook/tests/hook_linux_test.cc",
      import.meta.url,
    ),
  );
  const directory = mkdtempSync(
    path.join(tmpdir(), "animama-native-input-test-"),
  );
  const executable = path.join(directory, "hook-linux-test");
  try {
    for (const [command, args] of [
      [
        compiler,
        [
          ...prefix,
          "-std=c++20",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-o",
          executable,
          source,
        ],
      ],
      [executable, []],
    ]) {
      const result = spawnSync(command, args, {
        stdio: "inherit",
        timeout: 60_000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `${command} failed (${result.signal ?? result.status}).`,
        );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Load the addon from the packaged app's `app.asar.unpacked` and check a real
 * low-level hook: an injected F24 key (which no keyboard has) must arrive as
 * one down and one up. The mouse hook is only started and stopped; nothing
 * clicks on the desktop. The packaged executable cannot run as Node (its
 * RunAsNode fuse is off), so Electron's own staged binary loads the addon.
 */
function testPackagedWindowsAddon() {
  const unpacked = fileURLToPath(
    new URL("../../release/win-unpacked/", import.meta.url),
  );
  const executable = fileURLToPath(
    new URL(
      "../../.desktop-runtime/win32-x64/electron/electron.exe",
      import.meta.url,
    ),
  );
  const addon = path.join(
    unpacked,
    "resources/app.asar.unpacked/dist/native/animama_input_hook.node",
  );
  if (!existsSync(executable) || !existsSync(addon))
    throw new Error(
      "Stage and audit the Windows runtime, then run pnpm desktop:win first.",
    );
  const directory = mkdtempSync(
    path.join(tmpdir(), "animama-native-input-test-"),
  );
  const script = path.join(directory, "hook-check.cjs");
  writeFileSync(
    script,
    `const { spawnSync } = require("node:child_process");
const hook = require(process.argv[2]);
const modifiers = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
if (!hook.isSupported() || !hook.permissionGranted()) throw new Error("hook unavailable");
const events = [];
hook.start({ type: "keyboard", code: "F24", ...modifiers }, (down) => events.push(down));
// VK_F24 with its scan code; flag 2 is KEYEVENTF_KEYUP.
const injected = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "Add-Type -Namespace W -Name K -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'; [W.K]::keybd_event(0x87, 0x76, 0, [System.UIntPtr]::Zero); [W.K]::keybd_event(0x87, 0x76, 2, [System.UIntPtr]::Zero)"],
  { stdio: "inherit" });
if (injected.status !== 0) throw new Error("input injection failed");
setTimeout(() => {
  hook.stop();
  if (JSON.stringify(events) !== "[true,false]") throw new Error("keyboard events: " + JSON.stringify(events));
  hook.start({ type: "mouse", button: 4, ...modifiers }, () => {});
  hook.stop();
  console.log("native input (Windows): OK");
}, 1000);
`,
  );
  try {
    const result = spawnSync(executable, [script, addon], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "inherit",
      timeout: 60_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`The packaged addon check failed (${result.status}).`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function testMacHook() {
  const source = fileURLToPath(
    new URL(
      "../../native/global-input-hook/tests/hook_mac_test.cc",
      import.meta.url,
    ),
  );
  const directory = mkdtempSync(
    path.join(tmpdir(), "animama-native-input-test-"),
  );
  const executable = path.join(directory, "hook-mac-test");

  /** Bound compiler/test execution; never start a hook or request OS permission. */
  function run(command, args) {
    const result = spawnSync(command, args, {
      stdio: "inherit",
      timeout: 60_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${command} failed (${result.signal ?? result.status}).`);
    }
  }

  try {
    run("xcrun", [
      "clang++",
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-arch",
      "arm64",
      "-mmacosx-version-min=15.0",
      "-framework",
      "ApplicationServices",
      "-framework",
      "CoreFoundation",
      source,
      "-o",
      executable,
    ]);
    run(executable, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
