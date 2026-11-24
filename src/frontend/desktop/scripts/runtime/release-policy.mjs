import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  desktopRoot,
  readJson,
  sha256,
  sourceRoot,
  writeJson,
} from "./common.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
const releasePolicyPath = path.join(sourceRoot, "release-policy.json");
const DISTRIBUTIONS = ["r2", "github"];
const RELEASE_TARGETS = ["darwin-arm64", "win32-x64"];

/**
 * The build-time transport choice. It is sealed into the signed app's update
 * policy and pack catalog; installed apps never read this variable.
 */
export function selectedDistribution(env = process.env) {
  const name = env.ANIMAMA_RELEASE_DISTRIBUTION || "r2";
  if (!DISTRIBUTIONS.includes(name))
    throw new Error("ANIMAMA_RELEASE_DISTRIBUTION must be r2 or github");
  return name;
}

/** A public HTTPS origin and path prefix that cannot carry credentials or overrides. */
function isPublicBaseUrl(value) {
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

function validDistributions(value) {
  const { r2, github } = value ?? {};
  return (
    Object.keys(value ?? {})
      .sort()
      .join(",") === "github,r2" &&
    Object.keys(r2 ?? {})
      .sort()
      .join(",") === "base_url,bucket" &&
    isPublicBaseUrl(r2.base_url) &&
    BUCKET.test(r2.bucket ?? "") &&
    Object.keys(github ?? {})
      .sort()
      .join(",") === "owner,repo" &&
    PART.test(github.owner ?? "") &&
    PART.test(github.repo ?? "")
  );
}

/** The public folder holding one release's immutable assets. */
export function releaseTagBase(distribution, tag) {
  return distribution.name === "r2"
    ? `${distribution.base_url}/${tag}`
    : `https://github.com/${distribution.owner}/${distribution.repo}/releases/download/${tag}`;
}

/** A human receipt for one target's exact staged inventory. */
function validReview(review) {
  return (
    HASH.test(review?.inventory_sha256 ?? "") &&
    Object.keys(review).sort().join(",") ===
      "inventory_sha256,reviewed_by,reviewed_on" &&
    typeof review.reviewed_by === "string" &&
    /^[^\x00-\x1f\x7f]{1,100}$/u.test(review.reviewed_by) &&
    typeof review.reviewed_on === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(review.reviewed_on) &&
    review.reviewed_on <= new Date().toISOString().slice(0, 10)
  );
}

/**
 * The Artifact Signing identity that signs Windows releases. These names are
 * not secrets: the subject and the identity-validation EKU appear in every
 * signature, and signing authenticates through the maintainer's Azure sign-in.
 */
function validWindowsPublisher(publisher) {
  return (
    Object.keys(publisher ?? {})
      .sort()
      .join(",") ===
      "account,certificate_profile,certificate_subject,endpoint,identity_validation_eku" &&
    /^https:\/\/[a-z0-9]+\.codesigning\.azure\.net\/$/u.test(
      publisher.endpoint,
    ) &&
    PART.test(publisher.account ?? "") &&
    PART.test(publisher.certificate_profile ?? "") &&
    typeof publisher.certificate_subject === "string" &&
    /^CN=[^\x00-\x1f\x7f]{1,300}$/u.test(publisher.certificate_subject) &&
    // Each identity validation has its own OID under 1.3.6.1.4.1.311.97;
    // 311.97.1.0 only marks public trust and identifies no one.
    /^1\.3\.6\.1\.4\.1\.311\.97(?:\.\d{1,10}){4}$/u.test(
      publisher.identity_validation_eku ?? "",
    )
  );
}

/**
 * electron-builder's `publish` setting, which writes the app-update.yml it
 * embeds; the updater itself takes its transport from the staged update policy.
 */
export function builderPublishConfig(distribution) {
  return [
    distribution.name === "r2"
      ? { provider: "generic", url: distribution.base_url, channel: "latest" }
      : {
          provider: "github",
          owner: distribution.owner,
          repo: distribution.repo,
          private: false,
          releaseType: "release",
        },
  ];
}

/** Pin candidate URLs and publisher inputs offline; visibility is checked only at publication. */
export function validateReleasePolicy(
  policy,
  packs,
  version,
  {
    requireReview = true,
    distribution = selectedDistribution(),
    target = "darwin-arm64",
  } = {},
) {
  if (!RELEASE_TARGETS.includes(target))
    throw new Error(`Unsupported release target ${target}`);
  if (!DISTRIBUTIONS.includes(distribution))
    throw new Error("ANIMAMA_RELEASE_DISTRIBUTION must be r2 or github");
  if (
    policy?.schema !== "animama-release-policy/4" ||
    policy.channel !== "stable" ||
    !["offered", "ended"].includes(policy.updates) ||
    Object.keys(policy).sort().join(",") !==
      "channel,distribution_basis,distributions,redistribution_reviews,schema,updates" ||
    !policy.distribution_basis ||
    Object.keys(policy.distribution_basis).sort().join(",") !==
      "commercial,pocket_tts_onnx_license" ||
    policy.distribution_basis.commercial !== false ||
    policy.distribution_basis.pocket_tts_onnx_license !== "CC-BY-4.0" ||
    !validDistributions(policy.distributions)
  )
    throw new Error(
      "Set the intended installer/update destinations (an R2 public HTTPS base URL and bucket, and a GitHub repository), whether updates are offered or ended, and the noncommercial installer/update policy in runtime/release-policy.json; the release policy records a noncommercial PocketTTS distribution basis, candidates may remain private, and embedded tokens are not supported.",
    );
  const publisher = packs?.macos;
  if (
    !/^[A-Z0-9]{10}$/u.test(publisher?.team_id ?? "") ||
    typeof publisher?.signing_identity !== "string" ||
    !publisher.signing_identity.startsWith("Developer ID Application:") ||
    !publisher.signing_identity.endsWith(`(${publisher.team_id})`)
  )
    throw new Error(
      "Configure the reviewed macOS publisher in runtime/feature-pack-releases.json; ad-hoc signing is not a release.",
    );
  if (!/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/u.test(version))
    throw new Error("Release version must be an exact stable version.");
  // Pack URLs share the core update destination, so they are never configured separately.
  if (packs && "release_base_url" in packs)
    throw new Error(
      "Remove release_base_url from runtime/feature-pack-releases.json; pack URLs are derived from the selected distribution.",
    );
  const selected = {
    name: distribution,
    ...policy.distributions[distribution],
  };
  // Each target's inventory differs (its own native lock and files), so a
  // receipt reviews exactly one target and never stands in for another.
  const reviews = policy.redistribution_reviews;
  const review = reviews?.[target] ?? null;
  if (
    !reviews ||
    typeof reviews !== "object" ||
    Object.keys(reviews).some((name) => !RELEASE_TARGETS.includes(name)) ||
    Object.values(reviews).some((value) => !validReview(value)) ||
    (requireReview && !review)
  )
    throw new Error(
      `A human redistribution review of the exact staged ${target} licenses/inventory.json is required. Do not invent or auto-approve this receipt.`,
    );
  const windowsPublisher = packs?.windows ?? null;
  if (target === "win32-x64" && !validWindowsPublisher(windowsPublisher))
    throw new Error(
      "Configure the reviewed Windows Artifact Signing publisher in runtime/feature-pack-releases.json; unsigned builds are not releases.",
    );
  const packReleases = packs.packs;
  if (
    !packReleases ||
    Object.keys(packReleases).sort().join(",") !==
      "expanded-included-content" ||
    Object.values(packReleases).some(
      (pack) => !["active", "deferred"].includes(pack?.release_status),
    )
  )
    throw new Error(
      "Every supported feature pack requires an explicit active or deferred release status.",
    );
  // A build that never checks for updates cannot keep a pack current either.
  if (
    policy.updates === "ended" &&
    Object.values(packReleases).some((pack) => pack.release_status === "active")
  )
    throw new Error(
      "Updates have ended in runtime/release-policy.json, so no feature pack can be active.",
    );
  return {
    policy,
    target,
    review,
    publisher,
    windowsPublisher,
    version,
    packReleases,
    activePackIds: Object.keys(packReleases)
      .filter((id) => packReleases[id].release_status === "active")
      .sort(),
    distribution: selected,
    packReleaseBase: releaseTagBase(selected, `v${version}`),
    updatePolicy: {
      schema: "animama-update-policy/3",
      distribution:
        selected.name === "r2"
          ? { kind: "r2", base_url: selected.base_url }
          : { kind: "github", owner: selected.owner, repo: selected.repo },
      channel: "stable",
      // Sealed into the signed runtime; an installed app has no other switch.
      updates: policy.updates,
      // Installed apps accept updates only from their own platform's publisher.
      ...(target === "win32-x64"
        ? {
            windows_publisher: {
              certificate_subject: windowsPublisher.certificate_subject,
              identity_validation_eku: windowsPublisher.identity_validation_eku,
            },
          }
        : { team_id: publisher.team_id }),
    },
  };
}

export function loadReleasePolicy(options) {
  return validateReleasePolicy(
    readJson(releasePolicyPath),
    readJson(path.join(sourceRoot, "feature-pack-releases.json")),
    readJson(path.join(desktopRoot, "package.json")).version,
    options,
  );
}

/** Publication alone requires anonymous access; credentials must never make this check pass. */
export async function isPublicReleaseRepository({ owner, repo }) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      },
    );
    return response.ok && (await response.json()).private === false;
  } catch {
    // Network/JSON/redirect failures cannot grant permission to publish.
    return false;
  }
}

