import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  assertFrontendDependenciesCurrent,
  buildPython,
  cacheRoot,
  copyTree,
  desktopRoot,
  electronDist,
  executableSuffix,
  frontendRoot,
  nativeLockFile,
  normalizeTree,
  parseTarget,
  pnpmCommand,
  pythonEnvironment,
  readJson,
  removeFinderMetadata,
  repoRoot,
  run,
  sourceRoot,
  syncBuildEnvironment,
  writeJson,
} from "./common.mjs";
import {
  componentInventory,
  inventoryId,
  inventoryTree,
} from "./inventory.mjs";
import { writeLicenses } from "./licenses.mjs";
import { measure } from "./measure.mjs";
import { stageFeaturePacks } from "./feature-packs.mjs";
import { stagedUpdatePolicy } from "./release-policy.mjs";
import { excludeDesktopWebAssets } from "./desktop-web.mjs";
import { writeRedistributionReview } from "./review-packet.mjs";
import { importBundledTool } from "./bundled-tool.mjs";
import { sealReleaseModelManifests } from "./release-models.mjs";
import { buildProcessGuard } from "./process-guard.mjs";
import { measureMinimumOs } from "./linux-platform.mjs";
import { PRIVATE_PACKS, stagePack } from "./private-packs.mjs";

const target = parseTarget();
const sources = readJson(path.join(sourceRoot, "source-manifest.json"));
const app = readJson(path.join(desktopRoot, "package.json"));
const args = ["--platform", target.platform, "--arch", target.arch];
const env = pythonEnvironment();
// Only the strict, internally derived target may be removed. Build caches and
// all user/application state are outside this output directory.
rmSync(target.output, { recursive: true, force: true });
mkdirSync(target.runtime, { recursive: true });
const logged = (name, command, argv, options = {}) => {
  console.log(`Staging ${name}…`);
  const text = run(command, argv, {
    ...options,
    capture: true,
    logFile: path.join(target.output, `${name}.log`),
  });
  return text;
};

