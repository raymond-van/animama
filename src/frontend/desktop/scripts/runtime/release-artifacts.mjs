import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { readJson, sha256, writeJson } from "./common.mjs";
import { componentInventory } from "./inventory.mjs";
import { packSizeReport, validateSizeReport } from "./size.mjs";

async function sha512(file) {
  const hash = createHash("sha512");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("base64");
}

/**
 * What differs between release targets. Both targets share one versioned
 * distribution folder, so Windows evidence files that would collide with the
 * macOS names carry a `-win32-x64` suffix; macOS names stay unchanged.
 */
export const RELEASE_TARGETS = {
  "darwin-arm64": {
    label: "macOS 15",
    platform: "darwin",
    architecture: "arm64",
    minimumOs: "15.0",
    // macOS 15 is Darwin 24. electron-updater compares os.release(), not the product version.
    minimumSystemVersion: "24.0.0",
    feed: "latest-mac.yml",
    runtime: "Contents/Resources/runtime",
    measurement: "signed-stapled-app-and-final-distribution-archives",
    suffix: "",
    // The first entry is the feed's primary download.
    downloads: (version) => [
      ["zip", `Animama-${version}-arm64.zip`],
      ["dmg", `Animama-${version}-arm64.dmg`],
    ],
  },
  "win32-x64": {
    label: "Windows",
    platform: "win32",
    architecture: "x64",
    // Windows 10 version 1903; os.release() reports 10.0.<build>.
    minimumOs: "10.0.18362",
    // Frozen. Installed 0.1.6 apps reject a feed unless this is exactly
    // 10.0.22000, so it no longer follows the floor. The release's real floor
    // travels as `animama.minimum_os`, which newer apps enforce instead.
    minimumSystemVersion: "10.0.22000",
    feedCarriesMinimumOs: true,
    feed: "latest.yml",
    runtime: "resources/runtime",
    measurement: "signed-app-and-installer",
    suffix: "-win32-x64",
    downloads: (version) => [["nsis", `Animama-${version}-x64-setup.exe`]],
  },
};

/** A target's evidence file name in the shared folder: `size-report.json` → `size-report-win32-x64.json`. */
export function releaseName(target, name) {
  const { suffix } = RELEASE_TARGETS[target];
  const dot = name.indexOf(".");
  return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
}

/**
 * Feed metadata is derived from the final signed bytes, never hand-entered
 * estimates. An R2 feed sits above per-version folders, so its file paths
 * include the folder and it carries the tag GitHub would otherwise supply.
 */
export async function updateFeed(
  directory,
  manifest,
  installedBytes,
  catalog,
  distribution,
  target = "darwin-arm64",
) {
  const spec = RELEASE_TARGETS[target];
  const version = manifest.app_version;
  if (!/^\d+\.\d+\.\d+$/u.test(version))
    throw new Error("Invalid release version");
  if (manifest.minimum_os !== spec.minimumOs)
    throw new Error(
      `Update feed requires the ${spec.label} runtime manifest (minimum_os ${spec.minimumOs})`,
    );
  if (!["r2", "github"].includes(distribution?.kind))
    throw new Error("Update feed requires the selected release distribution");
  const folder = distribution.kind === "r2" ? `v${version}/` : "";
  const files = [];
  for (const [, name] of spec.downloads(version)) {
    const url = `${folder}${name}`;
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size <= 0 ||
      stat.size > 750 * 1024 ** 2
    )
      throw new Error(
        "Update artifact is missing, unsafe or over its size ceiling",
      );
    files.push({ url, sha512: await sha512(file), size: stat.size });
  }
  return {
    version,
    ...(distribution.kind === "r2" ? { tag: `v${version}` } : {}),
    files,
    path: files[0].url,
    sha512: files[0].sha512,
    minimumSystemVersion: spec.minimumSystemVersion,
    releaseDate: new Date().toISOString(),
    animama: {
      schema: "animama-update/1",
      platform: spec.platform,
      architecture: spec.architecture,
      installed_bytes: installedBytes,
      runtime_build_id: manifest.build_id,
      ...(spec.feedCarriesMinimumOs ? { minimum_os: manifest.minimum_os } : {}),
      packs: catalog.entries.map((pack) => ({
        id: pack.id,
        manifest_sha256: createHash("sha256")
          .update(JSON.stringify(pack))
          .digest("hex"),
      })),
    },
  };
}

