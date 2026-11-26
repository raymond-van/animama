import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, Platform, Arch } from "electron-builder";
import { sha256 } from "../scripts/runtime/common.mjs";
import { validateReleasePolicy } from "../scripts/runtime/release-policy.mjs";
import {
  releaseName,
  releaseSizes,
  updateFeed,
  verifyArtifactIndex,
  writeArtifactIndex,
} from "../scripts/runtime/release-artifacts.mjs";
import {
  certificateTableSize,
  portableExecutables,
  signatureEntry,
  signingOrder,
  signtoolArguments,
  validateSigningReport,
  WINDOWS_EXECUTABLE,
} from "../scripts/runtime/windows-signing.mjs";
import {
  builderSigningHook,
  parseWindowsReleaseArgs,
  windowsBuilderOptions,
} from "../scripts/runtime/release-windows.mjs";
import { iconFile } from "../scripts/runtime/windows-resources.mjs";
import {
  candidateDistribution,
  isWindowsReleaseName,
  mayResumeRelease,
  previewAssets,
} from "../scripts/runtime/release-artifacts.mjs";
import { verifyScanReceipt } from "../scripts/runtime/publication.mjs";
import {
  acceptsRequiredNameSmoke,
  manualWindowsChecks,
  validateManualAcceptance,
} from "../scripts/runtime/smoke-policy.mjs";
import { homeDirectoryNeedles } from "../scripts/runtime/release-scan.mjs";
import {
  validateUpdateCandidate,
  windowsUpdateSupported,
} from "../src/main-process/updates/policy.ts";
import { validateUpdateCandidate as validateUpdateCandidateAsShippedIn016 } from "./fixtures/update-policy-0.1.6.js";
import {
  ownedWindowsChild,
  parseProcessImages,
  windowsLaunchEnvironment,
  windowsProfile,
} from "../scripts/runtime/smoke-windows.mjs";
import { validateUpdatePolicy } from "../src/main-process/updates/policy.js";

const roots = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "animama-windows-release-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const publisher = {
  endpoint: "https://eus.codesigning.azure.net/",
  account: "fixture-signing",
  certificate_profile: "fixture-public",
  certificate_subject: "CN=Fixture Publisher, O=Fixture Publisher, C=CA",
  identity_validation_eku: "1.3.6.1.4.1.311.97.11.22.33.44",
};
const review = {
  inventory_sha256: "a".repeat(64),
  reviewed_by: "Fixture reviewer",
  reviewed_on: "2026-09-01",
};
const policy = {
  schema: "animama-release-policy/4",
  updates: "offered",
  channel: "stable",
  distributions: {
    r2: {
      base_url: "https://downloads.example.test/desktop",
      bucket: "example-releases",
    },
    github: { owner: "example", repo: "releases" },
  },
  distribution_basis: {
    commercial: false,
    pocket_tts_onnx_license: "CC-BY-4.0",
  },
  redistribution_reviews: { "win32-x64": review },
};
const packs = {
  macos: {
    team_id: "TESTTEAM01",
    signing_identity: "Developer ID Application: Fixture (TESTTEAM01)",
  },
  windows: publisher,
  packs: {
    "expanded-included-content": { release_status: "deferred" },
  },
};

describe("Windows release policy", () => {
  it("binds the Windows receipt and the Artifact Signing publisher to the win32-x64 target", () => {
    const release = validateReleasePolicy(policy, packs, "0.1.0", {
      distribution: "r2",
      target: "win32-x64",
    });
    expect(release.review).toEqual(review);
    expect(release.windowsPublisher).toEqual(publisher);
    // A macOS release neither needs nor uses the Windows receipt.
    expect(() =>
      validateReleasePolicy(policy, packs, "0.1.0", { distribution: "r2" }),
    ).toThrow("darwin-arm64 licenses/inventory.json");
    // Staging seals the distribution before any review exists.
    expect(
      validateReleasePolicy(
        { ...policy, redistribution_reviews: {} },
        packs,
        "0.1.0",
        { distribution: "r2", target: "win32-x64", requireReview: false },
      ).review,
    ).toBeNull();
  });

  it("refuses a Windows release without a complete, pinned publisher", () => {
    const check = (windows) => () =>
      validateReleasePolicy(policy, { ...packs, windows }, "0.1.0", {
        distribution: "r2",
        target: "win32-x64",
      });
    const message = "Windows Artifact Signing publisher";
    expect(check(undefined)).toThrow(message);
    expect(
      check({ ...publisher, endpoint: "http://eus.codesigning.azure.net/" }),
    ).toThrow(message);
    expect(
      check({ ...publisher, endpoint: "https://codesigning.example.test/" }),
    ).toThrow(message);
    // 311.97.1.0 marks public trust; it identifies no validated identity.
    expect(
      check({
        ...publisher,
        identity_validation_eku: "1.3.6.1.4.1.311.97.1.0",
      }),
    ).toThrow(message);
    expect(check({ ...publisher, certificate_subject: "Fixture" })).toThrow(
      message,
    );
    expect(check({ ...publisher, client_secret: "x" })).toThrow(message);
  });
});

