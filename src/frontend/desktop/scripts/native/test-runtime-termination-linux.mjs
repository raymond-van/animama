import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { cacheRoot, desktopRoot } from "../runtime/common.mjs";

/**
 * Force-kill unpackaged Electron at every startup stage and require that no
 * process from the staged runtime survives it, that the next launch on the
 * same data starts cleanly, and that a normal quit stops every service. Run
 * `pnpm desktop:build` and stage the Linux runtime first. It opens real
 * Electron windows, so it needs a desktop session.
 */
if (process.platform !== "linux")
  throw new Error("This runtime termination harness runs on Linux only");
// The real path: /proc reports images by it, whatever link the checkout
// was opened through.
const stagedRuntime = path.join(cacheRoot, "linux-x64", "runtime");
const runtimeRoot = existsSync(stagedRuntime)
  ? realpathSync(stagedRuntime)
  : stagedRuntime;
if (!existsSync(path.join(runtimeRoot, "manifest.json")))
  throw new Error("Stage the Linux runtime first");
if (!existsSync(path.join(desktopRoot, "dist", "main.js")))
  throw new Error("Run pnpm desktop:build first");

const electron = createRequire(import.meta.url)("electron");
const STAGES = [
  "validating",
  "vault",
  "application",
  "database",
  "migrations",
  "backend",
  "ready",
];
const LAUNCH_TIMEOUT_MS = 240_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const QUIT_TIMEOUT_MS = 90_000;

/**
 * Processes whose executable lies inside the staged runtime, as
 * `<pid> <name>`, read from `/proc`. Another account's processes cannot be
 * read and are never ours.
 */
function runtimeProcesses(root = `${runtimeRoot}${path.sep}`) {
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const image = readlinkSync(`/proc/${entry}/exe`).replace(
        / \(deleted\)$/u,
        "",
      );
      if (image.startsWith(root))
        found.push(`${entry} ${path.basename(image)}`);
    } catch {
      // Exited meanwhile, or not readable by this account.
    }
  }
  return found;
}

async function waitForNoRuntimeProcesses() {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  let remaining = runtimeProcesses();
  while (remaining.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    remaining = runtimeProcesses();
  }
  return remaining;
}

/**
 * Launch Electron and resolve once `stage` is reached. `lines` keeps
 * collecting Electron's log output after that.
 */
function launchUntil(stage, userData) {
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  const child = spawn(electron, [desktopRoot], {
    env: {
      ...env,
      ANIMAMA_DESKTOP_DEV_RUNTIME_ROOT: runtimeRoot,
      ANIMAMA_DESKTOP_DEV_USER_DATA: userData,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out before the ${stage} stage`));
    }, LAUNCH_TIMEOUT_MS);
    let settled = false;
    // Each stream keeps its own partial line so output never interleaves.
    const reader = () => {
      let pending = "";
      return (chunk) => {
        pending += chunk;
        for (let newline; (newline = pending.indexOf("\n")) >= 0; ) {
          const line = pending.slice(0, newline).trimEnd();
          pending = pending.slice(newline + 1);
          onLine(line);
        }
      };
    };
    const onLine = (line) => {
      lines.push(line);
      // main.ts logs every status change as "Runtime <state>[: <detail>]".
      const status =
        /\] Runtime (starting|ready|error|stopping|stopped)(?:: (\S+))?$/u.exec(
          line,
        );
      if (!status) return;
      process.stdout.write(`  ${status[0].slice(2)}\n`);
      // After the target stage, callers inspect `lines` themselves.
      if (settled) return;
      const [, state, detail] = status;
      if (state === "error") {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`Startup failed with ${detail}`));
      } else if (
        (state === "starting" && detail === stage) ||
        (state === "ready" && stage === "ready")
      ) {
        settled = true;
        clearTimeout(timer);
        resolve({
          child,
          lines,
          origin: state === "ready" ? detail : undefined,
        });
      }
    };
    child.stdout.setEncoding("utf8").on("data", reader());
    child.stderr.setEncoding("utf8").on("data", reader());
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Electron exited with ${code} before ${stage}`));
    });
  });
}

