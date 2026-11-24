import { app, autoUpdater as nativeUpdater } from "electron";
import {
  MacUpdater,
  NsisUpdater,
  type AppUpdater,
  type UpdateCheckResult,
} from "electron-updater";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";
import { RuntimeError } from "../runtime/errors.js";
import { runCommand } from "../runtime/processes.js";
import {
  allowedUpdateUrl,
  updatePlatform,
  validateUpdateCandidate,
  windowsUpdateSupported,
  type UpdateCandidate,
  type UpdatePolicy,
  type WindowsPublisher,
} from "./policy.js";
import type { UpdateAdapter } from "./controller.js";

/** A developer/ad-hoc core cannot participate in the production update chain. */
export async function verifyUpdaterPublisher(
  appPath: string,
  policy: UpdatePolicy,
): Promise<void> {
  if (!("team_id" in policy)) {
    await verifyWindowsPublisher(appPath, policy.windows_publisher);
    return;
  }
  try {
    await runCommand(
      "/usr/bin/codesign",
      [
        "--verify",
        "--deep",
        "--strict",
        "-R",
        `=anchor apple generic and identifier "com.animama.desktop" and certificate leaf[subject.OU] = "${policy.team_id}"`,
        appPath,
      ],
      {},
      appPath,
    );
  } catch {
    throw new RuntimeError("update_publisher_invalid");
  }
}

// The path arrives through the environment, so no file name is ever parsed as
// PowerShell. Status Valid means a trusted chain and an intact file. Output is
// UTF-8 so a non-ASCII subject compares exactly.
const AUTHENTICODE_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$s = Get-AuthenticodeSignature -LiteralPath $env:ANIMAMA_SIGNED_FILE",
  "if ($s.Status -ne 'Valid') { exit 3 }",
  "$c = $s.SignerCertificate",
  "[Console]::Out.Write($c.Subject + \"`n\" + (($c.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId }) -join ','))",
].join("; ");

/**
 * A Windows file must carry a valid Authenticode signature from the build's
 * Artifact Signing identity: the exact certificate subject and the identity
 * validation EKU that a different validated identity could not have.
 */
export async function verifyWindowsPublisher(
  file: string,
  publisher: WindowsPublisher,
): Promise<void> {
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  let output: string;
  try {
    output = await runCommand(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", AUTHENTICODE_SCRIPT],
      { ANIMAMA_SIGNED_FILE: file },
      path.dirname(file),
      60_000,
    );
  } catch {
    throw new RuntimeError("update_publisher_invalid");
  }
  const [subject, ekus = ""] = output.trim().split(/\r?\n/u);
  if (
    subject !== publisher.certificate_subject ||
    !ekus.split(",").includes(publisher.identity_validation_eku)
  )
    throw new RuntimeError("update_publisher_invalid");
}

/** Recheck the exact bytes the person approved: a regular single-link file of the feed's size and SHA-512. */
async function verifyDownloadedBytes(
  downloadedFile: string,
  expected: UpdateCandidate,
): Promise<void> {
  const file = await open(
    downloadedFile,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size !== expected.downloadBytes
    )
      throw new RuntimeError("update_download_invalid");
    const hash = createHash("sha512");
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hash.update(chunk);
    if (hash.digest("base64") !== expected.sha512)
      throw new RuntimeError("update_download_invalid");
  } finally {
    await file.close();
  }
}

/**
 * The only headers an update request needs. electron-updater also sends a
 * random ID it keeps for each installation (`<userData>/.updaterId`) for staged
 * rollouts, which no feed may use (see `validateUpdateCandidate`), and Chromium
 * adds the system language.
 */
const UPDATE_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "cache-control",
  "user-agent",
]);

/**
 * Pin the transport and consent rules shared by every platform: no automatic
 * download or install, no prerelease, downgrade, differential or web
 * installer, and requests confined to the sealed distribution that carry
 * nothing about the installation.
 */
