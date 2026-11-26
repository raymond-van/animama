import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitDurableEncryptionKey,
  CredentialVault,
  validateConnectionOrigin,
  validateCredential,
  validateProvider,
  type Encryption,
} from "../src/main-process/runtime/vault.js";
import {
  atomicWrite,
  privateFileMode,
  retrySharingViolations,
  retrySharingViolationsAsync,
} from "../src/main-process/runtime/atomic-file.js";
import {
  dataRootFits,
  MAX_WINDOWS_DATA_ROOT,
  migrateLegacyTree,
  prepareDesktopIdentity,
  readRuntimeState,
  runtimePaths,
} from "../src/main-process/runtime/paths.js";
import { SecretRedactor } from "../src/main-process/runtime/redaction.js";
import {
  baseChildEnvironment,
  elevatedGroups,
  guardHandshake,
  nativeLoadFailure,
  OwnedProcesses,
  recordedImageRunning,
  runCommand,
  useProcessGuard,
} from "../src/main-process/runtime/processes.js";
import { reportsAddressInUse } from "../src/main-process/runtime/ports.js";
import {
  ownedProcessesLaunchable,
  stagedProcessGuard,
} from "./fixtures/process-guard.js";
import {
  createRendererCapability,
  installRendererCapability,
} from "../src/main-process/security/renderer-capability.js";
import type { App, Session } from "electron";
import {
  PrivatePostgres,
  postmasterRecordMatches,
  refusesAdministrator,
  reportsPortCollision,
} from "../src/main-process/runtime/postgres.js";
import { readBackendReadiness } from "../src/main-process/runtime/readiness.js";
import {
  verifyRuntime,
  supportsRuntimePlatform,
  type RuntimeManifest,
  runtimePlatform,
} from "../src/main-process/runtime/manifest.js";

const roots: string[] = [];
function fixture(prefix = "animama-runtime-state-"): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/**
 * Fake protected storage. `seal` stands for the synchronous `encryptString`
 * that Electron 44 and earlier builds wrote vaults with; the vault itself only
 * uses the asynchronous calls.
 */
