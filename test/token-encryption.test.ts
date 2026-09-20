import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  decryptAccountsInConfig,
  decryptTypeSafeRoutingInConfig,
  decryptRefreshToken,
  deriveKey,
  encryptAccountsInConfig,
  encryptTypeSafeRoutingInConfig,
  encryptRefreshToken,
  getEncryptionKey,
  isEncryptedToken,
  isRedactedSecret,
  redactTypeSafeRoutingInConfig,
} from "../src/token-encryption.js";
import type { Config } from "../src/types.js";
import { initDb, closeDb, getCachedConfig, setCachedConfig } from "../src/db-store.js";
import { getDefaultConfig } from "../src/config-defaults.js";

describe("token encryption", () => {
  const originalEnvKey = process.env.PI_ROTATOR_ENCRYPTION_KEY;
  const originalEncKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    delete process.env.PI_ROTATOR_ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (originalEnvKey !== undefined) {
      process.env.PI_ROTATOR_ENCRYPTION_KEY = originalEnvKey;
    } else {
      delete process.env.PI_ROTATOR_ENCRYPTION_KEY;
    }

    if (originalEncKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalEncKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  it("reads encryption key from environment", () => {
    assert.equal(getEncryptionKey(), undefined);

    process.env.PI_ROTATOR_ENCRYPTION_KEY = "my-secret-key";
    assert.equal(getEncryptionKey(), "my-secret-key");

    delete process.env.PI_ROTATOR_ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "fallback-key";
    assert.equal(getEncryptionKey(), "fallback-key");
  });

  it("derives 32-byte key from string or 64-hex string", () => {
    const key1 = deriveKey("short-secret");
    assert.equal(key1.length, 32);

    const hex64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const key2 = deriveKey(hex64);
    assert.equal(key2.length, 32);
    assert.equal(key2.toString("hex"), hex64);
  });

  it("encrypts and decrypts refresh tokens with the versioned KDF format", () => {
    const plain = "1//04abcdef1234567890_refresh_token_test";
    const secret = "super-secret-passphrase";

    const encrypted = encryptRefreshToken(plain, secret);
    assert.ok(isEncryptedToken(encrypted));
    assert.ok(encrypted.startsWith("enc:v2:"));
    assert.equal(encrypted.split(":").length, 6);

    const decrypted = decryptRefreshToken(encrypted, secret);
    assert.equal(decrypted, plain);
  });

  it("decrypts existing v1 tokens for backward compatibility", () => {
    const legacy =
      "enc:v1:ed6423ed963d2f492056bb6f:a27da3778c8d401e0c0a79816dcd7eec:c11c428bc7e1c632ce09ae569256d393acf41eab";

    assert.equal(decryptRefreshToken(legacy, "legacy-secret"), "legacy-refresh-token");
  });

  it("does not re-encrypt an already encrypted token", () => {
    const plain = "1//04abcdef1234567890_refresh_token_test";
    const secret = "super-secret-passphrase";

    const enc1 = encryptRefreshToken(plain, secret);
    const enc2 = encryptRefreshToken(enc1, secret);

    assert.equal(enc1, enc2);
  });

  it("encrypts and redacts the optional TypeSafe API key", () => {
    const config: Config = {
      ...getDefaultConfig(),
      typesafeRouting: { enabled: true, apiKey: "typesafe-secret" },
    };
    const encrypted = encryptTypeSafeRoutingInConfig(config, "config-key");
    assert.ok(isEncryptedToken(encrypted.typesafeRouting?.apiKey ?? ""));
    assert.notEqual(encrypted.typesafeRouting?.apiKey, "typesafe-secret");

    const redacted = redactTypeSafeRoutingInConfig(config);
    assert.equal(redacted.typesafeRouting?.apiKey, "[configured]");
    assert.equal(isRedactedSecret(redacted.typesafeRouting?.apiKey), true);
    assert.equal(config.typesafeRouting?.apiKey, "typesafe-secret");

    const restored = decryptTypeSafeRoutingInConfig(encrypted, "config-key");
    assert.equal(restored.migrated, false);
    assert.equal(restored.config.typesafeRouting?.apiKey, "typesafe-secret");
  });

  it("refuses to persist a new TypeSafe API key without encryption", () => {
    const config: Config = {
      ...getDefaultConfig(),
      typesafeRouting: { enabled: true, apiKey: "typesafe-secret" },
    };
    assert.throws(() => encryptTypeSafeRoutingInConfig(config), /ENCRYPTION_KEY/);
  });

  it("throws when decrypting with wrong passphrase", () => {
    const plain = "secret-token-value";
    const enc = encryptRefreshToken(plain, "correct-key");

    assert.throws(() => {
      decryptRefreshToken(enc, "wrong-key");
    });
  });

  it("handles encryptAccountsInConfig and decryptAccountsInConfig with auto-migration flag", () => {
    const secret = "test-secret-key";
    const initialConfig: Config = {
      ...getDefaultConfig(),
      accounts: [
        { email: "user1@example.com", refreshToken: "plain-rt-1", projectId: "p1" },
        { email: "user2@example.com", refreshToken: "plain-rt-2", projectId: "p2" },
      ],
    };

    // When secret is passed, decrypt detects plain tokens and sets migrated: true
    const { config: plainConfig, migrated } = decryptAccountsInConfig(initialConfig, secret);
    assert.equal(migrated, true);

    // Encrypting config replaces plain tokens with enc:v2:... tokens
    const encryptedConfig = encryptAccountsInConfig(plainConfig, secret);
    assert.ok(isEncryptedToken(encryptedConfig.accounts[0].refreshToken ?? ""));
    assert.ok(isEncryptedToken(encryptedConfig.accounts[1].refreshToken ?? ""));

    // Decrypting encrypted config returns plain tokens and migrated: false
    const { config: restoredConfig, migrated: migrated2 } = decryptAccountsInConfig(encryptedConfig, secret);
    assert.equal(migrated2, false);
    assert.equal(restoredConfig.accounts[0].refreshToken, "plain-rt-1");
    assert.equal(restoredConfig.accounts[1].refreshToken, "plain-rt-2");
  });

  it("transparently encrypts tokens in db-store when PI_ROTATOR_ENCRYPTION_KEY is set", async () => {
    if (!process.env.TUXEVIL_ROTATOR_DIR) {
      process.env.TUXEVIL_ROTATOR_DIR = mkdtempSync(join(tmpdir(), "tuxevil-token-enc-"));
    }
    await initDb();
    process.env.PI_ROTATOR_ENCRYPTION_KEY = "db-store-secret";

    const config: Config = {
      ...getDefaultConfig(),
      accounts: [
        { email: "encrypted-user@example.com", refreshToken: "1//plain-token-db", projectId: "proj" },
      ],
    };

    await setCachedConfig(config);

    // In memory, getCachedConfig returns the plain refresh token for usage
    const loaded = getCachedConfig();
    assert.ok(loaded);
    assert.equal(loaded.accounts[0].refreshToken, "1//plain-token-db");

    await closeDb();
  });
});
