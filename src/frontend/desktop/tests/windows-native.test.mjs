import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  crlfConvertedPaths,
  desktopRoot,
  parseTarget,
  pnpmCommand,
  readJson,
  sourceRoot,
} from "../scripts/runtime/common.mjs";
import {
  assertInventory,
  inventoryTree,
} from "../scripts/runtime/inventory.mjs";
import { distprepConflicts } from "../scripts/runtime/native-windows.mjs";
import { packagedTarget } from "../scripts/before-build.mjs";
import { PROCESS_GUARD } from "../scripts/runtime/process-guard.mjs";
import {
  PROCESS_GUARD_PATH,
  runtimePlatform,
} from "../src/main-process/runtime/manifest.ts";
import { RELEASE_TARGETS } from "../scripts/runtime/release-artifacts.mjs";
import { iconFile } from "../scripts/runtime/windows-resources.mjs";
import { untrustedWriters } from "../scripts/runtime/windows-acl.mjs";
import {
  compilerVersion,
  parseEnvironmentBlock,
  prependPath,
} from "../scripts/runtime/windows-build.mjs";
import {
  assertNoEmbeddedPaths,
  auditWindowsDependencies,
  auditWindowsStage,
  isPortableExecutable,
  parseDumpbinDependents,
  resolveDependency,
  VC_RUNTIME_DLL,
} from "../scripts/runtime/windows-platform.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "animama-windows-native-"));
  roots.push(root);
  return root;
}

/** The smallest header isPortableExecutable accepts: MZ, e_lfanew, PE\0\0. */
function portableExecutable(file) {
  const bytes = Buffer.alloc(0x84);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "latin1");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