/** Measure the actual app and its distribution files, including signature/installer overhead. */
export function releaseSizes(
  app,
  directory,
  manifest,
  catalog,
  target = "darwin-arm64",
) {
  const spec = RELEASE_TARGETS[target];
  const installed = componentInventory(app).reduce(
    (sum, file) => sum + file.size_bytes,
    0,
  );
  const manifestBytes = lstatSync(
    path.join(app, spec.runtime, "manifest.json"),
  ).size;
  const runtimeBytes =
    manifest.files.reduce((sum, file) => sum + file.size_bytes, 0) +
    manifestBytes;
  const components = new Map([["electron", installed - runtimeBytes]]);
  for (const file of manifest.files)
    components.set(
      file.component,
      (components.get(file.component) ?? 0) + file.size_bytes,
    );
  components.set(
    "package_overhead",
    (components.get("package_overhead") ?? 0) + manifestBytes,
  );
  const downloads = Object.fromEntries(
    spec
      .downloads(manifest.app_version)
      .map(([kind, name]) => [kind, lstatSync(path.join(directory, name)).size])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const report = {
    schema: "animama-size-report/1",
    target,
    app_version: manifest.app_version,
    measurement: spec.measurement,
    installed_bytes: installed,
    download_bytes: Math.max(...Object.values(downloads)),
    downloads,
    components: [...components].map(([name, installed_bytes]) => ({
      name,
      installed_bytes,
    })),
    packs: Object.fromEntries(
      catalog.entries.map((pack) => [pack.id, packSizeReport(pack)]),
    ),
  };
  report.validation = validateSizeReport(report);
  if (report.validation.failures.length)
    throw new Error(report.validation.failures.join("\n"));
  return report;
}

/** CycloneDX inventory distinguishes exact runtime file hashes from conservative dependency groups. */
export function releaseSbom(manifest, inventory) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "Animama",
        version: manifest.app_version,
      },
      properties: [
        { name: "animama:coverage", value: inventory.coverage },
        { name: "animama:runtime-build-id", value: manifest.build_id },
      ],
    },
    components: [
      ...inventory.records.map((record, index) => ({
        type: "library",
        "bom-ref": `dependency:${index}`,
        name: record.name ?? record.id,
        ...(record.version ? { version: record.version } : {}),
        properties: [
          { name: "animama:inventory-id", value: record.id },
          {
            name: "animama:license-observation",
            value: String(record.license ?? "NOASSERTION"),
          },
        ],
      })),
      ...manifest.files.map((file) => ({
        type: "file",
        "bom-ref": `runtime:${file.path}`,
        name: file.path,
        hashes: [{ alg: "SHA-256", content: file.sha256 }],
      })),
    ],
  };
}

/**
 * The distribution a candidate was built for, as its signing report records
 * it; null if absent. A signing rehearsal is never `release_ready`, so it
 * names no distribution a publisher could accept.
 */
export function candidateDistribution(directory, target = "darwin-arm64") {
  try {
    const report = readJson(
      path.join(directory, releaseName(target, "signing-report.json")),
    );
    if (report.release_ready !== true) return null;
    const { distribution } = report;
    return ["r2", "github"].includes(distribution?.kind) ? distribution : null;
  } catch {
    return null;
  }
}

/**
 * Publish only a fixed allowlist, not release directories, build logs, or
 * source maps. A target's index and checksums take its evidence suffix.
 */
