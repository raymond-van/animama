import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import {
  connectionCredentialPattern,
  connectionOriginVariable,
  credentialProviders,
  httpOrigin,
  maxConnectionCredentials,
  maxCredentialChanges,
  type CredentialChange,
  type CredentialProvider,
  type CredentialStatus,
} from "../../../../shared/desktop-runtime.js";
import path from "node:path";
import {
  atomicWrite,
  privateDirectory,
  privateFileMode,
} from "./atomic-file.js";
import { RuntimeError } from "./errors.js";

/**
 * On Windows, Electron encrypts with a key that Chromium keeps in `Local State`
 * and first writes about 10 seconds after startup; the asynchronous encryptor
 * reads the same key. A vault encrypted before that write could never be read
 * again if the app stopped in between, so a new vault waits until the key is
 * on disk.
 */
export async function awaitDurableEncryptionKey(
  userData: string,
  vaultFile: string,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 30_000,
): Promise<void> {
  if (platform !== "win32" || existsSync(vaultFile)) return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const state = JSON.parse(
        readFileSync(path.join(userData, "Local State"), "utf8"),
      );
      if (typeof state?.os_crypt?.encrypted_key === "string") return;
    } catch {
      // Absent or mid-write; Chromium replaces the file atomically.
    }
    if (Date.now() >= deadline)
      throw new RuntimeError("secure_storage_unavailable");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The asynchronous `safeStorage` calls (Electron 45 deprecates the synchronous
 * ones and Electron 46 removes them). They use the same Keychain item or DPAPI
 * key, so they read vaults that the synchronous `encryptString` wrote.
 */
export type Encryption = {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(
    value: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }>;
};
/** Whether a secret store holds the vault's key, or only Electron's built-in one. */
export type VaultProtection = "system" | "unprotected";

/**
 * Chromium begins Linux ciphertext with `v11` when the key came from a secret
 * store and `v10` when it is the key built into every Chromium. Electron
 * reports encryption as available either way, so this prefix is the only
 * evidence of protection. It is Chromium's format, not a documented API:
 * recheck it (`components/os_crypt/async`, the key providers) on every
 * Electron upgrade.
 */
const SECRET_STORE_PREFIX = "v11";
function underSecretStore(ciphertext: Buffer): boolean {
  return ciphertext.subarray(0, 3).toString("latin1") === SECRET_STORE_PREFIX;
}

/**
 * The secret store Animama asks Electron for on Linux. Electron chooses by the
 * desktop's name and uses its built-in key on any desktop it does not know,
 * such as i3, Sway or Hyprland, even when a Secret Service is running. Naming
 * the Secret Service makes a running one count everywhere. KDE keeps Electron's
 * own KWallet choice: Chromium recognises KDE from `XDG_CURRENT_DESKTOP`,
 * `DESKTOP_SESSION` or `KDE_FULL_SESSION`, and a vault keyed by KWallet must
 * not be opened with another store's key. A switch the user passed is left
 * alone; `hasSwitch` is Chromium's own parser.
 */
