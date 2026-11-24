import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { atomicWrite, privateDirectory } from "./atomic-file.js";
import { RuntimeError } from "./errors.js";
import { runtimeRedactor } from "./redaction.js";
import { writeLog } from "../logging.js";

export type OwnedProcess = {
  name: string;
  /** Under a process guard this is the guard; the service runs beneath it. */
  child: ChildProcess;
  /** The service's own PID, once known. Health and postmaster checks use it. */
  processId?: number;
  token: string;
  executable: string;
  dataRoot: string;
  output: string;
  exit: Promise<void>;
  /** Settles once the output pipes have closed, after `exit`. */
  closed: Promise<void>;
};

const GUARD_HANDSHAKE = /^animama-process-guard pid=([1-9]\d*)\r?$/u;
let processGuard: string | undefined;

/**
 * Windows and Linux run every owned process under a process guard, so nothing
 * outlives Electron: a kill-on-close job on Windows, a lifeline-watching
 * parent on Linux. The supervisor selects the verified guard.
 */
export function useProcessGuard(executable: string | undefined): void {
  processGuard = executable;
}

/** Whether this platform's services may only run under the process guard. */
export function guardedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" || platform === "linux";
}

/**
 * Spawn a service through the selected guard, or directly where the platform
 * has none (macOS). The guard's stdin is its lifeline: closing it, or Electron
 * exiting, stops the service.
 */
function spawnService(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): ChildProcess {
  if (!processGuard) {
    if (guardedPlatform()) throw new RuntimeError("process_guard_unavailable");
    return spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const guard = spawn(processGuard, ["--", executable, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // Closing the lifeline of a guard that already exited is not an error.
  guard.stdin!.on("error", () => undefined);
  return guard;
}

// Windows integrity levels of an elevated administrator and of SYSTEM. The
// SIDs are not localized, unlike the group names `whoami` prints beside them.
const ELEVATED_LABELS = ["S-1-16-12288", "S-1-16-16384"];

/** Does `whoami /groups` output show an elevated token? */
export function elevatedGroups(output: string): boolean {
  return ELEVATED_LABELS.some((label) => output.includes(`"${label}"`));
}

/**
 * PostgreSQL refuses to run with an elevated Windows token. Detect one before
 * anything is created, so an elevated launch leaves no files a normal launch
 * cannot use. A failed check returns false; PostgreSQL's own refusal remains.
 */
export function runsElevated(): Promise<boolean> {
  const whoami = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "whoami.exe",
  );
  // Asynchronous: resolving group names can stall on an offline domain member,
  // and the startup window must stay responsive meanwhile.
  return new Promise((resolve) =>
    execFile(
      whoami,
      ["/groups", "/fo", "csv", "/nh"],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(!error && elevatedGroups(stdout)),
    ),
  );
}

/** Parse the guard's first stdout line, which precedes any service output. */
export function guardHandshake(line: string): number | undefined {
  const match = GUARD_HANDSHAKE.exec(line);
  return match ? Number(match[1]) : undefined;
}

/**
 * Inherit OS locale, home and temporary folders only; never leak unrelated
 * developer credentials to children. Windows children also need SystemRoot
 * (Winsock fails without it) and a PATH limited to the system folders.
 */
export function baseChildEnvironment(
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const systemRoot = source.SystemRoot || "C:\\Windows";
  const env: NodeJS.ProcessEnv = {
    PATH: windows
      ? [`${systemRoot}\\System32`, systemRoot].join(";")
      : "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  const keys = windows
    ? [
        "SystemRoot",
        "SystemDrive",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "LOCALAPPDATA",
      ]
    : ["HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME"];
  for (const key of keys) if (source[key]) env[key] = source[key];
  return env;
}

function logLines(
  child: ChildProcess,
  owned: OwnedProcess,
  onHandshake: () => void,
): void {
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    let discarding = false;
    let handshake = stream === child.stdout && owned.processId === undefined;
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (handshake) {
          handshake = false;
          owned.processId = guardHandshake(line);
          if (owned.processId !== undefined) {
            onHandshake();
            continue;
          }
          writeLog("error", `[${owned.name}] process guard handshake missing`);
        }
        if (!discarding) {
          const safe = runtimeRedactor.redact(line);
          owned.output = (owned.output + safe + "\n").slice(-8192);
          writeLog("info", `[${owned.name}] ${safe}`);
        }
        discarding = false;
      }
      // Never emit a partial oversized line: it could split a secret value.
      if (pending.length > 64 * 1024) {
        pending = "";
        discarding = true;
      }
    });
    stream?.on("end", () => {
      if (pending && !discarding)
        writeLog("info", `[${owned.name}] ${runtimeRedactor.redact(pending)}`);
    });
  }
}