export function writeArtifactIndex(
  directory,
  version,
  names,
  extra = {},
  target = "darwin-arm64",
) {
  const files = [...new Set(names)].sort().map((name) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,150}$/u.test(name))
      throw new Error("Unsafe release artifact name");
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("Unsafe release artifact");
    return { name, size_bytes: stat.size, sha256: sha256(file) };
  });
  const index = {
    schema: "animama-release-artifacts/1",
    app_version: version,
    ...extra,
    files,
  };
  writeJson(
    path.join(directory, releaseName(target, "release-artifacts.json")),
    index,
  );
  writeFileSync(
    path.join(directory, releaseName(target, "SHA256SUMS.txt")),
    files.map((file) => `${file.sha256}  ${file.name}\n`).join(""),
  );
  return index;
}

export function verifyArtifactIndex(directory, target = "darwin-arm64") {
  const indexName = releaseName(target, "release-artifacts.json");
  const sumsName = releaseName(target, "SHA256SUMS.txt");
  for (const name of [indexName, sumsName]) {
    const stat = lstatSync(path.join(directory, name));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 64 * 1024
    )
      throw new Error("Invalid release artifact index");
  }
  const index = readJson(path.join(directory, indexName));
  if (
    index.schema !== "animama-release-artifacts/1" ||
    !Array.isArray(index.files) ||
    !index.files.length ||
    index.files.length > 64
  )
    throw new Error("Invalid release artifact index");
  const names = new Set();
  for (const file of index.files) {
    if (
      !file ||
      typeof file.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,150}$/u.test(file.name) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes < 1 ||
      names.has(file.name) ||
      [indexName, sumsName].includes(file.name)
    )
      throw new Error("Invalid release artifact entry");
    names.add(file.name);
    const artifact = path.join(directory, file.name);
    const stat = lstatSync(artifact);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size !== file.size_bytes ||
      sha256(artifact) !== file.sha256
    )
      throw new Error("Release artifact changed after verification");
  }
  const sums = index.files
    .map((file) => `${file.sha256}  ${file.name}\n`)
    .join("");
  if (readFileSync(path.join(directory, sumsName), "utf8") !== sums)
    throw new Error("Release checksum list changed");
  return index;
}

/** A public testing preview exposes immutable payloads/notices, never the stable feed or final acceptance. */
export function previewAssets(index, target = "darwin-arm64") {
  const withheld = [
    RELEASE_TARGETS[target].feed,
    ...[
      "manual-acceptance.json",
      "release-artifacts.json",
      "SHA256SUMS.txt",
      ...["smoke", "network"].flatMap((kind) =>
        ["skip", "name"].map((setup) => `${kind}-${setup}-report.json`),
      ),
    ].map((name) => releaseName(target, name)),
  ];
  return index.files.filter((file) => !withheld.includes(file.name));
}

/** Names both targets publish with identical bytes into the same version folder. */
export const SHARED_RELEASE_NAMES = ["backend-model-assets.json"];

/**
 * Whether a published name belongs to the Windows candidate. Windows names
 * carry the `-win32-x64` suffix or are its feed and installer; every other
 * name is macOS's or shared by both targets.
 */
export function isWindowsReleaseName(name) {
  return (
    name === RELEASE_TARGETS["win32-x64"].feed ||
    /-win32-x64\.[A-Za-z0-9.]+$/u.test(name) ||
    /^Animama-\d+\.\d+\.\d+-x64-setup\.exe$/u.test(name)
  );
}

/**
 * Only the exact version's draft or explicit prerelease can advance. A
 * published stable release may still receive the other target's files, by a
 * stable promotion that has not yet uploaded its own feed; nothing in it is
 * ever replaced.
 */
export function mayResumeRelease(
  remote,
  version,
  { preview = true, feedPublished = true } = {},
) {
  return (
    Number.isSafeInteger(remote?.id) &&
    remote.id > 0 &&
    remote.tag_name === `v${version}` &&
    typeof remote.draft === "boolean" &&
    typeof remote.prerelease === "boolean" &&
    (remote.draft || remote.prerelease || (!preview && !feedPublished))
  );
}