const dumpbin = (imports, delayed = []) =>
  [
    "Dump of file C:\\stage\\bin\\postgres.exe",
    "",
    "File Type: EXECUTABLE IMAGE",
    "",
    "  Image has the following dependencies:",
    "",
    ...imports.map((name) => `    ${name}`),
    "",
    ...(delayed.length
      ? [
          "  Image has the following delay load dependencies:",
          "",
          ...delayed.map((name) => `    ${name}`),
          "",
        ]
      : []),
    "  Summary",
    "",
    "        1000 .data",
  ].join("\r\n");

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Windows native build inputs", () => {
  it("names one Windows floor in the installer, the stage inputs and the app", () => {
    const floor = readJson(
      path.join(sourceRoot, "native-components.win32-x64.lock.json"),
    ).minimum_os;
    // Windows 10 version 1903.
    expect(floor).toBe("10.0.18362");
    expect(
      readJson(path.join(sourceRoot, "source-manifest.json")).targets[
        "win32-x64"
      ].minimum_os,
    ).toBe(floor);
    expect(runtimePlatform("win32").minimumOs).toBe(floor);
    expect(RELEASE_TARGETS["win32-x64"].minimumOs).toBe(floor);
    // Nothing else checks the installer's own number.
    const installer = readFileSync(
      path.join(desktopRoot, "build/installer.nsh"),
      "utf8",
    );
    const refusals = [...installer.matchAll(/\$\{If\} \$0 < (\d+)/gu)];
    expect(refusals.map(([, build]) => `10.0.${build}`)).toEqual([floor]);
    expect(installer).toContain(
      "Animama requires Windows 10 version 1903 or later.",
    );
  });

  it("builds the same pinned PostgreSQL and pgvector sources as macOS", () => {
    const mac = readJson(path.join(sourceRoot, "native-components.lock.json"));
    const windows = readJson(
      path.join(sourceRoot, "native-components.win32-x64.lock.json"),
    );
    expect(windows.target).toBe("win32-x64");
    expect(windows.minimum_os).toBe("10.0.18362");
    for (const name of ["postgresql", "pgvector"])
      for (const field of [
        "version",
        "url",
        "sha256",
        "license",
        "license_file",
      ])
        expect(windows[name][field]).toBe(mac[name][field]);
    expect(windows.executables).toEqual(mac.executables);
    expect(windows.extensions).toEqual(mac.extensions);
    for (const tool of Object.values(windows.build_tools)) {
      expect(tool.url).toMatch(/^https:\/\//u);
      expect(tool.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    // Every optional PostgreSQL feature stays off unless named, as on macOS.
    expect(windows.postgresql.meson).toContain("--auto-features=disabled");
    expect(windows.postgresql.meson).toContain("-Dssl=none");
  });

  it("accepts the Windows target only on a native Windows x64 host", () => {
    const args = ["--platform", "win32", "--arch", "x64"];
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    expect(parseTarget(args)).toMatchObject({
      platform: "win32",
      arch: "x64",
      target: "win32-x64",
    });
    vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    expect(() => parseTarget(args)).toThrow("cross-building is unsupported");
  });

  it("removes only the prebuilt PostgreSQL files meson names as conflicts", () => {
    const source = "C:\\work dir\\postgresql-16.15";
    const report = [
      "Message: checking for file conflicts between source and build directory",
      "ERROR: Problem encountered:",
      "****",
      "Non-clean source code directory detected.",
      "",
      "Conflicting files in source directory:",
      "  C:/work dir/postgresql-16.15/src/common/kwlist_d.h C:/work dir/postgresql-16.15/src/backend/parser/gram.c",
      "",
      "The conflicting files need to be removed",
    ].join("\r\n");
    expect(distprepConflicts(report, source, () => true)).toEqual([
      "src/common/kwlist_d.h",
      "src/backend/parser/gram.c",
    ]);
    expect(
      distprepConflicts("ERROR: cl not found", source, () => true),
    ).toEqual([]);
    expect(() =>
      distprepConflicts(
        report.replace("src/common", "src/../common"),
        source,
        () => true,
      ),
    ).toThrow("Unexpected meson conflict");
    // Windows path APIs also treat a backslash as a separator.
    expect(() =>
      distprepConflicts(
        report.replace("src/common/kwlist_d.h", "src\\..\\..\\outside.txt"),
        source,
        () => true,
      ),
    ).toThrow("Unexpected meson conflict");
    expect(() => distprepConflicts(report, source, () => false)).toThrow(
      "Unexpected meson conflict",
    );
    expect(() =>
      distprepConflicts(
        report.replaceAll("C:/work dir", "C:/elsewhere"),
        source,
        () => true,
      ),
    ).toThrow("outside the PostgreSQL source");
  });

  it("finds only working-tree files converted from LF to CRLF", () => {
    const listing = [
      "i/lf    w/lf    attr/text eol=lf      \tuv.lock",
      "i/lf    w/crlf  attr/                 \tsrc/frontend/desktop/runtime/release-policy.json",
      "i/crlf  w/crlf  attr/-text            \tlicenses/third-party/art-CC-BY-4.0.txt",
      "i/-text w/-text attr/                 \tcontent/a b.png",
    ].join("\n");
    expect(crlfConvertedPaths(listing)).toEqual([
      "src/frontend/desktop/runtime/release-policy.json",
    ]);
  });
});

describe("Windows stage inventory", () => {
  it("marks PE files as the executables and ignores POSIX modes on Windows", () => {
    const root = fixture();
    mkdirSync(path.join(root, "backend/_internal"), { recursive: true });
    for (const name of [
      "backend/animama-runtime.exe",
      "backend/_internal/python312.dll",
      "backend/_internal/_ssl.pyd",
      "backend/_internal/base_library.zip",
      "web/index.html",
    ]) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), name);
    }
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const inventory = inventoryTree(root);
    expect(
      Object.fromEntries(inventory.map((file) => [file.path, file.mode])),
    ).toEqual({
      "backend/_internal/_ssl.pyd": "0755",
      "backend/_internal/base_library.zip": "0644",
      "backend/_internal/python312.dll": "0755",
      "backend/animama-runtime.exe": "0755",
      "web/index.html": "0644",
    });
    expect(inventory.find((file) => file.path.endsWith(".exe")).critical).toBe(
      true,
    );
    // NTFS reports no execute bits, so only bytes and names are compared.
    expect(assertInventory(root, inventory)).toEqual(inventory);
  });

  it("runs pnpm through its JavaScript entry point instead of a .cmd shim", () => {
    expect(pnpmCommand(["web:check"], "C:\\pnpm\\bin\\pnpm.cjs")).toEqual([
      process.execPath,
      ["C:\\pnpm\\bin\\pnpm.cjs", "web:check"],
    ]);
    expect(pnpmCommand(["web:check"], "")).toEqual(["pnpm", ["web:check"]]);
  });
});

describe("VC++ runtime names", () => {
  it("recognizes the runtime DLLs, including wheel-renamed copies", () => {
    for (const name of [
      "vcruntime140.dll",
      "VCRUNTIME140_1.dll",
      "MSVCP140.dll",
      "msvcp140_atomic_wait.dll",
      "msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll",
      "concrt140.dll",
    ])
      expect(VC_RUNTIME_DLL.test(name)).toBe(true);
    for (const name of [
      "ucrtbase.dll",
      "vcruntime140.dll.bak",
      "msvcp140-x.dll",
    ])
      expect(VC_RUNTIME_DLL.test(name)).toBe(false);
  });
});

