import {
  featurePackIds,
  type FeaturePackId,
} from "../../../../shared/desktop-runtime.js";
import { RuntimeError } from "../runtime/errors.js";

const MAX_UPDATE_BYTES = 750 * 1024 ** 2;
const MAX_INSTALLED_BYTES = 1536 * 1024 ** 2;
const UPDATE_RESERVE_BYTES = 256 * 1024 ** 2;
/** Where this build's installers, update feed and packs are published; fixed at build time. */
export type ReleaseDistribution =
  | { kind: "r2"; base_url: string }
  | { kind: "github"; owner: string; repo: string };
/** The Authenticode identity every Windows update must be signed by. */
export type WindowsPublisher = {
  certificate_subject: string;
  identity_validation_eku: string;
};
type PolicyBase = {
  schema: "animama-update-policy/3";
  distribution: ReleaseDistribution;
  channel: "stable";
  /**
   * Whether this build checks for updates. The final release seals `ended`:
   * it never contacts its distribution, which stays recorded because the pack
   * catalog and release tooling read it.
   */
  updates: "offered" | "ended";
};
/** macOS builds name their Apple Team ID; Windows builds their Authenticode publisher. */
export type UpdatePolicy =
  | (PolicyBase & { team_id: string })
  | (PolicyBase & { windows_publisher: WindowsPublisher });
export type UpdatePlatform = "darwin" | "win32";
export type UpdateCandidate = {
  version: string;
  filename: string;
  sha512: string;
  downloadBytes: number;
  installedBytes: number;
  runtimeBuildId: string;
  packDigests: Partial<Record<FeaturePackId, string>>;
};

/** What each platform's feed must name; the first file is the one the updater installs. */
const PLATFORMS = {
  darwin: {
    architecture: "arm64",
    feed: "latest-mac.yml",
    // macOS 15 is Darwin 24; electron-updater compares os.release().
    minimumSystemVersion: "24.0.0",
    files: (version: string) => [
      `Animama-${version}-arm64.zip`,
      `Animama-${version}-arm64.dmg`,
    ],
  },
  win32: {
    architecture: "x64",
    feed: "latest.yml",
    // Frozen. Installed 0.1.6 apps reject a feed unless this is exactly
    // 10.0.22000, so it no longer follows the floor. A release names its real
    // floor in `animama.minimum_os`; see `windowsUpdateSupported`.
    minimumSystemVersion: "10.0.22000",
    files: (version: string) => [`Animama-${version}-x64-setup.exe`],
  },
} as const;

const VERSION = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/u;
const HASH = /^[a-f0-9]{64}$/u;
/** Windows 10 and 11 report `10.0.<build>`; a feed names its floor the same way. */
const WINDOWS_RELEASE = /^10\.0\.(\d{1,6})$/u;
const repositoryPart = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;

/** A stable release folder name: `v<major>.<minor>.<patch>`. */
export function isReleaseTag(value: string | undefined): boolean {
  return Boolean(value?.startsWith("v") && VERSION.test(value.slice(1)));
}

/** Stable releases only; prereleases and downgrade channels have no local switch. */
function compareVersions(left: string, right: string): number {
  if (!VERSION.test(left) || !VERSION.test(right))
    throw new RuntimeError("update_metadata_invalid");
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}

/** A public HTTPS base that cannot carry credentials, ports or overrides. */
function isPublicBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !url.pathname.endsWith("/") &&
      url.href === value
    );
  } catch {
    return false;
  }
}

/** Accept exactly one of the two supported distribution shapes. */
export function isReleaseDistribution(
  value: unknown,
): value is ReleaseDistribution {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item !== "object") return false;
  const keys = Object.keys(item).sort().join(",");
  return item.kind === "r2"
    ? keys === "base_url,kind" && isPublicBaseUrl(item.base_url)
    : item.kind === "github" &&
        keys === "kind,owner,repo" &&
        typeof item.owner === "string" &&
        typeof item.repo === "string" &&
        repositoryPart.test(item.owner) &&
        repositoryPart.test(item.repo);
}

function isWindowsPublisher(value: unknown): value is WindowsPublisher {
  const item = value as Record<string, unknown> | null;
  return (
    !!item &&
    typeof item === "object" &&
    Object.keys(item).sort().join(",") ===
      "certificate_subject,identity_validation_eku" &&
    typeof item.certificate_subject === "string" &&
    /^CN=[^\x00-\x1f\x7f]{1,500}$/u.test(item.certificate_subject) &&
    typeof item.identity_validation_eku === "string" &&
    // An Artifact Signing identity validation's own OID under 1.3.6.1.4.1.311.97.
    /^1\.3\.6\.1\.4\.1\.311\.97(\.\d{1,10}){4}$/u.test(
      item.identity_validation_eku,
    )
  );
}

