// `pnpm desktop:test:termination`: each platform with a process guard has its
// own harness, because finding and killing processes differs. macOS has no
// guard and no such guarantee.
if (process.platform === "win32")
  await import("./test-runtime-termination-windows.mjs");
else if (process.platform === "linux")
  await import("./test-runtime-termination-linux.mjs");
else
  throw new Error(
    "The runtime termination harness runs on Windows and Linux only",
  );
