import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPrivateWindowsDirectory, systemPath } from "./windows-acl.mjs";

export const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
export const frontendRoot = path.dirname(desktopRoot);
export const repoRoot = path.resolve(frontendRoot, "../..");
export const sourceRoot = path.join(desktopRoot, "runtime");
export const cacheRoot = path.join(desktopRoot, ".desktop-runtime");
// ZIP cannot represent the Unix epoch. Use one fixed, portable date everywhere.
const normalizedTime = new Date("2000-01-01T00:00:00Z");

/**
 * Electron's binary distribution for this host. The `electron` package has no
 * install script since Electron 42: resolving it downloads the binary on first
 * use and verifies it against the package's pinned checksums.
 */
export function electronDist() {
  // The override makes `electron` skip the download and the checksum check.
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH)
    throw new Error(
      "Unset ELECTRON_OVERRIDE_DIST_PATH: builds use the electron package's own verified binary",
    );
  const require = createRequire(path.join(desktopRoot, "package.json"));
  require("electron");
  return path.join(
    path.dirname(require.resolve("electron/package.json")),
    "dist",
  );
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Every target the embedded runtime can be staged, audited and packaged for. */
export const RUNTIME_TARGETS = ["darwin-arm64", "win32-x64", "linux-x64"];

/**
 * No user-controlled path or unknown target can reach downloads or deletion.
 * `host` is the machine running the build; tests pass another one.
 */
export function parseTarget(
  argv = process.argv.slice(2),
  host = { platform: process.platform, arch: process.arch },
) {
  const args = argv.filter((arg) => arg !== "--");
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--platform", "--arch"].includes(args[i]) ||
      !args[i + 1] ||
      values[args[i]]
    ) {
      throw new Error(
        "Expected --platform <darwin|win32|linux> --arch <arm64|x64>",
      );
    }
    values[args[i]] = args[i + 1];
  }
  const platform = values["--platform"];
  const arch = values["--arch"];
  if (!RUNTIME_TARGETS.includes(`${platform}-${arch}`)) {
    throw new Error(`Supported targets are ${RUNTIME_TARGETS.join(", ")}`);
  }
  if (platform !== host.platform || arch !== host.arch) {
    throw new Error(
      "Runtime builds and audits must run on the native target; cross-building is unsupported",
    );
  }
  const target = `${platform}-${arch}`;
  const output = path.join(cacheRoot, target);
  return {
    platform,
    arch,
    target,
    output,
    runtime: path.join(output, "runtime"),
  };
}

