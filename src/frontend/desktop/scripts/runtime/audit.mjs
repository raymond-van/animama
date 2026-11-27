import { existsSync, lstatSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildPython,
  buildRoot,
  executableSuffix,
  filesIn,
  nativeLockFile,
  parseTarget,
  pythonEnvironment,
  readJson,
  repoRoot,
  run,
  sha256,
  sourceRoot,
  writeJson,
} from "./common.mjs";
import {
  assertInventory,
  componentInventory,
  inventoryId,
} from "./inventory.mjs";
import { assertBundledImports } from "./js-audit.mjs";
import { validateSizeReport } from "./size.mjs";
import { auditLinuxStage, compiledOnLinux } from "./linux-platform.mjs";
import { auditMacosMinimum } from "./macos-platform.mjs";
import { msvcEnvironment } from "./windows-build.mjs";
import { auditWindowsStage } from "./windows-platform.mjs";
import {
  assertDesktopWebAssets,
  assertNoHomeDirectoryPaths,
  assertNoIncludedAliasCopies,
} from "./desktop-web.mjs";
import { resolveBrowserRuntimeAssets } from "../../../scripts/browser-runtime-assets.mjs";

const target = parseTarget();
const env = pythonEnvironment();
// A failed current audit must not leave an older success receipt in place.
rmSync(path.join(target.output, "audit-report.json"), { force: true });
try {
  const nativeLock = readJson(nativeLockFile(target));
  if (existsSync(path.join(target.output, "stage-failure.json")))
    throw new Error(
      "Staging failed; correct the error and run a fresh stage before auditing",
    );
  const manifest = readJson(path.join(target.runtime, "manifest.json"));
  if (
    manifest.platform !== target.platform ||
    manifest.architecture !== target.arch
  )
    throw new Error("Manifest target mismatch");
  const pinnedMinimum = readJson(path.join(sourceRoot, "source-manifest.json"))
    .targets[target.target]?.minimum_os;
  // A Linux stage measures its minimum; the lock and source manifest carry
  // the marker `glibc`, and the measured value is checked again below.
  if (
    nativeLock.minimum_os !== pinnedMinimum ||
    (target.platform === "linux"
      ? pinnedMinimum !== "glibc" ||
        !/^glibc-\d+\.\d+$/u.test(manifest.minimum_os)
      : manifest.minimum_os !== pinnedMinimum)
  )
    throw new Error("Minimum OS target changed; run a fresh runtime stage");
  run(
    buildPython(),
    [
      path.join(
        repoRoot,
        "src/backend/packaging/desktop/validate_manifests.py",
      ),
      "--runtime",
      target.runtime,
    ],
    { env },
  );
  assertInventory(target.runtime, manifest.files);
  assertDesktopWebAssets(path.join(target.runtime, "web"));
  await assertNoHomeDirectoryPaths(path.join(target.runtime, "web"));
  if (inventoryId(manifest.files) !== manifest.build_id)
    throw new Error("Manifest inventory ID mismatch");
  console.log(
    `Manifest: ${manifest.files.length} files; missing/unexpected: 0`,
  );
  const buildEvidence = readJson(
    path.join(target.runtime, "build-evidence.json"),
  );
  assertBundledImports(buildEvidence.esbuild);
  for (const part of ["app", "electron"]) {
    if (
      JSON.stringify(componentInventory(path.join(target.output, part))) !==
      JSON.stringify(buildEvidence[part])
    )
      throw new Error(`Staged ${part} differs from the build evidence`);
  }
  // Check native compatibility before executing any staged binary: macOS
  // deployment minimums (compiler flags cannot lower a prebuilt wheel's), or
  // where every Windows PE import resolves.
  const roots = {
    runtime: target.runtime,
    app: path.join(target.output, "app"),
    electron: path.join(target.output, "electron"),
  };
  const componentFiles = {
    runtime: manifest.files.map((entry) => entry.path),
    ...Object.fromEntries(
      ["app", "electron"].map((part) => [
        part,
        buildEvidence[part]
          .filter((entry) => entry.type === "file")
          .map((entry) => entry.path),
      ]),
    ),
  };
  const nativePlatforms =
    target.platform === "win32"
      ? auditWindowsStage(roots, componentFiles, {
          systemDlls: nativeLock.system_dlls,
          env: msvcEnvironment(nativeLock.toolchain).env,
        })
      : target.platform === "linux"
        ? auditLinuxStage(roots, componentFiles, {
            compiled: compiledOnLinux,
            systemLibraries: nativeLock.system_libraries,
            buildPaths: [repoRoot, buildRoot, homedir()],
          })
        : Object.fromEntries(
            Object.entries(componentFiles).map(([part, names]) => [
              part,
              auditMacosMinimum(roots[part], names, manifest.minimum_os),
            ]),
          );
  if (
    target.platform === "linux" &&
    nativePlatforms.minimum_os !== manifest.minimum_os
  )
    throw new Error(
      `Staged binaries need ${nativePlatforms.minimum_os}, but the manifest says ${manifest.minimum_os}; run a fresh runtime stage`,
    );
  const nativeHook = "dist/native/animama_input_hook.node";
  const stagedNativeFiles = filesIn(
    path.join(target.output, "app/dist/native"),
  );
  if (
    JSON.stringify(stagedNativeFiles) !==
    JSON.stringify(["animama_input_hook.node"])
  )
    throw new Error("First-party global input hook inventory is incomplete");
  const electron = path.join(
    target.output,
    target.platform === "win32"
      ? "electron/electron.exe"
      : target.platform === "linux"
        ? "electron/electron"
        : "electron/Electron.app/Contents/MacOS/Electron",
  );
  const electronEvidence = JSON.parse(
    run(
      electron,
      [
        "-e",
        'console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,zstd:typeof require("node:zlib").createZstdDecompress}))',
      ],
      { env: { ELECTRON_RUN_AS_NODE: "1" }, capture: true },
    ),
  );
  if (electronEvidence.zstd !== "function")
    throw new Error("Pinned Electron cannot decode zstd feature packs");
  run(
    electron,
    [
      "-e",
      `const addon=require("./${nativeHook}"); const names=["start","stop","isSupported","permissionGranted","requestPermission"]; if(names.some(name=>typeof addon[name]!=="function")) process.exit(1);`,
    ],
    {
      cwd: path.join(target.output, "app"),
      env: { ELECTRON_RUN_AS_NODE: "1" },
      capture: true,
    },
  );
  const executable = path.join(
    target.runtime,
    `backend/animama-runtime${executableSuffix}`,
  );
  const resources = JSON.parse(
    run(executable, ["audit-resources"], {
      cwd: target.output,
      env,
      capture: true,
    }),
  );
  if (
    !resources.frozen ||
    resources.alembic_head !== manifest.alembic_head ||
    resources.local_http_schema_version !== manifest.local_http_schema_version
  )
    throw new Error("Frozen resource/head audit mismatch");
  const coreRoot = path.join(target.runtime, "content/included-core");
  const content = JSON.parse(
    run(executable, ["content", "audit"], {
      cwd: target.output,
      env: { ...env, ANIMAMA_DESKTOP_INCLUDED_ROOT: coreRoot },
      capture: true,
    }),
  );
  if (
    content.id !== manifest.core_content_inventory_id ||
    content.starters.some((starter) => starter.diagnostics.length)
  )
    throw new Error("Staged starter closure differs from the manifest");
  console.log("Annie + Andrew: zero content diagnostics");
  const publicRoot = path.join(repoRoot, "src/frontend/web/public");
  assertNoIncludedAliasCopies(path.join(target.runtime, "web"), publicRoot);
  for (const model of [
    "parakeet-tdt-0.6b-v2",
    "parakeet-tdt-0.6b-v2-webgpu",
    "sensevoice-small",
    "sensevoice-small-webgpu",
  ])
    if (existsSync(path.join(target.runtime, "web/onnx/models", model)))
      throw new Error(
        "Speech-to-text models must remain outside core web assets",
      );
  // The standalone output must retain every reviewed model and ORT variant.
  resolveBrowserRuntimeAssets({ builtRoot: path.join(target.runtime, "web") });
  // Small vendored runtime code, provider marks and stage scenes stay source-bound.
  for (const prefix of ["tts", "basis", "provider-logos", "background"])
    for (const name of filesIn(path.join(publicRoot, prefix))) {
      if (
        sha256(path.join(publicRoot, prefix, name)) !==
        sha256(path.join(target.runtime, "web", prefix, name))
      )
        throw new Error("Browser runtime asset omitted or changed");
    }
  const postgres = JSON.parse(
    run(
      buildPython(),
      [
        path.join(repoRoot, "src/backend/packaging/desktop/probe_postgres.py"),
        "--runtime",
        target.runtime,
      ],
      { env, capture: true },
    ),
  );
  if (
    postgres.pgvector_version !== manifest.postgresql.pgvector ||
    postgres.alembic_head !== manifest.alembic_head ||
    postgres.backup_restore_verified !== true
  )
    throw new Error("PostgreSQL probe version mismatch");
  console.log(
    `Fresh cluster: SELECT extversion FROM pg_extension WHERE extname = 'vector' => ${postgres.pgvector_version}`,
  );
  console.log(
    "Native backup restore: principal, schema, extension and snapshot rows preserved",
  );
  const report = readJson(path.join(target.output, "size-report.json"));
  const installedBytes =
    manifest.files.reduce((total, file) => total + file.size_bytes, 0) +
    lstatSync(path.join(target.runtime, "manifest.json")).size +
    [...buildEvidence.app, ...buildEvidence.electron].reduce(
      (total, file) => total + file.size_bytes,
      0,
    );
  if (
    installedBytes !== report.installed_bytes ||
    report.components.reduce(
      (total, item) => total + item.installed_bytes,
      0,
    ) !== installedBytes
  )
    throw new Error("Size report does not describe the staged installed bytes");
  const archive = path.join(target.output, "core-feasibility.tar.zst");
  if (
    sha256(archive) !== report.archive_sha256 ||
    lstatSync(archive).size !== report.download_bytes
  )
    throw new Error("Size report archive mismatch");
  const sizes = validateSizeReport(report);
  if (sizes.failures.length) throw new Error(sizes.failures.join("\n"));
  console.log(
    `Core download: ${report.download_bytes} / 786432000; installed: ${report.installed_bytes} / 1610612736`,
  );
  console.log(`Component regression baseline: ${sizes.regression_baseline}`);
  const licenses = readJson(
    path.join(target.runtime, "licenses/inventory.json"),
  );
  writeJson(path.join(target.output, "audit-report.json"), {
    schema: "animama-runtime-audit/1",
    build_id: manifest.build_id,
    electron: electronEvidence,
    native_platforms: nativePlatforms,
    resources,
    postgres,
    missing_files: 0,
    unexpected_files: 0,
    compatibility_aliases: 0,
    pending_license_reviews: licenses.pending_review.length,
    release_ready: false,
  });
  console.log(
    `Release gate remains closed (${licenses.pending_review.length} pending license records; signed-release acceptance is separate).`,
  );
  console.log("runtime audit: OK");
} catch (error) {
  console.error(
    `Runtime audit failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