describe("Windows build environment", () => {
  const user = "S-1-5-21-1-2-3-1001";

  it("rejects build directories other accounts can modify", () => {
    const privateAcl = {
      user,
      owner: user,
      rules: [
        { sid: user, rights: 0x1f01ff, allow: true },
        { sid: "S-1-5-18", rights: 0x1f01ff, allow: true },
        { sid: "S-1-5-32-544", rights: 0x1f01ff, allow: true },
        // Read and execute for Users does not let them plant files.
        { sid: "S-1-5-32-545", rights: 0x1200a9, allow: true },
        // A deny rule never grants access.
        { sid: "S-1-1-0", rights: 0x1f01ff, allow: false },
      ],
    };
    expect(untrustedWriters(privateAcl)).toEqual([]);
    // The ACE every new folder below C:\ inherits by default.
    const inherited = {
      ...privateAcl,
      rules: [
        ...privateAcl.rules,
        { sid: "S-1-5-11", rights: 0x1301bf, allow: true },
      ],
    };
    expect(untrustedWriters(inherited)).toEqual(["S-1-5-11"]);
    expect(
      untrustedWriters({ ...privateAcl, owner: "S-1-5-21-9-9-9-1002" }),
    ).toEqual(["owner S-1-5-21-9-9-9-1002"]);
  });

  it("reads a vcvars environment and the compiler's own version", () => {
    const env = parseEnvironmentBlock(
      "Path=C:\\VS\\bin;C:\\Windows\r\nVCToolsRedistDir=C:\\VS\\Redist\\MSVC\\14.44.35112\\\r\nINCLUDE=a=b\r\n",
    );
    expect(env).toEqual({
      Path: "C:\\VS\\bin;C:\\Windows",
      VCToolsRedistDir: "C:\\VS\\Redist\\MSVC\\14.44.35112\\",
      INCLUDE: "a=b",
    });
    expect(
      compilerVersion(
        "Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35207.1 for x64\r\nCopyright",
      ),
    ).toBe("19.44.35207");
    expect(() =>
      compilerVersion(
        "Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35207 for ARM64",
      ),
    ).toThrow("x64 MSVC compiler");
  });

  it("prepends pinned tools to the existing PATH key, whatever its case", () => {
    expect(
      prependPath({ Path: "C:\\Windows" }, [
        "C:\\tools\\ninja",
        "C:\\tools\\perl",
      ]),
    ).toEqual({
      Path: ["C:\\tools\\ninja", "C:\\tools\\perl", "C:\\Windows"].join(
        path.delimiter,
      ),
    });
  });
});

