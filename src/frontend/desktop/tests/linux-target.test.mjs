import path from "node:path";
import { describe, expect, it } from "vitest";
import { packagedTarget } from "../scripts/before-build.mjs";
import {
  buildRootFor,
  nativeLockFile,
  parseTarget,
  readJson,
  sourceRoot,
  uvCacheDir,
} from "../scripts/runtime/common.mjs";
import {
  sourceBuildUpdatePolicy,
  stagedUpdatePolicy,
  validateReleasePolicy,
} from "../scripts/runtime/release-policy.mjs";

const linux = { platform: "linux", arch: "x64" };
const linuxArgs = ["--platform", "linux", "--arch", "x64"];

describe("linux-x64 runtime target", () => {
  it("is staged only on a Linux x64 host", () => {
    expect(parseTarget(linuxArgs, linux)).toMatchObject({
      platform: "linux",
      arch: "x64",
      target: "linux-x64",
    });
    expect(() =>
      parseTarget(["--platform", "linux", "--arch", "arm64"], {
        platform: "linux",
        arch: "arm64",
      }),
    ).toThrow("Supported targets are");
    for (const host of [
      { platform: "darwin", arch: "arm64" },
      { platform: "win32", arch: "x64" },
      { platform: "linux", arch: "arm64" },
    ])
      expect(() => parseTarget(linuxArgs, host)).toThrow("cross-building");
    expect(() =>
      parseTarget(["--platform", "darwin", "--arch", "arm64"], linux),
    ).toThrow("cross-building");
  });

  it("has its own native lock, and an unknown target has none", () => {
    expect(path.basename(nativeLockFile(linux))).toBe(
      "native-components.linux-x64.lock.json",
    );
    expect(
      path.basename(nativeLockFile({ platform: "darwin", arch: "arm64" })),
    ).toBe("native-components.lock.json");
    expect(
      path.basename(nativeLockFile({ platform: "win32", arch: "x64" })),
    ).toBe("native-components.win32-x64.lock.json");
    expect(() => nativeLockFile({ platform: "linux", arch: "arm64" })).toThrow(
      "No native component lock",
    );
  });

  it("builds below a neutral root and caches under the XDG cache folder", () => {
    expect(buildRootFor("linux")).toBe("/var/tmp/animama-build");
    expect(buildRootFor("darwin")).toBe("/Users/Shared/animama-build");
    expect(buildRootFor("win32")).toBe("C:\\animama-build");
    // Expectations use the host's separator, like the code under test.
    const home = path.join("/home/builder", ".cache", "animama", "uv-cache");
    expect(uvCacheDir("linux", {}, "/home/builder")).toBe(home);
    expect(
      uvCacheDir("linux", { XDG_CACHE_HOME: "/cache" }, "/home/builder"),
    ).toBe(path.join("/cache", "animama", "uv-cache"));
    // A relative XDG value is invalid by the specification and is ignored.
    expect(
      uvCacheDir("linux", { XDG_CACHE_HOME: "cache" }, "/home/builder"),
    ).toBe(home);
    expect(uvCacheDir("linux", { UV_CACHE_DIR: "/uv" }, "/home/builder")).toBe(
      "/uv",
    );
    expect(uvCacheDir("darwin", {}, "/Users/builder")).toBe(
      path.join("/Users/builder", "Library", "Caches", "Animama", "uv-cache"),
    );
  });

  it("is listed in the source manifest and the runtime manifest schema", () => {
    const sources = readJson(path.join(sourceRoot, "source-manifest.json"));
    // The Linux minimum is measured from the staged binaries, not pinned.
    expect(sources.targets["linux-x64"]).toEqual({
      minimum_os: "glibc",
      status: "source-build",
    });
    const schema = readJson(
      path.join(sourceRoot, "desktop-runtime.schema.json"),
    );
    expect(schema.properties.platform.enum).toEqual([
      "darwin",
      "win32",
      "linux",
    ]);
    expect(schema.allOf).toContainEqual({
      if: { properties: { platform: { const: "linux" } } },
      then: { properties: { architecture: { const: "x64" } } },
    });
  });

  it("is packaged only for x64", () => {
    expect(
      packagedTarget({ platform: { nodeName: "linux" }, arch: "x64" }),
    ).toBe("linux-x64");
    expect(() =>
      packagedTarget({ platform: { nodeName: "linux" }, arch: "arm64" }),
    ).toThrow("Embedded packaging supports");
  });
});

describe("Linux update policy", () => {
  const sealed = {
    schema: "animama-update-policy/3",
    distribution: { kind: "r2", base_url: "https://downloads.example.test/d" },
    channel: "stable",
    updates: "offered",
    team_id: "TESTTEAM01",
  };

  it("seals updates off and names no publisher", () => {
    expect(sourceBuildUpdatePolicy(sealed)).toEqual({
      schema: "animama-update-policy/3",
      distribution: sealed.distribution,
      channel: "stable",
      updates: "ended",
    });
    const staged = stagedUpdatePolicy("linux-x64");
    expect(staged.updates).toBe("ended");
    expect(staged).not.toHaveProperty("team_id");
    expect(staged).not.toHaveProperty("windows_publisher");
    expect(["r2", "github"]).toContain(staged.distribution.kind);
  });

  it("leaves the macOS and Windows policies as they were", () => {
    expect(stagedUpdatePolicy("darwin-arm64")).toHaveProperty("team_id");
    expect(stagedUpdatePolicy("win32-x64")).toHaveProperty("windows_publisher");
  });

  it("is never a release target", () => {
    expect(() =>
      validateReleasePolicy({}, {}, "0.1.0", { target: "linux-x64" }),
    ).toThrow("Unsupported release target linux-x64");
  });
});
