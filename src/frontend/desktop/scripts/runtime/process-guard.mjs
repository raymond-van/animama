import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildRoot,
  desktopRoot,
  nativeLockFile,
  readJson,
  repoRoot,
  run,
} from "./common.mjs";
import { assertPrivateWindowsDirectory } from "./windows-acl.mjs";
import { msvcEnvironment } from "./windows-build.mjs";
import {
  assertNoEmbeddedPaths,
  auditWindowsDependencies,
} from "./windows-platform.mjs";

/** Must equal the main process's PROCESS_GUARD_PATH, which a test checks. */
export const PROCESS_GUARD = "bin/animama-process-guard.exe";
/** Must equal the main process's LINUX_PROCESS_GUARD_PATH, which a test checks. */
export const LINUX_PROCESS_GUARD = "bin/animama-process-guard";

// Warnings are errors, and the usual hardening for a small C program: stack
// protector, fortified libc calls, a position-independent executable and
// full RELRO.
export const LINUX_GUARD_COMPILE = [
  "-std=c11",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  // Some distributions' compilers predefine it; defining it twice is an error.
  "-U_FORTIFY_SOURCE",
  "-D_FORTIFY_SOURCE=2",
  "-fstack-protector-strong",
  "-fPIE",
  "-pie",
  "-Wl,-z,relro,-z,now",
];

/** Compile the Linux process guard into the staged runtime's bin/. */
function buildProcessGuardLinux(target) {
  const lock = readJson(nativeLockFile(target));
  const source = path.join(
    desktopRoot,
    "native/process-guard/process_guard_linux.c",
  );
  const output = path.join(target.runtime, LINUX_PROCESS_GUARD);
  mkdirSync(path.dirname(output), { recursive: true });
  run(
    lock.toolchain.cc,
    [
      ...LINUX_GUARD_COMPILE,
      // No checkout path in the binary, whatever the compiler records.
      `-ffile-prefix-map=${path.dirname(source)}=.`,
      "-o",
      output,
      source,
    ],
    { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
  );
  run("strip", ["--strip-unneeded", output]);
}

// Static CRT, so the guard needs no runtime DLL, and the hardening the plan
// requires: Control Flow Guard, ASLR with high entropy and CET shadow stacks.
const COMPILE = [
  "/nologo",
  "/std:c++17",
  "/EHsc",
  "/O2",
  "/W4",
  "/WX",
  "/MT",
  "/guard:cf",
  "/DUNICODE",
  "/D_UNICODE",
];
const LINK = ["/DYNAMICBASE", "/HIGHENTROPYVA", "/CETCOMPAT", "/guard:cf"];

/** Compile the first-party process guard into the staged runtime's bin folder. */
export function buildProcessGuard(target) {
  if (target.platform === "linux") return buildProcessGuardLinux(target);
  const lock = readJson(nativeLockFile(target));
  const msvc = msvcEnvironment(lock.toolchain);
  // Compile below the neutral build root so no checkout path is embedded.
  assertPrivateWindowsDirectory(path.join(buildRoot, "process-guard"));
  const work = path.join(buildRoot, "process-guard", target.target);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  copyFileSync(
    path.join(desktopRoot, "native/process-guard/process_guard.cpp"),
    path.join(work, "process_guard.cpp"),
  );
  const output = path.join(target.runtime, PROCESS_GUARD);
  mkdirSync(path.dirname(output), { recursive: true });
  run(
    "cl",
    [...COMPILE, "process_guard.cpp", "/link", ...LINK, `/OUT:${output}`],
    { cwd: work, env: msvc.env },
  );
  const bin = path.dirname(output);
  const name = path.basename(output);
  auditWindowsDependencies(bin, [name], {
    searchDirs: () => [],
    systemDlls: lock.system_dlls,
    env: msvc.env,
  });
  assertNoEmbeddedPaths(bin, [name], [repoRoot, homedir()]);
}