describe("Windows signing", () => {
  it("finds every PE file and orders nested code deepest first, then the outer files", () => {
    const root = fixture();
    const pe = Buffer.alloc(256);
    pe.write("MZ", 0, "latin1");
    pe.writeUInt32LE(128, 0x3c);
    pe.write("PE\0\0", 128, "latin1");
    for (const name of [
      "Animama.exe",
      "ffmpeg.dll",
      "resources/app.asar.unpacked/dist/native/global_input_hook.node",
      "resources/runtime/bin/animama-process-guard.exe",
      "resources/runtime/postgresql/bin/postgres.exe",
      "resources/runtime/postgresql/lib/vector.dll",
      "resources/runtime/backend/_internal/python312.dll",
    ]) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), pe);
    }
    writeFileSync(path.join(root, "resources/runtime/manifest.json"), "{}");
    writeFileSync(path.join(root, "LICENSE.electron.txt"), "MZ text");
    const files = portableExecutables(root);
    expect(files).toHaveLength(7);
    // electron-builder signs Animama.exe itself, after these.
    const order = signingOrder(
      files.filter((file) => file !== WINDOWS_EXECUTABLE),
    );
    expect(order.nested).toEqual([
      "resources/app.asar.unpacked/dist/native/global_input_hook.node",
      "resources/runtime/backend/_internal/python312.dll",
      "resources/runtime/postgresql/bin/postgres.exe",
      "resources/runtime/postgresql/lib/vector.dll",
      "resources/runtime/bin/animama-process-guard.exe",
    ]);
    expect(order.outer).toEqual(["ffmpeg.dll"]);
  });

  it("reads an embedded signature from the PE certificate table, not from catalog trust", () => {
    const root = fixture();
    // A minimal PE header: PE32+ or PE32 optional header with data directory 4.
    const image = (magic, size) => {
      const bytes = Buffer.alloc(512);
      bytes.write("MZ", 0, "latin1");
      bytes.writeUInt32LE(64, 0x3c);
      bytes.write("PE\0\0", 64, "latin1");
      const optional = 64 + 24;
      bytes.writeUInt16LE(magic, optional);
      const directories = optional + (magic === 0x20b ? 112 : 96);
      bytes.writeUInt32LE(size ? 400 : 0, directories + 32);
      bytes.writeUInt32LE(size, directories + 36);
      return bytes;
    };
    for (const [name, magic, size] of [
      ["signed64.dll", 0x20b, 10600],
      ["catalog-only.dll", 0x20b, 0],
      ["signed32.exe", 0x10b, 9000],
    ])
      writeFileSync(path.join(root, name), image(magic, size));
    expect(certificateTableSize(path.join(root, "signed64.dll"))).toBe(10600);
    expect(certificateTableSize(path.join(root, "catalog-only.dll"))).toBe(0);
    expect(certificateTableSize(path.join(root, "signed32.exe"))).toBe(9000);
  });

  it("signs with SHA-256 file and timestamp digests through the pinned client, never a credential argument", () => {
    const args = signtoolArguments(
      {
        dlib: "C:\\tools\\Azure.CodeSigning.Dlib.dll",
        timestampUrl: "http://timestamp.acs.microsoft.com",
      },
      "C:\\temp\\metadata.json",
      ["C:\\app\\a.dll", "C:\\app\\b.exe"],
    );
    expect(args).toEqual([
      "sign",
      "/fd",
      "SHA256",
      "/tr",
      "http://timestamp.acs.microsoft.com",
      "/td",
      "SHA256",
      "/dlib",
      "C:\\tools\\Azure.CodeSigning.Dlib.dll",
      "/dmdf",
      "C:\\temp\\metadata.json",
      "C:\\app\\a.dll",
      "C:\\app\\b.exe",
    ]);
  });

  it("accepts only valid signatures: Animama's with its identity and a timestamp, or a kept vendor signature", () => {
    const ours = {
      status: "Valid",
      embedded: true,
      subject: publisher.certificate_subject,
      timestamped: true,
      eku: ["1.3.6.1.5.5.7.3.3", publisher.identity_validation_eku],
    };
    expect(
      signatureEntry("a.dll", "f".repeat(64), ours, publisher, true),
    ).toEqual({
      path: "a.dll",
      sha256: "f".repeat(64),
      signer: "animama",
      status: "Valid",
      subject: publisher.certificate_subject,
      timestamped: true,
    });
    const vendor = {
      status: "Valid",
      embedded: true,
      subject: "CN=Microsoft Corporation",
      timestamped: false,
      eku: [],
    };
    expect(
      signatureEntry("d3d.dll", "e".repeat(64), vendor, publisher, false)
        .signer,
    ).toBe("vendor");
    for (const bad of [
      { ...ours, status: "HashMismatch" },
      { ...ours, timestamped: false },
      { ...ours, subject: "CN=Someone Else" },
      { ...ours, eku: ["1.3.6.1.5.5.7.3.3"] },
    ])
      expect(() =>
        signatureEntry("a.dll", "f".repeat(64), bad, publisher, true),
      ).toThrow("a.dll");
    // A catalog signature, valid only on this host, carries no certificate table.
    for (const bad of [
      { ...vendor, status: "NotSigned" },
      { ...vendor, embedded: false },
    ])
      expect(() =>
        signatureEntry("x.dll", "f".repeat(64), bad, publisher, false),
      ).toThrow("x.dll");
  });

  it("rejects a signing report with any unsigned file or an unsigned installer", () => {
    const entry = {
      path: "Animama.exe",
      sha256: "f".repeat(64),
      signer: "animama",
      status: "Valid",
      subject: publisher.certificate_subject,
      timestamped: true,
    };
    const report = {
      schema: "animama-windows-signing/1",
      app_version: "0.1.0",
      release_ready: true,
      stage_build_id: "a".repeat(64),
      runtime_build_id: "b".repeat(64),
      certificate_subject: publisher.certificate_subject,
      files: [entry],
      installer: { ...entry, path: "Animama-0.1.0-x64-setup.exe" },
      uninstaller: { ...entry, path: "uninstaller" },
      signed_files: 3,
    };
    expect(validateSigningReport(report, publisher)).toBe(report);
    expect(() =>
      validateSigningReport(
        { ...report, files: [{ ...entry, status: "NotSigned" }] },
        publisher,
      ),
    ).toThrow("Animama.exe");
    expect(() =>
      validateSigningReport({ ...report, uninstaller: null }, publisher),
    ).toThrow("uninstaller");
    expect(() =>
      validateSigningReport({ ...report, signed_files: 2 }, publisher),
    ).toThrow("count of signed files");
    expect(() =>
      validateSigningReport(
        { ...report, runtime_build_id: report.stage_build_id },
        publisher,
      ),
    ).toThrow("re-inventoried");
  });
});

