import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialVault,
  currentProtection,
  linuxPasswordStore,
  linuxVaultGate,
  storedProtection,
  type Encryption,
} from "../src/main-process/runtime/vault.js";

const roots: string[] = [];
function vaultFile(): string {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "animama-linux-vault-"),
  );
  roots.push(root);
  return path.join(root, "secrets", "vault.bin");
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/**
 * Stands in for Electron on Linux: ciphertext begins `v11` under a secret
 * store and `v10` under the built-in key, which can always be read back. A
 * `v11` value cannot be read once the store is gone.
 */
function encryption(store: { available: boolean }): Encryption {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) =>
      Buffer.from(`${store.available ? "v11" : "v10"}${value}`),
    decryptStringAsync: async (value) => {
      const text = value.toString();
      if (text.startsWith("v11") && !store.available)
        throw new Error("Error while decrypting the ciphertext");
      return {
        result: text.slice(3),
        // Electron reports a key of another security level this way.
        shouldReEncrypt: text.startsWith("v10") && store.available,
      };
    },
  };
}

describe("Linux secret store selection", () => {
  it("selects the Secret Service wherever Electron would not choose a store itself", () => {
    // i3, Sway and Hyprland are not desktops Electron recognises.
    for (const desktop of ["i3", "sway", "Hyprland", "", undefined, "GNOME"])
      expect(
        linuxPasswordStore("linux", { XDG_CURRENT_DESKTOP: desktop }, []),
      ).toBe("gnome-libsecret");
  });

  it("leaves KDE's KWallet choice and the user's own switch alone", () => {
    for (const desktop of ["KDE", "kde", "ubuntu:KDE"])
      expect(
        linuxPasswordStore("linux", { XDG_CURRENT_DESKTOP: desktop }, []),
      ).toBeUndefined();
    for (const argv of [
      ["--password-store=basic"],
      ["--password-store", "kwallet6"],
    ])
      expect(
        linuxPasswordStore("linux", { XDG_CURRENT_DESKTOP: "i3" }, argv),
      ).toBeUndefined();
  });

  it("adds nothing on macOS or Windows", () => {
    for (const platform of ["darwin", "win32"] as const)
      expect(
        linuxPasswordStore(platform, { XDG_CURRENT_DESKTOP: "i3" }, []),
      ).toBeUndefined();
  });
});

describe("Linux vault protection", () => {
  it("reads protection from what the encryptor actually produces", async () => {
    expect(await currentProtection(encryption({ available: true }))).toBe(
      "system",
    );
    expect(await currentProtection(encryption({ available: false }))).toBe(
      "unprotected",
    );
    // Reporting encryption as available says nothing about a secret store.
    const plain: Encryption = {
      ...encryption({ available: false }),
      encryptStringAsync: async (value) => Buffer.from(value),
    };
    expect(await currentProtection(plain)).toBe("unprotected");
    const failing: Encryption = {
      ...plain,
      encryptStringAsync: async () => {
        throw new Error("no key");
      },
    };
    await expect(currentProtection(failing)).rejects.toThrow(
      "secure_storage_unavailable",
    );
  });

  it("creates a protected vault without asking when a secret store is in use", async () => {
    const file = vaultFile();
    const crypto = encryption({ available: true });
    expect(storedProtection(file)).toBeNull();
    await expect(
      linuxVaultGate({
        file,
        encryption: crypto,
        databaseExists: false,
        consented: false,
      }),
    ).resolves.toBeUndefined();
    await CredentialVault.open(file, crypto, false);
    expect(storedProtection(file)).toBe("system");
  });

  it("asks before creating an unprotected vault, and creates nothing until consent", async () => {
    const file = vaultFile();
    const crypto = encryption({ available: false });
    const gate = (consented: boolean) =>
      linuxVaultGate({
        file,
        encryption: crypto,
        databaseExists: false,
        consented,
      });
    await expect(gate(false)).rejects.toThrow(
      "unprotected_storage_consent_required",
    );
    // Quit at this point leaves no vault behind.
    expect(existsSync(file)).toBe(false);
    await expect(gate(true)).resolves.toBeUndefined();
    await CredentialVault.open(file, crypto, false);
    expect(storedProtection(file)).toBe("unprotected");
    // The vault itself records the answer: the next launch does not ask.
    await expect(gate(false)).resolves.toBeUndefined();
  });

  it("moves an unprotected vault under a secret store once one is available", async () => {
    const file = vaultFile();
    const store = { available: false };
    const crypto = encryption(store);
    const vault = await CredentialVault.open(file, crypto, false);
    await vault.set("openai", "provider-key-value");
    const password = vault.databasePassword();
    expect(storedProtection(file)).toBe("unprotected");

    store.available = true;
    await linuxVaultGate({
      file,
      encryption: crypto,
      databaseExists: true,
      consented: false,
    });
    const reopened = await CredentialVault.open(file, crypto, true);
    await reopened.protect();
    expect(storedProtection(file)).toBe("system");
    expect(reopened.databasePassword()).toBe(password);
    expect(reopened.childEnvironment().OPENAI_API_KEY).toBe(
      "provider-key-value",
    );
  });

  it("re-encrypts on request even when Electron does not ask for it", async () => {
    const file = vaultFile();
    const store = { available: false };
    const quiet: Encryption = {
      ...encryption(store),
      decryptStringAsync: async (value) => ({
        result: value.toString().slice(3),
        shouldReEncrypt: false,
      }),
    };
    await CredentialVault.open(file, quiet, false);
    store.available = true;
    const reopened = await CredentialVault.open(file, quiet, true);
    expect(storedProtection(file)).toBe("unprotected");
    await reopened.protect();
    expect(storedProtection(file)).toBe("system");
  });

  it("stops with recovery, untouched, when a protected vault's store is gone", async () => {
    const file = vaultFile();
    const store = { available: true };
    const crypto = encryption(store);
    await CredentialVault.open(file, crypto, false);
    const before = readFileSync(file);

    store.available = false;
    // Consent to unprotected storage never unlocks a protected vault.
    for (const consented of [false, true])
      await expect(
        linuxVaultGate({
          file,
          encryption: crypto,
          databaseExists: true,
          consented,
        }),
      ).rejects.toThrow("secure_storage_unavailable");
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("leaves a missing vault beside a database to the existing recovery", async () => {
    const file = vaultFile();
    const crypto = encryption({ available: false });
    // No consent question: there is nothing to create, only data to preserve.
    await expect(
      linuxVaultGate({
        file,
        encryption: crypto,
        databaseExists: true,
        consented: false,
      }),
    ).resolves.toBeUndefined();
    await expect(CredentialVault.open(file, crypto, true)).rejects.toThrow(
      "vault_missing_for_database",
    );
  });
});