async function requireNoRuntimeProcesses(after) {
  const remaining = await waitForNoRuntimeProcesses();
  if (remaining.length)
    throw new Error(
      `Runtime processes survived ${after}: ${remaining.join(", ")}`,
    );
}

async function killAt(stage, userData) {
  process.stdout.write(`Force-killing Electron at ${stage}\n`);
  const { child, origin } = await launchUntil(stage, userData);
  child.removeAllListeners("exit");
  let answered = true;
  // Without this, a process listing that matches nothing (a runtime reached
  // through a symlink, say) would pass every "no process survived" check.
  const running = origin ? runtimeProcesses() : [];
  try {
    // Ready already means the supervisor verified the backend's private health.
    // Outside the app, requests lack the renderer capability, so any non-5xx
    // answer shows that the listener serves.
    if (origin) answered = (await fetch(new URL("/", origin))).status < 500;
  } finally {
    // SIGKILL to the main process alone: no cleanup code runs, and each guard
    // sees its lifeline close.
    child.kill("SIGKILL");
  }
  if (!answered) throw new Error(`The app at ${origin} failed to answer`);
  if (origin && !running.length)
    throw new Error(
      "No runtime process was found while the app was ready; the process listing cannot see the staged runtime",
    );
  await requireNoRuntimeProcesses(`a kill at ${stage}`);
  return origin;
}

/**
 * Ask the app to quit as a session would (SIGTERM) and require every service
 * to stop on its own, well inside the guard's 15 second grace period.
 */
async function quitNormally(userData) {
  process.stdout.write("Quitting normally from ready\n");
  const { child, lines, origin } = await launchUntil("ready", userData);
  child.removeAllListeners("exit");
  let exited = false;
  child.once("exit", () => (exited = true));
  const fail = (message) => {
    process.stderr.write(`${lines.join("\n")}\n`);
    child.kill("SIGKILL");
    throw new Error(message);
  };
  // Let the app window replace the startup page first.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  child.kill("SIGTERM");
  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (!exited && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 250));
  if (!exited) fail("Electron did not quit after SIGTERM");
  const remaining = await waitForNoRuntimeProcesses();
  if (remaining.length)
    fail(`Runtime processes survived a normal quit: ${remaining.join(", ")}`);
  const log = lines.join("\n");
  const error = /\] Runtime error: (\S+)$/mu.exec(log);
  if (error) fail(`Quitting reported ${error[1]}`);
  for (const line of lines.filter((text) => /Owned \S+ stopped in/u.test(text)))
    process.stdout.write(`  ${line.replace(/^.*\] /u, "")}\n`);
  const checks = [
    [/exceeded its shutdown deadline/u, false, "a service missed its deadline"],
    [
      /Application shutdown complete/u,
      true,
      "FastAPI did not shut down cleanly",
    ],
    [/database system is shut down/u, true, "PostgreSQL did not shut down"],
  ];
  for (const [pattern, expected, failure] of checks)
    if (pattern.test(log) !== expected) fail(failure);
  for (const match of log.matchAll(/Owned (\S+) stopped in (\d+) ms/gu))
    if (Number(match[2]) >= 15_000)
      fail(`${match[1]} needed the guard's group kill`);
  return origin;
}

const leftovers = runtimeProcesses();
if (leftovers.length)
  throw new Error(`Runtime processes are already running: ${leftovers}`);
// Private state refuses symlinked parents.
const userData = mkdtempSync(
  path.join(realpathSync(tmpdir()), "animama-term-"),
);
try {
  for (const stage of STAGES) await killAt(stage, userData);
  // After every kill the same data must reach ready again, with the same
  // origin, once PostgreSQL recovers; a normal quit must stop everything.
  const origins = [
    await killAt("ready", userData),
    await quitNormally(userData),
    await quitNormally(userData),
  ];
  if (!origins[0] || origins.some((origin) => origin !== origins[0]))
    throw new Error(`The origin changed across launches: ${origins}`);
  process.stdout.write("runtime termination: OK\n");
} finally {
  // Electron's helper processes can hold profile files briefly after it dies.
  try {
    rmSync(userData, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 500,
    });
  } catch (error) {
    process.stderr.write(`Could not remove ${userData}: ${error.message}\n`);
  }
}