describe("Windows release candidate", () => {
  it("accepts only the signing rehearsal option", () => {
    expect(parseWindowsReleaseArgs([])).toEqual({ rehearsal: false });
    expect(parseWindowsReleaseArgs(["--signing-rehearsal"])).toEqual({
      rehearsal: true,
    });
    expect(() => parseWindowsReleaseArgs(["--skip-review"])).toThrow();
  });

  it("signs only through the repository hook: no Azure module or SHA-1", () => {
    const sign = () => {};
    const afterPack = () => {};
    const options = windowsBuilderOptions({
      icon: "icon.ico",
      release: {
        distribution: {
          name: "r2",
          base_url: "https://downloads.example.test/desktop",
        },
      },
      afterPack,
      sign,
    });
    expect(options.publish).toBe("never");
    expect(options.config.forceCodeSigning).toBe(true);
    expect(options.config.afterPack).toBe(afterPack);
    expect(options.config.extraMetadata).toEqual({ name: "Animama" });
    expect(options.config.win).toEqual({
      icon: "icon.ico",
      signtoolOptions: { signingHashAlgorithms: ["sha256"], sign },
    });
    expect(options.config.win).not.toHaveProperty("azureSignOptions");
    expect(options.config.publish).toEqual([
      {
        provider: "generic",
        url: "https://downloads.example.test/desktop",
        channel: "latest",
      },
    ]);
  });

  it("leaves files under the app's resources to afterPack and signs the rest", () => {
    const app = path.join(fixture(), "win-unpacked");
    const signed = [];
    const hook = builderSigningHook(app, (file) => signed.push(file));
    for (const file of [
      path.join(app, "resources/runtime/postgresql/bin/postgres.exe"),
      path.join(app, "resources/app.asar.unpacked/tool.exe"),
      path.join(app, "Animama.exe"),
      path.join(app, "../Animama-0.1.1-x64-setup.exe"),
      path.join(app, "../resources-elsewhere.exe"),
    ])
      hook({ path: file });
    expect(signed.map((file) => path.relative(app, file))).toEqual([
      "Animama.exe",
      path.join("..", "Animama-0.1.1-x64-setup.exe"),
      path.join("..", "resources-elsewhere.exe"),
    ]);
  });

  it("packages through electron-builder's Windows path: runtime files wait for afterPack and Animama.exe is edited before it is signed", async () => {
    const ResEdit = createRequire(import.meta.url)("resedit");
    const root = fixture();
    const write = (name, data) => {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), data);
    };
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
        "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
      "hex",
    );
    // A stand-in electron.exe with the version strings and icon group the real one has.
    const executable = ResEdit.NtExecutable.createEmpty(true, false);
    const resources = ResEdit.NtExecutableResource.from(executable);
    const info = ResEdit.Resource.VersionInfo.createEmpty();
    info.setStringValues(
      { lang: 1033, codepage: 1200 },
      { FileDescription: "Electron", ProductName: "Electron" },
    );
    info.outputToResourceEntries(resources.entries);
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      1,
      1033,
      ResEdit.Data.IconFile.from(iconFile([{ size: 16, png }])).icons.map(
        (item) => item.data,
      ),
    );
    resources.outputResource(executable);
    write("electron/electron.exe", Buffer.from(executable.generate()));
    write(
      "project/package.json",
      JSON.stringify({
        name: "animama-desktop",
        version: "0.1.1",
        main: "dist/main.js",
        author: "Animama",
      }),
    );
    write("project/dist/main.js", "// main\n");
    write("project/runtime/bin/tool.exe", "MZ runtime tool");
    write(
      "icon.ico",
      iconFile([
        { size: 16, png },
        { size: 256, png },
      ]),
    );

    const app = path.join(root, "project/release/win-unpacked");
    const events = [];
    const hook = builderSigningHook(app, (file) =>
      events.push(["signed", path.relative(app, file), sha256(file)]),
    );
    const options = windowsBuilderOptions({
      icon: path.join(root, "icon.ico"),
      release: {
        distribution: {
          name: "r2",
          base_url: "https://downloads.example.test/desktop",
        },
      },
      afterPack: () => events.push(["afterPack"]),
      sign: (configuration) => {
        events.push(["offered", path.relative(app, configuration.path)]);
        hook(configuration);
      },
    });
    // The release options and hooks, with a stand-in project and Electron.
    await build({
      ...options,
      projectDir: path.join(root, "project"),
      targets: Platform.WINDOWS.createTarget(["dir"], Arch.x64),
      config: {
        ...options.config,
        extends: null,
        productName: "Animama",
        electronVersion: "45.3.1",
        electronDist: path.join(root, "electron"),
        npmRebuild: false,
        directories: { output: "release" },
        files: ["dist/**/*", "package.json"],
        extraResources: [{ from: "runtime", to: "runtime" }],
      },
    });

    const exe = path.join(app, "Animama.exe");
    expect(events).toEqual([
      ["offered", path.join("resources", "runtime", "bin", "tool.exe")],
      ["afterPack"],
      ["offered", "Animama.exe"],
      ["signed", "Animama.exe", sha256(exe)],
    ]);
    const [version] = ResEdit.Resource.VersionInfo.fromEntries(
      ResEdit.NtExecutableResource.from(
        ResEdit.NtExecutable.from(readFileSync(exe)),
      ).entries,
    );
    expect(
      version.getStringValues({ lang: 1033, codepage: 1200 }),
    ).toMatchObject({ FileDescription: "Animama", ProductName: "Animama" });
  }, 60_000);

  it("names Windows evidence so it cannot collide with macOS files in the shared version folder", () => {
    expect(releaseName("win32-x64", "size-report.json")).toBe(
      "size-report-win32-x64.json",
    );
    expect(releaseName("win32-x64", "sbom.cdx.json")).toBe(
      "sbom-win32-x64.cdx.json",
    );
    expect(releaseName("darwin-arm64", "size-report.json")).toBe(
      "size-report.json",
    );
    const root = fixture();
    writeFileSync(path.join(root, "Animama-0.1.0-x64-setup.exe"), "installer");
    writeArtifactIndex(
      root,
      "0.1.0",
      ["Animama-0.1.0-x64-setup.exe"],
      {},
      "win32-x64",
    );
    expect(
      readFileSync(path.join(root, "SHA256SUMS-win32-x64.txt"), "utf8"),
    ).toContain("Animama-0.1.0-x64-setup.exe");
    expect(verifyArtifactIndex(root, "win32-x64").files).toHaveLength(1);
    expect(() => verifyArtifactIndex(root)).toThrow();
  });

  it("writes latest.yml from the signed installer's bytes", async () => {
    const root = fixture();
    writeFileSync(path.join(root, "Animama-0.1.0-x64-setup.exe"), "installer");
    const manifest = {
      app_version: "0.1.0",
      build_id: "a".repeat(64),
      minimum_os: "10.0.18362",
    };
    const r2 = {
      kind: "r2",
      base_url: "https://downloads.example.test/desktop",
    };
    const feed = await updateFeed(
      root,
      manifest,
      2000,
      { entries: [] },
      r2,
      "win32-x64",
    );
    expect(feed.path).toBe("v0.1.0/Animama-0.1.0-x64-setup.exe");
    expect(feed.files).toEqual([
      {
        url: "v0.1.0/Animama-0.1.0-x64-setup.exe",
        sha512: expect.any(String),
        size: 9,
      },
    ]);
    // Frozen for installed 0.1.6 apps; the release's real floor is Animama's own field.
    expect(feed.minimumSystemVersion).toBe("10.0.22000");
    expect(feed.animama).toMatchObject({
      platform: "win32",
      architecture: "x64",
      installed_bytes: 2000,
      minimum_os: "10.0.18362",
    });
    for (const minimum_os of ["15.0", "10.0.22000"])
      await expect(
        updateFeed(
          root,
          { ...manifest, minimum_os },
          2000,
          { entries: [] },
          r2,
          "win32-x64",
        ),
      ).rejects.toThrow("Windows runtime manifest");
  });

  /** The 0.1.7 Windows feed for each distribution, as an installed app reads it. */
  async function generatedWindowsFeeds() {
    const root = fixture();
    writeFileSync(path.join(root, "Animama-0.1.7-x64-setup.exe"), "installer");
    const manifest = {
      app_version: "0.1.7",
      build_id: "a".repeat(64),
      minimum_os: "10.0.18362",
    };
    const feeds = [];
    for (const distribution of [
      { kind: "r2", base_url: "https://downloads.example.test/desktop" },
      { kind: "github", owner: "example", repo: "releases" },
    ]) {
      const feed = await updateFeed(
        root,
        manifest,
        2000,
        { entries: [] },
        distribution,
        "win32-x64",
      );
      // electron-updater's GitHub provider supplies the tag an R2 feed carries.
      feeds.push({ distribution, read: { tag: "v0.1.7", ...feed } });
    }
    return feeds;
  }
  const accepted = {
    version: "0.1.7",
    filename: "Animama-0.1.7-x64-setup.exe",
    installedBytes: 2000,
  };

  it("writes a Windows feed that installed 0.1.6 apps still accept", async () => {
    for (const { distribution, read } of await generatedWindowsFeeds())
      expect(
        validateUpdateCandidateAsShippedIn016(
          read,
          "0.1.6",
          distribution,
          "win32",
        ),
      ).toMatchObject(accepted);
  });

  it("writes a Windows feed that this app accepts and offers on Windows 10", async () => {
    for (const { distribution, read } of await generatedWindowsFeeds()) {
      expect(
        validateUpdateCandidate(read, "0.1.6", distribution, "win32"),
      ).toMatchObject(accepted);
      // Windows 10 22H2, below the feed's frozen top-level minimum.
      expect(windowsUpdateSupported(read, "10.0.19045")).toBe(true);
      expect(windowsUpdateSupported(read, "10.0.18361")).toBe(false);
    }
  });

  it("leaves the macOS feed without a Windows floor", async () => {
    const root = fixture();
    for (const name of ["Animama-0.1.7-arm64.zip", "Animama-0.1.7-arm64.dmg"])
      writeFileSync(path.join(root, name), "archive");
    const feed = await updateFeed(
      root,
      { app_version: "0.1.7", build_id: "a".repeat(64), minimum_os: "15.0" },
      2000,
      { entries: [] },
      { kind: "r2", base_url: "https://downloads.example.test/desktop" },
    );
    expect(feed.minimumSystemVersion).toBe("24.0.0");
    expect(feed.animama).not.toHaveProperty("minimum_os");
  });

  it("measures the unpacked app and the installer against the Windows caps", () => {
    const root = fixture();
    const app = path.join(root, "win-unpacked");
    const runtime = path.join(app, "resources/runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(app, "Animama.exe"), "x".repeat(100));
    writeFileSync(path.join(runtime, "postgres.exe"), "y".repeat(40));
    writeFileSync(path.join(runtime, "manifest.json"), "{}");
    writeFileSync(
      path.join(root, "Animama-0.1.0-x64-setup.exe"),
      "z".repeat(70),
    );
    const manifest = {
      app_version: "0.1.0",
      files: [
        { path: "postgres.exe", size_bytes: 40, component: "postgresql" },
      ],
    };
    const report = releaseSizes(
      app,
      root,
      manifest,
      { entries: [] },
      "win32-x64",
    );
    expect(report).toMatchObject({
      target: "win32-x64",
      measurement: "signed-app-and-installer",
      installed_bytes: 142,
      download_bytes: 70,
      downloads: { nsis: 70 },
    });
    expect(report.components).toEqual(
      expect.arrayContaining([
        { name: "electron", installed_bytes: 100 },
        { name: "postgresql", installed_bytes: 40 },
        { name: "package_overhead", installed_bytes: 2 },
      ]),
    );
  });
});