/** Windows paths compare without case and in resolved form. */
function sameWindowsImage(running: string, recorded: string): boolean {
  return running.toLowerCase() === path.win32.resolve(recorded).toLowerCase();
}

/**
 * A process ID is reused after a crash, soon on Windows. A live recorded PID
 * is the earlier runtime only while it still runs the recorded image: the
 * process guard for a guard PID, or the recorded service. An image that cannot
 * be read (another user's or an elevated process) was never ours, since
 * Animama never runs elevated. An unknown expected image, or a failed lookup,
 * still blocks.
 */
export function recordedImageRunning(
  live: { pid: number; image: string | undefined }[],
  images: Map<number, string> | null,
  sameImage: (running: string, recorded: string) => boolean = sameWindowsImage,
): boolean {
  return live.some(
    ({ pid, image }) =>
      !image || !images || sameImage(images.get(pid) ?? "", image),
  );
}

/**
 * Linux image paths of these PIDs, from `/proc/<pid>/exe`. A process whose
 * link cannot be read belongs to another account and is left out. Null when
 * this process cannot read even its own link, so the lookup itself is broken.
 */
export function linuxImages(
  pids: number[],
  read: (file: string) => string = readlinkSync,
): Map<number, string> | null {
  try {
    read("/proc/self/exe");
  } catch {
    return null;
  }
  const images = new Map<number, string>();
  for (const pid of pids)
    try {
      // The kernel marks an image whose file was replaced or unmounted.
      images.set(pid, read(`/proc/${pid}/exe`).replace(/ \(deleted\)$/u, ""));
    } catch {
      // Not readable: another account's process, or one that just exited.
    }
  return images;
}

/** How a platform tells a recorded process from a reused PID, if it can. */
export type ImageLookup = {
  images(pids: number[]): Map<number, string> | null;
  sameImage(running: string, recorded: string): boolean;
};
export function imageLookup(
  platform: NodeJS.Platform,
): ImageLookup | undefined {
  if (platform === "win32")
    return { images: windowsImages, sameImage: sameWindowsImage };
  if (platform === "linux")
    return {
      images: linuxImages,
      sameImage: (running, recorded) => running === path.resolve(recorded),
    };
  return undefined;
}

