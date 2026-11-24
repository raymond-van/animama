import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRIVATE_PACK_IDS,
  RuntimeSupervisor,
} from "../src/main-process/runtime/supervisor.js";
import { runtimePaths } from "../src/main-process/runtime/paths.js";
import { atomicWrite } from "../src/main-process/runtime/atomic-file.js";
import { normalizeSchemaDump } from "../src/main-process/runtime/schema.js";
import {
  manifestDigest,
  versionDirectory,
  PACK_METADATA,
  type PackManifest,
} from "../src/main-process/feature-packs/catalog.js";
import { credentialTarget } from "../../shared/desktop-runtime";
import { useProcessGuard } from "../src/main-process/runtime/processes.js";

const fixture = vi.hoisted(() => {
  type Child = {
    name: string;
    env: Record<string, string>;
    args: string[];
    child: { pid: number };
    output: string;
    token: string;
    exit: Promise<void>;
    finish(): void;
  };
  const launches: Child[] = [];
  const owners: Set<Child>[] = [];
  const state = {
    schema_version: 1,
    postgresql_version: "16.15",
    pgvector_version: "0.8.6",
    alembic_head: "baseline_20260908",
    installation_principal_id: "11111111-1111-4111-8111-111111111111",
  };
  const health = {
    schema_version: 1,
    runtime_version: "0.1.0",
    build_id: "b".repeat(64),
    alembic_head: state.alembic_head,
    installation_principal_id: state.installation_principal_id,
  };
  // Stands in for the bundled pg_dump --schema-only output of a current profile.
  const schema =
    "-- Dumped from database version 16.15\nCREATE TABLE public.fixture (id integer);\n";
  return {
    launches,
    owners,
    state,
    health,
    schema,
    ready: vi.fn(),
    quiesce: vi.fn(),
    deliveries: [] as {
      headers: Record<string, string>;
      body: {
        schema_version: number;
        generation: number;
        credentials: Record<string, string>;
      };
    }[],
    deliver: vi.fn(),
    available: vi.fn(),
    elevated: vi.fn(async () => false),
    verify: vi.fn(),
    postgresStarts: vi.fn(),
    postgresStops: vi.fn(),
    command: vi.fn(),
  };
});

vi.mock("../src/main-process/runtime/manifest.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/main-process/runtime/manifest.js")
  >()),
  verifyRuntime: fixture.verify,
}));
vi.mock("../src/main-process/runtime/ports.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/main-process/runtime/ports.js")
  >()),
  unusedLoopbackPort: async () => 41234,
  assertLoopbackPortAvailable: fixture.available,
}));
vi.mock("../src/main-process/runtime/processes.js", () => ({
  runCommand: fixture.command,
  runsElevated: fixture.elevated,
  useProcessGuard: vi.fn(),
  OwnedProcesses: class {
    children = new Set<(typeof fixture.launches)[number]>();
    constructor() {
      fixture.owners.push(this.children);
    }
    launch(
      name: string,
      _executable: string,
      args: string[],
      env: Record<string, string>,
    ) {
      let done!: () => void;
      const exit = new Promise<void>((resolve) => {
        done = resolve;
      });
      const child = {
        name,
        env,
        args,
        child: { pid: 1000 + fixture.launches.length },
        processId: 1000 + fixture.launches.length,
        output: "",
        token: `fixture-process-token-${fixture.launches.length}`,
        exit,
        finish: () => {
          this.children.delete(child);
          done();
        },
      };
      this.children.add(child);
      fixture.launches.push(child);
      return child;
    }
    async terminate(child: (typeof fixture.launches)[number]) {
      if (this.children.has(child)) child.finish();
    }
    async terminateAll() {
      for (const child of this.children) child.finish();
    }
  },
}));
vi.mock("../src/main-process/runtime/postgres.js", () => ({
  PrivatePostgres: class {
    port = 41236;
    process?: (typeof fixture.launches)[number];
    constructor(
      _runtime: string,
      private paths: ReturnType<typeof runtimePaths>,
      private owned: {
        launch: (...args: unknown[]) => (typeof fixture.launches)[number];
        terminate: (child: unknown) => Promise<void>;
      },
    ) {}
    bin(name: string) {
      return name;
    }
    async start(password: string) {
      fixture.postgresStarts();
      mkdirSync(this.paths.pgData, { recursive: true });
      writeFileSync(path.join(this.paths.pgData, "PG_VERSION"), "16\n");
      this.process = this.owned.launch("postgres", "postgres", [], {});
      return { PGPORT: String(this.port), PGPASSWORD: password };
    }
    async stop() {
      fixture.postgresStops();
      if (this.process) await this.owned.terminate(this.process);
    }
  },
}));

const roots: string[] = [];
let runtime: RuntimeSupervisor | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  fixture.launches.splice(0);
  fixture.owners.splice(0);
  fixture.verify.mockResolvedValue({
    app_version: "0.1.0",
    build_id: fixture.health.build_id,
    alembic_head: fixture.state.alembic_head,
    postgresql: { pgvector: "0.8.6" },
    local_http_schema_version: 1,
    database_schema_sha256: createHash("sha256")
      .update(normalizeSchemaDump(fixture.schema))
      .digest("hex"),
  });
  fixture.command.mockImplementation(async (executable, args) =>
    executable === "pg_dump" && args[0] === "--schema-only"
      ? fixture.schema
      : JSON.stringify(fixture.state),
  );
  fixture.available.mockResolvedValue(undefined);
  fixture.ready.mockImplementation(async () => {
    const child = fixture.launches
      .filter((item) => item.name === "fastapi")
      .at(-1)!;
    return Response.json({
      ...fixture.health,
      local_http_schema_version: 1,
      process_id: child.child.pid,
      process_start_token: child.token,
    });
  });
  fixture.quiesce.mockImplementation(async () =>
    Response.json({ schema_version: 1, state: "quiesced" }),
  );
  fixture.deliveries.splice(0);
  fixture.deliver.mockImplementation(async (body: { generation: number }) =>
    Response.json({ schema_version: 1, generation: body.generation }),
  );
  vi.stubGlobal("fetch", vi.fn(defaultFetch));
});
afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function create(
  paths = runtimePaths(
    mkdtempSync(path.join(realpathSync(tmpdir()), "animama-supervisor-")),
  ),
) {
  roots.push(paths.base);
  const options = {
    runtimeRoot: path.join(paths.base, "fixture-runtime"),
    appVersion: "0.1.0",
    paths,
    // Fake encryption isolates orchestration; vault tests exercise encryption separately.
    encryption: {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value: string) => Buffer.from(value),
      decryptStringAsync: async (value: Buffer) => ({
        result: value.toString(),
        shouldReEncrypt: false,
      }),
    },
    onStatus: vi.fn(),
    quiesceRenderers: vi.fn(async () => undefined),
  };
  mkdirSync(options.runtimeRoot, { recursive: true });
  const catalog = {
    schema: "animama-pack-catalog/1",
    app_version: options.appVersion,
    entries: [],
  };
  writeFileSync(
    path.join(options.runtimeRoot, "pack-catalog.json"),
    JSON.stringify({
      id: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
      ...catalog,
    }),
  );
  runtime = new RuntimeSupervisor(options);
  return { runtime, options };
}