type FakeEncryption = Encryption & {
  seal(value: string): Buffer;
  unseal(value: Buffer): string;
};
function encryption(): FakeEncryption {
  const key = randomBytes(32);
  const seal = (value: string): Buffer => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  };
  const unseal = (value: Buffer): string => {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      value.subarray(0, 12),
    );
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([
      decipher.update(value.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  };
  return {
    seal,
    unseal,
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => seal(value),
    decryptStringAsync: async (value) => ({
      result: unseal(value),
      shouldReEncrypt: false,
    }),
  };
}
/** Electron's rejection when a key may come back, such as a locked Keychain. */
const temporarilyUnavailable = new Error(
  "safeStorage.decryptStringAsync is temporarily unavailable. Please try again.",
);

describe("private local state and vault", () => {
  it("persists encrypted credentials and the database password, returning only status", async () => {
    const file = path.join(fixture(), "vault.bin");
    const crypto = encryption();
    const vault = await CredentialVault.open(file, crypto, false);
    const password = vault.databasePassword();
    const key = "fixture-provider-key-not-a-real-credential";
    await vault.set("openai", key);
    expect(readFileSync(file).includes(Buffer.from(key))).toBe(false);
    expect(readFileSync(file).includes(Buffer.from(password))).toBe(false);
    expect(privateFileMode(lstatSync(file))).toBe(true);
    expect(JSON.stringify(vault.list())).not.toContain(key);
    const restarted = await CredentialVault.open(file, crypto, true);
    expect(restarted.databasePassword()).toBe(password);
    expect(restarted.childEnvironment()).toEqual({ OPENAI_API_KEY: key });
    expect(
      restarted.list().find((item) => item.provider === "openai"),
    ).toMatchObject({ configured: true, restartRequired: false });
    await restarted.delete("openai");
    expect(
      (await CredentialVault.open(file, crypto, true)).childEnvironment(),
    ).toEqual({});
    expect(
      (
        await CredentialVault.open(
          path.join(fixture(), "vault.bin"),
          crypto,
          false,
        )
      ).databasePassword(),
    ).not.toBe(password);
  });

  it("keeps the ChatGPT plan session key apart from status and child environments", async () => {
    const file = path.join(fixture(), "vault.bin");
    const crypto = encryption();
    const vault = await CredentialVault.open(file, crypto, false);
    const key = await vault.chatgptPlanStoreKey();
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(await vault.chatgptPlanStoreKey()).toBe(key);
    expect(readFileSync(file).includes(Buffer.from(key))).toBe(false);
    expect(vault.secrets()).toContain(key);
    expect(JSON.stringify(vault.list())).not.toContain(key);
    expect(JSON.stringify(vault.childEnvironment())).not.toContain(key);
    const restarted = await CredentialVault.open(file, crypto, true);
    expect(await restarted.chatgptPlanStoreKey()).toBe(key);
    // Two first uses at once create one key: the second write sees the first's.
    const fresh = await CredentialVault.open(
      path.join(fixture(), "vault.bin"),
      crypto,
      false,
    );
    const [one, two] = await Promise.all([
      fresh.chatgptPlanStoreKey(),
      fresh.chatgptPlanStoreKey(),
    ]);
    expect(one).toBe(two);

    // A stored key that is not 32 bytes of hex makes the vault unreadable, not silently replaced.
    const stored = JSON.parse(crypto.unseal(readFileSync(file)));
    writeFileSync(
      file,
      crypto.seal(JSON.stringify({ ...stored, chatgptPlanStoreKey: "short" })),
      { mode: 0o600 },
    );
    await expect(
      CredentialVault.open(file, crypto, true),
    ).rejects.toMatchObject({
      code: "vault_unreadable",
    });
  });

  it("opens a vault in the layout Electron 44 builds saved", async () => {
    const file = path.join(fixture(), "vault.bin");
    const crypto = encryption();
    const connection = "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY";
    const updatedAt = "2026-10-20T12:00:00.000Z";
    // Exactly what the synchronous vault saved: restored providers apart.
    const sealed = crypto.seal(
      JSON.stringify({
        version: 1,
        postgresPassword: "b".repeat(64),
        providers: { openai: { value: "fixture-openai", updatedAt } },
        connections: {
          [connection]: { value: "fixture-connection", updatedAt },
        },
        restoredProviders: { gemini: { value: "fixture-gemini", updatedAt } },
      }),
    );
    atomicWrite(file, sealed);

    const vault = await CredentialVault.open(file, crypto, true);
    expect(vault.databasePassword()).toBe("b".repeat(64));
    expect(vault.childEnvironment()).toEqual({
      OPENAI_API_KEY: "fixture-openai",
      GEMINI_API_KEY: "fixture-gemini",
      [connection]: "fixture-connection",
    });
    expect(vault.list()).toContainEqual(
      expect.objectContaining({ provider: "openai", updatedAt }),
    );
    // Opening alone leaves the earlier release's file untouched.
    expect(readFileSync(file)).toEqual(sealed);

    await vault.apply([{ provider: "anthropic", value: "fixture-anthropic" }]);
    expect(
      (await CredentialVault.open(file, crypto, true)).childEnvironment(),
    ).toEqual({
      OPENAI_API_KEY: "fixture-openai",
      ANTHROPIC_API_KEY: "fixture-anthropic",
      GEMINI_API_KEY: "fixture-gemini",
      [connection]: "fixture-connection",
    });
  });

  it("rewrites a vault with the current key when the decryptor asks for it", async () => {
    const file = path.join(fixture(), "vault.bin");
    const previous = encryption();
    const current = encryption();
    atomicWrite(
      file,
      previous.seal(
        JSON.stringify({
          version: 1,
          postgresPassword: "c".repeat(64),
          providers: {
            openai: {
              value: "fixture-openai",
              updatedAt: "2026-10-20T12:00:00Z",
            },
          },
        }),
      ),
    );
    // A rotated key still decrypts older data and reports `shouldReEncrypt`.
    const rotated: Encryption = {
      ...current,
      decryptStringAsync: async (value) => {
        try {
          return await current.decryptStringAsync(value);
        } catch {
          return { result: previous.unseal(value), shouldReEncrypt: true };
        }
      },
    };

    // A rewrite that fails fails the open and keeps the earlier file.
    const sealed = readFileSync(file);
    await expect(
      CredentialVault.open(
        file,
        {
          ...rotated,
          encryptStringAsync: async () => {
            throw new Error("Error while encrypting the text");
          },
        },
        true,
      ),
    ).rejects.toThrow("secure_storage_unavailable");
    expect(readFileSync(file)).toEqual(sealed);

    const vault = await CredentialVault.open(file, rotated, true);
    expect(vault.childEnvironment()).toEqual({
      OPENAI_API_KEY: "fixture-openai",
    });
    const onDisk = JSON.parse(current.unseal(readFileSync(file)));
    expect(onDisk.postgresPassword).toBe("c".repeat(64));
    expect(onDisk.providers.openai.value).toBe("fixture-openai");
  });

  it("orders concurrent writes and keeps going after a failed one", async () => {
    const file = path.join(fixture(), "vault.bin");
    const crypto = encryption();
    await CredentialVault.open(file, crypto, false);
    // The first write's encryption finishes last.
    const delays = [40, 0, 0];
    let failNext = false;
    const slow: Encryption = {
      ...crypto,
      encryptStringAsync: async (value) => {
        await new Promise((resolve) => setTimeout(resolve, delays.shift()));
        if (failNext) {
          failNext = false;
          throw new Error("Error while encrypting the text");
        }
        return crypto.seal(value);
      },
    };
    const reopened = await CredentialVault.open(file, slow, true);
    await Promise.all([
      reopened.apply([{ provider: "openai", value: "fixture-openai" }]),
      reopened.apply([{ provider: "anthropic", value: "fixture-anthropic" }]),
    ]);
    expect(
      (await CredentialVault.open(file, crypto, true)).childEnvironment(),
    ).toEqual({
      OPENAI_API_KEY: "fixture-openai",
      ANTHROPIC_API_KEY: "fixture-anthropic",
    });

    failNext = true;
    const saved = readFileSync(file);
    await expect(
      reopened.apply([{ provider: "elevenlabs", value: "fixture-voice" }]),
    ).rejects.toThrow("secure_storage_unavailable");
    expect(readFileSync(file)).toEqual(saved);
    expect(reopened.childEnvironment()).not.toHaveProperty(
      "ELEVENLABS_API_KEY",
    );
    await reopened.apply([{ provider: "openai" }]);
    expect(
      (await CredentialVault.open(file, crypto, true)).childEnvironment(),
    ).toEqual({ ANTHROPIC_API_KEY: "fixture-anthropic" });
  });

  it("creates a Windows vault only after Chromium has saved its encryption key", async () => {
    const root = fixture();
    const vault = path.join(root, "secrets", "vault.bin");
    const state = path.join(root, "Local State");
    await expect(
      awaitDurableEncryptionKey(root, vault, "darwin", 0),
    ).resolves.toBeUndefined();
    await expect(
      awaitDurableEncryptionKey(root, vault, "win32", 300),
    ).rejects.toThrow("secure_storage_unavailable");
    writeFileSync(state, JSON.stringify({ os_crypt: {} }));
    const waiting = awaitDurableEncryptionKey(root, vault, "win32", 5000);
    setTimeout(
      () =>
        writeFileSync(
          state,
          JSON.stringify({ os_crypt: { encrypted_key: "fixture" } }),
        ),
      400,
    );
    await expect(waiting).resolves.toBeUndefined();
    rmSync(state);
    mkdirSync(path.dirname(vault));
    writeFileSync(vault, "existing");
    await expect(
      awaitDurableEncryptionKey(root, vault, "win32", 0),
    ).resolves.toBeUndefined();
  });

  it("fails closed on unavailable encryption, loss, corruption, and links without replacing data", async () => {
    const root = fixture();
    const file = path.join(root, "vault.bin");
    const crypto = encryption();
    await expect(
      CredentialVault.open(
        file,
        { ...crypto, isAsyncEncryptionAvailable: async () => false },
        false,
      ),
    ).rejects.toThrow("secure_storage_unavailable");
    expect(existsSync(file)).toBe(false);
    const failingEncryption: Encryption = {
      ...crypto,
      encryptStringAsync: async () => {
        throw new Error("DPAPI failed");
      },
    };
    await expect(
      CredentialVault.open(file, failingEncryption, false),
    ).rejects.toThrow("secure_storage_unavailable");
    expect(existsSync(file)).toBe(false);
    await expect(CredentialVault.open(file, crypto, true)).rejects.toThrow(
      "vault_missing_for_database",
    );
    atomicWrite(file, "corrupt");
    await expect(CredentialVault.open(file, crypto, true)).rejects.toThrow(
      "vault_unreadable",
    );
    expect(readFileSync(file, "utf8")).toBe("corrupt");
    const target = path.join(root, "outside");
    mkdirSync(target);
    const link = path.join(root, "linked");
    // A junction is Windows' unprivileged directory link; POSIX ignores the type.
    symlinkSync(target, link, "junction");
    expect(() => atomicWrite(path.join(link, "secret"), "secret")).toThrow(
      "private_state_path_invalid",
    );
    expect(existsSync(path.join(target, "secret"))).toBe(false);
  });

  it("reports a temporarily unavailable key as secure storage, not a lost vault", async () => {
    const file = path.join(fixture(), "vault.bin");
    const crypto = encryption();
    await CredentialVault.open(file, crypto, false);
    const saved = readFileSync(file);
    const locked: Encryption = {
      ...crypto,
      decryptStringAsync: async () => {
        throw temporarilyUnavailable;
      },
    };
    await expect(CredentialVault.open(file, locked, true)).rejects.toThrow(
      "secure_storage_unavailable",
    );
    const broken: Encryption = {
      ...crypto,
      decryptStringAsync: async () => {
        throw new Error(
          "Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.",
        );
      },
    };
    await expect(CredentialVault.open(file, broken, true)).rejects.toThrow(
      "vault_unreadable",
    );
    expect(readFileSync(file)).toEqual(saved);
  });

  it("stores model-connection keys by variable name and drops retired providers", async () => {
    const file = path.join(fixture(), "vault.bin");
    const crypto = encryption();
    const vault = await CredentialVault.open(file, crypto, false);
    const password = vault.databasePassword();
    const connection = "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY";
    await vault.apply([
      { provider: "openai", value: "fixture-openai" },
      { provider: "anthropic", value: "fixture-anthropic" },
      { connection, value: "fixture-connection" },
    ]);
    expect(vault.childEnvironment()).toEqual({
      OPENAI_API_KEY: "fixture-openai",
      ANTHROPIC_API_KEY: "fixture-anthropic",
      [connection]: "fixture-connection",
    });
    expect(vault.list()).toEqual([
      expect.objectContaining({ provider: "openai", configured: true }),
      expect.objectContaining({ provider: "anthropic", configured: true }),
      expect.objectContaining({ provider: "elevenlabs", configured: false }),
      expect.objectContaining({ provider: "gemini", configured: false }),
      expect.objectContaining({ connection, configured: true }),
    ]);
    expect(JSON.stringify(vault.list())).not.toContain("fixture-");

    // An earlier release's vault with a retired provider still opens.
    const legacy = path.join(fixture(), "legacy.bin");
    const now = new Date().toISOString();
    atomicWrite(
      legacy,
      crypto.seal(
        JSON.stringify({
          version: 1,
          postgresPassword: password,
          providers: {
            openai: { value: "fixture-openai", updatedAt: now },
            gemini: { value: "fixture-gemini", updatedAt: now },
          },
        }),
      ),
    );
    const upgraded = await CredentialVault.open(legacy, crypto, true);
    expect(upgraded.childEnvironment()).toEqual({
      OPENAI_API_KEY: "fixture-openai",
    });
    await upgraded.apply([{ connection, value: "fixture-connection" }]);
    expect(readFileSync(legacy).includes(Buffer.from("fixture-gemini"))).toBe(
      false,
    );
    expect(
      (await CredentialVault.open(legacy, crypto, true)).childEnvironment(),
    ).not.toHaveProperty("GEMINI_API_KEY");
  });

  it("delivers a connection key with the origin it was entered for, never as a secret", async () => {
    const file = path.join(fixture(), "vault.bin");
    const crypto = encryption();
    const vault = await CredentialVault.open(file, crypto, false);
    const connection = "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY";
    const origin = "ANIMAMA_CONNECTION_C_0123456789AB_ORIGIN";
    await vault.apply([
      { provider: "openai", value: "fixture-openai" },
      {
        connection,
        value: "fixture-connection",
        origin: "https://lab.example.test",
      },
    ]);
    const delivered = {
      OPENAI_API_KEY: "fixture-openai",
      [connection]: "fixture-connection",
      [origin]: "https://lab.example.test",
    };
    expect(vault.childEnvironment()).toEqual(delivered);
    expect(
      (await CredentialVault.open(file, crypto, true)).childEnvironment(),
    ).toEqual(delivered);
    expect(vault.secrets().sort()).toEqual([
      "fixture-connection",
      "fixture-openai",
    ]);
    expect(JSON.stringify(vault.list())).not.toContain("lab.example.test");

    // A key entered again without an origin replaces the whole entry.
    await vault.apply([{ connection, value: "fixture-replaced" }]);
    expect(vault.childEnvironment()).not.toHaveProperty(origin);
    await vault.apply([
      { connection, value: "fixture-connection", origin: "http://[::1]:8080" },
    ]);
    expect(vault.childEnvironment()[origin]).toBe("http://[::1]:8080");
    await vault.apply([{ connection }]);
    expect(vault.childEnvironment()).toEqual({
      OPENAI_API_KEY: "fixture-openai",
    });

    for (const stored of ["https://lab.example.test/", "lab.example.test"]) {
      const bad = path.join(fixture(), "bad.bin");
      atomicWrite(
        bad,
        crypto.seal(
          JSON.stringify({
            version: 1,
            postgresPassword: vault.databasePassword(),
            providers: {},
            connections: {
              [connection]: {
                value: "fixture",
                updatedAt: new Date().toISOString(),
                origin: stored,
              },
            },
          }),
        ),
      );
      await expect(CredentialVault.open(bad, crypto, true)).rejects.toThrow(
        "vault_unreadable",
      );
    }
  });

  it.each([
    "https://lab.example.test/",
    "HTTPS://lab.example.test",
    "https://lab.example.test:443",
    "https://lab.example.test/v1",
    "https://user:secret@lab.example.test",
    "ftp://lab.example.test",
    "lab.example.test",
    42,
  ])("refuses a connection origin that is not canonical: %s", (value) => {
    expect(() => validateConnectionOrigin(value)).toThrow(
      "credential_origin_invalid",
    );
  });

  it("stores a Gemini key apart from an earlier release's retired Gemini entry", async () => {
    const file = path.join(fixture(), "vault.bin");
    const crypto = encryption();
    const now = new Date().toISOString();
    // A vault an earlier release wrote, still holding its retired Gemini entry.
    atomicWrite(
      file,
      crypto.seal(
        JSON.stringify({
          version: 1,
          postgresPassword: "a".repeat(64),
          providers: { gemini: { value: "fixture-retired", updatedAt: now } },
        }),
      ),
    );
    const vault = await CredentialVault.open(file, crypto, true);
    expect(vault.childEnvironment()).not.toHaveProperty("GEMINI_API_KEY");

    await vault.apply([{ provider: "gemini", value: "fixture-gemini" }]);
    expect(vault.childEnvironment()).toEqual({
      GEMINI_API_KEY: "fixture-gemini",
    });
    const onDisk = JSON.parse(crypto.unseal(readFileSync(file)));
    expect(onDisk.providers).toEqual({});
    expect(onDisk.restoredProviders.gemini.value).toBe("fixture-gemini");
    expect(JSON.stringify(onDisk)).not.toContain("fixture-retired");

    const reopened = await CredentialVault.open(file, crypto, true);
    expect(reopened.childEnvironment()).toEqual({
      GEMINI_API_KEY: "fixture-gemini",
    });
    expect(reopened.list()).toContainEqual(
      expect.objectContaining({ provider: "gemini", configured: true }),
    );
    await reopened.apply([{ provider: "gemini" }]);
    expect(
      (await CredentialVault.open(file, crypto, true)).childEnvironment(),
    ).not.toHaveProperty("GEMINI_API_KEY");
  });

  it("refuses a malformed restored-provider section", async () => {
    const crypto = encryption();
    const now = new Date().toISOString();
    for (const restoredProviders of [
      { openai: { value: "fixture-openai", updatedAt: now } },
      [{ value: "fixture-gemini", updatedAt: now }],
      "fixture-gemini",
      { gemini: { value: "fixture gemini", updatedAt: now } },
      { gemini: { value: "fixture-gemini", updatedAt: "not a date" } },
    ]) {
      const file = path.join(fixture(), "vault.bin");
      atomicWrite(
        file,
        crypto.seal(
          JSON.stringify({
            version: 1,
            postgresPassword: "a".repeat(64),
            providers: {},
            restoredProviders,
          }),
        ),
      );
      await expect(CredentialVault.open(file, crypto, true)).rejects.toThrow(
        "vault_unreadable",
      );
    }
  });

  it("bounds connection keys and rejects malformed stored names", async () => {
    const root = fixture();
    const crypto = encryption();
    const vault = await CredentialVault.open(
      path.join(root, "vault.bin"),
      crypto,
      false,
    );
    const full = Array.from({ length: 32 }, (_, index) => ({
      connection: `ANIMAMA_CONNECTION_C${index}_API_KEY`,
      value: `fixture-${index}`,
    }));
    await vault.apply(full);
    await expect(
      vault.apply([
        { connection: "ANIMAMA_CONNECTION_EXTRA_API_KEY", value: "x" },
      ]),
    ).rejects.toThrow("connection_credentials_full");
    expect(
      Object.keys(vault.childEnvironment()).filter((name) =>
        name.startsWith("ANIMAMA_CONNECTION_"),
      ),
    ).toHaveLength(32);

    const file = path.join(root, "bad.bin");
    atomicWrite(
      file,
      crypto.seal(
        JSON.stringify({
          version: 1,
          postgresPassword: vault.databasePassword(),
          providers: {},
          connections: {
            PATH: { value: "fixture", updatedAt: new Date().toISOString() },
          },
        }),
      ),
    );
    await expect(CredentialVault.open(file, crypto, true)).rejects.toThrow(
      "vault_unreadable",
    );
  });

  it.each(["", " ", "a\nb", "x".repeat(8193), 42, null])(
    "rejects invalid key inputs without echoing them",
    (value) => {
      expect(() => validateCredential(value)).toThrow(
        "credential_value_invalid",
      );
    },
  );
  it.each(["__proto__", "OPENAI_API_KEY", "../openai", undefined])(
    "rejects unknown providers",
    (provider) => {
      expect(() => validateProvider(provider)).toThrow(
        "credential_provider_invalid",
      );
    },
  );

  it("keeps one stable-port state and refuses malformed or linked state", () => {
    const root = fixture();
    const state = runtimePaths(root).state;
    expect(readRuntimeState(state)).toBeNull();
    atomicWrite(state, JSON.stringify({ version: 1, gatewayPort: 41234 }));
    expect(readRuntimeState(state)?.gatewayPort).toBe(41234);
    expect(readRuntimeState(state)?.gatewayPort).toBe(41234);
    atomicWrite(state, JSON.stringify({ version: 1, gatewayPort: 0 }));
    expect(() => readRuntimeState(state)).toThrow("runtime_state_invalid");
  });

  it("moves one legacy tree once and never merges a second profile", () => {
    const root = fixture();
    const legacy = path.join(root, "Anima");
    const destination = path.join(root, "Animama");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "keep"), "profile");
    const journal = path.join(root, "migration.json");
    migrateLegacyTree(legacy, destination, journal);
    migrateLegacyTree(legacy, destination, journal);
    expect(readFileSync(path.join(destination, "keep"), "utf8")).toBe(
      "profile",
    );
    expect(JSON.parse(readFileSync(journal, "utf8")).state).toBe("complete");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "new"), "other");
    expect(() => migrateLegacyTree(legacy, destination, journal)).toThrow(
      "legacy_profile_conflict",
    );
    expect(readFileSync(path.join(legacy, "new"), "utf8")).toBe("other");
  });

  it("rejects development-only overrides before creating packaged state", () => {
    const setName = vi.fn();
    const setPath = vi.fn();
    const app = {
      isPackaged: true,
      setName,
      setPath,
      getPath: () => fixture(),
    } as unknown as App;
    vi.stubEnv("ANIMAMA_DESKTOP_WEB_URL", "https://unexpected.invalid");
    expect(() => prepareDesktopIdentity(app)).toThrow(
      "packaged_runtime_override_rejected",
    );
    expect(setName).toHaveBeenCalledWith("Animama");
    expect(setPath).not.toHaveBeenCalled();
  });

  it("lets a packaged app take a throwaway profile only while its inspector runs", () => {
    const appData = fixture("a-");
    const legacy = path.join(appData, "Anima");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "keep"), "legacy profile");
    const base = path.join(fixture("a-"), "smoke-profile");
    vi.stubEnv("ANIMAMA_DESKTOP_DEV_USER_DATA", base);
    const app = () =>
      ({
        isPackaged: true,
        setName: vi.fn(),
        setPath: vi.fn(),
        getPath: (name: string) => (name === "home" ? fixture() : appData),
      }) as unknown as App;

    expect(() => prepareDesktopIdentity(app(), false)).toThrow(
      "packaged_runtime_override_rejected",
    );
    expect(prepareDesktopIdentity(app(), true).base).toBe(base);
    // The legacy profile stays where it is; only the canonical root adopts it.
    expect(readFileSync(path.join(legacy, "keep"), "utf8")).toBe(
      "legacy profile",
    );
    vi.stubEnv("ANIMAMA_DESKTOP_DEV_RUNTIME_ROOT", fixture());
    expect(() => prepareDesktopIdentity(app(), true)).toThrow(
      "packaged_runtime_override_rejected",
    );
  });

  it("creates the selected userData directory before Electron setPath", () => {
    // A short prefix keeps the root within the Windows data-root budget.
    const base = path.join(fixture("a-"), "new-profile");
    vi.stubEnv("ANIMAMA_DESKTOP_DEV_USER_DATA", base);
    const setPath = vi.fn((_name: string, value: string) => {
      // Electron's real setPath rejects a directory that does not exist yet.
      expect(lstatSync(value).isDirectory()).toBe(true);
    });
    const app = {
      isPackaged: false,
      setName: vi.fn(),
      setPath,
      getPath: () => fixture(),
    } as unknown as App;
    expect(prepareDesktopIdentity(app).base).toBe(base);
    expect(setPath).toHaveBeenCalledWith("userData", base);
  });

  it("refuses unsupported database majors before launching or changing the cluster", async () => {
    const paths = runtimePaths(fixture());
    mkdirSync(paths.pgData, { recursive: true });
    writeFileSync(path.join(paths.pgData, "PG_VERSION"), "15\n");
    const owned = new OwnedProcesses(paths.processes);
    const launch = vi.spyOn(owned, "launch");
    await expect(
      new PrivatePostgres("/unused-runtime", paths, owned).start(
        "fixture-password",
      ),
    ).rejects.toThrow("unsupported_postgresql_major");
    expect(launch).not.toHaveBeenCalled();
    expect(readFileSync(path.join(paths.pgData, "PG_VERSION"), "utf8")).toBe(
      "15\n",
    );
  });

  it("installs a fresh, host-only HttpOnly renderer capability without exposing it as runtime status", async () => {
    const first = createRendererCapability();
    const second = createRendererCapability();
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
    const set = vi.fn(async () => undefined);
    await installRendererCapability(
      { cookies: { set } } as unknown as Session,
      "http://127.0.0.1:41234",
      first,
    );
    expect(set).toHaveBeenCalledWith({
      url: "http://127.0.0.1:41234/",
      name: "animama_renderer_capability",
      value: first,
      httpOnly: true,
      secure: false,
      sameSite: "strict",
      path: "/",
    });
  });
});

