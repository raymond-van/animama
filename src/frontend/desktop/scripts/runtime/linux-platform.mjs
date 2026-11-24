import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";
import { run } from "./common.mjs";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** Whether a regular file is an ELF executable or shared library. */
export function isElf(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size < ELF_MAGIC.length) return false;
  const descriptor = openSync(file, "r");
  try {
    const head = Buffer.alloc(ELF_MAGIC.length);
    readSync(descriptor, head, 0, head.length, 0);
    return head.equals(ELF_MAGIC);
  } finally {
    closeSync(descriptor);
  }
}

/** Every regular file below `root`, as sorted relative POSIX paths; symlinks are not followed. */
export function regularFiles(root, relative = "") {
  const result = [];
  for (const entry of readdirSync(path.join(root, relative)).sort()) {
    const name = relative ? `${relative}/${entry}` : entry;
    const stat = lstatSync(path.join(root, name));
    if (stat.isDirectory()) result.push(...regularFiles(root, name));
    else if (stat.isFile()) result.push(name);
  }
  return result;
}

/** Compare two `[major, minor]` versions numerically: 2.9 is older than 2.38. */
function newer(a, b) {
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

/**
 * The highest glibc version a binary requires, as `[major, minor]`, from
 * `readelf --version-info --wide` output; null when it requires none. Only the
 * "Version needs" section counts: a library's own definitions are not needs.
 * `GLIBC_ABI_DT_RELR` marks relative relocations that only glibc 2.36 and
 * later can read, whatever symbol versions the file names.
 */
export function requiredGlibc(versionInfo) {
  let highest = null;
  let needs = false;
  for (const line of versionInfo.split("\n")) {
    const section = /^Version (needs|definition|symbols) section/u.exec(line);
    if (section) {
      needs = section[1] === "needs";
      continue;
    }
    if (!needs) continue;
    const match = /\bName: GLIBC_(\d+)\.(\d+)(?:\.\d+)?\b/u.exec(line);
    const relr = /\bName: GLIBC_ABI_DT_RELR\b/u.test(line);
    if (!match && !relr) continue;
    const version = match ? [Number(match[1]), Number(match[2])] : [2, 36];
    if (!highest || newer(version, highest)) highest = version;
  }
  return highest;
}

/** Needed libraries and run paths from `readelf --dynamic --wide` output. */
export function dynamicEntries(dynamic) {
  const needed = [];
  const runpaths = [];
  for (const line of dynamic.split("\n")) {
    const library = /\(NEEDED\)\s+Shared library: \[(.*)\]/u.exec(line);
    if (library) needed.push(library[1]);
    const runpath =
      /\((?:RUNPATH|RPATH)\)\s+Library r(?:un)?path: \[(.*)\]/u.exec(line);
    if (runpath) runpaths.push(...runpath[1].split(":").filter(Boolean));
  }
  return { needed, runpaths };
}

/**
 * The only absolute folders a staged library may search: the system's own
 * library folders, which a library copied from the system names. Any other
 * absolute path could be created by another program on the user's machine, or
 * is left over from the machine a wheel was built on.
 */
const SYSTEM_LIBRARY_FOLDER = /^\/(?:usr\/)?lib(?:32|64)?(?:\/|$)/u;

/** `glibc-<major>.<minor>`, the form a Linux runtime manifest carries. */
export function glibcMinimum(version) {
  return `glibc-${version[0]}.${version[1]}`;
}

/**
 * Where a `$ORIGIN` run path of the file `name` points, relative to the root
 * the file is staged under; null when it leaves that root.
 */
function insideStage(name, runpath) {
  const resolved = path.posix.normalize(
    path.posix.join(
      path.posix.dirname(name),
      runpath.replace(/^\$(?:ORIGIN|\{ORIGIN\})/u, "."),
    ),
  );
  return resolved.startsWith("..") ? null : resolved;
}

/** Does the file hold any of these build-machine paths as plain text? */
function embedsPath(file, needles) {
  const bytes = openSync(file, "r");
  try {
    const stat = lstatSync(file);
    const content = Buffer.alloc(stat.size);
    readSync(bytes, content, 0, stat.size, 0);
    return needles.find((needle) => content.includes(needle));
  } finally {
    closeSync(bytes);
  }
}

/**
 * Inspect every ELF file of a Linux stage without running it.
 *
 * - `compiled(part, name)` marks the files this build compiled itself
 *   (PostgreSQL, pgvector, the process guard, the input hook). They may need
 *   only `systemLibraries` or a library staged beside them, must find those
 *   through `$ORIGIN` run paths that stay inside the stage, and must not embed
 *   a build-machine path.
 * - Any other ELF file, Electron's and the frozen backend's included, may
 *   search only the stage, through `$ORIGIN`, or the system's library folders.
 *
 * Returns each part's ELF files with what they need, and the stage's minimum
 * system: the highest glibc version any file requires.
 */
export function auditLinuxStage(
  roots,
  componentFiles,
  { compiled, systemLibraries, buildPaths, inspect = inspectElf },
) {
  const parts = {};
  let highest = null;
  for (const [part, names] of Object.entries(componentFiles)) {
    const staged = new Set(names.map((name) => path.posix.basename(name)));
    parts[part] = [];
    for (const name of names) {
      const file = path.join(roots[part], name);
      if (!isElf(file)) continue;
      const { glibc, needed, runpaths } = inspect(file);
      const strict = compiled(part, name);
      for (const runpath of runpaths) {
        if (/^\$(?:ORIGIN|\{ORIGIN\})/u.test(runpath)) {
          if (insideStage(name, runpath) === null)
            throw new Error(`${name}: run path ${runpath} leaves the stage`);
        } else if (strict || !SYSTEM_LIBRARY_FOLDER.test(runpath))
          throw new Error(
            `${name}: run path ${runpath} is not relative to the stage`,
          );
      }
      if (strict) {
        for (const library of needed)
          if (!systemLibraries.includes(library) && !staged.has(library))
            throw new Error(`${name}: ${library} is not an allowed library`);
        const embedded = embedsPath(file, buildPaths);
        if (embedded)
          throw new Error(`${name}: embeds the build path ${embedded}`);
      }
      if (glibc && (!highest || newer(glibc, highest))) highest = glibc;
      parts[part].push({
        path: name,
        glibc: glibc ? `${glibc[0]}.${glibc[1]}` : null,
        needed,
        runpaths,
      });
    }
  }
  if (!highest)
    throw new Error("No staged binary names a glibc version; is this glibc?");
  return { minimum_os: glibcMinimum(highest), parts };
}

/**
 * The files a Linux stage compiles itself, which the audit holds to the lock's
 * system libraries: PostgreSQL and pgvector, the process guard, and the input
 * hook in the app. Everything else is Electron's or the frozen backend's.
 */
export function compiledOnLinux(part, name) {
  return part === "runtime"
    ? name.startsWith("postgres/") || name === "bin/animama-process-guard"
    : part === "app" && name.startsWith("dist/native/");
}

/**
 * Read one ELF file's requirements with binutils' readelf. The C locale is
 * forced: readelf translates its headings, and a translated listing would
 * parse as "needs nothing".
 */
export function inspectElf(file, runTool = run) {
  const output = runTool(
    "readelf",
    ["--dynamic", "--version-info", "--wide", file],
    { capture: true, env: { LC_ALL: "C" } },
  );
  return { glibc: requiredGlibc(output), ...dynamicEntries(output) };
}

/**
 * The stage's minimum system before its manifest exists: the highest glibc
 * version required by any ELF file under these folders.
 */
export function measureMinimumOs(folders, inspect = inspectElf) {
  let highest = null;
  for (const folder of folders)
    for (const name of regularFiles(folder)) {
      const file = path.join(folder, name);
      if (!isElf(file)) continue;
      const { glibc } = inspect(file);
      if (glibc && (!highest || newer(glibc, highest))) highest = glibc;
    }
  if (!highest)
    throw new Error("No staged binary names a glibc version; is this glibc?");
  return glibcMinimum(highest);
}
