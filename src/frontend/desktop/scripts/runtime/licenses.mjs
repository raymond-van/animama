import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  buildPython,
  desktopRoot,
  electronDist,
  filesIn,
  frontendRoot,
  nativeLockFile,
  pythonEnvironment,
  readJson,
  repoRoot,
  run,
  sourceRoot,
  sha256,
  writeJson,
} from "./common.mjs";
import { PRIVATE_PACKS } from "./private-packs.mjs";
import { PROCESS_GUARD } from "./process-guard.mjs";
import { VC_RUNTIME_DLL } from "./windows-platform.mjs";

// "NOTICES" too: three-liltoon ships lilToon's and its bundled shaders' notices
// as dist/THIRD_PARTY_NOTICES.md.
const NOTICE_NAME =
  /(?:^|[._ -])(?:licen[cs]e|copying|notices?|copyright)(?:[._ -]|$)/iu;
// Source and map files can share notice words (for example an icon named
// "copyright.js"), whereas bundle notices use text extensions such as
// "bundle.js.LICENSE.txt".
const CODE_FILE = /\.(?:[cm]?[jt]sx?|map)$/iu;

/** Include notices shipped inside bundles without traversing dependency links. */
function javascriptNotices(folder, recursive) {
  const notices = [];
  const visit = (relative) => {
    const directory = path.join(folder, relative);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    )) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (recursive && entry.name !== "node_modules" && entry.name !== ".git")
          visit(name);
      } else if (
        entry.isFile() &&
        NOTICE_NAME.test(entry.name) &&
        !CODE_FILE.test(entry.name)
      ) {
        notices.push({
          path: name,
          text: readFileSync(path.join(folder, name), "utf8"),
        });
      }
    }
  };
  visit("");
  return notices.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/** Conservative dependency closure; optional modules absent on this target are recorded. */