describe("Windows update policy and publication", () => {
  it("seals the Authenticode publisher, not the Team ID, into a Windows stage", () => {
    const windows = validateReleasePolicy(policy, packs, "0.1.0", {
      distribution: "r2",
      target: "win32-x64",
    }).updatePolicy;
    expect(windows).toEqual({
      schema: "animama-update-policy/3",
      distribution: {
        kind: "r2",
        base_url: "https://downloads.example.test/desktop",
      },
      channel: "stable",
      updates: "offered",
      windows_publisher: {
        certificate_subject: publisher.certificate_subject,
        identity_validation_eku: publisher.identity_validation_eku,
      },
    });
    // The installed app reads exactly what the stage seals.
    expect(validateUpdatePolicy(windows, "win32")).toEqual(windows);
    const mac = validateReleasePolicy(
      {
        ...policy,
        redistribution_reviews: { "darwin-arm64": review },
      },
      packs,
      "0.1.0",
      { distribution: "r2" },
    ).updatePolicy;
    expect(mac.team_id).toBe("TESTTEAM01");
    expect(mac).not.toHaveProperty("windows_publisher");
  });

  it("publishes only a release-ready candidate under its own evidence names", () => {
    const root = fixture();
    const distribution = { kind: "r2", base_url: "https://d.example.test/x" };
    const report = (data) =>
      writeFileSync(
        path.join(root, "signing-report-win32-x64.json"),
        JSON.stringify({ distribution, ...data }),
      );
    report({ release_ready: false });
    expect(candidateDistribution(root, "win32-x64")).toBeNull();
    report({ release_ready: true });
    expect(candidateDistribution(root, "win32-x64")).toEqual(distribution);
    // The macOS name in the same folder is a different candidate.
    expect(candidateDistribution(root)).toBeNull();

    const names = [
      "Animama-0.2.0-x64-setup.exe",
      "latest.yml",
      "latest-mac.yml",
      "backend-model-assets.json",
      "size-report-win32-x64.json",
      "manual-acceptance-win32-x64.json",
      "release-artifacts-win32-x64.json",
      "SHA256SUMS-win32-x64.txt",
      "smoke-name-report-win32-x64.json",
    ];
    expect(
      previewAssets(
        { files: names.map((name) => ({ name })) },
        "win32-x64",
      ).map((file) => file.name),
    ).toEqual([
      "Animama-0.2.0-x64-setup.exe",
      "latest-mac.yml",
      "backend-model-assets.json",
      "size-report-win32-x64.json",
    ]);
    expect(names.filter(isWindowsReleaseName)).toEqual([
      "Animama-0.2.0-x64-setup.exe",
      "latest.yml",
      "size-report-win32-x64.json",
      "manual-acceptance-win32-x64.json",
      "release-artifacts-win32-x64.json",
      "SHA256SUMS-win32-x64.txt",
      "smoke-name-report-win32-x64.json",
    ]);
  });

  it("adds a target to a published stable release only until its own feed is there", () => {
    const remote = {
      id: 7,
      tag_name: "v0.2.0",
      draft: false,
      prerelease: false,
    };
    expect(
      mayResumeRelease(remote, "0.2.0", {
        preview: false,
        feedPublished: false,
      }),
    ).toBe(true);
    expect(
      mayResumeRelease(remote, "0.2.0", {
        preview: false,
        feedPublished: true,
      }),
    ).toBe(false);
    // A preview would turn a stable release back into a prerelease.
    expect(
      mayResumeRelease(remote, "0.2.0", {
        preview: true,
        feedPublished: false,
      }),
    ).toBe(false);
    expect(mayResumeRelease(remote, "0.2.0")).toBe(false);
  });

  it("lets only the publisher's derived Windows files skip the scan receipt", () => {
    const root = fixture();
    const scanned = {
      name: "Animama-0.2.0-x64-setup.exe",
      sha256: "a".repeat(64),
    };
    writeFileSync(
      path.join(root, "release-scan.json"),
      JSON.stringify({
        schema: "animama-release-scan/1",
        result: "pass",
        scanner: {
          version: JSON.parse(
            readFileSync(
              path.join(
                import.meta.dirname,
                "../../../../scripts/repository-boundary/scanner-pins.json",
              ),
            ),
          ).gitleaks.version,
          canary: "detected",
          config_sha256: createHash("sha256")
            .update(
              readFileSync(
                path.join(
                  import.meta.dirname,
                  "../runtime/release-scan.gitleaks.toml",
                ),
              ),
            )
            .digest("hex"),
        },
        files: [scanned],
      }),
    );
    const derived = {
      name: "manual-acceptance-win32-x64.json",
      sha256: "b".repeat(64),
    };
    expect(() =>
      verifyScanReceipt(root, [scanned, derived], "win32-x64"),
    ).not.toThrow();
    // The macOS name is not a Windows derived file.
    expect(() =>
      verifyScanReceipt(
        root,
        [scanned, { ...derived, name: "manual-acceptance.json" }],
        "win32-x64",
      ),
    ).toThrow("does not cover these exact artifacts");
  });

  it("binds smoke and human acceptance to the exact installer", () => {
    const smoke = {
      passed: true,
      setup: "name",
      installer_sha256: "a".repeat(64),
      runtime_build_id: "build-1",
      checks: {
        required_private_name: true,
        empty_name_rejected: true,
        blank_name_rejected: true,
        adult_confirmation_required: true,
        setup_steps: true,
        first_anima_chat: true,
        temporary_provider_removed: true,
        temporary_provider_removal_persists: true,
        exact_fuse_wire: true,
        publisher_signature: true,
        sealed_update_policy: true,
        debugging_switches_refused: true,
        copy_fuse_wire: true,
        copy_updates_unavailable: true,
        canonical_profile_untouched: true,
      },
    };
    const expected = {
      artifactSha256: "a".repeat(64),
      runtimeBuildId: "build-1",
      target: "win32-x64",
    };
    expect(acceptsRequiredNameSmoke(smoke, { violations: 0 }, expected)).toBe(
      true,
    );
    expect(
      acceptsRequiredNameSmoke(
        { ...smoke, installer_sha256: "b".repeat(64) },
        { violations: 0 },
        expected,
      ),
    ).toBe(false);
    // A DMG hash field never satisfies the Windows binding.
    expect(
      acceptsRequiredNameSmoke(
        { ...smoke, installer_sha256: undefined, dmg_sha256: "a".repeat(64) },
        { violations: 0 },
        expected,
      ),
    ).toBe(false);
    const accepted = {
      schema: "animama-windows-acceptance/1",
      app_version: "0.2.0",
      installer_sha256: "a".repeat(64),
      reviewed_by: "Fixture reviewer",
      reviewed_on: "2026-09-01",
      prior_signed_version: "0.1.0",
      checks: Object.fromEntries(
        manualWindowsChecks.map((name) => [name, true]),
      ),
    };
    expect(
      validateManualAcceptance(accepted, "a".repeat(64), "0.2.0", "win32-x64")
        .installer_sha256,
    ).toBe("a".repeat(64));
    expect(() =>
      validateManualAcceptance(accepted, "b".repeat(64), "0.2.0", "win32-x64"),
    ).toThrow("exact installer");
    expect(() =>
      validateManualAcceptance(
        { ...accepted, schema: "animama-macos-acceptance/1" },
        "a".repeat(64),
        "0.2.0",
        "win32-x64",
      ),
    ).toThrow();
    expect(() =>
      validateManualAcceptance(
        {
          ...accepted,
          checks: { ...accepted.checks, smartscreen_download: false },
        },
        "a".repeat(64),
        "0.2.0",
        "win32-x64",
      ),
    ).toThrow();
  });
});