/**
 * The update platform of a host, or none where the app is never updated in
 * place: a Linux build is rebuilt from source and never requests a feed.
 */
export function hostUpdatePlatform(
  platform: string,
  architecture: string,
): UpdatePlatform | undefined {
  if (platform === "darwin" && architecture === "arm64") return "darwin";
  if (platform === "win32" && architecture === "x64") return "win32";
  return undefined;
}

/** The platform whose publisher a policy names. */
export function updatePlatform(policy: UpdatePolicy): UpdatePlatform {
  return "team_id" in policy ? "darwin" : "win32";
}

/** Read only the non-secret policy embedded in verified application resources. */
export function validateUpdatePolicy(
  value: unknown,
  platform: UpdatePlatform = "darwin",
): UpdatePolicy {
  const policy = value as Record<string, unknown> | null;
  const publisher = platform === "darwin" ? "team_id" : "windows_publisher";
  if (
    !policy ||
    policy.schema !== "animama-update-policy/3" ||
    policy.channel !== "stable" ||
    !["offered", "ended"].includes(policy.updates as string) ||
    !isReleaseDistribution(policy.distribution) ||
    !(platform === "darwin"
      ? typeof policy.team_id === "string" &&
        /^[A-Z0-9]{10}$/u.test(policy.team_id)
      : isWindowsPublisher(policy.windows_publisher)) ||
    Object.keys(policy).sort().join(",") !==
      ["channel", "distribution", "schema", "updates", publisher]
        .sort()
        .join(",")
  ) {
    throw new RuntimeError("updates_not_configured");
  }
  return policy as UpdatePolicy;
}

/**
 * Open a packaged build's updates from its sealed policy: check the app's own
 * publisher, then create the controller. A build that seals updates off (the
 * final release) returns nothing before either step, so it never creates an
 * updater session or contacts its distribution.
 */
export async function openSealedUpdates<T>({
  platform,
  readPolicy,
  verifyPublisher,
  cancelled,
  create,
}: {
  platform: UpdatePlatform;
  readPolicy(): Promise<unknown>;
  verifyPublisher(policy: UpdatePolicy): Promise<void>;
  /** Whether the app began quitting while the publisher was checked. */
  cancelled(): boolean;
  create(policy: UpdatePolicy): T;
}): Promise<T | undefined> {
  const policy = validateUpdatePolicy(await readPolicy(), platform);
  if (policy.updates === "ended") return undefined;
  await verifyPublisher(policy);
  if (cancelled()) return undefined;
  return create(policy);
}

/**
 * Whether a Windows system meets the floor a feed names in
 * `animama.minimum_os`. It stands in for electron-updater's own check, which
 * reads the frozen top-level minimum and would refuse every Windows 10 system.
 * Only a well-formed floor above the running build withholds the update;
 * anything malformed passes, so `validateUpdateCandidate` reports it.
 */
export function windowsUpdateSupported(
  info: unknown,
  kernelRelease: string,
): boolean {
  const floor = (info as { animama?: { minimum_os?: unknown } } | null)?.animama
    ?.minimum_os;
  const required =
    typeof floor === "string" ? WINDOWS_RELEASE.exec(floor) : null;
  const running = WINDOWS_RELEASE.exec(kernelRelease);
  return !required || !running || Number(running[1]) >= Number(required[1]);
}

