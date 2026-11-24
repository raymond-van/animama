import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { cpus } from "node:os";
import {
  cacheRoot,
  downloadVerified,
  filesIn,
  nativeLockFile,
  normalizeTree,
  readJson,
  run,
  sha256,
  writeJson,
} from "./common.mjs";
import { buildPostgresLinux } from "./native-linux.mjs";
import { buildPostgresWindows } from "./native-windows.mjs";

// Configure-time paths are compiled into PostgreSQL. Build against this neutral
// prefix and install through DESTDIR so the build machine's directories never
// ship; the relocatable binaries resolve their files relative to bin/ at runtime.
// The prefix must not contain "postgres" or "pgsql", or configure drops the
// postgresql/ subdirectories that staging expects.
const INSTALL_PREFIX = "/opt/animama";
const installedRoot = (work) => path.join(work, "destdir", INSTALL_PREFIX);

export function buildPostgres(target) {
  if (target.platform === "win32") return buildPostgresWindows(target);
  if (target.platform === "linux") return buildPostgresLinux(target);
  return buildPostgresMacos(target);
}

/** Build pinned sources with the Xcode toolchain, never a Homebrew database. */
function buildPostgresMacos(target) {
  const lock = readJson(nativeLockFile(target));
  if (lock.target !== target.target)
    throw new Error("No native component lock for this target");
  const work = path.join(cacheRoot, "native-build", target.target);
  const downloads = path.join(cacheRoot, "downloads");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const [name, component] of [
    ["postgresql", lock.postgresql],
    ["pgvector", lock.pgvector],
  ]) {
    const suffix = name === "postgresql" ? "tar.bz2" : "tar.gz";
    const archive = downloadVerified(
      component.url,
      component.sha256,
      path.join(downloads, `${name}-${component.version}.${suffix}`),
    );
    // Source archives are exact, digest-pinned upstream inputs, not user packs.
    run("tar", ["-xf", archive, "-C", work]);
  }
  const prefix = installedRoot(work);
  const destdir = `DESTDIR=${path.join(work, "destdir")}`;
  const pg = path.join(work, `postgresql-${lock.postgresql.version}`);
  const vector = path.join(work, `pgvector-${lock.pgvector.version}`);
  const jobs = String(Math.min(cpus().length, 8));
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CC: "clang",
    CFLAGS: lock.postgresql.cflags,
    MACOSX_DEPLOYMENT_TARGET: lock.minimum_os,
  };
  run(
    path.join(pg, "configure"),
    [`--prefix=${INSTALL_PREFIX}`, ...lock.postgresql.configure],
    { cwd: pg, env },
  );
  run("make", ["-j", jobs], { cwd: pg, env });
  run("make", ["install", destdir], { cwd: pg, env });
  run("make", ["-j", jobs, "install", destdir], {
    cwd: path.join(pg, "contrib", "pg_trgm"),
    env,
  });
  // pg_config is relocatable: from the DESTDIR copy it reports DESTDIR paths.
  // Those absolute header paths reach __FILE__ in the extension, so map the
  // build tree away. PostgreSQL itself compiles with relative include paths,
  // and it records its build flags, so it must not receive this flag.
  const prefixMap = `-ffile-prefix-map=${work}=.`;
  const vectorMake = lock.pgvector.make.map((arg) =>
    arg.startsWith("CFLAGS=") ? `${arg} ${prefixMap}` : arg,
  );
  if (!vectorMake.some((arg) => arg.endsWith(prefixMap)))
    throw new Error("The pgvector make inputs need a CFLAGS= entry");
  run(
    "make",
    ["-j", jobs, "install", `PG_CONFIG=${prefix}/bin/pg_config`, ...vectorMake],
    { cwd: vector, env },
  );

  return stagePostgres(target, lock, work);
}