/** A data-only archive pack fixture exercises custody and transitions. */
function seedPack(
  options: ReturnType<typeof create>["options"],
  appVersions = ["0.1.0"],
) {
  const manifest: PackManifest = {
    schema: "animama-feature-pack/1",
    id: "expanded-included-content",
    display_name: "Fixture content",
    version: "0.1.0",
    app_versions: appVersions,
    platform: "data-only",
    architecture: "data-only",
    url: "https://github.com/example/animama/releases/download/v0.1.0/expanded-included-content.tar.zst",
    archive_bytes: 100,
    archive_sha256: "a".repeat(64),
    installed_bytes: 2,
    minimum_peak_free_bytes: 100,
    license_refs: ["fixture"],
    signing: null,
    files: [
      {
        path: "config.json",
        size_bytes: 2,
        sha256: createHash("sha256").update("{}").digest("hex"),
        media_type: "application/json",
        mode: "0644",
      },
    ],
  };
  const root = path.join(
    options.paths.packs,
    `${manifest.id}/versions`,
    versionDirectory(manifest),
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "config.json"), "{}", { mode: 0o644 });
  writeFileSync(path.join(root, PACK_METADATA), JSON.stringify(manifest));
  atomicWrite(
    path.join(options.paths.packs, "active.json"),
    JSON.stringify({
      schema: 1,
      packs: {
        [manifest.id]: {
          directory: versionDirectory(manifest),
          digest: manifestDigest(manifest),
        },
      },
    }),
  );
  const catalog = {
    schema: "animama-pack-catalog/1",
    app_version: "0.1.0",
    entries: [manifest],
  };
  writeFileSync(
    path.join(options.runtimeRoot, "pack-catalog.json"),
    JSON.stringify({
      id: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
      ...catalog,
    }),
  );
  return root;
}

/** Whether the backend was started with the expanded pack's content mounted. */
function mountsExpanded(env: Record<string, string>): boolean {
  return JSON.parse(env.ANIMAMA_INCLUDED_CONTENT_SOURCES_JSON).some(
    (source: { pack_id: string | null }) =>
      source.pack_id === "expanded-included-content",
  );
}

async function defaultFetch(
  input: unknown,
  init?: RequestInit,
): Promise<Response> {
  if (String(input).endsWith("/_desktop/credentials")) {
    const delivery = {
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([name, value]) => [
          name.toLowerCase(),
          String(value),
        ]),
      ),
      body: JSON.parse(String(init?.body)),
    };
    fixture.deliveries.push(delivery);
    return fixture.deliver(delivery.body);
  }
  return String(input).includes("runtime:quiesce")
    ? fixture.quiesce()
    : fixture.ready();
}

function fastapiLaunches() {
  return fixture.launches.filter((child) => child.name === "fastapi");
}

function allowRemoval() {
  vi.mocked(fetch).mockImplementation(async (input) => {
    if (String(input).includes(":removal-check"))
      return Response.json({
        schema_version: 1,
        pack_id: "expanded-included-content",
        removable: true,
        blockers: [],
      });
    return defaultFetch(input);
  });
}

