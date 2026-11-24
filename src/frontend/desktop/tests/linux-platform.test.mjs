import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJson, sourceRoot } from "../scripts/runtime/common.mjs";
import {
  auditLinuxStage,
  compiledOnLinux,
  dynamicEntries,
  glibcMinimum,
  isElf,
  measureMinimumOs,
  regularFiles,
  requiredGlibc,
} from "../scripts/runtime/linux-platform.mjs";
import { linuxPostgresClosure } from "../scripts/runtime/native-linux.mjs";
import {
  assertSandboxedDesktopEntry,
  developmentPackage,
} from "../scripts/runtime/package-development.mjs";
import { LINUX_PROCESS_GUARD } from "../scripts/runtime/process-guard.mjs";
import { LINUX_PROCESS_GUARD_PATH } from "../src/main-process/runtime/manifest.ts";

const roots = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "animama-elf-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
function write(root, name, content = ELF) {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

// `readelf --dynamic --version-info --wide` for a real binary (Debian 12,
// binutils 2.40), shortened: the symbol table rows are not read.
const READELF = `
Dynamic section at offset 0x15c58 contains 27 entries:
  Tag        Type                         Name/Value
 0x0000000000000001 (NEEDED)             Shared library: [libpq.so.5]
 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]
 0x000000000000001d (RUNPATH)            Library runpath: [$ORIGIN/../lib]
 0x0000000000000000 (NULL)               0x0

Version symbols section '.gnu.version' contains 89 entries:
 Addr: 0x0000000000000e4a  Offset: 0x00000e4a  Link: 5 (.dynsym)
  000:   0 (*local*)       0 (*local*)       0 (*local*)       2 (GLIBC_2.17)
  02c:   4 (GLIBC_2.33)    2 (GLIBC_2.17)    2 (GLIBC_2.17)    2 (GLIBC_2.17)

Version needs section '.gnu.version_r' contains 2 entries:
 Addr: 0x0000000000000f00  Offset: 0x00000f00  Link: 6 (.dynstr)
  000000: Version: 1  File: ld-linux-x86-64.so.2  Cnt: 1
  0x0010:   Name: GLIBC_2.3  Flags: none  Version: 5
  0x0020: Version: 1  File: libc.so.6  Cnt: 4
  0x0030:   Name: GLIBC_2.33  Flags: none  Version: 4
  0x0040:   Name: GLIBC_2.9  Flags: none  Version: 6
  0x0050:   Name: GLIBC_2.2.5  Flags: none  Version: 3
  0x0060:   Name: GLIBC_2.17  Flags: none  Version: 2
`;

describe("Linux ELF inspection", () => {
  it("recognises ELF files by their magic, whatever their name", () => {
    const root = fixture();
    expect(isElf(write(root, "bin/postgres"))).toBe(true);
    expect(isElf(write(root, "lib/vector.so"))).toBe(true);
    expect(isElf(write(root, "share/x.sql", "SELECT 1;"))).toBe(false);
    expect(isElf(write(root, "empty", ""))).toBe(false);
    expect(regularFiles(root)).toEqual([
      "bin/postgres",
      "empty",
      "lib/vector.so",
      "share/x.sql",
    ]);
  });

  it("reads the highest C library version a binary needs, as numbers", () => {
    // 2.33, not 2.9: versions are compared numerically.
    expect(requiredGlibc(READELF)).toEqual([2, 33]);
    expect(glibcMinimum([2, 33])).toBe("glibc-2.33");
  });

  it("ignores versions a library defines itself and binaries that need none", () => {
    expect(
      requiredGlibc(`
Version definition section '.gnu.version_d' contains 2 entries:
  0x0000: Rev: 1  Flags: BASE  Index: 1  Cnt: 1  Name: libc.so.6
  0x001c: Rev: 1  Flags: none  Index: 2  Cnt: 1  Name: GLIBC_2.99
`),
    ).toBeNull();
    expect(
      requiredGlibc("There is no dynamic section in this file."),
    ).toBeNull();
  });

  it("reads needed libraries and both kinds of run path", () => {
    expect(dynamicEntries(READELF)).toEqual({
      needed: ["libpq.so.5", "libc.so.6"],
      runpaths: ["$ORIGIN/../lib"],
    });
    expect(
      dynamicEntries(
        " 0x000000000000000f (RPATH)              Library rpath: [$ORIGIN:/usr/lib/x]",
      ).runpaths,
    ).toEqual(["$ORIGIN", "/usr/lib/x"]);
  });
});

describe("Linux stage audit", () => {
  const systemLibraries = ["libc.so.6", "libm.so.6"];
  const buildPaths = ["/home/builder", "/var/tmp/animama-build"];
  function stage(files) {
    const root = fixture();
    for (const name of Object.keys(files)) write(root, name);
    const audit = (overrides = {}) =>
      auditLinuxStage(
        { runtime: root },
        { runtime: Object.keys(files) },
        {
          compiled: compiledOnLinux,
          systemLibraries,
          buildPaths,
          inspect: (file) => ({
            glibc: [2, 17],
            needed: [],
            runpaths: [],
            ...files[path.relative(root, file).split(path.sep).join("/")],
            ...overrides,
          }),
        },
      );
    return { root, audit };
  }

  it("names the files this build compiles itself", () => {
    expect(compiledOnLinux("runtime", "postgres/bin/postgres")).toBe(true);
    expect(
      compiledOnLinux("runtime", "postgres/lib/postgresql/vector.so"),
    ).toBe(true);
    expect(compiledOnLinux("runtime", LINUX_PROCESS_GUARD)).toBe(true);
    expect(compiledOnLinux("app", "dist/native/animama_input_hook.node")).toBe(
      true,
    );
    expect(compiledOnLinux("runtime", "backend/animama-runtime")).toBe(false);
    expect(compiledOnLinux("electron", "electron")).toBe(false);
    expect(LINUX_PROCESS_GUARD).toBe(LINUX_PROCESS_GUARD_PATH);
  });

  it("reports the stage's minimum system as the highest version any file needs", () => {
    const { audit } = stage({
      "postgres/bin/postgres": { glibc: [2, 34], needed: ["libc.so.6"] },
      "postgres/lib/libpq.so.5": { glibc: [2, 38] },
      "backend/_internal/libpython3.12.so": { glibc: [2, 17] },
      "bin/animama-process-guard": { glibc: null },
    });
    const report = audit();
    expect(report.minimum_os).toBe("glibc-2.38");
    expect(report.parts.runtime).toContainEqual({
      path: "postgres/bin/postgres",
      glibc: "2.34",
      needed: ["libc.so.6"],
      runpaths: [],
    });
  });

  it("lets a compiled file need only system libraries or one staged beside it", () => {
    const allowed = stage({
      "postgres/bin/pg_dump": {
        needed: ["libpq.so.5", "libc.so.6"],
        runpaths: ["$ORIGIN/../lib"],
      },
      "postgres/lib/libpq.so.5": { needed: ["libc.so.6", "libm.so.6"] },
    });
    expect(() => allowed.audit()).not.toThrow();
    const stray = stage({
      "postgres/bin/postgres": { needed: ["libc.so.6", "libicuuc.so.76"] },
    });
    expect(() => stray.audit()).toThrow(
      "postgres/bin/postgres: libicuuc.so.76 is not an allowed library",
    );
  });

  it("refuses a compiled file that searches anywhere but the stage", () => {
    for (const runpath of ["/opt/animama/lib", "/usr/lib", "lib"]) {
      const { audit } = stage({
        "postgres/bin/pg_dump": { runpaths: [runpath] },
      });
      expect(() => audit()).toThrow("is not relative to the stage");
    }
    const { audit } = stage({
      "postgres/bin/pg_dump": { runpaths: ["$ORIGIN/../../../lib"] },
    });
    expect(() => audit()).toThrow("leaves the stage");
  });

  it("refuses a compiled file that embeds a build-machine path", () => {
    const { root, audit } = stage({ "postgres/lib/postgresql/vector.so": {} });
    expect(() => audit()).not.toThrow();
    writeFileSync(
      path.join(root, "postgres/lib/postgresql/vector.so"),
      Buffer.concat([ELF, Buffer.from("/home/builder/animama/src/vector.c\0")]),
    );
    expect(() => audit()).toThrow("embeds the build path /home/builder");
  });

  it("holds Electron and the frozen backend to no build-machine run path only", () => {
    // A library copied from the system may search system folders and need
    // any library; that is recorded, not refused.
    const system = stage({
      "backend/_internal/libssl.so.3": {
        needed: ["libcrypto.so.3", "libz.so.1"],
        runpaths: ["/usr/lib/x86_64-linux-gnu"],
      },
    });
    expect(system.audit().parts.runtime[0].runpaths).toEqual([
      "/usr/lib/x86_64-linux-gnu",
    ]);
    const leaked = stage({
      "backend/_internal/lib-dynload/_ssl.so": {
        runpaths: ["/var/tmp/animama-build/uv-python/lib"],
      },
    });
    expect(() => leaked.audit()).toThrow("is not relative to the stage");
    const escaping = stage({
      "backend/animama-runtime": { runpaths: ["${ORIGIN}/../../outside"] },
    });
    expect(() => escaping.audit()).toThrow("leaves the stage");
  });

  it("fails when nothing names a C library version, as on a non-glibc system", () => {
    const { audit } = stage({ "backend/animama-runtime": {} });
    expect(() => audit({ glibc: null })).toThrow("is this glibc?");
  });

  it("measures the minimum over whole folders before a manifest exists", () => {
    const one = fixture();
    const two = fixture();
    write(one, "postgres/bin/postgres");
    write(one, "web/index.html", "<html>");
    write(two, "electron");
    const versions = { postgres: [2, 34], electron: [2, 28] };
    expect(
      measureMinimumOs([one, two], (file) => ({
        glibc: versions[path.basename(file)],
      })),
    ).toBe("glibc-2.34");
  });
});

describe("Linux native lock and packaging", () => {
  const lock = readJson(
    path.join(sourceRoot, "native-components.linux-x64.lock.json"),
  );
  const mac = readJson(path.join(sourceRoot, "native-components.lock.json"));

  it("pins the same PostgreSQL and pgvector sources as macOS", () => {
    expect(lock.target).toBe("linux-x64");
    // The minimum is measured from the staged binaries.
    expect(lock.minimum_os).toBe("glibc");
    for (const component of ["postgresql", "pgvector"])
      for (const key of ["version", "url", "sha256", "license", "license_file"])
        expect(lock[component][key]).toBe(mac[component][key]);
    expect(lock.executables).toEqual(mac.executables);
    expect(lock.extensions).toEqual(mac.extensions);
    // No absolute run path from the build prefix; libpq is found beside bin/.
    expect(lock.postgresql.configure).toContain("--disable-rpath");
    expect(lock.postgresql.ldflags).toContain("$$ORIGIN/../lib");
    expect(lock.system_libraries).toContain("libc.so.6");
  });

  it("stages the server closure and nothing else from the installed tree", () => {
    const closure = linuxPostgresClosure(lock, [
      "vector.so",
      "pg_trgm.so",
      "plpgsql.so",
      "dict_snowball.so",
      "utf8_and_win.so",
      "euc2004_sjis2004.so",
      "postgres_fdw.so",
      "libpqwalreceiver.so",
      "pgxs",
    ]);
    expect(closure.map(([, staged]) => staged)).toEqual([
      "bin/initdb",
      "bin/pg_ctl",
      "bin/pg_dump",
      "bin/pg_isready",
      "bin/pg_restore",
      "bin/postgres",
      "lib/libpq.so.5",
      "lib/postgresql/dict_snowball.so",
      "lib/postgresql/euc2004_sjis2004.so",
      "lib/postgresql/pg_trgm.so",
      "lib/postgresql/plpgsql.so",
      "lib/postgresql/utf8_and_win.so",
      "lib/postgresql/vector.so",
    ]);
  });

  it("packages Linux as one AppImage beside the unpacked app", () => {
    const linux = developmentPackage(
      { platform: "linux", arch: "x64" },
      { installer: false, version: "0.1.6" },
    );
    expect(linux).toMatchObject({
      builder: "LINUX",
      targets: ["AppImage"],
      arch: "x64",
      runtime: "linux-unpacked/resources/runtime",
      fuses: "linux-unpacked/animama",
      artifact: "Animama-0.1.6-x86_64.AppImage",
    });
    expect(() =>
      developmentPackage(
        { platform: "linux", arch: "x64" },
        { installer: true, version: "0.1.6" },
      ),
    ).toThrow("--installer builds the Windows NSIS installer only");
  });

  it("keeps the macOS and Windows packages as they were", () => {
    expect(
      developmentPackage(
        { platform: "darwin", arch: "arm64" },
        { installer: false, version: "0.1.6" },
      ),
    ).toMatchObject({
      builder: "MAC",
      targets: ["dir"],
      arch: "arm64",
      config: {
        forceCodeSigning: false,
        mac: { identity: null, notarize: false },
      },
      app: "mac/Animama.app",
      runtime: "mac/Animama.app/Contents/Resources/runtime",
      fuses: "mac/Animama.app",
    });
    const windows = { platform: "win32", arch: "x64" };
    expect(
      developmentPackage(windows, { installer: false, version: "0.1.6" }),
    ).toMatchObject({
      builder: "WINDOWS",
      targets: ["dir"],
      runtime: "win-unpacked/resources/runtime",
      fuses: "win-unpacked/Animama.exe",
      artifact: undefined,
      config: {
        forceCodeSigning: false,
        win: { signExts: ["!.exe"] },
        extraMetadata: { name: "Animama" },
      },
    });
    expect(
      developmentPackage(windows, { installer: true, version: "0.1.6" }),
    ).toMatchObject({
      targets: ["nsis"],
      artifact: "Animama-0.1.6-x64-setup.exe",
    });
  });

  it("refuses an AppImage whose own desktop entry turns the sandbox off", () => {
    expect(() =>
      assertSandboxedDesktopEntry(
        "[Desktop Entry]\nName=Animama\nExec=AppRun %U\nTerminal=false\n",
      ),
    ).not.toThrow();
    // What electron-builder's default toolset writes.
    expect(() =>
      assertSandboxedDesktopEntry(
        "[Desktop Entry]\nName=Animama\nExec=AppRun --no-sandbox %U\n",
      ),
    ).toThrow("disables the sandbox");
    expect(() =>
      assertSandboxedDesktopEntry("[Desktop Entry]\nName=Animama\n"),
    ).toThrow("exactly one Exec line");
  });
});
