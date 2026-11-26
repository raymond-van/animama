import { copyFileSync } from "node:fs";
import path from "node:path";
import { desktopRoot, readJson, sha256, writeJson } from "./common.mjs";
import { loadReleasePolicy } from "./release-policy.mjs";
import {
  RELEASE_TARGETS,
  candidateDistribution,
  SHARED_RELEASE_NAMES,
  releaseName,
  verifyArtifactIndex,
  writeArtifactIndex,
  previewAssets,
} from "./release-artifacts.mjs";
import { PublicationError, verifyScanReceipt } from "./publication.mjs";
import { preflightGithub, publishGithub } from "./publish-github.mjs";
import { preflightR2, publishR2, r2Credentials } from "./publish-r2.mjs";
import { planReleaseModels } from "./release-models.mjs";
import {
  modelDistribution,
  publishModelObjects,
} from "./model-publication.mjs";
import {
  acceptsRequiredNameSmoke,
  validateManualAcceptance,
} from "./smoke-policy.mjs";

/** What differs when each target is promoted. */
const PUBLICATION = {
  "darwin-arm64": {
    acceptance: "ANIMAMA_MACOS_ACCEPTANCE",
    artifact: (version) => `Animama-${version}-arm64.dmg`,
    previewBody:
      "Public testing preview for macOS arm64. Native acceptance is NOT complete; this is not a stable update. Back up test data and see the attached notices and size reports.",
    stableBody:
      "Self-contained macOS arm64 application (macOS 15+). See the attached notices, checksums, size, and acceptance reports. Local data stays on your computer.",
  },
  "win32-x64": {
    acceptance: "ANIMAMA_WINDOWS_ACCEPTANCE",
    artifact: (version) => `Animama-${version}-x64-setup.exe`,
    previewBody:
      "Public testing preview for Windows x64 (Windows 10 22H2 or later). Native acceptance is NOT complete; this is not a stable update. Back up test data and see the attached notices and size reports.",
    stableBody:
      "Self-contained Windows x64 application (Windows 10 22H2 or later) with a per-user installer. See the attached notices, checksums, size, and acceptance reports. Local data stays on your computer.",
  },
};

/**
 * Promote one target's local candidate. Promotion is a separate, explicitly
 * authorized operation; builds never upload themselves. Each target publishes
 * its own files into the shared version folder or release, independently.
 */
export async function publishRelease(target, args) {
  const spec = PUBLICATION[target];
  const operation = args.join(" ");
  if (
    !["--confirm-publication", "--confirm-preview-publication"].includes(
      operation,
    )
  )
    throw new PublicationError(
      "Use --confirm-preview-publication for explicitly approved public testing, or --confirm-publication with the exact human acceptance receipt",
    );
  const preview = operation === "--confirm-preview-publication";
  const releaseBody = preview ? spec.previewBody : spec.stableBody;
  const release = loadReleasePolicy({ target });
  const directory = path.join(desktopRoot, "release/publish");
  // The candidate's sealed feed and pack URLs decide where it may be published.
  // A signing rehearsal records none, so it can never be published.
  const built = candidateDistribution(directory, target);
  if (
    !built ||
    JSON.stringify(built) !== JSON.stringify(release.updatePolicy.distribution)
  )
    throw new PublicationError(
      "The candidate was built for a different distribution than ANIMAMA_RELEASE_DISTRIBUTION selects, or records none; publish with the selection used to build it",
    );
  const { feed } = RELEASE_TARGETS[target];
  // Anonymous checks run before preparing promotion reports or reading
  // credentials. A local candidate build deliberately contacts neither host.
  if (built.kind === "r2")
    await preflightR2({
      distribution: built,
      version: release.version,
      feed,
    });
  else await preflightGithub(release.distribution);
  const index = verifyArtifactIndex(directory, target);
  if (index.app_version !== release.version)
    throw new PublicationError("Release version mismatch");
  verifyScanReceipt(directory, index.files, target);
  // Validate every dependency before credentials or writes. These references
  // come from the sealed app, including its frozen backend catalog.
  const models = modelDistribution(release.policy);
  const modelCandidates = planReleaseModels({
    directory,
    origin: models.origin,
    target,
  });
  const artifactSha256 = sha256(
    path.join(directory, spec.artifact(release.version)),
  );
  const receipt = preview
    ? null
    : validateManualAcceptance(
        JSON.parse(process.env[spec.acceptance] ?? "null"),
        artifactSha256,
        release.version,
        target,
        { packs: release.activePackIds.length > 0 },
      );
  const names = index.files.map((file) => file.name);
  const folder = path.join(desktopRoot, "release/smoke-name");
  const smoke = readJson(path.join(folder, "smoke-report.json"));
  const network = readJson(path.join(folder, "network-report.json"));
  if (
    !acceptsRequiredNameSmoke(smoke, network, {
      artifactSha256,
      runtimeBuildId: index.runtime_build_id,
      target,
    })
  )
    throw new PublicationError(
      "The fresh-profile smoke must reject blank names and complete named setup for this exact artifact",
    );
  for (const kind of preview ? [] : ["smoke", "network"]) {
    const name = releaseName(target, `${kind}-name-report.json`);
    copyFileSync(
      path.join(folder, `${kind}-report.json`),
      path.join(directory, name),
    );
    names.push(name);
  }
  if (!preview) {
    const name = releaseName(target, "manual-acceptance.json");
    writeJson(path.join(directory, name), receipt);
    names.push(name);
  }
  const final = preview
    ? index
    : writeArtifactIndex(
        directory,
        release.version,
        names,
        {
          runtime_build_id: index.runtime_build_id,
          smoke_verified: true,
          manual_verified: true,
        },
        target,
      );
  const files = preview
    ? previewAssets(final, target)
    : [
        ...final.files,
        ...["release-artifacts.json", "SHA256SUMS.txt"].map((base) => {
          const name = releaseName(target, base);
          return { name, sha256: sha256(path.join(directory, name)) };
        }),
      ];
  // Both app transports depend on the same immutable model origin. A failed
  // upload or anonymous verification leaves the app and stable feed untouched.
  const credentials = r2Credentials();
  for (const candidate of modelCandidates)
    await publishModelObjects({
      directory: candidate.directory,
      planned: candidate.planned,
      bucket: models.bucket,
      credentials,
    });
  if (built.kind === "r2")
    await publishR2({
      distribution: built,
      bucket: release.distribution.bucket,
      version: release.version,
      directory,
      files,
      preview,
      credentials,
      feed,
      // The other target may already have published these shared names;
      // they are checked before anything is uploaded.
      shared: SHARED_RELEASE_NAMES,
    });
  else
    await publishGithub({
      distribution: release.distribution,
      version: release.version,
      directory,
      files,
      preview,
      releaseBody,
      target,
    });
  console.log(
    preview
      ? `Published Animama ${release.version} (${target}) for testing only. Stable feed and promotion remain gated on native acceptance.`
      : `Published verified Animama ${release.version} (${target}) to the configured ${built.kind === "r2" ? "R2 distribution" : "public release repository"}.`,
  );
}

/** Command-line entry: only our own bounded summaries reach the console. */
export async function runPublication(target) {
  try {
    await publishRelease(target, process.argv.slice(2));
  } catch (error) {
    // fetch/stream errors can include credentials or host paths.
    console.error(
      error instanceof PublicationError
        ? error.message
        : "Release publication failed; inspect the draft/preview and private CI state before retrying.",
    );
    process.exitCode = 1;
  }
}