describe("runtime supervision", () => {
  const update = {
    version: "0.2.0",
    filename: "Animama-0.2.0-arm64.zip",
    sha512: "",
    downloadBytes: 1000,
    installedBytes: 5000,
    runtimeBuildId: "c".repeat(64),
    packDigests: {},
  };

  it("blocks an update that withdraws referenced expanded content before draining any service", async () => {
    const current = create();
    seedPack(current.options);
    await current.runtime.start();
    fixture.quiesce.mockClear();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        schema_version: 1,
        pack_id: "expanded-included-content",
        removable: false,
        blockers: [{ kind: "anima_loadout", id: "anima", label: "My Anima" }],
      }),
    );
    await expect(current.runtime.stopForUpdate(update)).rejects.toThrow(
      "update_pack_references_blocked",
    );
    expect(current.runtime.status().state).toBe("ready");
    expect(fixture.quiesce).not.toHaveBeenCalled();
    expect(fixture.owners.some((children) => children.size > 0)).toBe(true);
  });

  it("accepts an exact compatible expanded manifest without withdrawing its references", async () => {
    const current = create();
    seedPack(current.options, ["0.1.0", "0.2.0"]);
    await current.runtime.start();
    const expanded = current.runtime.featurePacks().activePacks()[
      "expanded-included-content"
    ]!;
    vi.mocked(fetch).mockClear();
    await current.runtime.preflightUpdate({
      ...update,
      packDigests: {
        "expanded-included-content": manifestDigest(expanded.manifest),
      },
    });
    expect(current.runtime.status().state).toBe("ready");
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(expanded.root)).toBe(true);
  });

  it("stops every owned service for an approved update and resumes only on explicit native failure", async () => {
    const current = create();
    await current.runtime.start();
    await current.runtime.stopForUpdate(update);
    expect(current.runtime.status()).toEqual({ state: "updating" });
    expect(fixture.owners.every((children) => children.size === 0)).toBe(true);
    expect(current.options.quiesceRenderers).toHaveBeenCalledOnce();
    expect(() =>
      current.runtime.changePack("install", "expanded-included-content"),
    ).toThrow("runtime_not_ready");
    await current.runtime.start(); // An ordinary Retry cannot resume writes during native replacement.
    expect(current.runtime.status()).toEqual({ state: "updating" });
    expect(fixture.owners.every((children) => children.size === 0)).toBe(true);
    await current.runtime.recoverFailedUpdate();
    expect(current.runtime.status().state).toBe("ready");
    expect(current.runtime.origin).toBe("http://127.0.0.1:41234");
    expect(
      existsSync(path.join(current.options.paths.pgData, "PG_VERSION")),
    ).toBe(true);
  });

  it.each([false, true])(
    "aborts an update safely when renderer drain fails (recovery failure=%s)",
    async (failRecovery) => {
      const current = create();
      await current.runtime.start();
      current.options.quiesceRenderers.mockRejectedValueOnce(
        new Error("fixture drain failure"),
      );
      if (failRecovery)
        fixture.ready.mockResolvedValueOnce(
          Response.json({ ...fixture.health, build_id: "wrong" }),
        );
      await expect(current.runtime.stopForUpdate(update)).rejects.toThrow(
        "fixture drain failure",
      );
      expect(current.runtime.status().state).toBe(
        failRecovery ? "error" : "ready",
      );
      expect(fixture.owners.every((children) => children.size === 0)).toBe(
        failRecovery,
      );
      expect(
        existsSync(path.join(current.options.paths.pgData, "PG_VERSION")),
      ).toBe(true);
    },
  );

  it("rejects an invalid replacement manifest before PostgreSQL or schema commands run", async () => {
    fixture.verify.mockRejectedValueOnce(new Error("invalid manifest"));
    const current = create();
    await current.runtime.start();
    expect(current.runtime.status().state).toBe("error");
    expect(fixture.postgresStarts).not.toHaveBeenCalled();
    expect(fixture.command).not.toHaveBeenCalled();
  });

  it("reports a bounded removal blocker without draining the app or changing the pack", async () => {
    const current = create();
    const root = seedPack(current.options);
    await current.runtime.start();
    const drainsBefore = fixture.quiesce.mock.calls.length;
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        schema_version: 1,
        pack_id: "expanded-included-content",
        removable: false,
        blockers: [
          { kind: "runtime_lease", id: "lease", label: "Active preview" },
        ],
      }),
    );
    await expect(
      current.runtime.featurePacks().remove("expanded-included-content"),
    ).rejects.toThrow("pack_in_use");
    expect(current.runtime.status().state).toBe("ready");
    expect(current.options.quiesceRenderers).not.toHaveBeenCalled();
    expect(fixture.quiesce.mock.calls.length).toBe(drainsBefore);
    expect(existsSync(root)).toBe(true);
    expect(current.runtime.featurePacks().list()[0].blockers?.[0].label).toBe(
      "Active preview",
    );
  });

  it.each([
    [[]],
    [["mixamo-motion"]],
    [["wow-comedy-sfx"]],
    [["mixamo-motion", "wow-comedy-sfx"]],
  ])(
    "mounts each bundled private pack only when it was staged (%j)",
    async (staged) => {
      const current = create();
      for (const id of staged)
        mkdirSync(path.join(current.options.runtimeRoot, "content", id), {
          recursive: true,
        });
      await current.runtime.start();
      const backend = fixture.launches
        .filter((child) => child.name === "fastapi")
        .at(-1)!;
      const sources = JSON.parse(
        backend.env.ANIMAMA_INCLUDED_CONTENT_SOURCES_JSON,
      ) as { id: string; pack_id: string | null }[];
      expect(sources[0].id).toBe("core");
      expect(
        sources
          .filter((source) =>
            (PRIVATE_PACK_IDS as readonly string[]).includes(
              source.pack_id ?? "",
            ),
          )
          .map((source) => [source.id, source.pack_id]),
      ).toEqual(staged.map((id) => [id, id]));
    },
  );

  it.each([false, true])(
    "quiesces the renderer and keeps the saved origin through removal (rollback=%s)",
    async (fail) => {
      const current = create();
      const root = seedPack(current.options);
      await current.runtime.start();
      expect(current.runtime.status().state).toBe("ready");
      const pointer = readFileSync(
        path.join(current.options.paths.packs, "active.json"),
        "utf8",
      );
      allowRemoval();
      if (fail)
        fixture.ready.mockResolvedValueOnce(
          Response.json({ ...fixture.health, build_id: "wrong" }),
        );
      const removal = current.runtime
        .featurePacks()
        .remove("expanded-included-content");
      if (fail) await expect(removal).rejects.toThrow();
      else await removal;
      expect(current.options.quiesceRenderers).toHaveBeenCalledOnce();
      expect(
        fixture.available.mock.calls.every(([port]) => port === 41234),
      ).toBe(true);
      expect(fixture.postgresStarts).toHaveBeenCalledOnce();
      expect(current.runtime.status()).toEqual({
        state: "ready",
        origin: "http://127.0.0.1:41234",
      });
      const backend = fixture.launches
        .filter((child) => child.name === "fastapi")
        .at(-1)!;
      expect(mountsExpanded(backend.env)).toBe(fail);
      expect(existsSync(root)).toBe(fail);
      if (fail)
        expect(
          readFileSync(
            path.join(current.options.paths.packs, "active.json"),
            "utf8",
          ),
        ).toBe(pointer);
    },
  );

  it("provisions once, reuses the stable origin, rotates launch tokens, and preserves the database identity", async () => {
    const first = create();
    await first.runtime.start();
    expect(first.runtime.status()).toEqual({
      state: "ready",
      origin: "http://127.0.0.1:41234",
    });
    const firstBackend = fixture.launches.find(
      (child) => child.name === "fastapi",
    )!;
    const firstPassword = firstBackend.env.PGPASSWORD;
    expect(firstBackend.args).not.toContain(firstPassword);
    expect(JSON.stringify(first.runtime.status())).not.toContain(
      firstBackend.env.ANIMAMA_DESKTOP_CONTROL_TOKEN,
    );
    await first.runtime.stop();
    expect(fixture.owners.every((children) => children.size === 0)).toBe(true);
    const second = create(first.options.paths);
    await second.runtime.start();
    const backend = fixture.launches
      .filter((child) => child.name === "fastapi")
      .at(-1)!;
    expect(backend.env.PGPASSWORD).toBe(firstPassword);
    expect(backend.env.ANIMAMA_DESKTOP_CONTROL_TOKEN).not.toBe(
      firstBackend.env.ANIMAMA_DESKTOP_CONTROL_TOKEN,
    );
    expect(second.runtime.rendererCapability).not.toBe(
      first.runtime.rendererCapability,
    );
    expect(fixture.available.mock.calls.at(-1)?.[0]).toBe(41234);
    expect(
      JSON.parse(readFileSync(second.options.paths.state, "utf8")).gatewayPort,
    ).toBe(41234);
  });

  it("preserves saved port 80 through failed startup, retry and consumer restart", async () => {
    const current = create();
    const saved = JSON.stringify({ version: 1, gatewayPort: 80 });
    atomicWrite(current.options.paths.state, saved);
    fixture.ready.mockResolvedValueOnce(Response.json({ invalid: true }));
    await current.runtime.start();
    expect(current.runtime.status().state).toBe("error");
    await current.runtime.start();
    expect(current.runtime.status()).toEqual({
      state: "ready",
      origin: "http://127.0.0.1",
    });
    await current.runtime.changeCredentials([
      { provider: "openai", value: "fixture-key" },
    ]);
    expect(current.runtime.status().state).toBe("ready");
    expect(fixture.deliveries).toHaveLength(1);
    expect(fixture.available.mock.calls.every(([port]) => port === 80)).toBe(
      true,
    );
    for (const child of fixture.launches.filter(
      (item) => item.name === "fastapi",
    ))
      expect(child.args).toEqual([
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "80",
      ]);
    expect(readFileSync(current.options.paths.state, "utf8")).toBe(saved);
  });

  it("makes the encryption key durable before creating a new vault, once", async () => {
    const current = create();
    const vaultExisted: boolean[] = [];
    const beforeNewVault = vi.fn(async () => {
      vaultExisted.push(existsSync(current.options.paths.vault));
    });
    Object.assign(current.options, { beforeNewVault });
    await current.runtime.start();
    expect(current.runtime.status().state).toBe("ready");
    expect(vaultExisted).toEqual([false]);
    expect(existsSync(current.options.paths.vault)).toBe(true);
  });

  it("reports a refused Keychain as unavailable secure storage and starts nothing until a later start", async () => {
    const first = create();
    await first.runtime.start();
    await first.runtime.stop();
    const vault = readFileSync(first.options.paths.vault);
    const postgresStarts = fixture.postgresStarts.mock.calls.length;
    const current = create(first.options.paths);
    const { decryptStringAsync } = current.options.encryption;
    current.options.encryption.decryptStringAsync = async () => {
      throw new Error(
        "safeStorage.decryptStringAsync is temporarily unavailable. Please try again.",
      );
    };
    await current.runtime.start();
    expect(current.runtime.status()).toEqual({
      state: "error",
      code: "secure_storage_unavailable",
    });
    expect(fixture.postgresStarts).toHaveBeenCalledTimes(postgresStarts);
    expect(readFileSync(current.options.paths.vault)).toEqual(vault);

    current.options.encryption.decryptStringAsync = decryptStringAsync;
    await current.runtime.start();
    expect(current.runtime.status().state).toBe("ready");
  });

  it("refuses an elevated Windows launch before verifying or creating anything", async () => {
    const platform = vi.spyOn(process, "platform", "get");
    platform.mockReturnValue("win32");
    fixture.elevated.mockResolvedValueOnce(true);
    try {
      const current = create();
      await current.runtime.start();
      expect(current.runtime.status()).toEqual({
        state: "error",
        code: "administrator_launch_unsupported",
      });
      expect(fixture.verify).not.toHaveBeenCalled();
      expect(fixture.postgresStarts).not.toHaveBeenCalled();
      expect(existsSync(current.options.paths.vault)).toBe(false);
    } finally {
      platform.mockRestore();
    }
  });

  it("selects the verified process guard before any Windows service starts", async () => {
    const platform = vi.spyOn(process, "platform", "get");
    platform.mockReturnValue("win32");
    try {
      const current = create();
      await current.runtime.start();
      expect(useProcessGuard).toHaveBeenCalledWith(
        path.join(current.options.runtimeRoot, "bin/animama-process-guard.exe"),
      );
      const selected = vi.mocked(useProcessGuard).mock.invocationCallOrder[0]!;
      expect(fixture.verify.mock.invocationCallOrder[0]).toBeLessThan(selected);
      expect(
        fixture.postgresStarts.mock.invocationCallOrder[0],
      ).toBeGreaterThan(selected);
    } finally {
      platform.mockRestore();
    }
  });

  it("selects the Linux process guard too, and none on macOS", async () => {
    const platform = vi.spyOn(process, "platform", "get");
    try {
      platform.mockReturnValue("linux");
      const linux = create();
      await linux.runtime.start();
      expect(useProcessGuard).toHaveBeenLastCalledWith(
        path.join(linux.options.runtimeRoot, "bin/animama-process-guard"),
      );
      vi.mocked(useProcessGuard).mockClear();
      platform.mockReturnValue("darwin");
      await create().runtime.start();
      expect(useProcessGuard).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });

  it("shows stable-port collision recovery without starting a database or changing the saved origin", async () => {
    const current = create();
    atomicWrite(
      current.options.paths.state,
      JSON.stringify({ version: 1, gatewayPort: 45678 }),
    );
    fixture.available.mockRejectedValueOnce(
      Object.assign(new Error("occupied"), { code: "EADDRINUSE" }),
    );
    await current.runtime.start();
    expect(current.runtime.status()).toEqual({
      state: "error",
      code: "gateway_port_in_use",
    });
    expect(fixture.postgresStarts).not.toHaveBeenCalled();
    await current.runtime.start();
    expect(current.runtime.status()).toEqual({
      state: "ready",
      origin: "http://127.0.0.1:45678",
    });
  });

  it("applies a saved key to the running backend without restarting anything", async () => {
    const current = create();
    await current.runtime.start();
    const launches = fixture.launches.length;
    const statuses: string[] = [];
    current.options.onStatus.mockImplementation((status) =>
      statuses.push(status.state),
    );

    const result = await current.runtime.changeCredentials([
      { provider: "openai", value: "fixture-provider-key" },
    ]);

    expect(
      result.find((entry) => credentialTarget(entry) === "openai"),
    ).toMatchObject({
      configured: true,
      restartRequired: false,
    });
    expect(
      result.find((entry) => credentialTarget(entry) === "openai")?.error,
    ).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("fixture-provider-key");
    expect(fixture.launches).toHaveLength(launches);
    expect(fixture.quiesce).not.toHaveBeenCalled();
    expect(current.options.quiesceRenderers).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
    expect(current.runtime.status().state).toBe("ready");
    expect(fixture.deliveries).toHaveLength(1);
    const [delivery] = fixture.deliveries;
    expect(delivery.body).toEqual({
      schema_version: 1,
      generation: 1,
      credentials: { OPENAI_API_KEY: "fixture-provider-key" },
    });
    // Only the private control token; nothing a browser would send.
    expect(Object.keys(delivery.headers).sort()).toEqual([
      "content-type",
      "x-animama-desktop-control",
    ]);
    expect(delivery.headers["x-animama-desktop-control"]).toBe(
      fastapiLaunches().at(-1)?.env.ANIMAMA_DESKTOP_CONTROL_TOKEN,
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(
          ([input]) => !String(input).includes("fixture-provider-key"),
        ),
    ).toBe(true);
  });

  it("delivers the whole saved set so a removed key is simply absent", async () => {
    const current = create();
    await current.runtime.start();
    await current.runtime.changeCredentials([
      { provider: "openai", value: "fixture-openai" },
      { provider: "anthropic", value: "fixture-anthropic" },
      { provider: "elevenlabs", value: "fixture-elevenlabs" },
    ]);
    await current.runtime.changeCredentials([{ provider: "openai" }]);

    expect(fixture.deliveries.map((delivery) => delivery.body)).toEqual([
      {
        schema_version: 1,
        generation: 1,
        credentials: {
          OPENAI_API_KEY: "fixture-openai",
          ANTHROPIC_API_KEY: "fixture-anthropic",
          ELEVENLABS_API_KEY: "fixture-elevenlabs",
        },
      },
      {
        schema_version: 1,
        generation: 2,
        credentials: {
          ANTHROPIC_API_KEY: "fixture-anthropic",
          ELEVENLABS_API_KEY: "fixture-elevenlabs",
        },
      },
    ]);
    expect(fastapiLaunches()).toHaveLength(1);
  });

  it("registers every value with the log redactor before sending it", async () => {
    const { runtimeRedactor } =
      await import("../src/main-process/runtime/redaction.js");
    const current = create();
    await current.runtime.start();
    fixture.deliver.mockImplementationOnce(
      async (body: { generation: number }) => {
        expect(
          runtimeRedactor.redact("sent fixture-redacted-value-0123456789"),
        ).not.toContain("fixture-redacted-value-0123456789");
        return Response.json({
          schema_version: 1,
          generation: body.generation,
        });
      },
    );

    await current.runtime.changeCredentials([
      { provider: "openai", value: "fixture-redacted-value-0123456789" },
    ]);

    expect(fixture.deliver).toHaveBeenCalledOnce();
  });

  it("runs concurrent saves in order with increasing generations", async () => {
    const current = create();
    await current.runtime.start();
    await Promise.all([
      current.runtime.changeCredentials([
        { provider: "openai", value: "fixture-a" },
      ]),
      current.runtime.changeCredentials([
        { provider: "openai", value: "fixture-b" },
      ]),
      current.runtime.changeCredentials([{ provider: "openai" }]),
    ]);

    expect(
      fixture.deliveries.map((delivery) => [
        delivery.body.generation,
        delivery.body.credentials.OPENAI_API_KEY,
      ]),
    ).toEqual([
      [1, "fixture-a"],
      [2, "fixture-b"],
      [3, undefined],
    ]);
  });

  it("retries one failed delivery without restarting", async () => {
    const current = create();
    await current.runtime.start();
    fixture.deliver.mockRejectedValueOnce(new Error("connection reset"));

    const statuses = await current.runtime.changeCredentials([
      { provider: "openai", value: "fixture-key" },
    ]);

    expect(
      statuses.find((entry) => credentialTarget(entry) === "openai")?.error,
    ).toBeUndefined();
    expect(
      fixture.deliveries.map((delivery) => delivery.body.generation),
    ).toEqual([1, 2]);
    expect(fastapiLaunches()).toHaveLength(1);
    expect(fixture.quiesce).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unreachable backend",
      () => fixture.deliver.mockRejectedValue(new Error("refused")),
    ],
    [
      "a refused delivery",
      () =>
        fixture.deliver.mockResolvedValue(
          Response.json(
            { detail: { code: "credentials_invalid" } },
            { status: 400 },
          ),
        ),
    ],
    [
      "a mismatched acknowledgement",
      () =>
        fixture.deliver.mockImplementation(async () =>
          Response.json({ schema_version: 1, generation: 999 }),
        ),
    ],
  ])(
    "restarts from the vault after two failed deliveries (%s)",
    async (_case, fail) => {
      const current = create();
      await current.runtime.start();
      fail();
      const logged = (["log", "info", "warn", "error", "debug"] as const).map(
        (level) => vi.spyOn(console, level),
      );

      const statuses = await current.runtime.changeCredentials([
        { provider: "openai", value: "fixture-key" },
      ]);

      for (const spy of logged)
        expect(JSON.stringify(spy.mock.calls)).not.toContain("fixture-key");

      expect(fixture.deliveries).toHaveLength(2);
      expect(fixture.quiesce).toHaveBeenCalledOnce();
      expect(current.options.quiesceRenderers).toHaveBeenCalledOnce();
      expect(fastapiLaunches()).toHaveLength(2);
      expect(fastapiLaunches().at(-1)?.env.OPENAI_API_KEY).toBe("fixture-key");
      expect(current.runtime.status().state).toBe("ready");
      expect(
        statuses.find((entry) => credentialTarget(entry) === "openai"),
      ).toMatchObject({
        configured: true,
        restartRequired: false,
      });
      expect(JSON.stringify(statuses)).not.toContain("fixture-key");
    },
  );

  it("restarts from the vault even when the drain reports busy, because admission stays closed", async () => {
    const current = create();
    await current.runtime.start();
    fixture.deliver.mockRejectedValue(new Error("refused"));
    fixture.quiesce.mockResolvedValueOnce(
      Response.json({ detail: { code: "runtime_busy" } }, { status: 409 }),
    );

    await current.runtime.changeCredentials([
      { provider: "openai", value: "fixture-key" },
    ]);

    expect(fastapiLaunches()).toHaveLength(2);
    expect(fastapiLaunches().at(-1)?.env.OPENAI_API_KEY).toBe("fixture-key");
    expect(current.runtime.status().state).toBe("ready");
  });

  it("starts no document worker and passes no worker settings beside a retired document pack", async () => {
    const current = create();
    // An installation that once activated the retired document-processing pack.
    const retired = path.join(
      current.options.paths.packs,
      "document-processing",
    );
    mkdirSync(path.join(retired, "versions/0.1.0-0123456789abcdef"), {
      recursive: true,
    });
    atomicWrite(
      path.join(current.options.paths.packs, "active.json"),
      JSON.stringify({
        schema: 1,
        packs: {
          "document-processing": {
            directory: "0.1.0-0123456789abcdef",
            digest: "a".repeat(64),
          },
        },
      }),
    );

    await current.runtime.start();

    expect(current.runtime.status().state).toBe("ready");
    expect(fixture.launches.map((child) => child.name).sort()).toEqual([
      "avatar-cleanup",
      "fastapi",
      "postgres",
    ]);
    for (const child of fixture.launches)
      expect(
        Object.keys(child.env).filter((name) =>
          name.startsWith("ANIMAMA_DOCUMENT_"),
        ),
      ).toEqual([]);
    expect(existsSync(retired)).toBe(false);
    expect(
      current.runtime
        .featurePacks()
        .list()
        .map((pack) => pack.id),
    ).toEqual(["expanded-included-content"]);
  });

  it("keeps the replacement running when the backend crashed during a save", async () => {
    const current = create();
    await current.runtime.start();
    fixture.deliver.mockImplementation(async () => {
      // The crash that makes delivery fail also queues the exit handler's stop.
      fastapiLaunches().at(-1)?.finish();
      throw new Error("connection refused");
    });

    await current.runtime.changeCredentials([
      { provider: "openai", value: "fixture-key" },
    ]);
    fixture.deliver.mockImplementation(async (body: { generation: number }) =>
      Response.json({ schema_version: 1, generation: body.generation }),
    );
    // A later save runs after the exit handler's queued stop.
    await current.runtime.changeCredentials([
      { provider: "elevenlabs", value: "fixture-other" },
    ]);

    expect(current.runtime.status().state).toBe("ready");
    const replacement = fastapiLaunches().at(-1)!;
    expect(fixture.owners.at(-1)?.has(replacement)).toBe(true);
    expect(replacement.env.OPENAI_API_KEY).toBe("fixture-key");
  });

  it("never gives saved keys to cleanup or database commands", async () => {
    const current = create();
    await current.runtime.start();
    await current.runtime.changeCredentials([
      { provider: "openai", value: "fixture-key" },
    ]);
    await current.runtime.stop();
    const again = create(current.options.paths);
    await again.runtime.start();

    expect(fastapiLaunches().at(-1)?.env.OPENAI_API_KEY).toBe("fixture-key");
    expect(
      fixture.launches.filter((child) => child.name === "avatar-cleanup").at(-1)
        ?.env.OPENAI_API_KEY,
    ).toBeUndefined();
    const databaseCommands = fixture.command.mock.calls.filter(
      ([, args]) => (args as string[])[0] === "database",
    );
    expect(databaseCommands.length).toBeGreaterThan(0);
    for (const [, , env] of databaseCommands)
      expect((env as Record<string, string>).OPENAI_API_KEY).toBeUndefined();
  });

  it("turns off OpenAI Agents SDK tracing in every runtime child, keys or not", async () => {
    const first = create();
    await first.runtime.start();
    await first.runtime.changeCredentials([
      { provider: "openai", value: "fixture-key" },
    ]);
    await first.runtime.stop();
    const again = create(first.options.paths);
    await again.runtime.start();

    // The first FastAPI started without a key; the relaunch starts with it.
    expect(fastapiLaunches().map((child) => child.env.OPENAI_API_KEY)).toEqual([
      undefined,
      "fixture-key",
    ]);
    const runtimeChildren = fixture.launches.filter(
      (child) => child.name !== "postgres",
    );
    expect(runtimeChildren.map((child) => child.name)).toEqual(
      expect.arrayContaining(["fastapi", "avatar-cleanup"]),
    );
    for (const child of runtimeChildren)
      expect(child.env.OPENAI_AGENTS_DISABLE_TRACING).toBe("1");
  });

  it("gives a saved connection key to FastAPI on start but never to cleanup", async () => {
    const env = "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY";
    const first = create();
    await first.runtime.start();
    await first.runtime.changeCredentials([
      { connection: env, value: "fixture-connection-key" },
    ]);
    await first.runtime.stop();
    const launches = fixture.launches.length;

    const second = create(first.options.paths);
    await second.runtime.start();

    const started = fixture.launches.slice(launches);
    expect(started.find((child) => child.name === "fastapi")?.env[env]).toBe(
      "fixture-connection-key",
    );
    const cleanup = started.find((child) => child.name === "avatar-cleanup");
    expect(cleanup).toBeDefined();
    expect(cleanup?.env[env]).toBeUndefined();
  });

  it("stores and removes the web search key under its managed name", async () => {
    const env = "ANIMAMA_CONNECTION_WEB_SEARCH_API_KEY";
    const current = create();
    await current.runtime.start();

    const saved = await current.runtime.changeCredentials([
      { connection: env, value: "fixture-search-key" },
    ]);
    expect(
      saved.find((status) => credentialTarget(status) === env),
    ).toMatchObject({ configured: true, restartRequired: false });
    // Delivered live to the running backend, without a restart.
    expect(fastapiLaunches()).toHaveLength(1);
    expect(fixture.deliveries.at(-1)?.body.credentials).toEqual({
      [env]: "fixture-search-key",
    });

    const removed = await current.runtime.changeCredentials([
      { connection: env },
    ]);
    expect(
      removed.find((status) => credentialTarget(status) === env),
    ).toBeUndefined();
    expect(fixture.deliveries.at(-1)?.body.credentials).toEqual({});
  });

  it("refuses a connection key beyond the limit without stopping services", async () => {
    const current = create();
    await current.runtime.start();
    for (let batch = 0; batch < 4; batch += 1)
      await current.runtime.changeCredentials(
        Array.from({ length: 8 }, (_, index) => ({
          connection: `ANIMAMA_CONNECTION_C${batch * 8 + index}_API_KEY`,
          value: `fixture-${batch * 8 + index}`,
        })),
      );
    const launches = fixture.launches.filter(
      (child) => child.name === "fastapi",
    ).length;
    const quiesces = fixture.quiesce.mock.calls.length;
    const deliveries = fixture.deliveries.length;

    const statuses = await current.runtime.changeCredentials([
      {
        connection: "ANIMAMA_CONNECTION_EXTRA_API_KEY",
        value: "fixture-extra",
      },
    ]);

    expect(current.runtime.status()).toMatchObject({ state: "ready" });
    expect(fixture.quiesce.mock.calls.length).toBe(quiesces);
    expect(fixture.deliveries).toHaveLength(deliveries);
    expect(
      fixture.launches.filter((child) => child.name === "fastapi"),
    ).toHaveLength(launches);
    expect(
      statuses.find(
        (status) =>
          credentialTarget(status) === "ANIMAMA_CONNECTION_EXTRA_API_KEY",
      ),
    ).toMatchObject({
      configured: false,
      restartRequired: false,
      error: "connection_credentials_full",
    });
  });

  it("applies several credential changes in one delivery", async () => {
    const current = create();
    await current.runtime.start();
    await current.runtime.changeCredentials([
      {
        connection: "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY",
        value: "fixture-old-connection",
      },
    ]);
    const statuses = await current.runtime.changeCredentials([
      { provider: "openai", value: "fixture-openai" },
      { provider: "elevenlabs", value: "fixture-elevenlabs" },
      { connection: "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY" },
      {
        connection: "ANIMAMA_CONNECTION_C_NEW_API_KEY",
        value: "fixture-new-connection",
      },
    ]);
    expect(fastapiLaunches()).toHaveLength(1);
    expect(fixture.deliveries.at(-1)?.body.credentials).toEqual({
      OPENAI_API_KEY: "fixture-openai",
      ELEVENLABS_API_KEY: "fixture-elevenlabs",
      ANIMAMA_CONNECTION_C_NEW_API_KEY: "fixture-new-connection",
    });
    expect(
      Object.fromEntries(
        statuses.map((status) => [credentialTarget(status), status.configured]),
      ),
    ).toEqual({
      openai: true,
      anthropic: false,
      elevenlabs: true,
      gemini: false,
      ANIMAMA_CONNECTION_C_NEW_API_KEY: true,
    });
    expect(JSON.stringify(statuses)).not.toContain("fixture-");
  });

  it("records a failed vault write against every change in it and sends nothing", async () => {
    const current = create();
    await current.runtime.start();
    await current.runtime.changeCredentials([
      {
        connection: "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY",
        value: "fixture-old-connection",
      },
    ]);
    const vault = readFileSync(current.options.paths.vault);
    const deliveries = fixture.deliveries.length;
    current.options.encryption.encryptStringAsync = async () => {
      throw new Error("Error while encrypting the text");
    };
    const statuses = await current.runtime.changeCredentials([
      { provider: "openai", value: "fixture-openai" },
      { connection: "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY" },
      { connection: "ANIMAMA_CONNECTION_C_NEW_API_KEY", value: "fixture-new" },
    ]);
    const byTarget = Object.fromEntries(
      statuses.map((status) => [credentialTarget(status), status]),
    );
    expect(readFileSync(current.options.paths.vault)).toEqual(vault);
    expect(fixture.deliveries).toHaveLength(deliveries);
    expect(current.runtime.status().state).toBe("ready");
    expect(byTarget.openai).toMatchObject({
      configured: false,
      error: "secure_storage_unavailable",
    });
    expect(byTarget.ANIMAMA_CONNECTION_C_0123456789AB_API_KEY).toMatchObject({
      configured: true,
      error: "secure_storage_unavailable",
    });
    // A key that was never saved is still reported with its failure.
    expect(byTarget.ANIMAMA_CONNECTION_C_NEW_API_KEY).toMatchObject({
      configured: false,
      error: "secure_storage_unavailable",
    });
    expect(byTarget.elevenlabs?.error).toBeUndefined();
  });

  it("keeps a saved key through a failed fallback restart and applies it on recovery Retry", async () => {
    const current = create();
    await current.runtime.start();
    fixture.deliver.mockRejectedValue(new Error("refused"));
    fixture.ready.mockResolvedValueOnce(Response.json({}));
    const statuses = await current.runtime.changeCredentials([
      { provider: "openai", value: "fixture-saved-key" },
    ]);
    const failed = statuses.find(
      (entry) => credentialTarget(entry) === "openai",
    );
    expect(failed).toMatchObject({
      configured: true,
      restartRequired: true,
      error: "backend_readiness_mismatch",
    });
    expect(current.runtime.status().state).toBe("error");
    expect(JSON.stringify(current.runtime.credentials())).not.toContain(
      "fixture-saved-key",
    );

    await current.runtime.start();

    expect(current.runtime.status().state).toBe("ready");
    const restored = current.runtime
      .credentials()
      .find((entry) => credentialTarget(entry) === "openai");
    expect(restored).toMatchObject({
      configured: true,
      restartRequired: false,
    });
    expect(restored?.error).toBeUndefined();
    expect(fastapiLaunches().at(-1)?.env.OPENAI_API_KEY).toBe(
      "fixture-saved-key",
    );
  });

  it("rejects mismatched backend identity and stops every owned child", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        ...fixture.health,
        installation_principal_id: "another-owner",
      }),
    );
    const current = create();
    await current.runtime.start();
    expect(current.runtime.status()).toEqual({
      state: "error",
      code: "backend_readiness_mismatch",
    });
    expect(
      current.options.onStatus.mock.calls.some(
        ([status]) => status.state === "ready",
      ),
    ).toBe(false);
    expect(fixture.owners.every((children) => children.size === 0)).toBe(true);
  });

  it("stops before launching services when a current-revision profile has a stale schema", async () => {
    fixture.command.mockImplementation(async (executable, args) =>
      executable === "pg_dump" && args[0] === "--schema-only"
        ? "CREATE TABLE public.fixture (id integer, stale text);\n"
        : JSON.stringify(fixture.state),
    );
    const current = create();
    await current.runtime.start();
    expect(current.runtime.status()).toEqual({
      state: "error",
      code: "database_schema_mismatch",
    });
    expect(fixture.launches.map((child) => child.name)).toEqual(["postgres"]);
    // Repeatable seeds never run against a schema they may not fit.
    expect(
      fixture.command.mock.calls.some(([, args]) => args[1] === "bootstrap"),
    ).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(fixture.owners.every((children) => children.size === 0)).toBe(true);
    expect(
      existsSync(path.join(current.options.paths.pgData, "PG_VERSION")),
    ).toBe(true);
  });

  it.each([
    [
      "a current-revision profile before seeding",
      fixture.state.alembic_head,
      ["provision", "inspect", "--schema-only", "bootstrap"],
    ],
    [
      "a fresh profile after bootstrap",
      null,
      ["provision", "inspect", "bootstrap", "--schema-only"],
    ],
  ])(
    "verifies %s and before launching services",
    async (_name, head, expected) => {
      fixture.command.mockImplementation(async (executable, args) => {
        if (executable === "pg_dump" && args[0] === "--schema-only")
          return fixture.schema;
        return JSON.stringify(
          args[1] === "bootstrap"
            ? fixture.state
            : { ...fixture.state, alembic_head: head },
        );
      });
      const current = create();
      await current.runtime.start();
      expect(current.runtime.status().state).toBe("ready");
      const operations = fixture.command.mock.calls.map(([executable, args]) =>
        executable === "pg_dump" ? args[0] : args[1],
      );
      expect(operations).toEqual(expected);
      expect(
        fixture.command.mock.calls.find(
          ([executable]) => executable === "pg_dump",
        )?.[2],
      ).toMatchObject({ PGPORT: "41236" });
    },
  );

  it("reports a terminal content startup failure without waiting for the readiness deadline", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json(
        { detail: { code: "content_startup_failed" } },
        { status: 503 },
      ),
    );
    const current = create();
    await current.runtime.start();
    expect(current.runtime.status()).toEqual({
      state: "error",
      code: "content_startup_failed",
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    expect(fixture.owners.every((children) => children.size === 0)).toBe(true);
  });

  it("keeps polling while the backend reports ordinary startup progress", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({ detail: "runtime_starting" }, { status: 503 }),
      )
      .mockResolvedValueOnce(new Response("not json", { status: 503 }));
    const current = create();
    await current.runtime.start();
    expect(current.runtime.status().state).toBe("ready");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("recovers after an owned backend exit without deleting initialized data", async () => {
    const current = create();
    await current.runtime.start();
    fixture.launches.find((child) => child.name === "fastapi")!.finish();
    await vi.waitFor(() =>
      expect(current.runtime.status()).toEqual({
        state: "error",
        code: "backend_exited",
      }),
    );
    await current.runtime.start();
    expect(current.runtime.status().state).toBe("ready");
    expect(
      existsSync(path.join(current.options.paths.pgData, "PG_VERSION")),
    ).toBe(true);
  });

  it("supplies built assets and the asset-store speech source only to the owned HTTP child", async () => {
    const current = create();
    await current.runtime.start();
    const backend = fixture.launches.find((child) => child.name === "fastapi")!;
    expect(backend.args.slice(-2)).toEqual(["--port", "41234"]);
    expect(backend.env.ANIMAMA_PUBLIC_ORIGIN).toBe("http://127.0.0.1:41234");
    expect(backend.env.ANIMAMA_WEB_ROOT).toBe(
      path.join(current.options.runtimeRoot, "web"),
    );
    expect(backend.env.ANIMAMA_DESKTOP_RENDERER_CAPABILITY).toBe(
      current.runtime.rendererCapability,
    );
    expect(backend.env.ANIMAMA_DESKTOP_CONTROL_TOKEN).not.toBe(
      current.runtime.rendererCapability,
    );
    expect(backend.env.ANIMAMA_INTERNAL_GATEWAY_TOKEN).toBeUndefined();
    // The backend echoes this in /_desktop/health; a hard-coded API version
    // there blocked startup of any app version other than 0.1.0.
    expect(backend.env.ANIMAMA_DESKTOP_APP_VERSION).toBe(
      current.options.appVersion,
    );
    // Offline speech installs and serves through the backend's model-asset
    // store; main passes no Parakeet enablement, version or mount of its own.
    const parakeet = (env: Record<string, string>) =>
      Object.keys(env).filter((name) => name.startsWith("ANIMAMA_PARAKEET_"));
    expect(backend.env.ANIMAMA_PARAKEET_SOURCE).toBe("asset-store");
    expect(parakeet(backend.env)).toEqual(["ANIMAMA_PARAKEET_SOURCE"]);
    for (const worker of fixture.launches.filter(
      (child) => child.name !== "fastapi",
    )) {
      expect(worker.env.ANIMAMA_DESKTOP_CONTROL_TOKEN).toBeUndefined();
      expect(worker.env.ANIMAMA_DESKTOP_RENDERER_CAPABILITY).toBeUndefined();
      expect(parakeet(worker.env)).toEqual([]);
    }
  });

  it("leaves upload processing on by the backend's default, whatever the shell says", async () => {
    // The core backend processes uploads itself (spec #871 R1.7); no feature
    // pack switches it, and an owner's shell variable must not turn it off.
    vi.stubEnv("ANIMAMA_USER_FILE_PROCESSING_ENABLED", "false");
    try {
      const current = create();
      await current.runtime.start();
      expect(fastapiLaunches()).toHaveLength(1);
      for (const child of fixture.launches)
        expect(child.env).not.toHaveProperty(
          "ANIMAMA_USER_FILE_PROCESSING_ENABLED",
        );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes no companion-safety override to any packaged child", async () => {
    // Packaged builds must run with the safe defaults (spec R8); a shell
    // variable on the owner's machine must not relax them.
    const names = [
      "ANIMAMA_COMPANION_SAFETY_ENABLED",
      "ANIMAMA_AI_NOTICE_ENABLED",
      "ANIMAMA_AI_NOTICE_REMINDER_HOURS",
      "ANIMAMA_CRISIS_DETECTION_ENABLED",
      "ANIMAMA_CRISIS_RESOURCES_PATH",
    ];
    for (const name of names) vi.stubEnv(name, "false");
    try {
      const current = create();
      await current.runtime.start();
      expect(fixture.launches.length).toBeGreaterThan(0);
      for (const child of fixture.launches) {
        expect(
          Object.keys(child.env).filter((key) =>
            /^ANIMAMA_(COMPANION_SAFETY|AI_NOTICE|CRISIS)/u.test(key),
          ),
        ).toEqual([]);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("cannot expose ready after cleanup exits during the readiness request", async () => {
    fixture.ready.mockImplementationOnce(async () => {
      const backend = fixture.launches.find(
        (child) => child.name === "fastapi",
      )!;
      fixture.launches
        .find((child) => child.name === "avatar-cleanup")!
        .finish();
      return Response.json({
        ...fixture.health,
        local_http_schema_version: 1,
        process_id: backend.child.pid,
        process_start_token: backend.token,
      });
    });
    const current = create();
    await current.runtime.start();
    expect(current.runtime.status().state).toBe("error");
    expect(
      current.options.onStatus.mock.calls.some(
        ([status]) => status.state === "ready",
      ),
    ).toBe(false);
    expect(fixture.owners.every((children) => children.size === 0)).toBe(true);
  });

  it.each([
    { process_id: 1 },
    { process_start_token: "foreign-process" },
    { local_http_schema_version: 0 },
    { build_id: "old-build" },
  ])(
    "never promotes a foreign or incompatible readiness response: %j",
    async (change) => {
      fixture.ready.mockImplementationOnce(async () => {
        const child = fixture.launches
          .filter((item) => item.name === "fastapi")
          .at(-1)!;
        return Response.json({
          ...fixture.health,
          local_http_schema_version: 1,
          process_id: child.child.pid,
          process_start_token: child.token,
          ...change,
        });
      });
      const current = create();
      await current.runtime.start();
      expect(current.runtime.status()).toEqual({
        state: "error",
        code: "backend_readiness_mismatch",
      });
      expect(
        current.options.onStatus.mock.calls.some(
          ([status]) => status.state === "ready",
        ),
      ).toBe(false);
      expect(fixture.owners.every((children) => children.size === 0)).toBe(
        true,
      );
    },
  );

  it.each(["pack", "update"])(
    "a busy quiesce preserves the old %s configuration and restarts it",
    async (action) => {
      const current = create();
      const packRoot = seedPack(current.options);
      await current.runtime.start();
      const pointer = readFileSync(
        path.join(current.options.paths.packs, "active.json"),
        "utf8",
      );
      const vault = readFileSync(current.options.paths.vault);
      allowRemoval();
      fixture.quiesce.mockResolvedValueOnce(
        Response.json({ detail: { code: "runtime_busy" } }, { status: 409 }),
      );
      if (action === "pack")
        await expect(
          current.runtime.featurePacks().remove("expanded-included-content"),
        ).rejects.toThrow("runtime_busy");
      else
        await expect(current.runtime.stopForUpdate(update)).rejects.toThrow(
          "runtime_busy",
        );
      expect(current.runtime.status()).toEqual({
        state: "ready",
        origin: "http://127.0.0.1:41234",
      });
      expect(
        readFileSync(
          path.join(current.options.paths.packs, "active.json"),
          "utf8",
        ),
      ).toBe(pointer);
      expect(readFileSync(current.options.paths.vault)).toEqual(vault);
      expect(existsSync(packRoot)).toBe(true);
      expect(fixture.postgresStarts).toHaveBeenCalledOnce();
      const backend = fixture.launches
        .filter((child) => child.name === "fastapi")
        .at(-1)!;
      expect(mountsExpanded(backend.env)).toBe(true);
      expect(backend.env.OPENAI_API_KEY).toBeUndefined();
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) => String(input).includes(":resume")),
      ).toBe(false);
    },
  );
});