try {
  assertFrontendDependenciesCurrent();
  syncBuildEnvironment();
  logged(
    "starter-content",
    buildPython(),
    [
      path.join(repoRoot, "src/backend/packaging/desktop/stage_content.py"),
      "--output",
      target.output,
    ],
    { env },
  );
  const content = readJson(
    path.join(target.output, "starter-content-inventory.json"),
  );
  // Only a verified private build input is staged; release candidates set
  // each pack's require variable (for example ANIMAMA_REQUIRE_MIXAMO_MOTION=1)
  // so a missing pack fails the build.
  for (const definition of PRIVATE_PACKS) {
    const pack = stagePack({
      pack: definition,
      runtime: target.runtime,
      required: process.env[definition.requireEnv] === "1",
    });
    console.log(
      pack.staged
        ? `Staged the ${definition.label} pack (${pack.files} files)`
        : `No ${definition.label} build input; staging without it`,
    );
  }
  logged("postgresql-build", process.execPath, [
    path.join(desktopRoot, "scripts/runtime/native-build.mjs"),
    ...args,
  ]);
  // macOS has no guard: its services are started directly.
  if (target.platform !== "darwin") buildProcessGuard(target);
  logged(
    "backend-build",
    buildPython(),
    [
      "-m",
      "PyInstaller",
      "--noconfirm",
      "--clean",
      "--distpath",
      path.join(cacheRoot, "frozen", target.target),
      "--workpath",
      path.join(cacheRoot, "pyinstaller-work", target.target),
      path.join(repoRoot, "src/backend/packaging/desktop/animama-runtime.spec"),
    ],
    { env },
  );
  copyTree(
    path.join(cacheRoot, "frozen", target.target, "animama-runtime"),
    path.join(target.runtime, "backend"),
  );
  const resourceAudit = JSON.parse(
    logged(
      "backend-resource-audit",
      path.join(target.runtime, `backend/animama-runtime${executableSuffix}`),
      ["audit-resources"],
      { cwd: target.output, env },
    ),
  );
  const pnpm = (name, args) =>
    logged(name, ...pnpmCommand(args), { cwd: frontendRoot });
  pnpm("web-check", ["web:check"]);
  if (
    resourceAudit.local_http_schema_version !==
    sources.local_http_schema_version
  )
    throw new Error(
      "Frozen local HTTP schema differs from the runtime source manifest",
    );
  pnpm("web-build", [
    "--filter",
    "animama-web",
    "exec",
    "vite",
    "build",
    "--mode",
    "embedded-desktop",
    "--outDir",
    path.join(target.runtime, "web"),
  ]);
  excludeDesktopWebAssets(path.join(target.runtime, "web"));
  pnpm("desktop-build", ["desktop:build"]);
  removeFinderMetadata(path.join(target.runtime, "web"));
  mkdirSync(path.join(target.output, "app"), { recursive: true });
  copyTree(
    path.join(desktopRoot, "dist"),
    path.join(target.output, "app/dist"),
  );
  writeJson(path.join(target.output, "app/package.json"), {
    name: app.name,
    version: app.version,
    type: "module",
    main: "dist/main.js",
  });
  const electronPackage = readJson(
    path.join(desktopRoot, "node_modules/electron/package.json"),
  );
  if (electronPackage.version !== sources.electron)
    throw new Error(
      "Electron does not match the pinned runtime source manifest",
    );
  copyTree(electronDist(), path.join(target.output, "electron"), {
    preserveLinks: true,
  });
  normalizeTree(path.join(target.output, "app"));
  writeJson(path.join(target.runtime, "build-evidence.json"), {
    schema: "animama-desktop-build-evidence/1",
    esbuild: readJson(path.join(cacheRoot, "esbuild-meta.json")),
    app: componentInventory(path.join(target.output, "app")),
    electron: componentInventory(path.join(target.output, "electron")),
  });
  // Large files are resources, never developer node_modules or ASAR contents.
  writeJson(
    path.join(target.runtime, "update-policy.json"),
    stagedUpdatePolicy(`${target.platform}-${target.arch}`),
  );
  const licenses = writeLicenses(target, content);
  const { id: catalogId } = await stageFeaturePacks(target);
  sealReleaseModelManifests({ runtime: target.runtime });
  normalizeTree(target.runtime);
  normalizeTree(path.join(target.output, "app"));
  const inventory = inventoryTree(target.runtime);
  const native = readJson(nativeLockFile(target));
  const core = readJson(
    path.join(target.runtime, "content/included-core/inventory.json"),
  );
  console.log("Staging database schema fingerprint…");
  const { stagedSchemaDigest } = await importBundledTool(
    "scripts/runtime/schema-fingerprint.ts",
  );
  const databaseSchema = await stagedSchemaDigest(target.runtime);
  const manifest = {
    schema: "animama-desktop-runtime/2",
    app_version: app.version,
    build_id: inventoryId(inventory),
    platform: target.platform,
    architecture: target.arch,
    // Linux has no pinned minimum: it is whatever C library the staged
    // binaries, Electron's included, turned out to need on this machine.
    minimum_os:
      target.platform === "linux"
        ? measureMinimumOs([
            target.runtime,
            path.join(target.output, "app"),
            path.join(target.output, "electron"),
          ])
        : native.minimum_os,
    postgresql: {
      major: 16,
      version: native.postgresql.version,
      pgvector: native.pgvector.version,
    },
    alembic_head: resourceAudit.alembic_head,
    local_http_schema_version: sources.local_http_schema_version,
    core_content_inventory_id: core.id,
    pack_catalog_id: catalogId,
    database_schema_sha256: databaseSchema,
    files: inventory,
  };
  writeJson(path.join(target.runtime, "manifest.json"), manifest);
  normalizeTree(target.runtime);
  const sizes = await measure(target, manifest);
  console.log(
    `Runtime manifest: ${path.join(target.runtime, "manifest.json")}`,
  );
  console.table(sizes.components);
  console.log(
    `Redistribution review: ${licenses.pending_review.length} pending records; this is not a release artifact.`,
  );
  if (sizes.validation.failures.length)
    throw new Error(sizes.validation.failures.join("\n"));
  run(process.execPath, [
    path.join(desktopRoot, "scripts/runtime/audit.mjs"),
    ...args,
  ]);
  console.log(`Review packet: ${writeRedistributionReview(target)}`);
} catch (error) {
  writeJson(path.join(target.output, "stage-failure.json"), {
    schema: "animama-stage-failure/1",
    message: error instanceof Error ? error.message : String(error),
    complete: false,
  });
  console.error(
    `Runtime stage failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
