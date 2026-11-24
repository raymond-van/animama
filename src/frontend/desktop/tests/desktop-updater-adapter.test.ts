import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { app } from "electron";
import {
  createMacUpdateAdapter,
  createWindowsUpdateAdapter,
  verifyUpdaterPublisher,
} from "../src/main-process/updates/electron-adapter.js";
import { runCommand } from "../src/main-process/runtime/processes.js";
import { validateUpdateCandidate } from "../src/main-process/updates/policy.js";

// Exercise the supported-library boundary without pretending a fixture is a signed app.
const fixture = vi.hoisted(() => ({
  native: null as unknown as EventEmitter & {
    checkForUpdates: ReturnType<typeof vi.fn>;
  },
  mac: null as unknown as {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    allowDowngrade: boolean;
    logger: unknown;
    downloadUpdate(): Promise<void>;
    quitAndInstall: ReturnType<typeof vi.fn>;
    isUpdateSupported?: (info: unknown) => boolean;
  },
  options: undefined as unknown,
  info: undefined as unknown,
  file: "",
  cancel: vi.fn(),
  beforeRequest: undefined as unknown as (
    details: { url: string },
    callback: (value: { cancel: boolean }) => void,
  ) => void,
  beforeSendHeaders: undefined as unknown as (
    details: { url: string; requestHeaders: Record<string, string> },
    callback: (value: { requestHeaders: Record<string, string> }) => void,
  ) => void,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  fixture.native = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(),
  });
  return { autoUpdater: fixture.native, app: { quit: vi.fn() } };
});
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    // Emits "spawn", or "error" for an installer path ending in "missing".
    spawn: vi.fn((file: string) => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      setImmediate(() =>
        file.endsWith("missing")
          ? child.emit("error", new Error("ENOENT"))
          : child.emit("spawn"),
      );
      return child;
    }),
  };
});
vi.mock("../src/main-process/runtime/processes.js", () => ({
  runCommand: vi.fn(async () => ""),
}));
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  const Updater = class extends EventEmitter {
    autoDownload = true;
    autoInstallOnAppQuit = true;
    allowDowngrade = true;
    logger: unknown = {};
    quitAndInstall = vi.fn();
    netSession = {
      webRequest: {
        onBeforeRequest: (callback: typeof fixture.beforeRequest) => {
          fixture.beforeRequest = callback;
        },
        onBeforeSendHeaders: (callback: typeof fixture.beforeSendHeaders) => {
          fixture.beforeSendHeaders = callback;
        },
        onHeadersReceived: vi.fn(),
      },
    };
    constructor(options: unknown) {
      super();
      fixture.mac = this;
      fixture.options = options;
    }
    async checkForUpdates() {
      return {
        isUpdateAvailable: true,
        updateInfo: fixture.info,
        cancellationToken: { cancel: fixture.cancel },
      };
    }
    async downloadUpdate() {
      this.emit("download-progress", { transferred: 6 });
      this.emit("update-downloaded", { downloadedFile: fixture.file });
    }
  };
  return { MacUpdater: Updater, NsisUpdater: Updater };
});