describe("bounded private readiness", () => {
  it("accepts bounded JSON and rejects malformed or oversized response streams", async () => {
    const report = {
      schema_version: 1,
      runtime_version: "0.1.0",
      build_id: "fixture",
      alembic_head: "fixture",
      installation_principal_id: "owner",
    };
    expect(await readBackendReadiness(Response.json(report))).toEqual(report);
    await expect(
      readBackendReadiness(new Response("not JSON")),
    ).rejects.toThrow("backend_readiness_mismatch");
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8193));
      },
      cancel,
    });
    await expect(readBackendReadiness(new Response(stream))).rejects.toThrow(
      "backend_readiness_mismatch",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("private PostgreSQL ownership checks", () => {
  const dataDir = path.resolve(
    tmpdir(),
    "animama-profile",
    "postgres",
    "16",
    "data",
  );

  it("matches only this postmaster's PID, data directory and port", () => {
    const record = (pid: number, dir: string, port: number) =>
      `${pid}\n${dir}\n1700000000\n${port}\n\n`;
    expect(
      postmasterRecordMatches(
        record(4321, dataDir, 55432),
        4321,
        dataDir,
        55432,
      ),
    ).toBe(true);
    expect(
      postmasterRecordMatches(
        record(4322, dataDir, 55432),
        4321,
        dataDir,
        55432,
      ),
    ).toBe(false);
    expect(
      postmasterRecordMatches(
        record(4321, `${dataDir}-other`, 55432),
        4321,
        dataDir,
        55432,
      ),
    ).toBe(false);
    expect(
      postmasterRecordMatches(
        record(4321, dataDir, 55433),
        4321,
        dataDir,
        55432,
      ),
    ).toBe(false);
    expect(
      postmasterRecordMatches("4321\n\n0\n55432\n", 4321, dataDir, 55432),
    ).toBe(false);
  });

  it.skipIf(process.platform !== "win32")(
    "accepts the forward-slash data directory PostgreSQL writes on Windows",
    () => {
      const record = `4321\n${dataDir.replaceAll("\\", "/")}\n1700000000\n55432\n`;
      expect(postmasterRecordMatches(record, 4321, dataDir, 55432)).toBe(true);
    },
  );

  it("recognizes an occupied port by PostgreSQL's hint, in any OS language", () => {
    const hint =
      "HINT:  Is another postmaster already running on port 55432? If not, wait a few seconds and retry.";
    expect(
      reportsPortCollision(
        `LOG:  could not bind IPv4 address "127.0.0.1": Address already in use\n${hint}`,
      ),
    ).toBe(true);
    expect(
      reportsPortCollision(
        `LOG:  could not bind IPv4 address "127.0.0.1": Normalerweise darf jede Socketadresse nur jeweils einmal verwendet werden.\n${hint}`,
      ),
    ).toBe(true);
    expect(
      reportsPortCollision("FATAL:  data directory has wrong ownership"),
    ).toBe(false);
  });

  it("recognizes PostgreSQL's refusal of an elevated Windows token", () => {
    expect(
      refusesAdministrator(
        "Execution of PostgreSQL by a user with administrative permissions is not\npermitted.\nThe server must be started under an unprivileged user ID to prevent\n",
      ),
    ).toBe(true);
    expect(refusesAdministrator("FATAL:  could not create lock file")).toBe(
      false,
    );
  });

  it("recognizes an occupied backend port on POSIX and in any Windows language", () => {
    expect(
      reportsAddressInUse(
        "ERROR: [Errno 98] error while attempting to bind on address ('127.0.0.1', 8000): address already in use",
      ),
    ).toBe(true);
    expect(
      reportsAddressInUse(
        "ERROR: [Errno 10048] error while attempting to bind on address ('127.0.0.1', 8000): normalerweise darf jede socketadresse nur jeweils einmal verwendet werden",
      ),
    ).toBe(true);
    expect(reportsAddressInUse("ERROR: [Errno 13] permission denied")).toBe(
      false,
    );
  });

  it("recognizes an elevated Windows token by its integrity level", () => {
    const groups = (label: string) =>
      `"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"\n"Mandatory Label\\${label}","Label","${label === "High Mandatory Level" ? "S-1-16-12288" : "S-1-16-8192"}",""\n`;
    expect(elevatedGroups(groups("High Mandatory Level"))).toBe(true);
    expect(elevatedGroups(groups("Medium Mandatory Level"))).toBe(false);
    expect(
      elevatedGroups(
        '"Mandatory Label\\System Mandatory Level","Label","S-1-16-16384",""',
      ),
    ).toBe(true);
  });

  it("reads the service PID only from the guard's exact handshake", () => {
    expect(guardHandshake("animama-process-guard pid=4321")).toBe(4321);
    expect(guardHandshake("animama-process-guard pid=4321\r")).toBe(4321);
    for (const line of [
      "animama-process-guard pid=0",
      "animama-process-guard pid=-1",
      "animama-process-guard pid=12 extra",
      "LOG:  animama-process-guard pid=12",
      "",
    ])
      expect(guardHandshake(line)).toBeUndefined();
  });
});

describe("Windows file semantics", () => {
  const sharing = (code: string) =>
    Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;

  it("retries a rename that antivirus briefly blocks on Windows only", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const operation = vi
      .fn()
      .mockImplementationOnce(() => {
        throw sharing("EPERM");
      })
      .mockImplementationOnce(() => {
        throw sharing("EBUSY");
      })
      .mockReturnValue("done");
    expect(retrySharingViolations(operation, [0, 0, 0])).toBe("done");
    expect(operation).toHaveBeenCalledTimes(3);
    const blocked = vi.fn(() => {
      throw sharing("EACCES");
    });
    expect(() => retrySharingViolations(blocked, [0, 0])).toThrow("EACCES");
    expect(blocked).toHaveBeenCalledTimes(3);
    const missing = vi.fn(() => {
      throw sharing("ENOENT");
    });
    expect(() => retrySharingViolations(missing, [0, 0])).toThrow("ENOENT");
    expect(missing).toHaveBeenCalledOnce();
  });

  it("never retries on POSIX, where a sharing error is a real failure", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const operation = vi.fn(() => {
      throw sharing("EPERM");
    });
    expect(() => retrySharingViolations(operation, [0])).toThrow("EPERM");
    expect(operation).toHaveBeenCalledOnce();
    const asynchronous = vi.fn(async () => {
      throw sharing("EBUSY");
    });
    await expect(
      retrySharingViolationsAsync(asynchronous, [0]),
    ).rejects.toThrow("EBUSY");
    expect(asynchronous).toHaveBeenCalledOnce();
  });

  it("requires owner-only POSIX modes but not on Windows, which has none", () => {
    const stat = (mode: number) => ({ mode }) as Stats;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(privateFileMode(stat(0o100600))).toBe(true);
    expect(privateFileMode(stat(0o100644))).toBe(false);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(privateFileMode(stat(0o100666))).toBe(true);
  });

  it("keeps Windows data roots short enough for MAX_PATH", () => {
    const root = (length: number) => `C:\\${"u".repeat(length - 3)}`;
    expect(dataRootFits("win32", root(MAX_WINDOWS_DATA_ROOT))).toBe(true);
    expect(dataRootFits("win32", root(MAX_WINDOWS_DATA_ROOT + 1))).toBe(false);
    expect(dataRootFits("darwin", `/${"u".repeat(400)}`)).toBe(true);
  });

  it("fits every model-asset file below the longest Windows data root", () => {
    const catalog = JSON.parse(
      readFileSync(
        path.join(
          import.meta.dirname,
          "../../../backend/animama/resources/model-assets.v1.json",
        ),
        "utf8",
      ),
    ) as {
      assets: {
        id: string;
        sha256?: string;
        manifest_sha256?: string;
        files?: { path: string }[];
      }[];
    };
    // The backend stages and installs below the desktop's data folder: a set
    // as <id>/<manifest digest>/<path>, a single file named by its digest.
    const store = (area: string, ...parts: string[]) =>
      path.win32.join("data", area, "model-assets", ...parts).length;
    const deepest = Math.max(
      ...catalog.assets.flatMap((asset) =>
        asset.files
          ? asset.files.flatMap((file) =>
              ["staging", "internal"].map((area) =>
                store(
                  area,
                  asset.id,
                  asset.manifest_sha256!,
                  ...file.path.split("/"),
                ),
              ),
            )
          : [
              store("staging", asset.id, asset.sha256!, asset.sha256!),
              store("internal", asset.id, asset.sha256!),
            ],
      ),
    );
    // MAX_PATH is 260 characters including the terminating null.
    expect(MAX_WINDOWS_DATA_ROOT + 1 + deepest).toBeLessThanOrEqual(259);
  });

  it("reports a runtime DLL the loader could not use as a damaged runtime file", () => {
    for (const code of [0xc0000135, 0xc000007b, 0xc0000142])
      expect(nativeLoadFailure(code)).toBe(true);
    for (const code of [0, 1, 3, 0xc0000005])
      expect(nativeLoadFailure(code)).toBe(false);
  });
});