describe("Windows PE dependency audit", () => {
  const options = (overrides = {}) => ({
    stagedNames: new Map(
      [
        "bin/postgres.exe",
        "bin/libpq.dll",
        "bin/vcruntime140.dll",
        "lib/vector.dll",
      ].map((name) => [name.toLowerCase(), name]),
    ),
    searchDirs: ["bin"],
    systemDlls: new Set(["kernel32.dll", "ws2_32.dll"]),
    systemDirectory: "C:\\Windows\\System32",
    exists: () => true,
    ...overrides,
  });

  it("reads direct and delay-loaded imports from dumpbin", () => {
    expect(
      parseDumpbinDependents(
        dumpbin(
          ["KERNEL32.dll", "VCRUNTIME140.dll"],
          ["WS2_32.dll", "kernel32.dll"],
        ),
      ),
    ).toEqual(["kernel32.dll", "vcruntime140.dll", "ws2_32.dll"]);
    expect(() =>
      parseDumpbinDependents(dumpbin(["KERNEL32.dll", "not a dll name"])),
    ).toThrow("Unexpected dumpbin dependency line");
    // A localized or changed format must not read as "no imports".
    expect(() =>
      parseDumpbinDependents(
        "Abbild von Datei C:\\stage\\bin\\postgres.exe\r\n\r\n  Zusammenfassung\r\n",
      ),
    ).toThrow("Unrecognized dumpbin output");
    expect(
      parseDumpbinDependents(
        "Dump of file C:\\res.dll\r\n\r\nFile Type: DLL\r\n\r\n  Summary\r\n",
      ),
    ).toEqual([]);
    expect(
      parseDumpbinDependents(dumpbin(["KERNEL32.dll"], ["bthprops.cpl"])),
    ).toEqual(["bthprops.cpl", "kernel32.dll"]);
  });

  it("resolves imports from the stage before reviewed Windows DLLs", () => {
    expect(
      resolveDependency(
        "api-ms-win-crt-runtime-l1-1-0.dll",
        "bin/postgres.exe",
        options(),
      ),
    ).toBe("api-set");
    expect(resolveDependency("libpq.dll", "bin/pg_dump.exe", options())).toBe(
      "stage:bin/libpq.dll",
    );
    // An extension DLL loads into postgres.exe, whose directory the loader searches.
    expect(resolveDependency("postgres.exe", "lib/vector.dll", options())).toBe(
      "stage:bin/postgres.exe",
    );
    expect(
      resolveDependency("kernel32.dll", "bin/postgres.exe", options()),
    ).toBe("system");
  });

  it("rejects runtime DLLs that only the build machine has", () => {
    const missingRuntime = options({
      stagedNames: new Map([["bin/postgres.exe", "bin/postgres.exe"]]),
    });
    // vcruntime140.dll is in System32 on developer machines but not on every
    // Windows install, so it is never a reviewed system DLL.
    expect(() =>
      resolveDependency("vcruntime140.dll", "bin/postgres.exe", missingRuntime),
    ).toThrow("vcruntime140.dll does not resolve");
    expect(() =>
      resolveDependency("libssl-3-x64.dll", "bin/postgres.exe", options()),
    ).toThrow("libssl-3-x64.dll does not resolve");
    expect(() =>
      resolveDependency(
        "ws2_32.dll",
        "bin/postgres.exe",
        options({ exists: () => false }),
      ),
    ).toThrow("ws2_32.dll does not resolve");
  });

  it("audits only PE files and reports each resolved import", () => {
    const root = fixture();
    portableExecutable(path.join(root, "bin", "postgres.exe"));
    portableExecutable(path.join(root, "bin", "libpq.dll"));
    writeFileSync(path.join(root, "bin", "notes.txt"), "MZ but not a PE image");
    const system = path.join(root, "System32");
    mkdirSync(system);
    writeFileSync(path.join(system, "kernel32.dll"), "");
    const runner = vi.fn((command, args) =>
      args.at(-1).endsWith("postgres.exe")
        ? dumpbin(["libpq.dll", "KERNEL32.dll"])
        : dumpbin(["KERNEL32.dll"]),
    );
    expect(isPortableExecutable(path.join(root, "bin", "notes.txt"))).toBe(
      false,
    );
    expect(
      auditWindowsDependencies(
        root,
        ["bin/libpq.dll", "bin/notes.txt", "bin/postgres.exe"],
        {
          systemDlls: ["KERNEL32.dll"],
          systemDirectory: system,
          runNative: runner,
        },
      ).map((file) => file.path),
    ).toEqual(["bin/libpq.dll", "bin/postgres.exe"]);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("resolves each process's imports only in the folders that process searches", () => {
    const root = fixture();
    const system = path.join(root, "System32");
    mkdirSync(system);
    writeFileSync(path.join(system, "kernel32.dll"), "");
    const imports = {
      "runtime/postgres/bin/postgres.exe": ["vcruntime140.dll", "kernel32.dll"],
      "runtime/postgres/bin/vcruntime140.dll": ["kernel32.dll"],
      "runtime/postgres/lib/vector.dll": ["postgres.exe", "vcruntime140.dll"],
      "runtime/backend/animama-runtime.exe": ["kernel32.dll"],
      "runtime/backend/_internal/python312.dll": ["vcruntime140.dll"],
      "runtime/backend/_internal/vcruntime140.dll": ["kernel32.dll"],
      "runtime/backend/_internal/pydantic_core/core.pyd": [
        "python312.dll",
        "vcruntime140.dll",
      ],
      "runtime/backend/_internal/psycopg_binary/pq.pyd": ["libpq-abc.dll"],
      "runtime/backend/_internal/psycopg_binary.libs/libpq-abc.dll": [
        "kernel32.dll",
      ],
      "app/dist/native/animama_input_hook.node": ["kernel32.dll", "node.exe"],
      "electron/electron.exe": ["kernel32.dll"],
    };
    const files = { runtime: [], app: [], electron: [] };
    for (const name of Object.keys(imports)) {
      portableExecutable(path.join(root, name));
      const [part, ...rest] = name.split("/");
      files[part].push(rest.join("/"));
    }
    const roots = Object.fromEntries(
      Object.keys(files).map((part) => [part, path.join(root, part)]),
    );
    const runNative = (command, args) =>
      dumpbin(imports[path.relative(root, args.at(-1)).replaceAll("\\", "/")]);
    const audit = (stageFiles) =>
      auditWindowsStage(roots, stageFiles, {
        systemDlls: ["kernel32.dll"],
        systemDirectory: system,
        runNative,
      });
    const report = audit(files);
    const resolved = (part, file, name) =>
      report[part]
        .find((entry) => entry.path === file)
        .dependencies.find((dependency) => dependency.name === name).resolved;
    expect(resolved("runtime", "postgres/lib/vector.dll", "postgres.exe")).toBe(
      "stage:postgres/bin/postgres.exe",
    );
    expect(
      resolved(
        "runtime",
        "backend/_internal/pydantic_core/core.pyd",
        "vcruntime140.dll",
      ),
    ).toBe("stage:backend/_internal/vcruntime140.dll");
    expect(
      resolved(
        "runtime",
        "backend/_internal/psycopg_binary/pq.pyd",
        "libpq-abc.dll",
      ),
    ).toBe("stage:backend/_internal/psycopg_binary.libs/libpq-abc.dll");
    expect(
      resolved("app", "dist/native/animama_input_hook.node", "node.exe"),
    ).toBe("host");
    // The backend never searches PostgreSQL's folder for its runtime DLLs.
    expect(() =>
      audit({
        ...files,
        runtime: files.runtime.filter(
          (name) => name !== "backend/_internal/vcruntime140.dll",
        ),
      }),
    ).toThrow(
      "backend/_internal/python312.dll: vcruntime140.dll does not resolve",
    );
    // Only an addon's node.exe import binds to the host process, even in app.
    imports["app/dist/helper.dll"] = ["node.exe"];
    portableExecutable(path.join(root, "app/dist/helper.dll"));
    expect(() =>
      audit({ ...files, app: [...files.app, "dist/helper.dll"] }),
    ).toThrow("dist/helper.dll: node.exe does not resolve");
  });

  it("rejects binaries that embed a build-machine path in either encoding", () => {
    const root = fixture();
    const work = "C:\\Build\\Native";
    writeFileSync(path.join(root, "clean.dll"), "postgres.pdb\0");
    writeFileSync(path.join(root, "ascii.dll"), "c:/build/native/src/x.c\0");
    writeFileSync(
      path.join(root, "wide.dll"),
      Buffer.from("C:\\BUILD\\Native\\x.pdb", "utf16le"),
    );
    expect(() =>
      assertNoEmbeddedPaths(root, ["clean.dll"], [work]),
    ).not.toThrow();
    expect(() => assertNoEmbeddedPaths(root, ["ascii.dll"], [work])).toThrow(
      "ascii.dll embeds a build-machine path",
    );
    expect(() => assertNoEmbeddedPaths(root, ["wide.dll"], [work])).toThrow(
      "wide.dll embeds a build-machine path",
    );
  });
});

describe("process guard path", () => {
  it("is the same file for the stage, the licenses and the main process", () => {
    expect(PROCESS_GUARD).toBe(PROCESS_GUARD_PATH);
  });
});

describe("packaging gate", () => {
  it("packages only targets that have an embedded runtime", () => {
    for (const [nodeName, arch] of [
      ["linux", "arm64"],
      ["win32", "arm64"],
      ["darwin", "x64"],
    ])
      expect(() => packagedTarget({ platform: { nodeName }, arch })).toThrow(
        "Embedded packaging supports macOS arm64, Windows x64 and Linux x64 only",
      );
    expect(
      packagedTarget({ platform: { nodeName: "win32" }, arch: "x64" }),
    ).toBe("win32-x64");
    expect(
      packagedTarget({ platform: { nodeName: "darwin" }, arch: "arm64" }),
    ).toBe("darwin-arm64");
  });
});

describe("Windows icon file", () => {
  // A 1x1 PNG is enough for the icon structure; content does not matter here.
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
    "hex",
  );

  it("writes an icon file whose images resedit can read back", async () => {
    const ResEdit = await import("resedit");
    const parsed = ResEdit.Data.IconFile.from(
      iconFile([
        { size: 16, png },
        { size: 256, png },
      ]),
    );
    // The directory stores 256 pixels as 0.
    expect(parsed.icons.map((icon) => icon.width)).toEqual([16, 0]);
  });
});