/** Keep only the server/client closure and builtin language/text/encoding support. */
function stagePostgres(target, lock, work) {
  const prefix = installedRoot(work);
  const pg = path.join(work, `postgresql-${lock.postgresql.version}`);
  const vector = path.join(work, `pgvector-${lock.pgvector.version}`);

  const dest = path.join(target.runtime, "postgres");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.join(dest, "bin"), { recursive: true });
  mkdirSync(path.join(dest, "lib"), { recursive: true });
  for (const binary of lock.executables)
    cpSync(path.join(prefix, "bin", binary), path.join(dest, "bin", binary));
  // Only libpq and its version aliases plus the two required server extensions.
  for (const name of ["libpq.5.dylib", "libpq.dylib"]) {
    copyFileSync(path.join(prefix, "lib", name), path.join(dest, "lib", name));
  }
  mkdirSync(path.join(dest, "lib", "postgresql"), { recursive: true });
  for (const name of lock.extensions) {
    copyFileSync(
      path.join(prefix, "lib", "postgresql", `${name}.dylib`),
      path.join(dest, "lib", "postgresql", `${name}.dylib`),
    );
  }
  cpSync(path.join(prefix, "share"), path.join(dest, "share"), {
    recursive: true,
    dereference: true,
  });
  const ext = path.join(dest, "share", "postgresql", "extension");
  for (const file of filesIn(ext)) {
    if (
      !lock.extensions.some(
        (name) => file === `${name}.control` || file.startsWith(`${name}--`),
      )
    )
      rmSync(path.join(ext, file));
  }
  // PL/pgSQL is needed by the schema and initdb. It is a core language, not a pack.
  for (const file of ["plpgsql.control", "plpgsql--1.0.sql"]) {
    cpSync(
      path.join(prefix, "share", "postgresql", "extension", file),
      path.join(ext, file),
    );
  }
  copyFileSync(
    path.join(prefix, "lib", "postgresql", "plpgsql.dylib"),
    path.join(dest, "lib", "postgresql", "plpgsql.dylib"),
  );
  for (const file of readdirSync(path.join(prefix, "lib", "postgresql"))) {
    if (
      file === "dict_snowball.dylib" ||
      /(?:_and_|euc2004_sjis2004).*\.dylib$/u.test(file)
    ) {
      copyFileSync(
        path.join(prefix, "lib", "postgresql", file),
        path.join(dest, "lib", "postgresql", file),
      );
    }
  }

  const symbols = path.join(target.output, "symbols", "postgres");
  mkdirSync(symbols, { recursive: true });
  for (const relative of filesIn(dest).filter(
    (name) => name.startsWith("bin/") || /\.(dylib|so)$/.test(name),
  )) {
    const file = path.join(dest, relative);
    run("dsymutil", [
      file,
      "-o",
      path.join(symbols, `${relative.replaceAll("/", "_")}.dSYM`),
    ]);
    const links = run("otool", ["-L", file], { capture: true });
    for (const line of links.split("\n").slice(1)) {
      const linked = line.trim().split(" (", 1)[0];
      if (linked.startsWith(`${INSTALL_PREFIX}/`)) {
        const installed = path.posix.relative(INSTALL_PREFIX, linked);
        const relocated = path.posix.relative(
          path.posix.dirname(relative),
          installed,
        );
        run("install_name_tool", [
          "-change",
          linked,
          `@loader_path/${relocated}`,
          file,
        ]);
      } else if (
        linked &&
        !linked.startsWith("/usr/lib/") &&
        !linked.startsWith("/System/Library/")
      ) {
        throw new Error(`Unbundled PostgreSQL library: ${linked}`);
      }
    }
    if (relative.endsWith(".dylib"))
      run("install_name_tool", ["-id", `@rpath/${path.basename(file)}`, file]);
    run("strip", ["-S", file]);
    run("codesign", ["--force", "--sign", "-", file]);
  }
  const licenseDir = path.join(target.runtime, "licenses", "native");
  mkdirSync(licenseDir, { recursive: true });
  for (const [name, folder, item] of [
    ["postgresql", pg, lock.postgresql],
    ["pgvector", vector, lock.pgvector],
  ]) {
    cpSync(
      path.join(folder, item.license_file),
      path.join(licenseDir, `${name}.txt`),
    );
  }
  writeJson(path.join(target.output, "native-build.json"), {
    lock_sha256: sha256(nativeLockFile(target)),
    target: target.target,
    compiler: run("clang", ["--version"], { capture: true }).split("\n")[0],
    sdk: run("xcrun", ["--show-sdk-version"], { capture: true }).trim(),
    system_libraries_only: true,
  });
  normalizeTree(dest);
  return lock;
}