function createUpdateAdapter(
  policy: UpdatePolicy,
  currentVersion: string,
  updater: AppUpdater,
  verifyDownload: (file: string) => Promise<void>,
  installDownloaded: (file: string, expected: UpdateCandidate) => Promise<void>,
): UpdateAdapter {
  const { distribution } = policy;
  const platform = updatePlatform(policy);
  updater.logger = null; // Library logs contain paths, signed redirect URLs and Squirrel capabilities.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.channel = "latest";
  updater.allowDowngrade = false; // Setting channel above otherwise turns this on.
  updater.allowPrerelease = false;
  updater.disableDifferentialDownload = true;
  updater.disableWebInstaller = true;
  updater.forceDevUpdateConfig = false;
  updater.requestHeaders = { "Accept-Encoding": "identity" };
  let checked: UpdateCheckResult | null = null;
  let candidate: UpdateCandidate | undefined;
  let downloadedFile: string | undefined;
  let progress: ((bytes: number) => void) | undefined;
  let closed = false;
  updater.netSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allowedUpdateUrl(details.url, policy) }),
  );
  updater.netSession.webRequest.onBeforeSendHeaders((details, callback) =>
    callback({
      requestHeaders: Object.fromEntries(
        Object.entries(details.requestHeaders).filter(([name]) =>
          UPDATE_REQUEST_HEADERS.has(name.toLowerCase()),
        ),
      ),
    }),
  );
  updater.netSession.webRequest.onHeadersReceived((details, callback) => {
    const length = Object.entries(details.responseHeaders ?? {}).find(
      ([key]) => key.toLowerCase() === "content-length",
    )?.[1]?.[0];
    const archive =
      candidate &&
      new URL(details.url).pathname.endsWith(`/${candidate.filename}`);
    callback({
      cancel: Boolean(
        archive &&
        details.statusCode === 200 &&
        length !== String(candidate!.downloadBytes),
      ),
    });
  });
  updater.on("download-progress", (event) => {
    if (candidate && event.transferred > candidate.downloadBytes)
      checked?.cancellationToken?.cancel();
    else progress?.(event.transferred);
  });
  updater.on("update-downloaded", (event) => {
    downloadedFile = event.downloadedFile;
  });
  // Errors are delivered by the awaited operations. Never forward raw messages to IPC/logs.
  updater.on("error", () => undefined);
  return {
    async check() {
      if (closed) return null;
      checked = await updater.checkForUpdates();
      return checked
        ? { available: checked.isUpdateAvailable, info: checked.updateInfo }
        : null;
    },
    async download(expected, listener) {
      if (closed) throw new RuntimeError("update_download_failed");
      // Refresh the library's internal provider state and token; never download a
      // different release than the one the person approved in the UI.
      checked = await updater.checkForUpdates();
      if (closed) {
        checked?.cancellationToken?.cancel();
        throw new RuntimeError("update_download_failed");
      }
      if (
        !checked?.isUpdateAvailable ||
        JSON.stringify(
          validateUpdateCandidate(
            checked.updateInfo,
            currentVersion,
            distribution,
            platform,
          ),
        ) !== JSON.stringify(expected)
      ) {
        throw new RuntimeError("update_changed_check_again");
      }
      candidate = expected;
      downloadedFile = undefined;
      progress = listener;
      try {
        await updater.downloadUpdate(checked.cancellationToken);
        if (closed || !downloadedFile)
          throw new RuntimeError("update_download_failed");
        await verifyDownloadedBytes(downloadedFile, expected);
        await verifyDownload(downloadedFile);
      } catch (error) {
        downloadedFile = undefined;
        throw error;
      } finally {
        progress = undefined;
      }
    },
    async install() {
      if (closed || !downloadedFile || !candidate)
        throw new RuntimeError("update_download_required");
      // Only called after explicit Restart and successful owned-service shutdown.
      await installDownloaded(downloadedFile, candidate);
    },
    close() {
      closed = true;
      checked?.cancellationToken?.cancel();
      progress = undefined;
    },
  };
}

function providerOptions(policy: UpdatePolicy) {
  const { distribution } = policy;
  return distribution.kind === "r2"
    ? { provider: "generic" as const, url: distribution.base_url }
    : {
        provider: "github" as const,
        owner: distribution.owner,
        repo: distribution.repo,
        private: false,
      };
}

/** Pin transport/publisher policy while leaving update ZIP and OS verification to the supported updater. */
export function createMacUpdateAdapter(
  policy: UpdatePolicy,
  currentVersion: string,
  permitQuit: () => void,
): UpdateAdapter {
  const updater = new MacUpdater(providerOptions(policy));
  return createUpdateAdapter(
    policy,
    currentVersion,
    updater,
    async () => undefined,
    async () => {
      // With autoInstallOnAppQuit=false, Squirrel has not yet read this ZIP.
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          nativeUpdater.removeListener("update-downloaded", ready);
          nativeUpdater.removeListener("error", failed);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new RuntimeError("update_install_failed"));
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new RuntimeError("update_install_timeout"));
        }, 180_000);
        nativeUpdater.once("update-downloaded", ready);
        nativeUpdater.once("error", failed);
        try {
          nativeUpdater.checkForUpdates();
        } catch {
          failed();
        }
      });
      permitQuit();
      updater.quitAndInstall();
    },
  );
}

/**
 * Windows downloads the per-user NSIS installer. Its publisher is checked when
 * the download completes and again just before it runs; the installer is
 * started here, so a failure to start it is reported before Animama quits.
 */
export function createWindowsUpdateAdapter(
  policy: UpdatePolicy,
  currentVersion: string,
  permitQuit: () => void,
  kernelRelease: string = release(),
): UpdateAdapter {
  if ("team_id" in policy) throw new RuntimeError("updates_not_configured");
  const publisher = policy.windows_publisher;
  const verify = (file: string) => verifyWindowsPublisher(file, publisher);
  const updater = new NsisUpdater(providerOptions(policy));
  // electron-updater would compare this system with the feed's frozen
  // top-level minimum and offer Windows 10 nothing.
  updater.isUpdateSupported = (info) =>
    windowsUpdateSupported(info, kernelRelease);
  return createUpdateAdapter(
    policy,
    currentVersion,
    updater,
    verify,
    async (file, expected) => {
      // The same approved bytes and publisher as at download.
      try {
        await verifyDownloadedBytes(file, expected);
        await verify(file);
      } catch {
        throw new RuntimeError("update_install_failed");
      }
      // `--updated` tells the uninstall step this is an upgrade, so it never
      // asks about data; the installer starts the new version when it ends.
      await new Promise<void>((resolve, reject) => {
        const installer = spawn(file, ["--updated", "--force-run"], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        installer.once("error", () =>
          reject(new RuntimeError("update_install_failed")),
        );
        installer.once("spawn", () => {
          installer.unref();
          resolve();
        });
      });
      permitQuit();
      app.quit();
    },
  );
}
