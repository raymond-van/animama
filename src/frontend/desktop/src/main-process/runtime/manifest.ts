import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { release } from "node:os";
import { RuntimeError } from "./errors.js";

export type RuntimeManifest = {
  schema: "animama-desktop-runtime/2";
  app_version: string;
  build_id: string;
  platform: string;
  architecture: string;
  minimum_os: string;
  postgresql: { major: number; version: string; pgvector: string };
  alembic_head: string;
  local_http_schema_version: number;
  core_content_inventory_id: string;
  pack_catalog_id: string;
  /** SHA-256 of the normalized schema dump of a freshly bootstrapped database. */
  database_schema_sha256: string;
  files: {
    path: string;
    size_bytes: number;
    sha256: string;
    mode: string;
    critical: boolean;
    component: string;
  }[];
};

/** Windows runs every owned process inside this guard's kill-on-close job. */
export const PROCESS_GUARD_PATH = "bin/animama-process-guard.exe";

/**
 * The lowest Windows build Animama accepts: Windows 10 version 1903, the
 * oldest build a shipped component needs (PostgreSQL's UTF-8 code page). The
 * installer (`build/installer.nsh`) and the staged runtime manifest carry the
 * same build. The documentation claims only Windows 10 22H2 (19045) and
 * Windows 11; builds from 1903 are accepted but not claimed.
 */
const WINDOWS_MINIMUM_BUILD = 18362;

/** Minimum OS and executable naming for each supported runtime platform. */
export function runtimePlatform(platform: string): {
  minimumOs: string;
  executableSuffix: string;
} {
  return platform === "win32"
    ? { minimumOs: `10.0.${WINDOWS_MINIMUM_BUILD}`, executableSuffix: ".exe" }
    : { minimumOs: "15.0", executableSuffix: "" };
}

/**
 * Node reports the kernel release, not the product version: macOS 15 is
 * Darwin 24, and Windows 10 and 11 are both 10.0 with a build number.
 */
export function supportsRuntimePlatform(
  platform: string,
  architecture: string,
  kernelRelease: string,
): boolean {
  if (platform === "darwin" && architecture === "arm64")
    return (
      /^\d+\.\d+\.\d+$/u.test(kernelRelease) &&
      Number(kernelRelease.split(".")[0]) >= 24
    );
  if (platform === "win32" && architecture === "x64")
    return (
      /^10\.0\.\d+$/u.test(kernelRelease) &&
      Number(kernelRelease.split(".")[2]) >= WINDOWS_MINIMUM_BUILD
    );
  return false;
}

function portable(name: string): boolean {
  return (
    Boolean(name) &&
    name === name.normalize("NFC") &&
    !/[\\:\x00-\x1f]/u.test(name) &&
    !name.split("/").some((part) => ["", ".", ".."].includes(part))
  );
}