describe("Windows smoke and scan helpers", () => {
  const runtime =
    "C:\\Users\\Smoke Test\\AppData\\Local\\Programs\\Animama\\resources\\runtime";
  const postgres = `${runtime}\\postgres\\bin\\postgres.exe`;
  const guard = `${runtime}\\bin\\animama-process-guard.exe`;

  it("owns a child only when its guard and service run from the installed runtime", () => {
    const images = parseProcessImages(
      `4\t\r\n100\t${guard.toUpperCase()}\r\n101\t${postgres}\r\n200\tC:\\Windows\\System32\\cmd.exe\r\n`,
    );
    expect(images.get(4)).toBeUndefined();
    const child = { pid: 100, servicePid: 101, executable: postgres };
    expect(ownedWindowsChild(child, runtime, images)).toBe(true);
    expect(
      ownedWindowsChild({ ...child, servicePid: 200 }, runtime, images),
    ).toBe(false);
    expect(ownedWindowsChild({ ...child, pid: 101 }, runtime, images)).toBe(
      false,
    );
    expect(
      ownedWindowsChild(
        {
          ...child,
          executable: "C:\\Windows\\System32\\cmd.exe",
          servicePid: 200,
        },
        runtime,
        images,
      ),
    ).toBe(false);
    // A sibling folder that only shares the prefix is outside the runtime.
    expect(
      ownedWindowsChild(
        { ...child, executable: `${runtime}-old\\postgres.exe` },
        runtime,
        new Map([...images, [101, `${runtime}-old\\postgres.exe`]]),
      ),
    ).toBe(false);
  });

  it("checks the canonical profile and launches with only system paths", () => {
    const env = {
      SystemRoot: "C:\\Windows",
      LOCALAPPDATA: "C:\\Users\\Zoë\\AppData\\Local",
      APPDATA: "C:\\Users\\Zoë\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\Zoë",
      PATH: "C:\\tools;C:\\Windows\\System32",
      NODE_OPTIONS: "--inspect",
      ANIMAMA_SMOKE_OPENAI_KEY: "sk-fixture",
    };
    expect(windowsProfile(env)).toMatchObject({
      userData: "C:\\Users\\Zoë\\AppData\\Local\\Animama",
      installed: "C:\\Users\\Zoë\\AppData\\Local\\Programs\\Animama",
    });
    expect(windowsProfile(env).existing).toContain(
      "C:\\Users\\Zoë\\AppData\\Roaming\\Animama",
    );
    expect(windowsLaunchEnvironment(env)).toEqual({
      PATH: "C:\\Windows\\System32;C:\\Windows",
      SystemRoot: "C:\\Windows",
      LOCALAPPDATA: env.LOCALAPPDATA,
      APPDATA: env.APPDATA,
      USERPROFILE: env.USERPROFILE,
    });
    expect(() => windowsProfile({})).toThrow("normal Windows user session");
  });

  it("searches for the Windows profile path with both separators and in UTF-16LE", () => {
    const needles = homeDirectoryNeedles("C:\\Users\\Zoë Test", "win32");
    expect(
      Object.fromEntries(
        needles.map(({ label, value }) => [
          label,
          Buffer.isBuffer(value) ? value.toString("utf16le") : value,
        ]),
      ),
    ).toEqual({
      "home-directory": "\\Users\\Zoë Test\\",
      "home-directory-slash": "/Users/Zoë Test/",
      "home-directory-json": "\\\\Users\\\\Zoë Test\\\\",
      "home-directory-utf16le": "\\Users\\Zoë Test\\",
      "home-directory-slash-utf16le": "/Users/Zoë Test/",
    });
    expect(homeDirectoryNeedles("/Users/fixture", "darwin")).toEqual([
      { label: "home-directory", value: "/Users/fixture/" },
    ]);
  });
});