export function javascriptLicenses(
  workspaceRoot = frontendRoot,
  workspaceNames = ["desktop", "web"],
) {
  const records = new Map();
  const absentOptional = new Set();
  const visit = (folder) => {
    folder = realpathSync(folder);
    const pkg = readJson(path.join(folder, "package.json"));
    const id = `npm:${pkg.name}@${pkg.version}`;
    if (records.has(id)) return;
    // Private workspace build outputs are inventoried separately. Only published
    // dependency packages may contain bundled third-party notice subdirectories.
    const notices = javascriptNotices(folder, !pkg.private);
    records.set(id, {
      id,
      name: pkg.name,
      version: pkg.version,
      license:
        typeof pkg.license === "string"
          ? pkg.license
          : pkg.private
            ? "Proprietary"
            : notices.length
              ? "SEE-NOTICE"
              : "NOASSERTION",
      source: pkg.private
        ? `workspace:${pkg.name}`
        : `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
      review: "pending",
      notices,
    });
    const resolve = createRequire(path.join(folder, "package.json"));
    for (const name of Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    }).sort()) {
      // Type-only packages have no executable entrypoint, and exports may hide
      // package.json. Follow Node's module search directories without executing it.
      const dependency = (resolve.resolve.paths(`${name}/package.json`) ?? [])
        .map((base) => path.join(base, name))
        .find((candidate) => existsSync(path.join(candidate, "package.json")));
      if (!dependency) {
        if (pkg.optionalDependencies?.[name]) {
          absentOptional.add(`${id}:${name}`);
          continue;
        }
        throw new Error(
          `Missing declared dependency during license inventory: ${id} -> ${name}`,
        );
      }
      visit(dependency);
    }
  };
  for (const name of workspaceNames) visit(path.join(workspaceRoot, name));
  return {
    records: [...records.values()].sort((a, b) => a.id.localeCompare(b.id)),
    absentOptional: [...absentOptional].sort(),
  };
}

/** Read a static notice by basename, keeping policy paths inside the notice directory. */
export function readStaticLicenseNotice(name) {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}\.txt$/u.test(name))
    throw new Error(`Invalid static license notice path: ${name}`);
  return {
    path: name,
    text: readFileSync(path.join(sourceRoot, "notices", name), "utf8"),
  };
}

const LICENSE_RECORD =
  /^(?:adapted-code\.md|code-[a-z0-9-]+-LICENSE\.(?:md|txt)|code-Apache-2\.0\.txt)$/u;

/**
 * Read a licence record kept in `licenses/third-party` by basename. Bundles
 * carry these records unchanged rather than copies that could drift.
 */
export function readLicenseRecord(name) {
  if (!LICENSE_RECORD.test(name))
    throw new Error(`Invalid licence record path: ${name}`);
  return {
    path: `licenses/third-party/${name}`,
    text: readFileSync(
      path.join(repoRoot, "licenses/third-party", name),
      "utf8",
    ),
  };
}

/** Every licence record a license-sources group names, checked as `readLicenseRecord` checks them. */
export function licenseRecordFiles(
  policy = readJson(path.join(sourceRoot, "license-sources.json")),
) {
  const names = [
    ...new Set(
      policy.groups.flatMap((group) => group.license_record_files ?? []),
    ),
  ].sort();
  for (const name of names)
    if (!LICENSE_RECORD.test(name))
      throw new Error(`Invalid licence record path: ${name}`);
  return names;
}

/** Every staged file gets an attribution group, with unresolved provenance visible. */
/** The AppImage toolset `electron-builder.yml` pins. */
export function appImageToolset() {
  const version = /^toolsets:\n(?:\s+.*\n)*?\s+appimage: "([^"]+)"/mu.exec(
    readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf8"),
  )?.[1];
  if (!version)
    throw new Error("electron-builder.yml does not pin toolsets.appimage");
  return version;
}

/**
 * Linux only: what electron-builder adds around the app when it makes the
 * AppImage. Its pinned toolset supplies the launcher that mounts the file and
 * a few desktop libraries that the launcher puts ahead of the system's. They
 * are outside the staged runtime, so no file inventory lists them; this
 * record names them for the licence review.
 */
export function appImageToolsetRecord(version) {
  return {
    id: "appimage-toolset",
    name: "AppImage launcher (type2-runtime) and the desktop libraries electron-builder bundles with it",
    version,
    license:
      "MIT for type2-runtime; libXtst, libXss, libnotify, libappindicator3, libindicator3 and libgconf-2 under their own upstream terms (X11/MIT, LGPL and GPL families)",
    source: `https://github.com/electron-userland/electron-builder-binaries/releases/tag/appimage%40${version}`,
    review: "pending",
  };
}

export function writeLicenses(target, contentInventory) {
  const directory = path.join(target.runtime, "licenses");
  mkdirSync(directory, { recursive: true });
  const python = JSON.parse(
    run(
      buildPython(),
      [path.join(repoRoot, "src/backend/packaging/desktop/python_licenses.py")],
      { env: pythonEnvironment(), capture: true },
    ),
  );
  const js = javascriptLicenses();
  const policy = readJson(path.join(sourceRoot, "license-sources.json"));
  const policyRecords = policy.groups.map((group) => ({
    ...group,
    notices: [
      ...(group.notice_files ?? []).map(readStaticLicenseNotice),
      ...(group.license_record_files ?? []).map(readLicenseRecord),
    ],
  }));
  const native = readJson(nativeLockFile(target));
  const records = [...policyRecords, ...python, ...js.records];
  for (const name of ["postgresql", "pgvector"])
    records.push({
      id: name,
      name,
      version: native[name].version,
      license: native[name].license,
      source: native[name].url,
      review: "pending",
      notices: [
        {
          path: `${name}.txt`,
          text: readFileSync(
            path.join(directory, "native", `${name}.txt`),
            "utf8",
          ),
        },
      ],
    });
  // Windows ships Microsoft's VC++ runtime DLLs app-local as Visual Studio
  // distributable code: PostgreSQL's copy from the pinned redistributable, and
  // copies inside the frozen Python runtime and wheels. The file inventory
  // binds each copy's bytes.
  if (target.platform === "win32")
    records.push({
      id: "msvc-runtime",
      name: "Microsoft Visual C++ Redistributable runtime DLLs",
      version: "14.x (Visual C++ 2015-2022)",
      license: "Microsoft Visual Studio distributable code terms",
      source: "https://visualstudio.microsoft.com/license-terms/",
      review: "pending",
    });
  if (target.platform === "linux")
    records.push(appImageToolsetRecord(appImageToolset()));
  records.push({
    id: "electron",
    name: "Electron + Chromium",
    version: readJson(
      path.join(desktopRoot, "node_modules/electron/package.json"),
    ).version,
    license: "MIT and bundled Chromium notices",
    source: "https://github.com/electron/electron",
    review: "pending",
    notices: ["LICENSE", "LICENSES.chromium.html"].map((name) => ({
      path: name,
      text: readFileSync(path.join(electronDist(), name), "utf8"),
    })),
  });
  const contentRecords = new Map();
  for (const file of contentInventory.files)
    contentRecords.set(file.license.license_id, {
      id: file.license.license_id,
      name: file.license.creator,
      license: file.license.license_id,
      source: file.license.provenance,
      review: file.license.redistribution_review,
    });
  // Each staged private pack carries its own licence inventory. A separate
  // map, so core content files never reference a pack licence.
  const packRules = new Map();
  const packRecords = new Map();
  for (const pack of PRIVATE_PACKS) {
    const packInventory = path.join(
      target.runtime,
      pack.stagedRelative,
      "licenses/inventory.json",
    );
    if (!existsSync(packInventory)) continue;
    const rules = JSON.parse(readFileSync(packInventory, "utf8")).rules;
    packRules.set(pack.stagedRelative, rules);
    for (const rule of rules)
      packRecords.set(rule.license_id, {
        id: rule.license_id,
        name: rule.creator,
        license: rule.license_id,
        source: rule.provenance,
        review: rule.redistribution_review,
      });
  }
  const stagedPack = (name) =>
    PRIVATE_PACKS.find((pack) => name.startsWith(`${pack.stagedRelative}/`));
  records.push(...contentRecords.values(), ...packRecords.values());
  records.sort((a, b) => a.id.localeCompare(b.id));
  const assignments = filesIn(target.runtime)
    .filter((name) => !name.startsWith("licenses/") && name !== "manifest.json")
    .map((name) => {
      const staticGroup = policy.groups.find((item) =>
        item.paths?.some((prefix) => name.startsWith(prefix)),
      );
      let refs = ["animama"];
      if (VC_RUNTIME_DLL.test(path.posix.basename(name)))
        refs = ["msvc-runtime"];
      // First-party, with the VC++ runtime linked in statically (/MT).
      else if (name === PROCESS_GUARD) refs = ["animama", "msvc-runtime"];
      else if (name.startsWith("backend/"))
        refs = ["animama", "python-runtime-dependencies"];
      else if (name.startsWith("postgres/"))
        refs = ["postgresql", ...(name.includes("vector") ? ["pgvector"] : [])];
      else if (stagedPack(name))
        refs = (packRules.get(stagedPack(name).stagedRelative) ?? []).map(
          (rule) => rule.license_id,
        );
      else if (name.startsWith("content/")) refs = [...contentRecords.keys()];
      else if (staticGroup) refs = [staticGroup.id];
      else if (name.startsWith("web/"))
        refs = ["animama", "javascript-runtime-dependencies"];
      return { path: name, license_refs: refs };
    });
  const inventory = {
    schema: "animama-redistribution-inventory/1",
    release_approved: false,
    coverage:
      "Conservative dependency groups per file; not a legal approval or exact binary SBOM",
    records: records.map(({ notices, ...record }) => ({
      ...record,
      notice_count: notices?.length ?? 0,
      notice_sha256: createHash("sha256")
        .update(JSON.stringify(notices ?? []))
        .digest("hex"),
    })),
    groups: {
      "python-runtime-dependencies": python.map((p) => p.id),
      "javascript-runtime-dependencies": js.records.map((p) => p.id),
    },
    files: assignments,
    external_components: {
      app: ["animama", "javascript-runtime-dependencies"],
      electron: ["electron"],
    },
    absent_optional_javascript: js.absentOptional,
    pending_review: records
      .filter((r) => r.review !== "approved")
      .map((r) => r.id),
    // Bind human review to unchanged dependency sources and static third-party
    // bytes, without tying it to nondeterministic native signing timestamps.
    source_locks: Object.fromEntries(
      [
        ["uv.lock", path.join(repoRoot, "uv.lock")],
        ["pnpm-lock.yaml", path.join(frontendRoot, "pnpm-lock.yaml")],
        ["runtime-sources", path.join(sourceRoot, "source-manifest.json")],
        ["license-sources", path.join(sourceRoot, "license-sources.json")],
        ["native-components", nativeLockFile(target)],
      ].map(([name, file]) => [name, sha256(file)]),
    ),
    source_assets: filesIn(target.runtime)
      .filter((name) =>
        ["content/", "web/onnx/", "web/tts/", "web/basis/"].some((prefix) =>
          name.startsWith(prefix),
        ),
      )
      .map((name) => ({
        path: name,
        sha256: sha256(path.join(target.runtime, name)),
      })),
  };
  writeJson(path.join(directory, "inventory.json"), inventory);
  const text = [
    "ANIMAMA DESKTOP — THIRD PARTY NOTICES",
    "Development feasibility build. Redistribution approval is pending.",
    "The inventory covers exact staged files and conservative dependency groups. NOASSERTION and missing notices require resolution before release.",
    ...records.map(
      (record) =>
        `\n${"=".repeat(72)}\n${record.name} (${record.id})\nLicense: ${record.license}\nSource: ${record.source}\nReview: ${record.review}\n${(record.notices ?? []).map((notice) => `\n--- ${notice.path} ---\n${notice.text}`).join("\n")}`,
    ),
  ].join("\n");
  writeFileSync(path.join(directory, "THIRD_PARTY_NOTICES.txt"), text);
  const packDir = path.join(
    target.output,
    "pack-inputs/expanded-included-content",
  );
  writeFileSync(
    path.join(packDir, "ATTRIBUTION.txt"),
    "Development pack input; not approved for redistribution.\n" +
      [...contentRecords.values()]
        .map((r) => `${r.id}: ${r.source} (${r.review})`)
        .join("\n") +
      "\n",
  );
  return inventory;
}
