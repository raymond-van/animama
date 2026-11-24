import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
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

// The same neutral prefix as the macOS build: configure-time paths are compiled
// into PostgreSQL, and the relocatable binaries find their files relative to
// bin/ at run time. It must not contain "postgres" or "pgsql".
const INSTALL_PREFIX = "/opt/animama";

/**
 * The files of an installed PostgreSQL tree that the runtime ships: the
 * server and client programs, libpq, the two extensions, PL/pgSQL, the
 * snowball dictionary and the encoding conversions. Returns
 * `[installed path, staged path]` pairs relative to the prefix and to
 * `runtime/postgres`.
 */
export function linuxPostgresClosure(lock, libraries) {
  const extensions = [...lock.extensions, "plpgsql", "dict_snowball"];
  return [
    ...lock.executables.map((name) => [`bin/${name}`, `bin/${name}`]),
    // The dynamic linker asks for the SONAME; its symlinks are not staged.
    ["lib/libpq.so.5", "lib/libpq.so.5"],
    ...libraries
      .filter(
        (name) =>
          name.endsWith(".so") &&
          (extensions.includes(name.slice(0, -3)) ||
            /(?:_and_|euc2004_sjis2004)/u.test(name)),
      )
      .sort()
      .map((name) => [`lib/postgresql/${name}`, `lib/postgresql/${name}`]),
  ];
}

/**
 * Build the pinned PostgreSQL and pgvector sources with the system compiler
 * and stage the closure the runtime needs. Nothing is taken from a
 * distribution's PostgreSQL package, so the result depends only on the C
 * library.
 */
export function buildPostgresLinux(target) {
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
  const prefix = path.join(work, "destdir", INSTALL_PREFIX);
  const destdir = `DESTDIR=${path.join(work, "destdir")}`;
  const pg = path.join(work, `postgresql-${lock.postgresql.version}`);
  const vector = path.join(work, `pgvector-${lock.pgvector.version}`);
  const jobs = String(Math.min(cpus().length, 8));
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CC: lock.toolchain.cc,
    CFLAGS: lock.postgresql.cflags,
    // `$$ORIGIN` survives make as `$ORIGIN`: the programs then find libpq
    // beside themselves wherever the runtime is mounted.
    LDFLAGS: lock.postgresql.ldflags,
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
  // pg_config reports DESTDIR paths from the DESTDIR copy, and those reach
  // __FILE__ in the extension, so map the build tree away.
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

  const dest = path.join(target.runtime, "postgres");
  rmSync(dest, { recursive: true, force: true });
  for (const [installed, staged] of linuxPostgresClosure(
    lock,
    readdirSync(path.join(prefix, "lib", "postgresql")),
  )) {
    mkdirSync(path.dirname(path.join(dest, staged)), { recursive: true });
    // copyFileSync follows libpq's version symlinks to the real file.
    copyFileSync(path.join(prefix, installed), path.join(dest, staged));
    run("strip", ["--strip-unneeded", path.join(dest, staged)], { env });
  }
  cpSync(path.join(prefix, "share"), path.join(dest, "share"), {
    recursive: true,
    dereference: true,
  });
  const ext = path.join(dest, "share", "postgresql", "extension");
  const kept = [...lock.extensions, "plpgsql"];
  for (const file of filesIn(ext))
    if (
      !kept.some(
        (name) => file === `${name}.control` || file.startsWith(`${name}--`),
      )
    )
      rmSync(path.join(ext, file));

  const licenseDir = path.join(target.runtime, "licenses", "native");
  mkdirSync(licenseDir, { recursive: true });
  for (const [name, folder, item] of [
    ["postgresql", pg, lock.postgresql],
    ["pgvector", vector, lock.pgvector],
  ])
    cpSync(
      path.join(folder, item.license_file),
      path.join(licenseDir, `${name}.txt`),
    );
  writeJson(path.join(target.output, "native-build.json"), {
    lock_sha256: sha256(nativeLockFile(target)),
    target: target.target,
    compiler: run(lock.toolchain.cc, ["--version"], {
      capture: true,
      env,
    }).split("\n")[0],
    c_library: run("getconf", ["GNU_LIBC_VERSION"], {
      capture: true,
      env,
    }).trim(),
    system_libraries_only: true,
  });
  normalizeTree(dest);
  return lock;
}