/** Image paths of these PIDs that this account may read; null if the lookup fails. */
function windowsImages(pids: number[]): Map<number, string> | null {
  try {
    const output = execFileSync(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Process -Id ($env:ANIMAMA_PIDS -split ',') -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id)`t$($_.Path)\" }",
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        env: { ...baseChildEnvironment(), ANIMAMA_PIDS: pids.join(",") },
      },
    );
    const images = new Map<number, string>();
    for (const line of output.split(/\r?\n/u)) {
      const [pid, image] = line.split("\t");
      if (/^\d+$/u.test(pid ?? "") && image) images.set(Number(pid), image);
    }
    return images;
  } catch {
    return null;
  }
}

/** Track exact handles. A stale persisted PID is evidence, never kill authority. */
export class OwnedProcesses {
  readonly children = new Set<OwnedProcess>();
  constructor(
    private recordFile: string,
    lookup: ImageLookup | undefined = imageLookup(process.platform),
  ) {
    privateDirectory(path.dirname(recordFile));
    if (!existsSync(recordFile)) return;
    try {
      const stat = lstatSync(recordFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
        throw new Error();
      const record = JSON.parse(readFileSync(recordFile, "utf8"));
      if (record.version !== 1 || !Array.isArray(record.children))
        throw new Error();
      const live: { pid: number; image: string | undefined }[] = [];
      for (const item of record.children) {
        const pids = [item.pid, item.servicePid ?? item.pid];
        if (!pids.every((pid) => Number.isInteger(pid) && pid >= 1))
          throw new Error();
        // The first PID is the guard, where there is one; the second runs the service.
        const images = [item.guard ?? processGuard, item.executable];
        for (const [index, pid] of pids.entries())
          try {
            process.kill(pid, 0);
            // Without an image lookup (macOS) any live recorded PID blocks.
            if (!lookup) throw new RuntimeError("previous_runtime_running");
            live.push({ pid, image: images[index] });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EPERM" && lookup)
              live.push({ pid, image: images[index] });
            else if (code !== "ESRCH") throw error;
          }
      }
      if (
        live.length &&
        lookup &&
        recordedImageRunning(
          live,
          lookup.images([...new Set(live.map((entry) => entry.pid))]),
          lookup.sameImage,
        )
      )
        throw new RuntimeError("previous_runtime_running");
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError("process_ownership_record_invalid");
    }
  }
  private persist(): void {
    atomicWrite(
      this.recordFile,
      JSON.stringify({
        version: 1,
        children: [...this.children]
          .filter((item) => item.child.pid)
          .map((item) => ({
            name: item.name,
            pid: item.child.pid,
            servicePid: item.processId,
            // The guard this launch used, should a later launch run elsewhere.
            ...(processGuard ? { guard: processGuard } : {}),
            startToken: item.token,
            executable: item.executable,
            dataRoot: item.dataRoot,
          })),
      }),
    );
  }
  launch(
    name: string,
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
  ): OwnedProcess {
    const token = randomUUID();
    const child = spawnService(
      executable,
      args,
      {
        ...baseChildEnvironment(),
        ...env,
        ANIMAMA_PROCESS_START_TOKEN: token,
      },
      cwd,
    );
    const item: OwnedProcess = {
      name,
      child,
      // Without the guard the child is the service itself.
      processId: processGuard ? undefined : child.pid,
      token,
      executable,
      dataRoot: cwd,
      output: "",
      exit: Promise.resolve(),
      closed: new Promise((resolve) => {
        child.once("close", () => resolve());
        child.once("error", () => resolve());
      }),
    };
    item.exit = new Promise((resolve) => {
      const finished = () => {
        this.children.delete(item);
        try {
          this.persist();
        } catch {
          writeLog("error", "process_ownership_record_write_failed");
        } finally {
          resolve();
        }
      };
      child.once("exit", finished);
      child.once("error", finished);
    });
    this.children.add(item);
    this.persist();
    logLines(child, item, () => {
      try {
        this.persist();
      } catch {
        writeLog("error", "process_ownership_record_write_failed");
      }
    });
    return item;
  }
  async terminate(item: OwnedProcess, timeoutMs = 15_000): Promise<void> {
    if (!this.children.has(item)) return;
    const started = Date.now();
    // Closing the guard's lifeline asks the service to stop (Ctrl+Break on
    // Windows, SIGINT on Linux), then kills it if it is still running after
    // the guard's grace period.
    if (item.child.stdin) item.child.stdin.end();
    else item.child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = await Promise.race([
      item.exit.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (expired && this.children.has(item)) {
      writeLog(
        "error",
        `Owned ${item.name} exceeded its shutdown deadline; terminating the retained handle`,
      );
      item.child.kill("SIGKILL");
      await item.exit;
    }
    writeLog(
      "info",
      `Owned ${item.name} stopped in ${Date.now() - started} ms (exit ${item.child.exitCode ?? item.child.signalCode})`,
    );
  }
  async terminateAll(): Promise<void> {
    for (const item of [...this.children].reverse()) await this.terminate(item);
  }
}

// NTSTATUS exit codes from the Windows loader: a dependent DLL is missing, is
// not a valid image for this architecture, or failed to initialize.
const NATIVE_LOAD_FAILURES = new Set([0xc0000135, 0xc000007b, 0xc0000142]);

/** Did a child exit because Windows could not load one of its runtime DLLs? */
export function nativeLoadFailure(code: number | null): boolean {
  return code !== null && NATIVE_LOAD_FAILURES.has(code >>> 0);
}

/** Bounded command output is internal to main; arguments never contain secrets. */
export async function runCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    // The guard's handshake line precedes the command's own output.
    const guarded = Boolean(processGuard);
    try {
      child = spawnService(
        executable,
        args,
        { ...baseChildEnvironment(), ...env },
        cwd,
      );
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    const timer = setTimeout(() => {
      failure = "runtime_command_timeout";
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (data: string) => {
      if (failure) return;
      stdout += data;
      if (stdout.length > 1024 * 1024) {
        failure = "runtime_command_output_limit";
        child.kill("SIGKILL");
      }
    });
    child.stderr!.on("data", (data: string) => {
      if (failure) return;
      stderr += data;
      if (stderr.length > 1024 * 1024) {
        failure = "runtime_command_output_limit";
        child.kill("SIGKILL");
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new RuntimeError("runtime_command_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || failure) {
        writeLog("error", runtimeRedactor.redact(stderr).slice(-8192));
        reject(
          new RuntimeError(
            failure ??
              (nativeLoadFailure(code)
                ? "runtime_file_invalid"
                : "runtime_command_failed"),
          ),
        );
      } else
        resolve(
          guarded
            ? stdout.replace(/^animama-process-guard pid=\d+\r?\n/u, "")
            : stdout,
        );
    });
  });
}