/** Gate untrusted feed data before disk estimates, downloads, or pack preflight. */
export function validateUpdateCandidate(
  value: unknown,
  currentVersion: string,
  distribution: ReleaseDistribution,
  platform: UpdatePlatform = "darwin",
): UpdateCandidate {
  const spec = PLATFORMS[platform];
  const info = value as Record<string, unknown>;
  if (
    !info ||
    typeof info.version !== "string" ||
    compareVersions(info.version, currentVersion) <= 0 ||
    info.tag !== `v${info.version}` ||
    !Array.isArray(info.files) ||
    info.files.length < 1 ||
    info.files.length > spec.files(info.version).length ||
    info.minimumSystemVersion !== spec.minimumSystemVersion ||
    info.stagingPercentage !== undefined
  ) {
    throw new RuntimeError("update_metadata_invalid");
  }
  const allowed = spec.files(info.version);
  const filename = allowed[0];
  // R2 feeds sit above per-version folders; GitHub resolves names within the tag.
  const folder = distribution.kind === "r2" ? `v${info.version}/` : "";
  const names = new Set<string>();
  let archive: { url: string; size: number; sha512: string } | undefined;
  for (const entry of info.files) {
    const file = entry as {
      url: string;
      size: number;
      sha512: string;
      isAdminRightsRequired?: unknown;
    };
    if (
      !file ||
      !allowed.map((name) => `${folder}${name}`).includes(file.url) ||
      // A per-user installer never asks the updater to elevate.
      file.isAdminRightsRequired !== undefined ||
      names.has(file.url) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > MAX_UPDATE_BYTES ||
      typeof file.sha512 !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/u.test(file.sha512)
    ) {
      throw new RuntimeError("update_metadata_invalid");
    }
    names.add(file.url);
    if (file.url === `${folder}${filename}`) archive = file;
  }
  const metadata = info.animama as Record<string, unknown>;
  if (
    !archive ||
    !metadata ||
    metadata.schema !== "animama-update/1" ||
    metadata.platform !== platform ||
    metadata.architecture !== spec.architecture ||
    !Number.isSafeInteger(metadata.installed_bytes) ||
    Number(metadata.installed_bytes) < 1 ||
    Number(metadata.installed_bytes) > MAX_INSTALLED_BYTES ||
    typeof metadata.runtime_build_id !== "string" ||
    !HASH.test(metadata.runtime_build_id) ||
    (platform === "win32" &&
      (typeof metadata.minimum_os !== "string" ||
        !WINDOWS_RELEASE.test(metadata.minimum_os))) ||
    !Array.isArray(metadata.packs) ||
    metadata.packs.length > featurePackIds.length
  ) {
    throw new RuntimeError("update_metadata_invalid");
  }
  const packDigests: UpdateCandidate["packDigests"] = {};
  for (const entry of metadata.packs) {
    const pack = entry as { id: FeaturePackId; manifest_sha256: string };
    if (
      !pack ||
      !featurePackIds.includes(pack.id) ||
      packDigests[pack.id] ||
      typeof pack.manifest_sha256 !== "string" ||
      !HASH.test(pack.manifest_sha256)
    ) {
      throw new RuntimeError("update_metadata_invalid");
    }
    packDigests[pack.id] = pack.manifest_sha256;
  }
  return {
    version: info.version,
    filename,
    sha512: archive.sha512,
    downloadBytes: archive.size,
    installedBytes: Number(metadata.installed_bytes),
    runtimeBuildId: metadata.runtime_build_id,
    packDigests,
  };
}

/**
 * Include the download cache, Squirrel staging or the installer's own
 * extraction, replacement bytes and a conservative SQL snapshot.
 */
export function updateFreeBytes(
  candidate: UpdateCandidate,
  databaseBytes: number,
): number {
  if (!Number.isSafeInteger(databaseBytes) || databaseBytes < 0)
    throw new RuntimeError("update_disk_estimate_failed");
  const value =
    2 * candidate.downloadBytes +
    2 * candidate.installedBytes +
    2 * databaseBytes +
    UPDATE_RESERVE_BYTES;
  if (!Number.isSafeInteger(value))
    throw new RuntimeError("update_disk_estimate_failed");
  return value;
}

/**
 * The updater's separate Electron session never contacts arbitrary or
 * credentialed origins: an R2 build reaches only its feed and version folders,
 * a GitHub build only its repository's releases and asset CDN.
 */
export function allowedUpdateUrl(value: string, policy: UpdatePolicy): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      return false;
    const distribution = policy.distribution;
    if (distribution.kind === "r2") {
      const base = new URL(distribution.base_url);
      if (url.origin !== base.origin) return false;
      // electron-updater's generic provider adds noCache=<base-32 time> to feed requests.
      if (
        url.pathname ===
        `${base.pathname}/${PLATFORMS[updatePlatform(policy)].feed}`
      )
        return !url.search || /^\?noCache=[0-9a-v]{1,16}$/u.test(url.search);
      const [tag, name, ...extra] = url.pathname.startsWith(`${base.pathname}/`)
        ? url.pathname.slice(base.pathname.length + 1).split("/")
        : [];
      return (
        !url.search && isReleaseTag(tag) && Boolean(name) && extra.length === 0
      );
    }
    if (
      [
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ].includes(url.hostname)
    )
      return true;
    const prefix = `/${distribution.owner}/${distribution.repo}/releases`;
    return (
      (url.hostname === "github.com" &&
        (url.pathname === `${prefix}.atom` ||
          url.pathname.startsWith(`${prefix}/`))) ||
      (url.hostname === "api.github.com" &&
        url.pathname.startsWith(`/repos${prefix}/`))
    );
  } catch {
    return false;
  }
}