export function linuxPasswordStore(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  hasSwitch: (name: string) => boolean,
): string | undefined {
  if (platform !== "linux" || hasSwitch("password-store")) return undefined;
  const kde =
    (env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().split(":").includes("kde") ||
    /kde|plasma/iu.test(env.DESKTOP_SESSION ?? "") ||
    Boolean(env.KDE_FULL_SESSION);
  return kde ? undefined : "gnome-libsecret";
}

/** What would protect a value encrypted now (Linux). */
export async function currentProtection(
  encryption: Encryption,
): Promise<VaultProtection> {
  let probe: Buffer;
  try {
    probe = await encryption.encryptStringAsync("animama-protection-probe");
  } catch {
    throw new RuntimeError("secure_storage_unavailable");
  }
  return underSecretStore(probe) ? "system" : "unprotected";
}

/** How the vault file on disk was encrypted (Linux); null when there is none. */
export function storedProtection(file: string): VaultProtection | null {
  if (!existsSync(file)) return null;
  const prefix = Buffer.alloc(3);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    readSync(descriptor, prefix, 0, 3, 0);
  } catch {
    // Opening the vault reports an unreadable file as it always has.
    return "unprotected";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return underSecretStore(prefix) ? "system" : "unprotected";
}

/**
 * Linux only: stop before the vault is opened or created when the protection
 * available now does not allow it.
 *
 * - A vault protected by a secret store is never opened without one: the app
 *   shows recovery and leaves the file alone.
 * - A first vault is not created under the built-in key until the owner has
 *   accepted that (`consented`). An existing unprotected vault is the record
 *   of that answer, so the question is asked once per data directory.
 * - A missing vault beside a database stays the existing recovery case.
 */
export async function linuxVaultGate({
  file,
  encryption,
  databaseExists,
  consented,
}: {
  file: string;
  encryption: Encryption;
  databaseExists: boolean;
  consented: boolean;
}): Promise<void> {
  if ((await currentProtection(encryption)) === "system") return;
  const stored = storedProtection(file);
  if (stored === "system") throw new RuntimeError("secure_storage_unavailable");
  if (stored === null && !databaseExists && !consented)
    throw new RuntimeError("unprotected_storage_consent_required");
}

type VaultEntry = { value: string; updatedAt: string };
/** A connection key and the origin it may be sent to; entries without one stay unused. */
type ConnectionEntry = VaultEntry & { origin?: string };
type VaultData = {
  version: 1;
  postgresPassword: string;
  providers: Partial<Record<CredentialProvider, VaultEntry>>;
  /** Model-connection keys by environment name; absent in older vaults. */
  connections?: Record<string, ConnectionEntry>;
  /**
   * Keys for providers an earlier release retired and this one offers again
   * (Gemini). They live apart from `providers`, where an older vault may still
   * hold a retired entry that must stay dropped.
   */
  restoredProviders?: Partial<Record<CredentialProvider, VaultEntry>>;
};
/** The backend variable each provider key is delivered as. */
const providerEnvironment: Record<CredentialProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  gemini: "GEMINI_API_KEY",
};
/** Provider keys earlier releases stored; they are dropped when a vault loads. */
const retiredProviders = new Set(["deepseek", "huggingface", "gemini"]);
/** Retired names this release stores again, only under `restoredProviders`. */
const restoredProviderNames = new Set<CredentialProvider>(["gemini"]);
/** Room for every provider and connection key at the value limit. */
const maxVaultBytes = 512 * 1024;

export function validateProvider(value: unknown): CredentialProvider {
  if (
    typeof value !== "string" ||
    !credentialProviders.includes(value as CredentialProvider)
  )
    throw new RuntimeError("credential_provider_invalid");
  return value as CredentialProvider;
}
export function validateConnectionCredential(value: unknown): string {
  if (typeof value !== "string" || !connectionCredentialPattern.test(value))
    throw new RuntimeError("credential_connection_invalid");
  return value;
}
/**
 * Validate the origin a connection key was entered for: exactly what
 * `URL.origin` gives for an http(s) address, with no path, credentials or
 * default port, so the backend can compare it as a string.
 */
export function validateConnectionOrigin(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    httpOrigin(value) !== value
  )
    throw new RuntimeError("credential_origin_invalid");
  return value;
}
/**
 * Validate a renderer-supplied batch: 1..N changes, one per provider or
 * connection, each an object with exactly one of `provider` or `connection`
 * and an optional `value`; a connection change with a value may add `origin`.
 */
export function validateCredentialChanges(value: unknown): CredentialChange[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maxCredentialChanges
  )
    throw new RuntimeError("credential_changes_invalid");
  const seen = new Set<string>();
  return value.map((change: unknown): CredentialChange => {
    if (!change || typeof change !== "object" || Array.isArray(change))
      throw new RuntimeError("credential_changes_invalid");
    const keys = Object.keys(change);
    const target = keys.includes("provider") ? "provider" : "connection";
    const allowed = target === "connection" ? ["value", "origin"] : ["value"];
    if (keys.some((key) => key !== target && !allowed.includes(key)))
      throw new RuntimeError("credential_changes_invalid");
    const record = change as {
      provider?: unknown;
      connection?: unknown;
      value?: unknown;
      origin?: unknown;
    };
    const name =
      target === "provider"
        ? validateProvider(record.provider)
        : validateConnectionCredential(record.connection);
    if (seen.has(name)) throw new RuntimeError("credential_changes_invalid");
    seen.add(name);
    const value =
      record.value === undefined ? undefined : validateCredential(record.value);
    if (target === "provider")
      return value === undefined
        ? { provider: name as CredentialProvider }
        : { provider: name as CredentialProvider, value };
    if (record.origin === undefined)
      return value === undefined
        ? { connection: name }
        : { connection: name, value };
    // An origin belongs only to a key being saved.
    if (value === undefined)
      throw new RuntimeError("credential_changes_invalid");
    return {
      connection: name,
      value,
      origin: validateConnectionOrigin(record.origin),
    };
  });
}
export function validateCredential(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 8192 ||
    /[\x00-\x20\x7f]/u.test(value)
  )
    throw new RuntimeError("credential_value_invalid");
  return value;
}
function validateEntry(entry: VaultEntry): void {
  validateCredential(entry.value);
  if (
    typeof entry.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.updatedAt))
  )
    throw new Error();
}

