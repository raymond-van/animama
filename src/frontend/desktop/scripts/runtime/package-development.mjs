import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, Platform, Arch } from "electron-builder";
import { desktopRoot, parseTarget, readJson, writeJson } from "./common.mjs";
import { assertFuseWire } from "./fuses.mjs";
import { assertInventory, componentInventory } from "./inventory.mjs";

/**
 * How each target's unsigned development package is built and where its parts
 * land under `release/`. Production signing has its own reviewed contract.
 *
 * - macOS arm64: an unsigned `.app` directory. Without `identity: null`,
 *   electron-builder signs with any identity it discovers in the Keychain,
 *   invalidating the staged per-file hashes.
 * - Windows x64: an unsigned `win-unpacked` directory, or with `--installer`
 *   an unsigned per-user NSIS installer for local installer testing. Neither
 *   is ever a release.
 * - Linux x64: the unpacked app and one AppImage, the only form a Linux build
 *   takes. Nothing is signed or published.
 */
export function developmentPackage(target, { installer, version }) {
  if (installer && target.platform !== "win32")
    throw new Error("--installer builds the Windows NSIS installer only");
  if (target.platform === "win32")
    return {
      builder: "WINDOWS",
      targets: [installer ? "nsis" : "dir"],
      arch: "x64",
      config: {
        forceCodeSigning: false,
        // Sign nothing, so the staged runtime keeps its audited hashes even if
        // a certificate is configured; release signing is a separate contract.
        // electron-builder still edits Animama.exe's icon and version
        // resources, exactly as for a release.
        win: { signExts: ["!.exe"] },
        // A one-click per-user install folder takes the package name:
        // %LOCALAPPDATA%\\Programs\\Animama, not ...\\animama-desktop.
        extraMetadata: { name: "Animama" },
      },
      app: "win-unpacked",
      runtime: "win-unpacked/resources/runtime",
      fuses: "win-unpacked/Animama.exe",
      reported: "win-unpacked/Animama.exe",
      // Matches nsis.artifactName in electron-builder.yml.
      artifact: installer ? `Animama-${version}-x64-setup.exe` : undefined,
    };
  if (target.platform === "linux")
    return {
      builder: "LINUX",
      targets: ["AppImage"],
      arch: "x64",
      config: { forceCodeSigning: false },
      app: "linux-unpacked",
      runtime: "linux-unpacked/resources/runtime",
      // linux.executableName in electron-builder.yml.
      fuses: "linux-unpacked/animama",
      reported: "linux-unpacked/animama",
      // linux.artifactName; electron-builder names the x64 AppImage x86_64.
      artifact: `Animama-${version}-x86_64.AppImage`,
    };
  return {
    builder: "MAC",
    targets: ["dir"],
    arch: "arm64",
    config: {
      forceCodeSigning: false,
      mac: { identity: null, notarize: false },
    },
    // The default architecture deliberately omits an architecture suffix.
    app: "mac/Animama.app",
    runtime: "mac/Animama.app/Contents/Resources/runtime",
    fuses: "mac/Animama.app",
    reported: "mac/Animama.app",
    artifact: undefined,
  };
}

/**
 * The desktop entry electron-builder put inside an AppImage must not turn the
 * sandbox off: the app refuses to run that way, and tools that add AppImages
 * to the application menu copy this entry.
 */
export function assertSandboxedDesktopEntry(text) {
  const exec = text.split("\n").filter((line) => line.startsWith("Exec="));
  if (exec.length !== 1)
    throw new Error("The AppImage's desktop entry needs exactly one Exec line");
  if (/--no-sandbox|--disable-[a-z-]*sandbox/u.test(exec[0]))
    throw new Error(
      `The AppImage's desktop entry disables the sandbox: ${exec[0]}`,
    );
}

/** Read the desktop entry out of a built AppImage with its own launcher. */
function appImageDesktopEntry(appImage) {
  const folder = mkdtempSync(
    path.join(realpathSync(tmpdir()), "animama-appimage-"),
  );
  try {
    const result = spawnSync(appImage, ["--appimage-extract", "*.desktop"], {
      cwd: folder,
      encoding: "utf8",
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Could not read the AppImage's desktop entry: ${result.error?.message ?? result.stderr}`,
      );
    const root = path.join(folder, "squashfs-root");
    const entries = readdirSync(root).filter((name) =>
      name.endsWith(".desktop"),
    );
    if (entries.length !== 1)
      throw new Error("The AppImage needs exactly one desktop entry");
    return readFileSync(path.join(root, entries[0]), "utf8");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Build a local unsigned app for this host's target without mutating the
 * audited native runtime.
 */
async function main() {
  const installer = process.argv.includes("--installer");
  // The script names its target; parseTarget refuses a different host.
  const target = parseTarget(
    process.argv.slice(2).filter((arg) => arg !== "--installer"),
  );
  const staged = readJson(path.join(target.runtime, "manifest.json"));
  const plan = developmentPackage(target, {
    installer,
    version: staged.app_version,
  });
  await build({
    projectDir: desktopRoot,
    targets: Platform[plan.builder].createTarget(plan.targets, Arch[plan.arch]),
    publish: "never",
    config: {
      extends: path.join(desktopRoot, "electron-builder.yml"),
      ...plan.config,
    },
  });
  const release = path.join(desktopRoot, "release");
  const runtime = path.join(release, plan.runtime);
  const manifest = readJson(path.join(runtime, "manifest.json"));
  if (manifest.build_id !== staged.build_id)
    throw new Error(
      "Packaged development runtime differs from the audited stage",
    );
  assertInventory(runtime, manifest.files);
  assertFuseWire(path.join(release, plan.fuses));
  if (plan.artifact && !existsSync(path.join(release, plan.artifact)))
    throw new Error(
      `electron-builder did not produce release/${plan.artifact}`,
    );
  if (target.platform === "linux")
    assertSandboxedDesktopEntry(
      appImageDesktopEntry(path.join(release, plan.artifact)),
    );
  writeJson(path.join(release, "development-package-report.json"), {
    schema: "animama-development-package/1",
    target: target.target,
    app_version: manifest.app_version,
    runtime_build_id: manifest.build_id,
    app: plan.reported,
    ...(installer ? { installer: plan.artifact } : {}),
    ...(target.platform === "linux" ? { appimage: plan.artifact } : {}),
    installed_bytes: componentInventory(path.join(release, plan.app)).reduce(
      (total, file) => total + file.size_bytes,
      0,
    ),
    runtime_inventory: "exact-audited-stage",
    release_ready: false,
    signing: "unsigned-development-only",
  });
  console.log(
    `Unsigned development ${installer ? `installer: release/${plan.artifact}` : plan.artifact ? `AppImage: release/${plan.artifact}` : `app: release/${plan.app}`}; runtime inventory: OK`,
  );
}

/**
 * Whether this file is the script being run, not a module a test imported.
 * Real paths on both sides: started through a symlinked checkout, a plain
 * comparison would skip the build and exit successfully.
 */
function runAsScript() {
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    // No script path, or one that is not a file: something else is running.
    return false;
  }
}

if (runAsScript()) await main();
