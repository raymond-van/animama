import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWrite } from "../src/main-process/runtime/atomic-file.js";
import {
  guardedPlatform,
  stopTimeout,
  imageLookup,
  linuxImages,
  OwnedProcesses,
  runCommand,
  useProcessGuard,
} from "../src/main-process/runtime/processes.js";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "animama-linux-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  useProcessGuard(undefined);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Linux process ownership", () => {
  it("requires the process guard on Windows and Linux, not macOS", () => {
    expect(guardedPlatform("win32")).toBe(true);
    expect(guardedPlatform("linux")).toBe(true);
    expect(guardedPlatform("darwin")).toBe(false);
  });

  it("gives the Linux guard time to finish before its handle is killed", () => {
    // The guard's own 15-second grace, then up to 5 seconds for orphans.
    expect(stopTimeout("linux", true)).toBeGreaterThan(20_000);
    expect(stopTimeout("win32", true)).toBe(15_000);
    expect(stopTimeout("darwin", false)).toBe(15_000);
  });

  it("refuses to launch a Linux service without the process guard", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const owned = new OwnedProcesses(path.join(fixture(), "processes.json"));
    expect(() =>
      owned.launch("fixture", process.execPath, [], {}, fixture()),
    ).toThrow("process_guard_unavailable");
    await expect(
      runCommand(process.execPath, [], {}, fixture()),
    ).rejects.toThrow("process_guard_unavailable");
  });

  it("reads process images from /proc and leaves out what it cannot read", () => {
    const links: Record<string, string> = {
      "/proc/self/exe": "/usr/bin/electron",
      "/proc/10/exe": "/mnt/app/resources/runtime/bin/animama-process-guard",
      // The kernel marks an image whose file was unlinked or replaced.
      "/proc/11/exe":
        "/mnt/app/resources/runtime/postgres/bin/postgres (deleted)",
    };
    const read = (file: string) => {
      if (file in links) return links[file]!;
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(linuxImages([10, 11, 12], read)).toEqual(
      new Map([
        [10, "/mnt/app/resources/runtime/bin/animama-process-guard"],
        [11, "/mnt/app/resources/runtime/postgres/bin/postgres"],
      ]),
    );
    // No /proc at all: the lookup failed, which must block, not pass.
    expect(
      linuxImages([10], () => {
        throw new Error("no procfs");
      }),
    ).toBeNull();
  });

  it("blocks a launch only while a recorded PID still runs the recorded image", () => {
    const guard = "/mnt/app/resources/runtime/bin/animama-process-guard";
    const service = "/mnt/app/resources/runtime/postgres/bin/postgres";
    const file = path.join(fixture(), "processes.json");
    atomicWrite(
      file,
      JSON.stringify({
        version: 1,
        children: [
          {
            name: "postgres",
            pid: 4100,
            servicePid: 4101,
            guard,
            executable: service,
            startToken: "stale",
            dataRoot: "/data",
          },
        ],
      }),
    );
    // Both recorded PIDs are alive, as after a reboot that reused them.
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const open = (images: Map<number, string> | null) =>
      new OwnedProcesses(file, {
        images: () => images,
        sameImage: imageLookup("linux")!.sameImage,
      });
    // Reused by unrelated programs, or not readable by this account.
    expect(() =>
      open(
        new Map([
          [4100, "/usr/bin/bash"],
          [4101, "/usr/lib/firefox/firefox"],
        ]),
      ),
    ).not.toThrow();
    expect(() => open(new Map())).not.toThrow();
    // The earlier launch's guard or service is still running.
    expect(() => open(new Map([[4100, guard]]))).toThrow(
      "previous_runtime_running",
    );
    expect(() => open(new Map([[4101, service]]))).toThrow(
      "previous_runtime_running",
    );
    // Linux paths are case-sensitive, unlike Windows image paths.
    expect(() => open(new Map([[4101, service.toUpperCase()]]))).not.toThrow();
    // A failed lookup stays conservative.
    expect(() => open(null)).toThrow("previous_runtime_running");
  });

  it("blocks on a live recorded PID whose image was never recorded", () => {
    const file = path.join(fixture(), "processes.json");
    atomicWrite(
      file,
      JSON.stringify({
        version: 1,
        children: [{ name: "postgres", pid: process.pid, startToken: "stale" }],
      }),
    );
    expect(() => new OwnedProcesses(file)).toThrow("previous_runtime_running");
  });
});