describe("owned child environment", () => {
  const source = {
    PATH: "C:\\Users\\dev\\bin;C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    SystemDrive: "C:",
    TEMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
    TMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
    USERPROFILE: "C:\\Users\\dev",
    LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
    OPENAI_API_KEY: "developer-secret",
    HOME: "/home/dev",
  };

  it("gives Windows children only system paths and their own folders", () => {
    expect(baseChildEnvironment("win32", source)).toEqual({
      PATH: "C:\\Windows\\System32;C:\\Windows",
      SystemRoot: "C:\\Windows",
      SystemDrive: "C:",
      TEMP: source.TEMP,
      TMP: source.TMP,
      USERPROFILE: source.USERPROFILE,
      LOCALAPPDATA: source.LOCALAPPDATA,
    });
  });

  it("keeps the POSIX child environment unchanged", () => {
    expect(baseChildEnvironment("darwin", source)).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/home/dev",
    });
  });
});

describe("runtime platform support boundary", () => {
  it("admits macOS 15 and newer Apple silicon kernels, rejecting older or unknown targets", () => {
    expect(supportsRuntimePlatform("darwin", "arm64", "24.0.0")).toBe(true);
    expect(supportsRuntimePlatform("darwin", "arm64", "25.6.0")).toBe(true);
    for (const release of ["22.0.0", "23.6.0", "unknown", "24", ""])
      expect(supportsRuntimePlatform("darwin", "arm64", release)).toBe(false);
    expect(supportsRuntimePlatform("darwin", "x64", "24.0.0")).toBe(false);
  });

  it("admits Windows 10 version 1903 and newer on x64, by build number", () => {
    // Node reports Windows 10 and 11 as 10.0.<build>; version 1903 is build
    // 18362, 22H2 is 19045 and Windows 11 starts at 22000.
    for (const release of [
      "10.0.18362",
      "10.0.19045",
      "10.0.22000",
      "10.0.26200",
    ])
      expect(supportsRuntimePlatform("win32", "x64", release)).toBe(true);
    for (const release of ["10.0.18361", "10.0.17763", "6.3.9600", "10.0", ""])
      expect(supportsRuntimePlatform("win32", "x64", release)).toBe(false);
    expect(supportsRuntimePlatform("win32", "arm64", "10.0.26200")).toBe(false);
    expect(supportsRuntimePlatform("linux", "x64", "6.18.0")).toBe(false);
  });

  it("names each platform's minimum OS and native executables", () => {
    expect(runtimePlatform("darwin")).toEqual({
      minimumOs: "15.0",
      executableSuffix: "",
    });
    expect(runtimePlatform("win32")).toEqual({
      minimumOs: "10.0.18362",
      executableSuffix: ".exe",
    });
  });
});