/**
 * Electron rejects with only this message when a key may come back, such as a
 * locked or denied macOS Keychain; any other decrypt failure is permanent.
 * Recheck the message (`electron_api_safe_storage.cc`) on every Electron upgrade.
 */
function temporarilyUnavailable(error: unknown): boolean {
  return (
    error instanceof Error && /temporarily unavailable/u.test(error.message)
  );
}

/** Parse and validate decrypted vault JSON; throws on any malformed part. */
function parseVault(json: string): VaultData {
  const data = JSON.parse(json) as VaultData;
  if (
    data.version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(data.postgresPassword) ||
    !data.providers ||
    typeof data.providers !== "object"
  )
    throw new Error();
  const providers: VaultData["providers"] = {};
  for (const [name, entry] of Object.entries(data.providers)) {
    if (retiredProviders.has(name)) continue;
    validateEntry(entry);
    providers[validateProvider(name)] = entry;
  }
  const restored = data.restoredProviders ?? {};
  if (typeof restored !== "object" || Array.isArray(restored))
    throw new Error();
  for (const [name, entry] of Object.entries(restored)) {
    const provider = validateProvider(name);
    if (!restoredProviderNames.has(provider)) throw new Error();
    validateEntry(entry);
    providers[provider] = entry;
  }
  const connections = data.connections ?? {};
  if (
    typeof connections !== "object" ||
    Array.isArray(connections) ||
    Object.keys(connections).length > maxConnectionCredentials
  )
    throw new Error();
  for (const [name, entry] of Object.entries(connections)) {
    validateConnectionCredential(name);
    validateEntry(entry);
    if (entry.origin !== undefined) validateConnectionOrigin(entry.origin);
  }
  delete data.restoredProviders;
  return { ...data, providers, connections };
}

/** Read and decrypt an existing vault file without changing it. */
async function readVault(
  file: string,
  encryption: Encryption,
): Promise<{ data: VaultData; shouldReEncrypt: boolean }> {
  let encrypted: Buffer;
  try {
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      !privateFileMode(stat) ||
      stat.size > maxVaultBytes
    )
      throw new Error();
    encrypted = readFileSync(file);
  } catch {
    throw new RuntimeError("vault_unreadable");
  }
  let decrypted: { result: string; shouldReEncrypt: boolean };
  try {
    decrypted = await encryption.decryptStringAsync(encrypted);
  } catch (error) {
    throw new RuntimeError(
      temporarilyUnavailable(error)
        ? "secure_storage_unavailable"
        : "vault_unreadable",
    );
  }
  try {
    return {
      data: parseVault(decrypted.result),
      shouldReEncrypt: decrypted.shouldReEncrypt,
    };
  } catch {
    throw new RuntimeError("vault_unreadable");
  }
}

/** The on-disk form: restored providers move out of `providers`. */
function stored(data: VaultData): VaultData {
  const providers: VaultData["providers"] = {};
  const restoredProviders: VaultData["providers"] = {};
  for (const [name, entry] of Object.entries(data.providers)) {
    const provider = name as CredentialProvider;
    if (restoredProviderNames.has(provider))
      restoredProviders[provider] = entry;
    else providers[provider] = entry;
  }
  return { ...data, providers, restoredProviders };
}