/**
 * Targets that are only ever built from source. They are not release targets:
 * no publisher, no redistribution review and no update feed.
 */
const SOURCE_BUILD_TARGETS = ["linux-x64"];

/**
 * The policy a source build seals: the distribution its pack catalog names,
 * updates ended, and no publisher to accept an update from.
 */
export function sourceBuildUpdatePolicy({ schema, distribution, channel }) {
  return { schema, distribution, channel, updates: "ended" };
}

/** Staging seals the selected distribution and the target's publisher; it needs no redistribution review yet. */
export function stagedUpdatePolicy(target) {
  if (SOURCE_BUILD_TARGETS.includes(target))
    return sourceBuildUpdatePolicy(
      loadReleasePolicy({ requireReview: false }).updatePolicy,
    );
  return loadReleasePolicy({ requireReview: false, target }).updatePolicy;
}

/**
 * Pack URLs are pinned in the staged catalog: the derived release folder and
 * the distribution the runtime will check them against.
 */
export function stagedPackRelease() {
  const release = loadReleasePolicy({ requireReview: false });
  return {
    release_base_url: release.packReleaseBase,
    distribution: release.updatePolicy.distribution,
  };
}

/**
 * The distribution sealed into a staged or signed runtime. Reports record this
 * rather than the current environment, which may differ from the build's.
 */
