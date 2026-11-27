import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopUpdateController,
  type UpdateAdapter,
} from "../src/main-process/updates/controller.js";
import { readFileSync } from "node:fs";
import {
  allowedUpdateUrl,
  hostUpdatePlatform,
  openSealedUpdates,
  updateFreeBytes,
  updatePlatform,
  validateUpdateCandidate,
  validateUpdatePolicy,
  windowsUpdateSupported,
} from "../src/main-process/updates/policy.js";
import { RuntimeError } from "../src/main-process/runtime/errors.js";

const policy = {
  schema: "animama-update-policy/3" as const,
  distribution: {
    kind: "github" as const,
    owner: "example",
    repo: "animama-releases",
  },
  channel: "stable" as const,
  updates: "offered" as const,
  team_id: "ABCDE12345",
};
const r2Policy = {
  ...policy,
  distribution: {
    kind: "r2" as const,
    base_url: "https://downloads.example.test/desktop",
  },
};
const feed = () => ({
  version: "0.2.0",
  tag: "v0.2.0",
  minimumSystemVersion: "24.0.0",
  files: [
    {
      url: "Animama-0.2.0-arm64.zip",
      size: 1000,
      sha512: Buffer.alloc(64).toString("base64"),
    },
  ],
  animama: {
    schema: "animama-update/1",
    platform: "darwin",
    architecture: "arm64",
    installed_bytes: 5000,
    runtime_build_id: "a".repeat(64),
    packs: [],
  },
});
function controller() {
  const adapter: UpdateAdapter = {
    check: vi.fn(async () => ({ available: true, info: feed() })),
    download: vi.fn(async (_candidate, progress) => progress(500)),
    install: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  const options = {
    version: "0.1.0",
    distribution: policy.distribution,
    platform: "darwin" as const,
    adapter,
    checkTimeoutMs: 10,
    disk: vi.fn(async () => ({ free: 10_000_000_000n, databaseBytes: 2000 })),
    preflight: vi.fn(async () => undefined),
    stopAndInstall: vi.fn(async (_candidate, install: () => Promise<void>) =>
      install(),
    ),
    onStatus: vi.fn(),
  };
  return { updates: new DesktopUpdateController(options), adapter, options };
}
afterEach(() => vi.useRealTimers());

describe("platforms that can update in place", () => {
  it("offers updates on macOS arm64 and Windows x64 only", () => {
    expect(hostUpdatePlatform("darwin", "arm64")).toBe("darwin");
    expect(hostUpdatePlatform("win32", "x64")).toBe("win32");
    // A Linux build is rebuilt from source; it never asks for a feed.
    for (const [platform, arch] of [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["darwin", "x64"],
      ["win32", "arm64"],
    ])
      expect(hostUpdatePlatform(platform, arch)).toBeUndefined();
  });

  it("is the only gate main.ts opens updates through", () => {
    const main = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );
    expect(main).toContain(
      "const platform = hostUpdatePlatform(process.platform, process.arch);",
    );
    expect(main).toMatch(
      /if \(!app\.isPackaged \|\| !platform \|\| !supervisor\) return Promise\.resolve\(\);/u,
    );
    expect(main.match(/openSealedUpdates\(/gu)).toHaveLength(1);
  });
});

describe("opening a packaged build's updates", () => {
  const open = (sealed: unknown, cancelled = false) => {
    const calls: string[] = [];
    const result = openSealedUpdates({
      platform: "darwin",
      readPolicy: async () => sealed,
      verifyPublisher: async () => {
        calls.push("verify");
      },
      cancelled: () => cancelled,
      create: () => {
        calls.push("create");
        return "controller";
      },
    });
    return { calls, result };
  };

  it("never checks the publisher or creates an updater when updates have ended", async () => {
    const { calls, result } = open({ ...policy, updates: "ended" });
    await expect(result).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("checks the publisher before creating the updater when updates are offered", async () => {
    const { calls, result } = open(policy);
    await expect(result).resolves.toBe("controller");
    expect(calls).toEqual(["verify", "create"]);
  });

  it("creates nothing when the app quits during the publisher check", async () => {
    const { calls, result } = open(policy, true);
    await expect(result).resolves.toBeUndefined();
    expect(calls).toEqual(["verify"]);
  });

  it("refuses an invalid sealed policy before anything else", async () => {
    const { calls, result } = open({ ...policy, updates: undefined });
    await expect(result).rejects.toThrow("updates_not_configured");
    expect(calls).toEqual([]);
  });
});

describe("public stable macOS update policy", () => {
  it("rejects credentials, alternate channels, targets, paths and unbounded feed sizes", () => {
    expect(validateUpdatePolicy(policy)).toEqual(policy);
    expect(validateUpdatePolicy(r2Policy)).toEqual(r2Policy);
    for (const distribution of [
      { kind: "github", repo: "releases" },
      { kind: "r2", base_url: "http://downloads.example.test/desktop" },
      { kind: "r2", base_url: "https://downloads.example.test/desktop/" },
      { kind: "r2", base_url: "https://downloads.example.test:8443/desktop" },
      { kind: "r2", base_url: "https://u@downloads.example.test/desktop" },
      { kind: "r2", base_url: "https://downloads.example.test/desktop?x=1" },
      {
        kind: "r2",
        base_url: "https://downloads.example.test/desktop",
        bucket: "b",
      },
      { kind: "s3", base_url: "https://downloads.example.test/desktop" },
      null,
    ])
      expect(() => validateUpdatePolicy({ ...policy, distribution })).toThrow(
        "updates_not_configured",
      );
    expect(() =>
      validateUpdatePolicy({
        schema: "animama-update-policy/1",
        github: { owner: "example", repo: "animama-releases" },
        channel: "stable",
        team_id: "ABCDE12345",
      }),
    ).toThrow("updates_not_configured");
    expect(() =>
      validateUpdatePolicy({ ...policy, token: "never-embedded" }),
    ).toThrow();
    // The final release seals updates off; nothing else is a valid state.
    const ended = { ...r2Policy, updates: "ended" as const };
    expect(validateUpdatePolicy(ended)).toEqual(ended);
    const { updates: _updates, ...unsealed } = policy;
    for (const value of [
      unsealed,
      { ...policy, updates: "paused" },
      { ...policy, updates: null },
      { ...policy, schema: "animama-update-policy/2" },
    ])
      expect(() => validateUpdatePolicy(value)).toThrow(
        "updates_not_configured",
      );
    for (const version of ["0.1.0", "0.0.9", "0.2.0-beta.1", "1.02.0"])
      expect(() =>
        validateUpdateCandidate(
          { ...feed(), version, tag: `v${version}` },
          "0.1.0",
          policy.distribution,
        ),
      ).toThrow();
    for (const field of [
      { minimumSystemVersion: "15.0" },
      { minimumSystemVersion: "22.0.0" },
      { minimumSystemVersion: "23.0.0" },
      { tag: "latest" },
      { stagingPercentage: 10 },
      {
        files: [
          { ...feed().files[0], url: "https://hostile.invalid/update.zip" },
        ],
      },
      { animama: { ...feed().animama, architecture: "x64" } },
      { files: [{ ...feed().files[0], size: 2 ** 32 }] },
    ])
      expect(() =>
        validateUpdateCandidate(
          { ...feed(), ...field },
          "0.1.0",
          policy.distribution,
        ),
      ).toThrow();
    expect(
      allowedUpdateUrl(
        "https://github.com/example/animama-releases/releases.atom",
        policy,
      ),
    ).toBe(true);
    for (const url of [
      "http://github.com/example/animama-releases/releases/latest",
      "https://github.com/attacker/repo/releases/latest",
      "https://github.com@example.invalid/releases",
      "https://secret@github.com/example/animama-releases/releases/latest",
      // A GitHub build never contacts R2.
      "https://downloads.example.test/desktop/latest-mac.yml",
      "file:///tmp/update.zip",
    ])
      expect(allowedUpdateUrl(url, policy)).toBe(false);
  });
  it("confines an R2 updater to the feed and versioned folders under its base URL", () => {
    const base = "https://downloads.example.test/desktop";
    for (const url of [
      `${base}/latest-mac.yml`,
      `${base}/latest-mac.yml?noCache=1j2k3l4m`,
      `${base}/v0.2.0/Animama-0.2.0-arm64.zip`,
    ])
      expect(allowedUpdateUrl(url, r2Policy)).toBe(true);
    for (const url of [
      `${base}/latest-mac.yml?token=secret`,
      `${base}/v0.2.0/Animama-0.2.0-arm64.zip?x=1`,
      `${base}/v0.2.0/nested/Animama-0.2.0-arm64.zip`,
      `${base}/other.yml`,
      `${base}/../latest-mac.yml`,
      "https://downloads.example.test/latest-mac.yml",
      "https://downloads.example.test/desktop-evil/latest-mac.yml",
      "https://evil.example.test/desktop/latest-mac.yml",
      "http://downloads.example.test/desktop/latest-mac.yml",
      "https://downloads.example.test:8443/desktop/latest-mac.yml",
      "https://github.com/example/animama-releases/releases.atom",
      "https://release-assets.githubusercontent.com/any",
    ])
      expect(allowedUpdateUrl(url, r2Policy)).toBe(false);
  });
  it("requires each distribution's own archive location in the feed", () => {
    const r2Feed = {
      ...feed(),
      files: [{ ...feed().files[0], url: "v0.2.0/Animama-0.2.0-arm64.zip" }],
    };
    expect(
      validateUpdateCandidate(r2Feed, "0.1.0", r2Policy.distribution).filename,
    ).toBe("Animama-0.2.0-arm64.zip");
    expect(() =>
      validateUpdateCandidate(feed(), "0.1.0", r2Policy.distribution),
    ).toThrow("update_metadata_invalid");
    expect(() =>
      validateUpdateCandidate(r2Feed, "0.1.0", policy.distribution),
    ).toThrow("update_metadata_invalid");
    expect(() =>
      validateUpdateCandidate(
        {
          ...r2Feed,
          files: [
            { ...r2Feed.files[0], url: "v0.3.0/Animama-0.2.0-arm64.zip" },
          ],
        },
        "0.1.0",
        r2Policy.distribution,
      ),
    ).toThrow("update_metadata_invalid");
  });
  it("includes installed bytes, updater staging and the actual database estimate", () => {
    expect(
      updateFreeBytes(
        validateUpdateCandidate(feed(), "0.1.0", policy.distribution),
        2000,
      ),
    ).toBe(2 * 1000 + 2 * 5000 + 2 * 2000 + 256 * 1024 ** 2);
  });
});

describe("public stable Windows update policy", () => {
  const { team_id: _teamId, ...base } = r2Policy;
  const windowsPolicy = {
    ...base,
    windows_publisher: {
      certificate_subject: "CN=Example Publisher, O=Example Publisher, C=CA",
      identity_validation_eku: "1.3.6.1.4.1.311.97.1.2.3.4",
    },
  };
  const windowsFeed = () => ({
    ...feed(),
    minimumSystemVersion: "10.0.22000",
    files: [
      {
        url: "v0.2.0/Animama-0.2.0-x64-setup.exe",
        size: 1000,
        sha512: Buffer.alloc(64).toString("base64"),
      },
    ],
    animama: {
      ...feed().animama,
      platform: "win32",
      architecture: "x64",
      minimum_os: "10.0.18362",
    },
  });

  it("names an Authenticode publisher instead of a Team ID", () => {
    expect(validateUpdatePolicy(windowsPolicy, "win32")).toEqual(windowsPolicy);
    const ended = { ...windowsPolicy, updates: "ended" as const };
    expect(validateUpdatePolicy(ended, "win32")).toEqual(ended);
    expect(updatePlatform(windowsPolicy)).toBe("win32");
    expect(updatePlatform(policy)).toBe("darwin");
    // Each platform reads only its own publisher shape.
    expect(() => validateUpdatePolicy(windowsPolicy)).toThrow(
      "updates_not_configured",
    );
    expect(() => validateUpdatePolicy(policy, "win32")).toThrow(
      "updates_not_configured",
    );
    for (const windows_publisher of [
      {
        certificate_subject: "O=No common name",
        identity_validation_eku: "1.3.6.1.4.1.311.97.1.2.3.4",
      },
      // The public-trust marker identifies no one.
      {
        certificate_subject: "CN=Example",
        identity_validation_eku: "1.3.6.1.4.1.311.97.1.0",
      },
      {
        certificate_subject: "CN=Example\n",
        identity_validation_eku: "1.3.6.1.4.1.311.97.1.2.3.4",
      },
      {
        certificate_subject: "CN=Example",
        identity_validation_eku: "1.3.6.1.4.1.311.97.1.2.3.4",
        thumbprint: "x",
      },
    ])
      expect(() =>
        validateUpdatePolicy({ ...windowsPolicy, windows_publisher }, "win32"),
      ).toThrow("updates_not_configured");
    expect(() =>
      validateUpdatePolicy(
        { ...windowsPolicy, team_id: "ABCDE12345" },
        "win32",
      ),
    ).toThrow("updates_not_configured");
  });

  it("withholds an update only from a Windows build below the release's floor", () => {
    const info = { animama: { minimum_os: "10.0.19045" } };
    expect(windowsUpdateSupported(info, "10.0.19045")).toBe(true);
    expect(windowsUpdateSupported(info, "10.0.26100")).toBe(true);
    expect(windowsUpdateSupported(info, "10.0.18362")).toBe(false);
    // With nothing well-formed to compare, validation reports the feed instead.
    for (const value of [
      null,
      {},
      { animama: {} },
      { animama: { minimum_os: "22000" } },
      // Not a string, though it would print as a well-formed floor.
      { animama: { minimum_os: ["10.0.99999"] } },
    ])
      expect(windowsUpdateSupported(value, "10.0.18362")).toBe(true);
    expect(windowsUpdateSupported(info, "")).toBe(true);
  });

  it("accepts only the per-user installer for Windows x64", () => {
    const candidate = validateUpdateCandidate(
      windowsFeed(),
      "0.1.0",
      windowsPolicy.distribution,
      "win32",
    );
    expect(candidate).toMatchObject({
      filename: "Animama-0.2.0-x64-setup.exe",
      downloadBytes: 1000,
      installedBytes: 5000,
    });
    // A later release may raise its floor; whether this system meets it is the
    // updater's support check, not metadata validity.
    expect(
      validateUpdateCandidate(
        {
          ...windowsFeed(),
          animama: { ...windowsFeed().animama, minimum_os: "10.0.19045" },
        },
        "0.1.0",
        windowsPolicy.distribution,
        "win32",
      ),
    ).toEqual(candidate);
    const file = windowsFeed().files[0];
    for (const field of [
      // The top-level value is frozen at what installed 0.1.6 apps require.
      { minimumSystemVersion: "10.0.18362" },
      { minimumSystemVersion: "10.0.19045" },
      { minimumSystemVersion: "24.0.0" },
      ...[undefined, "10.0", "6.3.9600", "10.0.18362.1", "10.0.x", 18362].map(
        (minimum_os) => ({
          animama: { ...windowsFeed().animama, minimum_os },
        }),
      ),
      { files: [{ ...file, url: "v0.2.0/Animama-0.2.0-x64.exe" }] },
      { files: [{ ...file, url: "v0.2.0/Animama-0.2.0-arm64.zip" }] },
      { files: [file, { ...file, url: "v0.2.0/Animama-0.2.0-x64.zip" }] },
      { files: [{ ...file, isAdminRightsRequired: true }] },
      { files: [{ ...file, isAdminRightsRequired: false }] },
      { animama: { ...windowsFeed().animama, platform: "darwin" } },
      { animama: { ...windowsFeed().animama, architecture: "arm64" } },
    ])
      expect(() =>
        validateUpdateCandidate(
          { ...windowsFeed(), ...field },
          "0.1.0",
          windowsPolicy.distribution,
          "win32",
        ),
      ).toThrow("update_metadata_invalid");
    // A macOS feed never satisfies a Windows build, nor the reverse.
    expect(() =>
      validateUpdateCandidate(
        {
          ...feed(),
          files: [
            { ...feed().files[0], url: "v0.2.0/Animama-0.2.0-arm64.zip" },
          ],
        },
        "0.1.0",
        windowsPolicy.distribution,
        "win32",
      ),
    ).toThrow("update_metadata_invalid");
    expect(() =>
      validateUpdateCandidate(windowsFeed(), "0.1.0", r2Policy.distribution),
    ).toThrow("update_metadata_invalid");
  });

  it("reads latest.yml, never the macOS feed", () => {
    const root = "https://downloads.example.test/desktop";
    for (const url of [
      `${root}/latest.yml`,
      `${root}/latest.yml?noCache=1j2k3l4m`,
      `${root}/v0.2.0/Animama-0.2.0-x64-setup.exe`,
    ])
      expect(allowedUpdateUrl(url, windowsPolicy)).toBe(true);
    for (const url of [
      `${root}/latest-mac.yml`,
      `${root}/latest.yml?token=secret`,
      `${root}/beta.yml`,
    ])
      expect(allowedUpdateUrl(url, windowsPolicy)).toBe(false);
    expect(allowedUpdateUrl(`${root}/latest.yml`, r2Policy)).toBe(false);
  });
});

describe("consent-driven desktop updates", () => {
  it("never downloads at check time and installs only after a second preflight and service shutdown", async () => {
    const { updates, adapter, options } = controller();
    expect(await updates.check()).toMatchObject({
      state: "available",
      version: "0.2.0",
    });
    expect(adapter.download).not.toHaveBeenCalled();
    await updates.restart();
    expect(adapter.install).not.toHaveBeenCalled();
    expect(await updates.download()).toMatchObject({ state: "downloaded" });
    expect(adapter.install).not.toHaveBeenCalled();
    options.stopAndInstall.mockImplementationOnce(
      async (_candidate, install) => {
        expect(adapter.install).not.toHaveBeenCalled();
        expect(options.preflight).toHaveBeenCalledTimes(2);
        await install();
      },
    );
    await updates.restart();
    expect(adapter.install).toHaveBeenCalledOnce();
  });
  it.each(["update_pack_references_blocked", "update_pack_operation_active"])(
    "keeps the current app when preflight fails: %s",
    async (code) => {
      const { updates, adapter, options } = controller();
      await updates.check();
      options.preflight.mockRejectedValueOnce(new RuntimeError(code));
      expect(await updates.download()).toMatchObject({ state: "error", code });
      expect(adapter.download).not.toHaveBeenCalled();
      expect(options.stopAndInstall).not.toHaveBeenCalled();
    },
  );
  it("rechecks free space and compatibility after download and never applies if shutdown fails", async () => {
    const { updates, adapter, options } = controller();
    await updates.check();
    await updates.download();
    options.disk.mockResolvedValueOnce({ free: 1n, databaseBytes: 2000 });
    await updates.restart();
    expect(updates.status()).toMatchObject({
      state: "error",
      code: "update_insufficient_disk",
    });
    expect(options.stopAndInstall).not.toHaveBeenCalled();
    options.stopAndInstall.mockRejectedValueOnce(
      new RuntimeError("owned_services_stop_failed"),
    );
    await updates.restart();
    expect(adapter.install).not.toHaveBeenCalled();
  });
  it("bounds an offline startup check and returns only a safe category", async () => {
    const { updates, adapter } = controller();
    vi.mocked(adapter.check).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    expect(await updates.check()).toEqual({
      state: "error",
      code: "update_check_timeout",
      retry: "check",
    });
    vi.mocked(adapter.check).mockRejectedValueOnce(
      new Error("credential and host path"),
    );
    expect(await updates.check()).toEqual({
      state: "error",
      code: "update_check_failed",
      retry: "check",
    });
    expect(adapter.download).not.toHaveBeenCalled();
  });
  it("cancels the startup timer and cannot start a late download after quit", async () => {
    const { updates, adapter, options } = controller();
    await updates.check();
    let finish!: () => void;
    options.preflight.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const download = updates.download();
    updates.close();
    finish();
    await download;
    expect(adapter.download).not.toHaveBeenCalled();
    expect(adapter.close).toHaveBeenCalledOnce();
  });
});