const policy = {
  schema: "animama-update-policy/3" as const,
  distribution: { kind: "github" as const, owner: "example", repo: "releases" },
  channel: "stable" as const,
  updates: "offered" as const,
  team_id: "TESTTEAM01",
};
const windowsPolicy = {
  schema: "animama-update-policy/3" as const,
  distribution: {
    kind: "r2" as const,
    base_url: "https://downloads.example.test/desktop",
  },
  channel: "stable" as const,
  updates: "offered" as const,
  windows_publisher: {
    certificate_subject: "CN=Example Publisher, O=Example Publisher, C=CA",
    identity_validation_eku: "1.3.6.1.4.1.311.97.1.2.3.4",
  },
};
let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.native.removeAllListeners();
  // Each test sees only the session hooks its own adapter registers.
  fixture.beforeRequest = undefined as never;
  fixture.beforeSendHeaders = undefined as never;
  root = mkdtempSync(path.join(realpathSync(tmpdir()), "animama-updater-"));
  fixture.file = path.join(root, "update.zip");
  writeFileSync(fixture.file, "zip fixture");
  fixture.info = {
    version: "0.2.0",
    tag: "v0.2.0",
    minimumSystemVersion: "24.0.0",
    files: [
      {
        url: "Animama-0.2.0-arm64.zip",
        size: 11,
        sha512: createHash("sha512").update("zip fixture").digest("base64"),
      },
    ],
    animama: {
      schema: "animama-update/1",
      platform: "darwin",
      architecture: "arm64",
      installed_bytes: 1000,
      runtime_build_id: "a".repeat(64),
      packs: [],
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe("macOS updater adapter", () => {
  it("passes a literal publisher requirement to codesign and refuses a failed signature", async () => {
    const app = path.join(root, "Animama.app");
    await verifyUpdaterPublisher(app, policy);
    expect(runCommand).toHaveBeenCalledWith(
      "/usr/bin/codesign",
      [
        "--verify",
        "--deep",
        "--strict",
        "-R",
        '=anchor apple generic and identifier "com.animama.desktop" and certificate leaf[subject.OU] = "TESTTEAM01"',
        app,
      ],
      {},
      app,
    );
    vi.mocked(runCommand).mockRejectedValueOnce(new Error("invalid signature"));
    await expect(verifyUpdaterPublisher(app, policy)).rejects.toThrow(
      "update_publisher_invalid",
    );
  });

  it("uses a public provider and does not hand a download to Squirrel until explicit install", async () => {
    const permitQuit = vi.fn();
    const adapter = createMacUpdateAdapter(policy, "0.1.0", permitQuit);
    const candidate = validateUpdateCandidate(
      fixture.info,
      "0.1.0",
      policy.distribution,
    );
    await adapter.check();
    await adapter.download(candidate, vi.fn());
    expect(fixture.options).toEqual({
      provider: "github",
      owner: "example",
      repo: "releases",
      private: false,
    });
    expect(fixture.mac).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowDowngrade: false,
      logger: null,
    });
    expect(fixture.native.checkForUpdates).not.toHaveBeenCalled();
    const install = adapter.install();
    expect(fixture.native.checkForUpdates).toHaveBeenCalledOnce();
    expect(permitQuit).not.toHaveBeenCalled();
    fixture.native.emit("update-downloaded");
    await install;
    expect(permitQuit).toHaveBeenCalledOnce();
    expect(fixture.mac.quitAndInstall).toHaveBeenCalledOnce();
    adapter.close();
  });
  it("uses a generic provider confined to the R2 base for an R2 build", async () => {
    const r2 = {
      ...policy,
      distribution: {
        kind: "r2" as const,
        base_url: "https://downloads.example.test/desktop",
      },
    };
    const info = fixture.info as { files: { url: string }[] };
    info.files[0].url = "v0.2.0/Animama-0.2.0-arm64.zip";
    const adapter = createMacUpdateAdapter(r2, "0.1.0", vi.fn());
    expect(fixture.options).toEqual({
      provider: "generic",
      url: "https://downloads.example.test/desktop",
    });
    const allowed = (url: string) => {
      let cancel = true;
      fixture.beforeRequest({ url }, (value) => (cancel = value.cancel));
      return !cancel;
    };
    expect(
      allowed(
        "https://downloads.example.test/desktop/latest-mac.yml?noCache=1",
      ),
    ).toBe(true);
    expect(allowed("https://github.com/example/releases/releases/latest")).toBe(
      false,
    );
    const candidate = validateUpdateCandidate(
      fixture.info,
      "0.1.0",
      r2.distribution,
    );
    await adapter.check();
    await adapter.download(candidate, vi.fn());
    expect(candidate.filename).toBe("Animama-0.2.0-arm64.zip");
  });

  it("rejects modified cache bytes and arbitrary updater hosts without exposing raw errors", async () => {
    const adapter = createMacUpdateAdapter(policy, "0.1.0", vi.fn());
    const callback = vi.fn();
    fixture.beforeRequest(
      { url: "https://hostile.invalid/update.zip" },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({ cancel: true });
    writeFileSync(fixture.file, "bad fixture");
    await expect(
      adapter.download(
        validateUpdateCandidate(fixture.info, "0.1.0", policy.distribution),
        vi.fn(),
      ),
    ).rejects.toThrow("update_download_invalid");
    expect(fixture.native.checkForUpdates).not.toHaveBeenCalled();
    adapter.close();
  });
  it("does not start downloading if Quit occurs during the fresh metadata check", async () => {
    const adapter = createMacUpdateAdapter(policy, "0.1.0", vi.fn());
    const bytes = vi.spyOn(fixture.mac, "downloadUpdate");
    const download = adapter.download(
      validateUpdateCandidate(fixture.info, "0.1.0", policy.distribution),
      vi.fn(),
    );
    adapter.close();
    await expect(download).rejects.toThrow("update_download_failed");
    expect(bytes).not.toHaveBeenCalled();
    expect(fixture.cancel).toHaveBeenCalled();
  });
  it("leaves native errors and late verification distinct, never approving quit after a timeout", async () => {
    vi.useFakeTimers();
    const permitQuit = vi.fn();
    const adapter = createMacUpdateAdapter(policy, "0.1.0", permitQuit);
    await adapter.download(
      validateUpdateCandidate(fixture.info, "0.1.0", policy.distribution),
      vi.fn(),
    );
    const install = adapter.install();
    const rejected = expect(install).rejects.toThrow("update_install_timeout");
    await vi.advanceTimersByTimeAsync(180_000);
    await rejected;
    fixture.native.emit("update-downloaded");
    expect(permitQuit).not.toHaveBeenCalled();
    expect(fixture.mac.quitAndInstall).not.toHaveBeenCalled();
    adapter.close();
  });
});

describe("Windows updater adapter", () => {
  const signedBy = (subject: string, ekus: string) =>
    vi.mocked(runCommand).mockResolvedValue(`${subject}\r\n${ekus}`);
  const valid = () =>
    signedBy(
      windowsPolicy.windows_publisher.certificate_subject,
      "1.3.6.1.5.5.7.3.3,1.3.6.1.4.1.311.97.1.2.3.4,1.3.6.1.4.1.311.97.1.0",
    );
  const windowsCandidate = () => {
    const info = fixture.info as {
      minimumSystemVersion: string;
      files: { url: string }[];
      animama: { platform: string; architecture: string; minimum_os: string };
    };
    info.minimumSystemVersion = "10.0.22000";
    info.files[0].url = "v0.2.0/Animama-0.2.0-x64-setup.exe";
    info.animama.platform = "win32";
    info.animama.architecture = "x64";
    info.animama.minimum_os = "10.0.18362";
    return validateUpdateCandidate(
      info,
      "0.1.0",
      windowsPolicy.distribution,
      "win32",
    );
  };
  afterEach(() => vi.mocked(runCommand).mockReset());

  it("passes the file through the environment and requires the exact subject and identity EKU", async () => {
    const file = path.join(root, "Animama.exe");
    valid();
    await verifyUpdaterPublisher(file, windowsPolicy);
    const [executable, args, env, cwd] = vi.mocked(runCommand).mock.calls[0]!;
    expect(executable).toMatch(/WindowsPowerShell.v1\.0.powershell\.exe$/u);
    expect(args.join(" ")).not.toContain(file);
    expect(env).toEqual({ ANIMAMA_SIGNED_FILE: file });
    expect(cwd).toBe(root);
    for (const [subject, ekus] of [
      ["CN=Example Publisher, O=Other, C=CA", "1.3.6.1.4.1.311.97.1.2.3.4"],
      [
        windowsPolicy.windows_publisher.certificate_subject,
        "1.3.6.1.4.1.311.97.1.0",
      ],
      [windowsPolicy.windows_publisher.certificate_subject, ""],
    ]) {
      signedBy(subject!, ekus!);
      await expect(verifyUpdaterPublisher(file, windowsPolicy)).rejects.toThrow(
        "update_publisher_invalid",
      );
    }
    // An invalid or missing signature makes the check exit non-zero.
    vi.mocked(runCommand).mockRejectedValue(new Error("exit 3"));
    await expect(verifyUpdaterPublisher(file, windowsPolicy)).rejects.toThrow(
      "update_publisher_invalid",
    );
  });

  it("rejects a download from another publisher and never installs it", async () => {
    const permitQuit = vi.fn();
    const adapter = createWindowsUpdateAdapter(
      windowsPolicy,
      "0.1.0",
      permitQuit,
    );
    signedBy("CN=Someone Else", "1.3.6.1.4.1.311.97.9.9.9.9");
    await expect(adapter.download(windowsCandidate(), vi.fn())).rejects.toThrow(
      "update_publisher_invalid",
    );
    await expect(adapter.install()).rejects.toThrow("update_download_required");
    expect(spawn).not.toHaveBeenCalled();
    expect(permitQuit).not.toHaveBeenCalled();
  });

  it("rechecks the publisher, starts the installer as an update and only then quits", async () => {
    const permitQuit = vi.fn();
    const adapter = createWindowsUpdateAdapter(
      windowsPolicy,
      "0.1.0",
      permitQuit,
    );
    expect(fixture.options).toEqual({
      provider: "generic",
      url: "https://downloads.example.test/desktop",
    });
    expect(fixture.mac).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowDowngrade: false,
      logger: null,
    });
    valid();
    await adapter.download(windowsCandidate(), vi.fn());
    expect(runCommand).toHaveBeenCalledTimes(1);
    await adapter.install();
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledWith(
      fixture.file,
      ["--updated", "--force-run"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(permitQuit).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(fixture.mac.quitAndInstall).not.toHaveBeenCalled();
  });

  it("reports a replaced or unstartable installer before quitting", async () => {
    const permitQuit = vi.fn();
    const adapter = createWindowsUpdateAdapter(
      windowsPolicy,
      "0.1.0",
      permitQuit,
    );
    valid();
    await adapter.download(windowsCandidate(), vi.fn());
    vi.mocked(runCommand).mockRejectedValueOnce(new Error("exit 3"));
    await expect(adapter.install()).rejects.toThrow("update_install_failed");
    expect(spawn).not.toHaveBeenCalled();
    // A same-publisher file swapped in after download is not the approved one.
    writeFileSync(fixture.file, "old fixture");
    await expect(adapter.install()).rejects.toThrow("update_install_failed");
    expect(spawn).not.toHaveBeenCalled();

    const missing = path.join(root, "missing");
    writeFileSync(missing, "zip fixture");
    fixture.file = missing;
    await adapter.download(windowsCandidate(), vi.fn());
    await expect(adapter.install()).rejects.toThrow("update_install_failed");
    expect(permitQuit).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("refuses a macOS policy", () => {
    expect(() => createWindowsUpdateAdapter(policy, "0.1.0", vi.fn())).toThrow(
      "updates_not_configured",
    );
  });

  it("offers an update by the release's own floor, not the frozen feed minimum", () => {
    windowsCandidate();
    const info = fixture.info as { animama: { minimum_os?: unknown } };
    // Windows 10 22H2: below the feed's frozen 10.0.22000.
    createWindowsUpdateAdapter(windowsPolicy, "0.1.0", vi.fn(), "10.0.19045");
    const supported = () => fixture.mac.isUpdateSupported!(fixture.info);
    expect(supported()).toBe(true);
    info.animama.minimum_os = "10.0.19045";
    expect(supported()).toBe(true);
    // A later release that needs a newer build is not offered here.
    info.animama.minimum_os = "10.0.19046";
    expect(supported()).toBe(false);
    // Malformed metadata is left for validation to report.
    for (const minimum_os of [undefined, "10.0", 19046]) {
      info.animama.minimum_os = minimum_os;
      expect(supported()).toBe(true);
    }
  });
});

describe("update support check on macOS", () => {
  it("keeps electron-updater's own minimum system version check", () => {
    createMacUpdateAdapter(policy, "0.1.0", vi.fn());
    expect(fixture.mac.isUpdateSupported).toBeUndefined();
  });
});

describe("update request headers", () => {
  // What Electron 45 hands the updater session for electron-updater 6.8.11's
  // requests. The feed check carries the random ID the library keeps for each
  // installation in <userData>/.updaterId; Chromium adds the system language.
  const added = {
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Dest": "empty",
    "Accept-Language": "ja",
  };
  const transport = {
    "Accept-Encoding": "identity",
    "User-Agent": "electron-builder",
    "Cache-Control": "no-cache",
  };
  const send = (url: string, requestHeaders: Record<string, string>) => {
    let sent: Record<string, string> | undefined;
    fixture.beforeSendHeaders(
      { url, requestHeaders },
      (value) => (sent = value.requestHeaders),
    );
    return sent;
  };

  it.each([
    [
      "macOS",
      () => createMacUpdateAdapter(policy, "0.1.0", vi.fn()),
      "https://github.com/example/releases/releases/download/v0.2.0/latest-mac.yml",
      "https://github.com/example/releases/releases/download/v0.2.0/Animama-0.2.0-arm64.zip",
    ],
    [
      "Windows",
      () => createWindowsUpdateAdapter(windowsPolicy, "0.1.0", vi.fn()),
      "https://downloads.example.test/desktop/latest.yml",
      "https://downloads.example.test/desktop/v0.2.0/Animama-0.2.0-x64-setup.exe",
    ],
  ])(
    "carry no per-installation value or system language on %s",
    (_platform, create, feed, download) => {
      create();
      for (const id of ["x-user-staging-id", "X-User-Staging-Id"])
        expect(
          send(feed, {
            [id]: "06ef7693-dac9-5eb8-80bc-29e45fa749d6",
            ...transport,
            ...added,
          }),
        ).toEqual(transport);
      expect(send(download, { accept: "*/*", ...transport, ...added })).toEqual(
        { accept: "*/*", ...transport },
      );
    },
  );
});
