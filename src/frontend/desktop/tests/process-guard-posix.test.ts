import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  guardHandshake,
  OwnedProcesses,
  runCommand,
  useProcessGuard,
} from "../src/main-process/runtime/processes.js";
import {
  POSIX_GUARD_TEST_GRACE_MS,
  posixProcessGuard,
} from "./fixtures/process-guard.js";

// The guard is compiled from source for this host. macOS proves the portable
// lifeline logic; the parent-death signal and the child subreaper are Linux
// only and are exercised when this suite runs on Linux.
const guard = posixProcessGuard();
if (!guard && process.platform !== "win32")
  console.warn(
    "Skipping the POSIX process guard suite: no C compiler on this host",
  );
const roots: string[] = [];
const started: ChildProcess[] = [];
/** Services and grandchildren a test started, so a failure leaves none behind. */
const descendants: number[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill("SIGKILL");
  for (const pid of descendants.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, as it should be.
    }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  useProcessGuard(undefined);
});

// A Node service that reports its PID and a grandchild's, then waits.
// "graceful" exits 7 on SIGINT; "stubborn" ignores it.
const SERVICE = `
const { spawn } = require("node:child_process");
if (process.argv[1] === "stubborn") process.on("SIGINT", () => {});
else process.on("SIGINT", () => { console.log("interrupted"); process.exit(7); });
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGINT', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("ready pid=" + process.pid + " grandchild=" + grandchild.pid + " stdin=" + require("node:fs").fstatSync(0).isCharacterDevice() + " secret=" + process.env.GUARD_TEST_SECRET);
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

type Guarded = {
  child: ChildProcess;
  lines: string[];
  ready: Promise<{ pid: number; grandchild: number }>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function startGuarded(mode: string): Guarded {
  const child = spawn(guard!, ["--", process.execPath, "-e", SERVICE, mode], {
    env: { ...process.env, GUARD_TEST_SECRET: "guard-secret-value" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  started.push(child);
  const lines: string[] = [];
  const ready = new Promise<{ pid: number; grandchild: number }>((resolve) => {
    let pending = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      pending += chunk;
      for (let newline; (newline = pending.indexOf("\n")) >= 0; ) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        lines.push(line);
        const match = /^ready pid=(\d+) grandchild=(\d+)/u.exec(line);
        if (match) {
          descendants.push(Number(match[1]), Number(match[2]));
          resolve({ pid: Number(match[1]), grandchild: Number(match[2]) });
        }
      }
    });
  });
  const exit = new Promise<Awaited<Guarded["exit"]>>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, lines, ready, exit };
}

describe.skipIf(!guard)("POSIX process guard", () => {
  it("reports the service PID before any service output", async () => {
    const run = startGuarded("graceful");
    const { pid } = await run.ready;
    expect(guardHandshake(run.lines[0]!)).toBe(pid);
    expect(run.lines[1]).toMatch(/^ready /u);
    // The lifeline is the guard's; the service reads the null device.
    expect(run.lines[1]).toContain(" stdin=true ");
    expect(run.lines[1]).toContain(" secret=guard-secret-value");
    run.child.stdin!.end();
    await run.exit;
  });

  it("stops the service when its lifeline closes and passes on the exit code", async () => {
    const run = startGuarded("graceful");
    const { pid, grandchild } = await run.ready;
    run.child.stdin!.end();
    expect(await run.exit).toEqual({ code: 7, signal: null });
    expect(run.lines).toContain("interrupted");
    // The grandchild ignored the signal; it goes with the service's group.
    expect(await waitUntil(() => !alive(pid) && !alive(grandchild), 5000)).toBe(
      true,
    );
  });

  it("kills a service that ignores the signal once the grace period ends", async () => {
    const run = startGuarded("stubborn");
    const { pid, grandchild } = await run.ready;
    const closed = Date.now();
    run.child.stdin!.end();
    // 128 + SIGKILL.
    expect(await run.exit).toEqual({ code: 137, signal: null });
    expect(Date.now() - closed).toBeGreaterThanOrEqual(
      POSIX_GUARD_TEST_GRACE_MS - 100,
    );
    expect(await waitUntil(() => !alive(pid) && !alive(grandchild), 5000)).toBe(
      true,
    );
  });

  it("treats a termination signal like a closed lifeline", async () => {
    const run = startGuarded("graceful");
    const { pid } = await run.ready;
    run.child.kill("SIGTERM");
    expect(await run.exit).toEqual({ code: 7, signal: null });
    expect(await waitUntil(() => !alive(pid), 5000)).toBe(true);
  });

  it("ignores bytes on the lifeline; only its end stops the service", async () => {
    const run = startGuarded("graceful");
    const { pid } = await run.ready;
    run.child.stdin!.write("noise\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(pid)).toBe(true);
    run.child.stdin!.end();
    expect((await run.exit).code).toBe(7);
  });

  // The kernel's parent-death signal does this; macOS has no equivalent. It
  // reaches the service only: its grandchild is a known limit of the guard,
  // which the cleanup above removes.
  it.skipIf(process.platform !== "linux")(
    "takes the service with it when the guard is killed",
    async () => {
      const run = startGuarded("stubborn");
      const { pid } = await run.ready;
      run.child.kill("SIGKILL");
      await run.exit;
      expect(await waitUntil(() => !alive(pid), 5000)).toBe(true);
    },
  );

  it("stops a service at once when the stop arrives as the guard starts", async () => {
    // With no lifeline at all the guard must stop the service immediately,
    // even though the request can land before the service has replaced the
    // guard's own signal handlers. A swallowed signal would cost the full
    // grace period and end in SIGKILL (137).
    for (let attempt = 0; attempt < 20; attempt++) {
      const started = Date.now();
      const result = spawnSync(guard!, ["--", "/bin/sleep", "30"], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
      // 128 + SIGINT.
      expect(result.status).toBe(130);
      expect(Date.now() - started).toBeLessThan(POSIX_GUARD_TEST_GRACE_MS / 2);
    }
  });

  it("refuses anything but one absolute executable after --", () => {
    for (const args of [
      [],
      [process.execPath],
      ["--"],
      ["--", "node"],
      ["--", "relative/node"],
    ]) {
      const result = spawnSync(guard!, args, { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
    }
    const missing = spawnSync(guard!, ["--", "/nonexistent/service"], {
      encoding: "utf8",
    });
    expect(missing.status).toBe(3);
    // No handshake: the main process must not take this for a started service.
    expect(missing.stdout).toBe("");
  });

  it("runs owned services and commands through the guard", async () => {
    const root = mkdtempSync(
      path.join(realpathSync(tmpdir()), "animama-guard-"),
    );
    roots.push(root);
    useProcessGuard(guard);
    const owned = new OwnedProcesses(path.join(root, "processes.json"));
    const service = owned.launch(
      "service",
      process.execPath,
      ["-e", SERVICE, "graceful"],
      { GUARD_TEST_SECRET: "from-the-vault" },
      root,
    );
    expect(
      await waitUntil(() => /ready pid=/u.test(service.output), 10_000),
    ).toBe(true);
    // The service's own PID, not the guard's, and no handshake in its log.
    expect(service.processId).not.toBe(service.child.pid);
    expect(service.output).toContain(`ready pid=${service.processId} `);
    expect(service.output).not.toContain("animama-process-guard");
    const kill = vi.spyOn(service.child, "kill");
    await owned.terminate(service, 5000);
    expect(kill).not.toHaveBeenCalled();
    expect(owned.children.size).toBe(0);
    expect(alive(service.processId!)).toBe(false);
    await expect(
      runCommand(
        process.execPath,
        ["-e", "process.stdout.write('only output')"],
        {},
        root,
      ),
    ).resolves.toBe("only output");
  });
});