export function sealedDistribution(runtime) {
  const distribution = readJson(
    path.join(runtime, "update-policy.json"),
  )?.distribution;
  if (!["r2", "github"].includes(distribution?.kind))
    throw new Error("The runtime has no sealed release distribution");
  return distribution;
}

/**
 * Ship the human receipt inside a runtime about to be signed, and point the
 * notices at it. The receipt is a decision about the exact inventory, not an
 * approval invented by the build; per-record labels stay as observed.
 */
export function embedRedistributionReview(runtime, release) {
  writeJson(path.join(runtime, "licenses/REDISTRIBUTION_REVIEW.json"), {
    schema: "animama-redistribution-review/1",
    ...release.review,
  });
  const notices = path.join(runtime, "licenses/THIRD_PARTY_NOTICES.txt");
  writeFileSync(
    notices,
    readFileSync(notices, "utf8").replace(
      "Development feasibility build. Redistribution approval is pending.",
      "Release inventory reviewed; see REDISTRIBUTION_REVIEW.json. Per-record review labels below are inventory-time observations.",
    ),
  );
}

export function verifyRedistributionReview(runtime, release) {
  if (
    !release.review ||
    sha256(path.join(runtime, "licenses/inventory.json")) !==
      release.review.inventory_sha256
  )
    throw new Error(
      "Redistribution review does not match the exact staged inventory. Review the changed dependencies/assets before releasing.",
    );
}
