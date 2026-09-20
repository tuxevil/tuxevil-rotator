import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import type { Config } from "./types.js";
import { logger } from "./logger.js";
import { rotatorEnv } from "./env.js";

const V1_PREFIX = "enc:v1:";
const V2_PREFIX = "enc:v2:";
const KEY_BYTES = 32;
const V2_SALT_BYTES = 16;
const V2_KDF_CONTEXT = "pi-antigravity-rotator:encryption:v2";
const SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
};
let missingKeyWarned = false;
const tokenLog = logger.child("token-encryption");

/**
 * Returns the configured encryption key from environment variables.
 * Prefers TUXEVIL_ROTATOR_ENCRYPTION_KEY, falls back to ENCRYPTION_KEY.
 */
export function getEncryptionKey(): string | undefined {
  const key = rotatorEnv("ENCRYPTION_KEY") || process.env.ENCRYPTION_KEY;
  return key && key.trim().length > 0 ? key.trim() : undefined;
}

/**
 * Derives a 32-byte key for AES-256-GCM.
 * High-entropy 64-hex keys are used directly; other key material goes through
 * scrypt with a per-ciphertext salt when encrypting v2 tokens.
 */
export function deriveKey(
  keyInput: string,
  salt: string | Buffer = V2_KDF_CONTEXT,
): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(keyInput)) {
    return Buffer.from(keyInput, "hex");
  }
  return scryptSync(keyInput, salt, KEY_BYTES, SCRYPT_OPTIONS);
}

/**
 * Derives the v1 key only for decrypting persisted legacy ciphertext.
 * New tokens never use this compatibility path.
 */
function deriveLegacyV1Key(keyInput: string): Buffer {
  return createHash("sha256").update(keyInput, "utf8").digest();
}

/**
 * Checks whether a refresh token string is already encrypted.
 */
export function isEncryptedToken(token: string): boolean {
  return (
    typeof token === "string" &&
    (token.startsWith(V1_PREFIX) || token.startsWith(V2_PREFIX))
  );
}

/** Checks whether any persisted secret uses one of the encrypted formats. */
export const isEncryptedSecret = isEncryptedToken;

export function isRedactedSecret(value: string | undefined): boolean {
  return value === "[configured]";
}

/**
 * Encrypts a plain-text OAuth refresh token using AES-256-GCM.
 * Format: enc:v2:<salt_hex>:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */
export function encryptRefreshToken(
  plainToken: string,
  keyInput: string,
): string {
  if (!plainToken || isEncryptedToken(plainToken)) {
    return plainToken;
  }
  const salt = randomBytes(V2_SALT_BYTES);
  const key = deriveKey(keyInput, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plainToken, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${V2_PREFIX}${salt.toString("hex")}:${iv.toString("hex")}:${tag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted refresh token.
 */
export function decryptRefreshToken(
  encryptedToken: string,
  keyInput: string,
): string {
  if (!encryptedToken || !isEncryptedToken(encryptedToken)) {
    return encryptedToken;
  }
  const isV2 = encryptedToken.startsWith(V2_PREFIX);
  const prefix = isV2 ? V2_PREFIX : V1_PREFIX;
  const payload = encryptedToken.slice(prefix.length);
  const parts = payload.split(":");
  if (parts.length !== (isV2 ? 4 : 3)) {
    throw new Error("Malformed encrypted refresh token format");
  }
  const saltHex = isV2 ? parts[0] : undefined;
  const ivHex = isV2 ? parts[1] : parts[0];
  const tagHex = isV2 ? parts[2] : parts[1];
  const ciphertextHex = isV2 ? parts[3] : parts[2];
  const key = isV2
    ? deriveKey(keyInput, Buffer.from(saltHex!, "hex"))
    : deriveLegacyV1Key(keyInput);
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertextHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/** Encrypts a non-OAuth secret using the same authenticated format. */
export function encryptSecret(secret: string, keyInput: string): string {
  return encryptRefreshToken(secret, keyInput);
}

/** Decrypts a non-OAuth secret using the same authenticated format. */
export function decryptSecret(secret: string, keyInput: string): string {
  return decryptRefreshToken(secret, keyInput);
}

/**
 * Encrypts the optional TypeSafe credential before it reaches persistence.
 * A newly supplied API key must never be silently written in plaintext.
 */
export function encryptTypeSafeRoutingInConfig(
  config: Config,
  keyInput?: string,
): Config {
  const routing = config.typesafeRouting;
  if (!routing?.apiKey || isEncryptedSecret(routing.apiKey) || isRedactedSecret(routing.apiKey)) return config;
  const key = keyInput || getEncryptionKey();
  if (!key) {
    throw new Error(
      "TypeSafe API key cannot be persisted without ENCRYPTION_KEY",
    );
  }
  return {
    ...config,
    typesafeRouting: {
      ...routing,
      apiKey: encryptSecret(routing.apiKey, key),
    },
  };
}

/**
 * Decrypts the persisted TypeSafe credential for runtime use. If the
 * encryption key is unavailable, the ciphertext remains in place and Jev is
 * treated as unavailable by the routing layer.
 */
export function decryptTypeSafeRoutingInConfig(
  config: Config,
  keyInput?: string,
): { config: Config; migrated: boolean } {
  const routing = config.typesafeRouting;
  if (!routing?.apiKey || !isEncryptedSecret(routing.apiKey)) {
    return { config, migrated: Boolean(routing?.apiKey && (keyInput || getEncryptionKey())) };
  }
  const key = keyInput || getEncryptionKey();
  if (!key) {
    if (!missingKeyWarned) {
      tokenLog.warn(
        "Found encrypted TypeSafe API key but ENCRYPTION_KEY is not set; Jev auto-routing is disabled until it is configured.",
      );
      missingKeyWarned = true;
    }
    return { config, migrated: false };
  }
  try {
    return {
      config: {
        ...config,
        typesafeRouting: { ...routing, apiKey: decryptSecret(routing.apiKey, key) },
      },
      migrated: false,
    };
  } catch (err) {
    tokenLog.error(`Failed to decrypt TypeSafe API key: ${err}`);
    return { config, migrated: false };
  }
}

/** Returns a config safe for the admin UI/export surface. */
export function redactTypeSafeRoutingInConfig(config: Config): Config {
  if (!config.typesafeRouting?.apiKey) return structuredClone(config);
  return {
    ...structuredClone(config),
    typesafeRouting: {
      ...config.typesafeRouting,
      apiKey: "[configured]",
    },
  };
}

/**
 * Transforms a Config object by encrypting all plain account refresh tokens
 * if an encryption key is present.
 */
export function encryptAccountsInConfig(config: Config, keyInput?: string): Config {
  const key = keyInput || getEncryptionKey();
  if (!key || !config.accounts || !Array.isArray(config.accounts)) {
    return config;
  }
  const encryptedAccounts = config.accounts.map((acc) => {
    if (!acc.refreshToken || isEncryptedToken(acc.refreshToken)) {
      return acc;
    }
    return {
      ...acc,
      refreshToken: encryptRefreshToken(acc.refreshToken, key),
    };
  });
  return {
    ...config,
    accounts: encryptedAccounts,
  };
}

/**
 * Transforms a Config object by decrypting all encrypted account refresh tokens.
 * Returns the decrypted config and whether any plain-text tokens were found that
 * should trigger transparent auto-migration (encryption on next save).
 */
export function decryptAccountsInConfig(
  config: Config,
  keyInput?: string,
): { config: Config; migrated: boolean } {
  const key = keyInput || getEncryptionKey();
  if (!config.accounts || !Array.isArray(config.accounts)) {
    return { config, migrated: false };
  }

  let migrated = false;

  const decryptedAccounts = config.accounts.map((acc) => {
    if (!acc.refreshToken) return acc;

    if (isEncryptedToken(acc.refreshToken)) {
      if (!key) {
        if (!missingKeyWarned) {
          tokenLog.warn(
            `Found encrypted refresh token for ${acc.email} but TUXEVIL_ROTATOR_ENCRYPTION_KEY is not set.`,
          );
          missingKeyWarned = true;
        }
        return acc;
      }
      try {
        const decrypted = decryptRefreshToken(acc.refreshToken, key);
        return { ...acc, refreshToken: decrypted };
      } catch (err) {
        tokenLog.error(
          `Failed to decrypt refresh token for ${acc.email}: ${err}`,
        );
        return acc;
      }
    } else {
      if (key) {
        migrated = true;
      }
      return acc;
    }
  });

  return {
    config: {
      ...config,
      accounts: decryptedAccounts,
    },
    migrated,
  };
}
