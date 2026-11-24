import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  atomicWrite,
  privateDirectory,
} from "../../src/main-process/runtime/atomic-file.js";
import { RuntimeError } from "../../src/main-process/runtime/errors.js";
import {
  awaitDurableEncryptionKey,
  CredentialVault,
  currentProtection,
  linuxPasswordStore,
  storedProtection,
} from "../../src/main-process/runtime/vault.js";

/**
 * Exercise the credential vault with the operating system's real protected
 * storage (DPAPI on Windows, Keychain on macOS). The runner passes a disposable
 * folder for both the vault and Electron's profile, and removes it afterwards.
 * On macOS, safeStorage still adds an "Electron Safe Storage" Keychain item.
 *
 * On Linux the harness selects the secret store as the app does and reports
 * the store Electron chose and whether the vault it wrote is protected. Set
 * `ANIMAMA_VAULT_HARNESS_EXPECT` to `system` or `unprotected` to fail on any
 * other outcome. Linux has no earlier release, so the legacy phases are
 * macOS and Windows only.
 *
 * Usage: `vault-encryption-harness [phase] <disposable folder>`. The default
 * phase, `all`, runs every check in one Electron. `write-legacy` and
 * `check-legacy` split the upgrade check across two Electron binaries: an
 * earlier release writes the vault, the current one opens the same folder.
 */
const legacy = {
  password: "d".repeat(64),
  providerKey: "harness-legacy-provider-key",
  connection: "ANIMAMA_CONNECTION_C_HARNESS_API_KEY",
  connectionKey: "harness-legacy-connection-key",
};
const legacyFile = (root: string) =>
  path.join(root, "legacy-secrets", "vault.bin");

/**
 * Write a vault exactly as Electron 44 and earlier builds did, with the
 * synchronous `encryptString` that Electron 46 removes.
 */
async function writeLegacy(root: string): Promise<void> {
  const file = legacyFile(root);
  await awaitDurableEncryptionKey(app.getPath("userData"), file);
  privateDirectory(path.dirname(file));
  const updatedAt = new Date().toISOString();
  atomicWrite(
    file,
    safeStorage.encryptString(
      JSON.stringify({
        version: 1,
        postgresPassword: legacy.password,
        providers: { openai: { value: legacy.providerKey, updatedAt } },
        restoredProviders: {},
        connections: {
          [legacy.connection]: { value: legacy.connectionKey, updatedAt },
        },
      }),
    ),
  );
}

/** Open the earlier release's vault with the asynchronous API, then update it. */
async function checkLegacy(root: string): Promise<void> {
  const file = legacyFile(root);
  const vault = await CredentialVault.open(file, safeStorage, true);
  const environment = vault.childEnvironment();
  if (
    vault.databasePassword() !== legacy.password ||
    environment.OPENAI_API_KEY !== legacy.providerKey ||
    environment[legacy.connection] !== legacy.connectionKey
  )
    throw new Error("the earlier release's vault did not decrypt intact");
  await vault.apply([{ provider: "anthropic", value: "harness-added-key" }]);
  const reopened = (
    await CredentialVault.open(file, safeStorage, true)
  ).childEnvironment();
  if (
    reopened.OPENAI_API_KEY !== legacy.providerKey ||
    reopened.ANTHROPIC_API_KEY !== "harness-added-key"
  )
    throw new Error("the upgraded vault did not survive reopening");
}

async function check(root: string): Promise<void> {
  const file = path.join(root, "secrets", "vault.bin");
  const providerKey = "harness-provider-key";
  if (!(await safeStorage.isAsyncEncryptionAvailable()))
    throw new Error("protected storage is unavailable");
  const vault = await CredentialVault.open(file, safeStorage, false);
  await vault.set("openai", providerKey);
  const reopened = await CredentialVault.open(file, safeStorage, true);
  if (reopened.databasePassword() !== vault.databasePassword())
    throw new Error("the database password did not survive reopening");
  if (reopened.childEnvironment().OPENAI_API_KEY !== providerKey)
    throw new Error("the provider key did not survive reopening");
  const bytes = readFileSync(file).toString("latin1");
  if (bytes.includes(providerKey) || bytes.includes(vault.databasePassword()))
    throw new Error("the vault file contains plaintext secrets");
  if (process.platform === "linux") await reportLinuxProtection(file);
  writeFileSync(file, Buffer.from("not an encrypted vault"));
  try {
    await CredentialVault.open(file, safeStorage, true);
    throw new Error("a corrupt vault was accepted");
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.code !== "vault_unreadable")
      throw error;
  }
}

/** Say which store Electron chose and whether the written vault is protected. */
async function reportLinuxProtection(file: string): Promise<void> {
  const stored = storedProtection(file);
  process.stdout.write(
    `selected store: ${safeStorage.getSelectedStorageBackend()}\n` +
      `new ciphertext: ${await currentProtection(safeStorage)}\n` +
      `vault file: ${stored}\n`,
  );
  const expected = process.env.ANIMAMA_VAULT_HARNESS_EXPECT;
  if (expected && stored !== expected)
    throw new Error(`expected a ${expected} vault, found ${stored}`);
}

const phases: Record<string, (root: string) => Promise<void>> = {
  all: async (root) => {
    if (process.platform !== "linux") {
      await writeLegacy(root);
      await checkLegacy(root);
    }
    await check(root);
  },
  "write-legacy": writeLegacy,
  "check-legacy": checkLegacy,
};
// Electron's argv is [electron, harness, ...arguments].
const [phase, root] =
  process.argv.length > 3
    ? process.argv.slice(-2)
    : ["all", process.argv.at(-1)];
if (!phase || !Object.hasOwn(phases, phase) || !root || !path.isAbsolute(root))
  throw new Error(
    "usage: vault-encryption-harness [phase] <disposable folder>",
  );
app.setPath("userData", path.join(root, "electron"));
// As main.ts does, before `ready`.
const passwordStore = linuxPasswordStore(
  process.platform,
  process.env,
  (name) => app.commandLine.hasSwitch(name),
);
if (passwordStore)
  app.commandLine.appendSwitch("password-store", passwordStore);

void app.whenReady().then(async () => {
  try {
    await phases[phase]!(root);
    process.stdout.write(`vault encryption (${phase}): OK\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`vault encryption failed: ${String(error)}\n`);
    app.exit(1);
  }
});