// Runs on each supported host: macOS on Apple silicon and Windows x64.
describe.skipIf(
  !supportsRuntimePlatform(process.platform, process.arch, release()),
)("runtime manifest custody", () => {
  const { executableSuffix, minimumOs } = runtimePlatform(process.platform);
  const backend = `backend/animama-runtime${executableSuffix}`;

  async function manifestFixture() {
    const root = fixture();
    const id = "a".repeat(64);
    const executables = Object.fromEntries(
      [
        ...(executableSuffix
          ? [["bin/animama-process-guard", "fixture-guard"]]
          : []),
        ["backend/animama-runtime", "fixture-backend"],
        ["postgres/bin/postgres", "fixture-postgres"],
        ["postgres/bin/initdb", "fixture-initdb"],
        ["postgres/bin/pg_ctl", "fixture-control"],
        ["postgres/bin/pg_isready", "fixture-ready"],
        ["postgres/bin/pg_dump", "fixture-dump"],
        ["postgres/bin/pg_restore", "fixture-restore"],
      ].map(([name, payload]) => [`${name}${executableSuffix}`, payload]),
    );
    const payloads = {
      ...executables,
      "postgres/lib/vector.dll": "fixture-extension",
      "web/index.html": "fixture-html",
      "content/included-core/inventory.json": JSON.stringify({ id }),
      "pack-catalog.json": JSON.stringify({ id }),
    };
    const files = Object.entries(payloads)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, payload]) => {
        const target = path.join(root, name);
        const executable = name in executables;
        mkdirSync(path.dirname(target), { recursive: true });
        // NTFS ignores these modes; Windows verification compares bytes only.
        writeFileSync(target, payload, { mode: executable ? 0o755 : 0o644 });
        chmodSync(target, executable ? 0o755 : 0o644);
        return {
          path: name,
          size_bytes: Buffer.byteLength(payload),
          sha256: createHash("sha256").update(payload).digest("hex"),
          mode: executable ? "0755" : "0644",
          critical: false,
          component: "fixture",
        };
      });
    const manifest: RuntimeManifest = {
      schema: "animama-desktop-runtime/2",
      app_version: "0.1.0",
      build_id: createHash("sha256")
        .update(JSON.stringify(files))
        .digest("hex"),
      platform: process.platform,
      architecture: process.arch,
      minimum_os: minimumOs,
      postgresql: { major: 16, version: "16.15", pgvector: "0.8.6" },
      alembic_head: "0011_included_mounts",
      local_http_schema_version: 1,
      core_content_inventory_id: id,
      pack_catalog_id: id,
      database_schema_sha256: "d".repeat(64),
      files,
    };
    writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    return { root, manifest };
  }

  it("checks executable hashes even if their manifest critical flag is false", async () => {
    const { root, manifest } = await manifestFixture();
    expect(await verifyRuntime(root, "0.1.0")).toEqual(manifest);
    writeFileSync(path.join(root, backend), "changed-backend");
    await expect(verifyRuntime(root, "0.1.0")).rejects.toThrow(
      "runtime_manifest_invalid",
    );
  });

  it("rejects a damaged or missing runtime library before launch", async () => {
    const { root } = await manifestFixture();
    const library = path.join(root, "postgres/lib/vector.dll");
    writeFileSync(library, "fixture-extensioN");
    await expect(verifyRuntime(root, "0.1.0")).rejects.toThrow(
      "runtime_manifest_invalid",
    );
    rmSync(library);
    await expect(verifyRuntime(root, "0.1.0")).rejects.toThrow(
      "runtime_manifest_invalid",
    );
  });

  it.skipIf(!executableSuffix)(
    "requires Windows executable names in a Windows runtime",
    async () => {
      const { root, manifest } = await manifestFixture();
      const entry = manifest.files.find((file) => file.path === backend)!;
      entry.path = "backend/animama-runtime";
      manifest.files.sort((a, b) => (a.path < b.path ? -1 : 1));
      manifest.build_id = createHash("sha256")
        .update(JSON.stringify(manifest.files))
        .digest("hex");
      renameSync(path.join(root, backend), path.join(root, entry.path));
      writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
      await expect(verifyRuntime(root, "0.1.0")).rejects.toThrow(
        "runtime_manifest_invalid",
      );
    },
  );

  it.skipIf(!executableSuffix)(
    "requires the process guard in a Windows runtime",
    async () => {
      const { root, manifest } = await manifestFixture();
      manifest.files = manifest.files.filter(
        (file) => file.path !== "bin/animama-process-guard.exe",
      );
      manifest.build_id = createHash("sha256")
        .update(JSON.stringify(manifest.files))
        .digest("hex");
      writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
      await expect(verifyRuntime(root, "0.1.0")).rejects.toThrow(
        "runtime_manifest_invalid",
      );
    },
  );

  it.each([
    { schema: "animama-desktop-runtime/1" },
    { local_http_schema_version: 0 },
    { gateway_schema_version: 1 },
    { database_schema_sha256: undefined },
    { database_schema_sha256: "not-a-digest" },
  ])(
    "rejects old or mixed runtime composition before native launch: %j",
    async (change) => {
      const { root, manifest } = await manifestFixture();
      writeFileSync(
        path.join(root, "manifest.json"),
        JSON.stringify({ ...manifest, ...change }),
      );
      await expect(verifyRuntime(root, "0.1.0")).rejects.toThrow(
        "runtime_manifest_invalid",
      );
    },
  );

  it("rejects composition identifiers that disagree with verified inventories", async () => {
    const { root, manifest } = await manifestFixture();
    manifest.core_content_inventory_id = "b".repeat(64);
    writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    await expect(verifyRuntime(root, "0.1.0")).rejects.toThrow(
      "runtime_manifest_invalid",
    );
  });

  it("refuses a stale manifest advertising the earlier OS target", async () => {
    const { root, manifest } = await manifestFixture();
    manifest.minimum_os = "13.0";
    writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    await expect(verifyRuntime(root, "0.1.0")).rejects.toThrow(
      "runtime_manifest_invalid",
    );
  });
});

