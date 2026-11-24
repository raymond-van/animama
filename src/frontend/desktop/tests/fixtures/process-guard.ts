import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The staged Windows runtime, when this checkout has one. */
export const stagedWindowsRuntime = path.resolve(
  here,
  "../../.desktop-runtime/win32-x64/runtime",
);

/** Every owned process on Windows runs through the staged process guard. */
export const stagedProcessGuard = path.join(
  stagedWindowsRuntime,
  "bin/animama-process-guard.exe",
);

/**
 * The grace period compiled into the test build of the POSIX guard: short
 * enough to test the deadline, long enough for a loaded host to stop a
 * graceful service first.
 */
export const POSIX_GUARD_TEST_GRACE_MS = 3000;

let posixGuard: string | undefined | null = null;

/**
 * The Linux process guard, compiled from source for this host with a short
 * grace period. Linux and macOS only; undefined on Windows and where no C
 * compiler is installed. A source that does not compile is an error. The
 * binary is kept in the ignored build cache under a name made from the source
 * and the grace period, so test runs neither rebuild it nor leave it behind.
 */
export function posixProcessGuard(): string | undefined {
  if (process.platform === "win32") return undefined;
  if (posixGuard !== null) return posixGuard;
  const source = path.resolve(
    here,
    "../../native/process-guard/process_guard_linux.c",
  );
  const digest = createHash("sha256")
    .update(readFileSync(source))
    .update(String(POSIX_GUARD_TEST_GRACE_MS))
    .digest("hex")
    .slice(0, 16);
  const folder = path.resolve(here, "../../.desktop-runtime/test-guard");
  const output = path.join(folder, `animama-process-guard-${digest}`);
  if (existsSync(output)) return (posixGuard = output);
  mkdirSync(folder, { recursive: true });
  // Test files compile concurrently; each renames its own complete binary.
  const pending = `${output}.${process.pid}`;
  const result = spawnSync(
    "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-DGUARD_GRACE_MS=${POSIX_GUARD_TEST_GRACE_MS}`,
      "-o",
      pending,
      source,
    ],
    { encoding: "utf8" },
  );
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
    return (posixGuard = undefined);
  if (result.error || result.status !== 0)
    throw new Error(
      `The Linux process guard does not compile: ${result.error?.message ?? result.stderr}`,
    );
  renameSync(pending, output);
  return (posixGuard = output);
}

/**
 * The guard a host's services must run under: the staged one on Windows, the
 * compiled one on Linux, and none on macOS, where services start directly.
 */
export const hostProcessGuard =
  process.platform === "win32"
    ? stagedProcessGuard
    : process.platform === "linux"
      ? posixProcessGuard()
      : undefined;

/** Real child processes can launch wherever the host's guard, if any, exists. */
export const ownedProcessesLaunchable =
  hostProcessGuard === undefined
    ? process.platform === "darwin"
    : existsSync(hostProcessGuard);