/** Release archives can be gigabytes; hash a fixed-size buffer rather than loading the archive. */
export function sha256(file) {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const length = readSync(fd, buffer, 0, buffer.length, null);
      if (!length) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Sorted, regular files only. Symlinks are materialized by component builders. */
export function filesIn(root, relative = "") {
  const result = [];
  for (const entry of readdirSync(path.join(root, relative)).sort()) {
    const name = relative ? `${relative}/${entry}` : entry;
    const stat = lstatSync(path.join(root, name));
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Non-regular staged member: ${name}`);
    }
    if (stat.isDirectory()) result.push(...filesIn(root, name));
    else result.push(name);
  }
  return result.sort();
}

export function normalizeTree(root) {
  for (const relative of filesIn(root)) {
    const file = path.join(root, relative);
    chmodSync(file, lstatSync(file).mode & 0o111 ? 0o755 : 0o644);
    utimesSync(file, normalizedTime, normalizedTime);
  }
}

/** Remove Finder metadata from generated web output, never from source assets. */
export function removeFinderMetadata(root) {
  for (const name of readdirSync(root).sort()) {
    const file = path.join(root, name);
    const stat = lstatSync(file);
    if (stat.isDirectory()) {
      removeFinderMetadata(file);
      if (readdirSync(file).length === 0) rmdirSync(file);
    } else if (!stat.isFile()) {
      throw new Error("Non-regular web build member");
    } else if (name === ".DS_Store") {
      rmSync(file);
    }
  }
}

/** Materialize only in-tree links, except Electron's signed framework layout. */
export function copyTree(source, destination, { preserveLinks = false } = {}) {
  const root = realpathSync(source);
  const copy = (from, to) => {
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(from);
      const relative = path.relative(root, target);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Component symlink escapes its root");
      if (preserveLinks) {
        const link = readlinkSync(from);
        if (path.isAbsolute(link))
          throw new Error("Absolute framework symlink is not portable");
        symlinkSync(link, to);
      } else copy(target, to);
    } else if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from).sort())
        copy(path.join(from, name), path.join(to, name));
    } else if (stat.isFile()) {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
      chmodSync(to, stat.mode & 0o111 ? 0o755 : 0o644);
    } else throw new Error("Special file in runtime component");
  };
  copy(root, destination);
}

/** Use argv arrays, never a shell; callers must keep secrets in the environment. */
export function run(
  command,
  args,
  { cwd = repoRoot, env = {}, capture = false, logFile, extraStdio = [] } = {},
) {
  const standard = capture || logFile ? "pipe" : "inherit";
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    // An entry at index zero is exposed to the child as descriptor 3. This lets
    // native inspectors read an already-open file without reparsing its name.
    stdio: extraStdio.length
      ? [standard, standard, standard, ...extraStdio]
      : standard,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (logFile)
    writeFileSync(logFile, (result.stdout ?? "") + (result.stderr ?? ""));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write((result.stderr ?? "").slice(-6000));
    throw new Error(
      `${path.basename(command)} failed (status ${result.status})`,
    );
  }
  return result.stdout ?? "";
}

/** Native executables carry `.exe` on Windows; the target is always the host. */
export const executableSuffix = process.platform === "win32" ? ".exe" : "";

/**
 * Run pnpm without a shell. On Windows `pnpm` is a `.cmd` shim that Node will
 * not spawn directly, so reuse the running pnpm's JavaScript entry point.
 */
export function pnpmCommand(args, execpath = process.env.npm_execpath) {
  return execpath && /\.c?js$/u.test(execpath)
    ? [process.execPath, [execpath, ...args]]
    : ["pnpm", args];
}

/**
 * Fail before the slow native and backend steps when the frontend install no
 * longer matches its lockfile, as after pulling a main that changed packages.
 * pnpm's own read-only status check compares the install with the lockfile,
 * package manifests and pnpm settings.
 */
export function assertFrontendDependenciesCurrent(root = frontendRoot) {
  const [command, args] = pnpmCommand(["exec", "node", "-e", ""]);
  const result = spawnSync(command, args, {
    cwd: root,
    // pnpm sets this to false for commands its scripts run, and in a workspace
    // that environment value overrides a command-line option.
    env: {
      ...process.env,
      npm_config_verify_deps_before_run: "error",
      pnpm_config_verify_deps_before_run: "error",
    },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const reason =
    output.match(/ERR_PNPM_\w+\s+(.+)/u)?.[1].trim() || output.trim();
  throw new Error(
    `Frontend dependencies in ${root} do not match pnpm-lock.yaml (${reason}). ` +
      "Run `pnpm install --frozen-lockfile` there, then stage again.",
  );
}

const NATIVE_LOCKS = {
  "darwin-arm64": "native-components.lock.json",
  "win32-x64": "native-components.win32-x64.lock.json",
  "linux-x64": "native-components.linux-x64.lock.json",
};

/** Each native target has its own pinned compiler inputs and minimum OS. */
export function nativeLockFile(target) {
  const name = NATIVE_LOCKS[`${target.platform}-${target.arch}`];
  if (!name) throw new Error("No native component lock for this target");
  return path.join(sourceRoot, name);
}

/** Windows tools (curl, bsdtar, cmd, icacls) come from System32, never PATH. */
export function systemTool(name) {
  return process.platform === "win32" ? systemPath(`${name}.exe`) : name;
}

/** Download a pinned upstream input once, accepting it only at its exact digest. */
export function downloadVerified(url, digest, file) {
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    const pending = `${file}.partial`;
    run(systemTool("curl"), [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--retry",
      "2",
      "--output",
      pending,
      url,
    ]);
    if (sha256(pending) !== digest)
      throw new Error(`${path.basename(file)} digest mismatch`);
    renameSync(pending, file);
  }
  if (sha256(file) !== digest)
    throw new Error(`${path.basename(file)} digest mismatch`);
  return file;
}

/** Paths whose working-tree bytes were converted from LF to CRLF at checkout. */
export function crlfConvertedPaths(eolListing) {
  return eolListing
    .split("\n")
    .map((line) => line.match(/^i\/lf\s+w\/crlf\s+\S.*?\t(.+)$/u)?.[1])
    .filter(Boolean);
}

/** Hashed build inputs must keep their committed bytes; CRLF checkouts change them. */
export function assertLfCheckout() {
  const autocrlf = spawnSync("git", ["config", "--get", "core.autocrlf"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout.trim();
  if (autocrlf === "true")
    throw new Error(
      "Build checkouts must not convert line endings; set core.autocrlf=false and check out again",
    );
  const converted = crlfConvertedPaths(
    run("git", ["ls-files", "--eol"], { capture: true }),
  );
  if (converted.length)
    throw new Error(
      `Build checkout has CRLF copies of LF files (for example ${converted.slice(0, 3).join(", ")}); check out again with core.autocrlf=false`,
    );
}

const hostTarget = `${process.platform}-${process.arch}`;

// The frozen runtime embeds the interpreter's sysconfig paths, and native
// builds embed their prefix. uv's default install directory is inside the
// builder's home, so pin a neutral one.
export function buildRootFor(platform) {
  if (platform === "win32") return "C:\\animama-build";
  // /var/tmp survives a reboot, unlike /tmp, and needs no administrator.
  // systemd still ages out files unused for about 30 days there; a stage that
  // then fails on its interpreter recovers by deleting this folder.
  return platform === "linux"
    ? "/var/tmp/animama-build"
    : "/Users/Shared/animama-build";
}
export const buildRoot = buildRootFor(process.platform);
const PYTHON_INSTALL_DIR = path.join(buildRoot, "uv-python");

/**
 * The neutral build root is writable by other accounts by default (/Users/Shared,
 * or inherited Authenticated Users rights below C:\). uv would run, and the
 * build would freeze, an interpreter another account planted there, so require
 * private ownership before any command installs or uses it.
 */
export function assertPrivatePythonInstallDir() {
  if (process.platform === "win32") {
    for (const directory of [
      buildRoot,
      PYTHON_INSTALL_DIR,
      pythonEnvironment().UV_CACHE_DIR,
    ])
      if (directory.startsWith(buildRoot))
        assertPrivateWindowsDirectory(directory);
    return;
  }
  for (const directory of [buildRoot, PYTHON_INSTALL_DIR]) {
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o022
    )
      throw new Error(
        `${directory} must be a directory owned by this user and not writable by others`,
      );
  }
}

/**
 * uv's download cache for staging. macOS purges files from old entries under
 * /private/tmp, which leaves uv a cache that fails installs, so each host uses
 * its persistent, private cache folder.
 */
export function uvCacheDir(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  if (env.UV_CACHE_DIR) return env.UV_CACHE_DIR;
  if (platform === "win32")
    return path.join(buildRootFor(platform), "uv-cache");
  if (platform === "linux")
    return path.join(
      path.isAbsolute(env.XDG_CACHE_HOME ?? "")
        ? env.XDG_CACHE_HOME
        : path.join(home, ".cache"),
      "animama",
      "uv-cache",
    );
  return path.join(home, "Library", "Caches", "Animama", "uv-cache");
}

export function pythonEnvironment() {
  return {
    UV_CACHE_DIR: uvCacheDir(),
    UV_PYTHON_INSTALL_DIR: PYTHON_INSTALL_DIR,
    UV_PROJECT_ENVIRONMENT: path.join(cacheRoot, "build-venv", hostTarget),
    PYTHONHASHSEED: "0",
    SOURCE_DATE_EPOCH: String(normalizedTime.getTime() / 1000),
    ...(process.platform === "darwin"
      ? { MACOSX_DEPLOYMENT_TARGET: "15.0" }
      : {}),
    PYINSTALLER_CONFIG_DIR: path.join(cacheRoot, "pyinstaller-cache"),
    ANIMAMA_LOG_TO_FILE: "0",
    ANIMAMA_LOG_TO_CONSOLE: "0",
  };
}

/**
 * Create or refresh the locked build interpreter outside the repository's .venv:
 * the core dependencies, the `documents` extra the upload parse child imports,
 * and PyInstaller.
 */
export function syncBuildEnvironment() {
  assertPrivatePythonInstallDir();
  run(
    "uv",
    [
      "sync",
      "--python",
      readJson(path.join(sourceRoot, "source-manifest.json")).python,
      "--frozen",
      "--no-default-groups",
      "--extra",
      "documents",
      "--group",
      "desktop-build",
    ],
    { env: pythonEnvironment() },
  );
}

export function buildPython() {
  const venv = pythonEnvironment().UV_PROJECT_ENVIRONMENT;
  return process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");
}