/** Only main can decrypt. Public methods return configured/missing status. */
export class CredentialVault {
  /** The last queued write; each write starts after the previous one settles. */
  private writes: Promise<unknown> = Promise.resolve();
  private constructor(
    private file: string,
    private encryption: Encryption,
    private data: VaultData,
  ) {}
  /**
   * Open the vault, or create one when no database exists yet. A vault that
   * the decryptor reports as encrypted with an older key is rewritten with the
   * current one.
   */
  static async open(
    file: string,
    encryption: Encryption,
    databaseExists: boolean,
  ): Promise<CredentialVault> {
    if (!(await encryption.isAsyncEncryptionAvailable()))
      throw new RuntimeError("secure_storage_unavailable");
    privateDirectory(path.dirname(file));
    if (existsSync(file)) {
      const { data, shouldReEncrypt } = await readVault(file, encryption);
      const vault = new CredentialVault(file, encryption, data);
      if (shouldReEncrypt) await vault.write((current) => current);
      return vault;
    }
    if (databaseExists) throw new RuntimeError("vault_missing_for_database");
    const vault = new CredentialVault(file, encryption, {
      version: 1,
      postgresPassword: randomBytes(32).toString("hex"),
      providers: {},
      connections: {},
    });
    await vault.write((current) => current);
    return vault;
  }
  /**
   * Encrypt `change(current data)` and atomically replace the vault file.
   * Writes run one at a time, so each starts from what the previous one saved;
   * a failed write leaves both the file and the data unchanged.
   */
  private write(change: (current: VaultData) => VaultData): Promise<void> {
    const write = this.writes.then(async () => {
      const next = change(this.data);
      let encrypted: Buffer;
      try {
        encrypted = await this.encryption.encryptStringAsync(
          JSON.stringify(stored(next)),
        );
      } catch {
        // Electron reports the encryptor as available once it is initialized;
        // a missing Keychain key or failing DPAPI call surfaces only here.
        throw new RuntimeError("secure_storage_unavailable");
      }
      atomicWrite(this.file, encrypted);
      this.data = next;
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
  /** Encrypt the vault again with the key available now, such as a secret store that appeared. */
  protect(): Promise<void> {
    return this.write((current) => current);
  }
  databasePassword(): string {
    return this.data.postgresPassword;
  }
  /** Every saved key as the backend reads it, each connection key beside its origin. */
  childEnvironment(): Record<string, string> {
    return {
      ...Object.fromEntries(
        Object.entries(this.data.providers).map(([provider, entry]) => [
          providerEnvironment[provider as CredentialProvider],
          entry.value,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(this.data.connections ?? {}).flatMap(([name, entry]) => [
          [name, entry.value],
          ...(entry.origin
            ? [[connectionOriginVariable(name), entry.origin]]
            : []),
        ]),
      ),
    };
  }
  /** The saved key values, for log redaction; origins are not secret. */
  secrets(): string[] {
    return [
      ...Object.values(this.data.providers),
      ...Object.values(this.data.connections ?? {}),
    ].map((entry) => entry.value);
  }
  list(): CredentialStatus[] {
    return [
      ...credentialProviders.map((provider) => ({
        provider,
        configured: Boolean(this.data.providers[provider]),
        updatedAt: this.data.providers[provider]?.updatedAt ?? null,
        restartRequired: false,
      })),
      ...Object.entries(this.data.connections ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([connection, entry]) => ({
          connection,
          configured: true,
          updatedAt: entry.updatedAt,
          restartRequired: false,
        })),
    ];
  }
  set(provider: CredentialProvider, value: string): Promise<void> {
    return this.apply([{ provider, value }]);
  }
  delete(provider: CredentialProvider): Promise<void> {
    return this.apply([{ provider }]);
  }
  /**
   * Set or remove several keys in one encrypted write, so a batch is
   * all-or-nothing on disk (an omitted value removes that key).
   */
  apply(changes: ReadonlyArray<CredentialChange>): Promise<void> {
    return this.write((current) => {
      assertCapacity(current, changes);
      const providers = { ...current.providers };
      const connections = { ...(current.connections ?? {}) };
      const updatedAt = new Date().toISOString();
      for (const change of changes) {
        const value =
          change.value === undefined
            ? undefined
            : { value: validateCredential(change.value), updatedAt };
        if ("provider" in change) {
          validateProvider(change.provider);
          if (value) providers[change.provider] = value;
          else delete providers[change.provider];
        } else {
          validateConnectionCredential(change.connection);
          if (value)
            connections[change.connection] =
              change.origin === undefined
                ? value
                : {
                    ...value,
                    origin: validateConnectionOrigin(change.origin),
                  };
          else delete connections[change.connection];
        }
      }
      return { ...current, providers, connections };
    });
  }
}

/**
 * Refuse a batch that would store more than `maxConnectionCredentials`
 * connection keys, before anything is written.
 */
function assertCapacity(
  current: VaultData,
  changes: ReadonlyArray<CredentialChange>,
): void {
  const names = new Set(Object.keys(current.connections ?? {}));
  for (const change of changes) {
    if (!("connection" in change)) continue;
    if (change.value === undefined) names.delete(change.connection);
    else names.add(change.connection);
  }
  if (names.size > maxConnectionCredentials)
    throw new RuntimeError("connection_credentials_full");
}