describe("owned processes and secret-safe logs", () => {
  it("redacts values, encoded URLs, headers and provider fields", () => {
    const redactor = new SecretRedactor();
    redactor.add("fake/key+with&symbols");
    const safe = redactor.redact(
      "value=fake/key+with&symbols\nencoded=fake%2Fkey%2Bwith%26symbols\npostgresql+asyncpg://owner:password@localhost/db\nAuthorization: Bearer bearer-fixture\nCookie: private=value\nX-Animama-Principal-Id: owner-fixture\nOPENAI_API_KEY=key-fixture",
    );
    for (const value of [
      "fake/key",
      "fake%2Fkey",
      "password",
      "bearer-fixture",
      "private=value",
      "owner-fixture",
      "key-fixture",
    ])
      expect(safe).not.toContain(value);
  });

  it("keeps ordinary words readable when an implausibly short value is registered", () => {
    const redactor = new SecretRedactor();
    redactor.add("a", "key/1", "x.y");
    expect(redactor.redact("Runtime starting: migrations")).toBe(
      "Runtime starting: migrations",
    );
    expect(redactor.redact("value=a id:key/1 path=monkey/12")).toBe(
      "value=[REDACTED] id:[REDACTED] path=monkey/12",
    );
    expect(redactor.redact("wildcard=xzy literal=x.y")).toBe(
      "wildcard=xzy literal=[REDACTED]",
    );
    expect(redactor.redact("encoded=key%2F1&next=a")).toBe(
      "encoded=[REDACTED]&next=[REDACTED]",
    );
  });

  it("still redacts real-length keys embedded in other text", () => {
    const redactor = new SecretRedactor();
    const key = "sk-proj-0123456789abcdefghijklmn";
    redactor.add(key);
    expect(redactor.redact(`prefix${key}suffix a`)).toBe(
      "prefix[REDACTED]suffix a",
    );
  });

  it("never adopts or signals a live process from an earlier record", () => {
    const file = path.join(fixture(), "processes.json");
    atomicWrite(
      file,
      JSON.stringify({
        version: 1,
        children: [
          {
            pid: process.pid,
            name: "unrelated",
            startToken: "stale",
            // Windows also requires the recorded image still to be running.
            executable:
              process.platform === "win32" ? process.execPath : "/unrelated",
          },
        ],
      }),
    );
    const kill = vi.spyOn(process, "kill");
    expect(() => new OwnedProcesses(file)).toThrow("previous_runtime_running");
    // Only existence probes, never a signal.
    expect(kill.mock.calls.length).toBeGreaterThan(0);
    expect(
      kill.mock.calls.every(
        ([pid, signal]) => pid === process.pid && signal === 0,
      ),
    ).toBe(true);
  });

  it("tells a reused Windows PID from the earlier runtime by its image", () => {
    const guard =
      "C:\\Users\\Ann\\AppData\\Local\\Programs\\Animama\\resources\\runtime\\bin\\animama-process-guard.exe";
    const postgres = guard.replace(
      "bin\\animama-process-guard.exe",
      "postgres\\bin\\postgres.exe",
    );
    const live = [
      { pid: 10, image: guard },
      { pid: 11, image: postgres },
    ];
    // Reused by unrelated programs, or by processes this account cannot read.
    expect(
      recordedImageRunning(
        live,
        new Map([[10, "C:\\Windows\\System32\\notepad.exe"]]),
      ),
    ).toBe(false);
    // Either recorded image still running blocks, whatever its case.
    expect(
      recordedImageRunning(live, new Map([[11, postgres.toUpperCase()]])),
    ).toBe(true);
    expect(recordedImageRunning(live, new Map([[10, guard]]))).toBe(true);
    // A failed lookup or an unknown expected image stays conservative.
    expect(recordedImageRunning(live, null)).toBe(true);
    expect(
      recordedImageRunning([{ pid: 10, image: undefined }], new Map()),
    ).toBe(true);
  });

  it("treats a live recorded service behind a dead guard as an earlier runtime", () => {
    const file = path.join(fixture(), "processes.json");
    const record = (servicePid: unknown) =>
      atomicWrite(
        file,
        JSON.stringify({
          version: 1,
          children: [
            { pid: 2 ** 30, servicePid, name: "postgres", startToken: "stale" },
          ],
        }),
      );
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === process.pid) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    record(process.pid);
    expect(() => new OwnedProcesses(file)).toThrow("previous_runtime_running");
    record("4321");
    expect(() => new OwnedProcesses(file)).toThrow(
      "process_ownership_record_invalid",
    );
    record(undefined);
    expect(() => new OwnedProcesses(file)).not.toThrow();
  });

  // Shell scripts stand in for the guard and PostgreSQL, so these run on POSIX.
  it.skipIf(process.platform === "win32")(
    "records the guard's service PID and stops a Windows service through its lifeline",
    async () => {
      const root = fixture();
      const guard = path.join(root, "fake-guard");
      writeFileSync(
        guard,
        `#!${process.execPath}\nprocess.stdout.write("animama-process-guard pid=" + process.pid + "\\n");\nprocess.stdin.on("end", () => process.exit(0));\nprocess.stdin.resume();\n`,
        { mode: 0o755 },
      );
      const platform = vi.spyOn(process, "platform", "get");
      platform.mockReturnValue("win32");
      try {
        useProcessGuard(guard);
        const file = path.join(root, "processes.json");
        const owned = new OwnedProcesses(file);
        const service = owned.launch("service", "/unused", [], {}, root);
        await vi.waitFor(() =>
          expect(service.processId).toBe(service.child.pid),
        );
        expect(JSON.parse(readFileSync(file, "utf8")).children).toEqual([
          expect.objectContaining({
            pid: service.child.pid,
            servicePid: service.child.pid,
          }),
        ]);
        const kill = vi.spyOn(service.child, "kill");
        await owned.terminate(service, 5000);
        expect(kill).not.toHaveBeenCalled();
        expect(owned.children.size).toBe(0);
      } finally {
        platform.mockRestore();
        useProcessGuard(undefined);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports PostgreSQL's refusal of an elevated token from its own output",
    async () => {
      const runtime = fixture();
      const postgres = path.join(runtime, "postgres/bin/postgres");
      mkdirSync(path.dirname(postgres), { recursive: true });
      writeFileSync(
        postgres,
        "#!/bin/sh\nprintf 'Execution of PostgreSQL by a user with administrative permissions is not\\npermitted.\\n' >&2\nexit 1\n",
        { mode: 0o755 },
      );
      const paths = runtimePaths(fixture());
      mkdirSync(paths.pgData, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(paths.pgData, "PG_VERSION"), "16\n");
      const owned = new OwnedProcesses(paths.processes);
      await expect(
        new PrivatePostgres(runtime, paths, owned).start("fixture-password"),
      ).rejects.toThrow("administrator_launch_unsupported");
      expect(owned.children.size).toBe(0);
    },
  );

  it("refuses to launch a Windows service without the process guard", async () => {
    const platform = vi.spyOn(process, "platform", "get");
    platform.mockReturnValue("win32");
    try {
      useProcessGuard(undefined);
      const owned = new OwnedProcesses(path.join(fixture(), "processes.json"));
      expect(() =>
        owned.launch("fixture", process.execPath, [], {}, fixture()),
      ).toThrow("process_guard_unavailable");
      await expect(
        runCommand(process.execPath, [], {}, fixture()),
      ).rejects.toThrow("process_guard_unavailable");
    } finally {
      platform.mockRestore();
    }
  });

  it.skipIf(!ownedProcessesLaunchable)(
    "stops only an exact owned child handle and clears the ownership record",
    async () => {
      useProcessGuard(stagedProcessGuard);
      const root = fixture();
      const file = path.join(root, "processes.json");
      const owned = new OwnedProcesses(file);
      const child = owned.launch(
        "fixture",
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        {},
        root,
      );
      const unrelatedKill = vi.fn();
      try {
        await owned.terminate({ child: { kill: unrelatedKill } } as never, 100);
        expect(unrelatedKill).not.toHaveBeenCalled();
        await owned.terminate(child, 1000);
        expect(owned.children.size).toBe(0);
        expect(JSON.parse(readFileSync(file, "utf8")).children).toEqual([]);
      } finally {
        await owned.terminate(child, 100);
      }
    },
  );

  it.skipIf(!ownedProcessesLaunchable)(
    "does not inherit unrelated developer credentials into commands",
    async () => {
      useProcessGuard(stagedProcessGuard);
      vi.stubEnv("ANIMAMA_TEST_PRIVATE_SENTINEL", "must-not-leak");
      const output = await runCommand(
        process.execPath,
        [
          "-e",
          "process.stdout.write(String(process.env.ANIMAMA_TEST_PRIVATE_SENTINEL === undefined))",
        ],
        {},
        fixture(),
      );
      expect(output).toBe("true");
    },
  );
});