/** Validate packaged resources before native execution; signing is a later release gate. */
export async function verifyRuntime(
  root: string,
  appVersion: string,
  full = false,
): Promise<RuntimeManifest> {
  try {
    const rootPath = await realpath(root);
    if (
      rootPath !== path.resolve(root) ||
      !(await lstat(rootPath)).isDirectory()
    )
      throw new Error();
    const manifestFile = path.join(root, "manifest.json");
    const metadata = await lstat(manifestFile);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 16 * 1024 * 1024
    )
      throw new Error();
    const manifest = JSON.parse(
      await readFile(manifestFile, "utf8"),
    ) as RuntimeManifest;
    if (
      manifest.schema !== "animama-desktop-runtime/2" ||
      manifest.app_version !== appVersion ||
      manifest.platform !== process.platform ||
      manifest.architecture !== process.arch ||
      manifest.postgresql?.major !== 16 ||
      !/^16\.\d+$/u.test(manifest.postgresql?.version) ||
      !/^\d+\.\d+\.\d+$/u.test(manifest.postgresql?.pgvector) ||
      manifest.minimum_os !== runtimePlatform(process.platform).minimumOs ||
      !/^[a-f0-9]{64}$/u.test(manifest.core_content_inventory_id) ||
      !/^[a-f0-9]{64}$/u.test(manifest.pack_catalog_id) ||
      !/^[a-f0-9]{64}$/u.test(manifest.database_schema_sha256) ||
      manifest.local_http_schema_version !== 1 ||
      Object.hasOwn(manifest, "gateway_schema_version") ||
      !Array.isArray(manifest.files) ||
      manifest.files.length < 1 ||
      manifest.files.length > 50_000 ||
      !/^[a-f0-9]{64}$/u.test(manifest.build_id) ||
      !/^[a-zA-Z0-9_]{1,128}$/u.test(manifest.alembic_head)
    )
      throw new Error();
    if (!supportsRuntimePlatform(process.platform, process.arch, release()))
      throw new RuntimeError("unsupported_runtime_platform");
    if (
      createHash("sha256")
        .update(JSON.stringify(manifest.files))
        .digest("hex") !== manifest.build_id
    )
      throw new Error();
    const seen = new Set<string>();
    const directories = new Set<string>([rootPath]);
    let previous = "";
    for (const file of manifest.files) {
      if (
        typeof file.path !== "string" ||
        !portable(file.path) ||
        file.path <= previous ||
        seen.has(file.path.toLowerCase()) ||
        !Number.isSafeInteger(file.size_bytes) ||
        file.size_bytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(file.sha256) ||
        !["0644", "0755"].includes(file.mode) ||
        typeof file.critical !== "boolean" ||
        /better[-_]auth|(?:^|\/)\.env(?:\.|$)|\.DS_Store$/iu.test(file.path)
      )
        throw new Error();
      seen.add(file.path.toLowerCase());
      previous = file.path;
      // Native executables, Python code/data, migrations, manifests and browser
      // executable code are critical even if an incorrect builder flag says otherwise.
      const critical =
        file.critical ||
        file.path.startsWith("backend/") ||
        file.path.startsWith("postgres/") ||
        file.path.startsWith("content/included-core/") ||
        /\.(?:json|sql|js|mjs|cjs|html|wasm)$/u.test(file.path);
      if (!full && !critical) continue;
      const absolute = path.join(rootPath, file.path);
      let folder = path.dirname(absolute);
      while (!directories.has(folder)) {
        const stat = await lstat(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
        directories.add(folder);
        folder = path.dirname(folder);
      }
      const stat = await lstat(absolute);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size !== file.size_bytes ||
        // Windows has no POSIX modes; its size and hash are still checked.
        (process.platform !== "win32" &&
          (stat.mode & 0o777) !== Number.parseInt(file.mode, 8))
      )
        throw new Error();
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      if (hash.digest("hex") !== file.sha256) throw new Error();
    }
    const { executableSuffix } = runtimePlatform(process.platform);
    for (const required of [
      ...[
        "backend/animama-runtime",
        "postgres/bin/postgres",
        "postgres/bin/initdb",
        "postgres/bin/pg_ctl",
        "postgres/bin/pg_isready",
        "postgres/bin/pg_dump",
        "postgres/bin/pg_restore",
      ].map((name) => `${name}${executableSuffix}`),
      ...(process.platform === "win32" ? [PROCESS_GUARD_PATH] : []),
      "web/index.html",
      "content/included-core/inventory.json",
      "pack-catalog.json",
    ])
      if (!seen.has(required)) throw new Error();
    // These bounded documents are already hash-checked above. Their identifiers
    // must also agree with the composition selected by this manifest.
    for (const [name, expectedId] of [
      [
        "content/included-core/inventory.json",
        manifest.core_content_inventory_id,
      ],
      ["pack-catalog.json", manifest.pack_catalog_id],
    ]) {
      if ((await lstat(path.join(rootPath, name))).size > 8 * 1024 * 1024)
        throw new Error();
      const inventory = JSON.parse(
        await readFile(path.join(rootPath, name), "utf8"),
      );
      if (inventory.id !== expectedId) throw new Error();
    }
    return manifest;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError("runtime_manifest_invalid");
  }
}
