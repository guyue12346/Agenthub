import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ConfigService } from "./config.service.js";

const SECRET_PREFIX = "enc:v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export function encryptSecret(plaintext: string, config: ConfigService) {
  const key = resolveEncryptionKey(config);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.material, iv, { authTagLength: AUTH_TAG_BYTES });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_PREFIX,
    key.id,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(":");
}

export function decryptSecret(value: string | null | undefined, config: ConfigService) {
  if (!value) return undefined;
  if (!isEncryptedSecret(value)) return value;
  const parts = value.split(":");
  if (parts.length !== 6) throw new Error("Encrypted secret payload is malformed");
  const version = parts[1];
  const keyId = parts[2];
  const encodedIv = parts[3];
  const encodedTag = parts[4];
  const encodedCiphertext = parts[5];
  if (!version || !keyId || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("Encrypted secret payload is malformed");
  }
  if (version !== "v1") throw new Error(`Unsupported encrypted secret version: ${version}`);
  const key = resolveDecryptionKey(config, keyId);
  const decipher = createDecipheriv(ALGORITHM, key.material, Buffer.from(encodedIv, "base64url"), { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function isEncryptedSecret(value: string) {
  return value.startsWith(`${SECRET_PREFIX}:`);
}

export function isEncryptedWithCurrentKey(value: string, config: ConfigService) {
  const keyId = encryptedKeyId(value);
  return Boolean(keyId && safeEqual(resolveEncryptionKey(config).id, keyId));
}

function resolveEncryptionKey(config: ConfigService) {
  const raw = config.secretEncryptionKey;
  if (!raw && config.nodeEnv === "production") {
    throw new Error("AGENTHUB_SECRET_ENCRYPTION_KEY is required in production for stored runtime secrets");
  }
  const materialSource = raw || `agenthub-dev-secret:${config.databaseUrl}`;
  return deriveKey(materialSource);
}

function resolveDecryptionKey(config: ConfigService, keyId: string) {
  const candidates = [
    resolveEncryptionKey(config),
    ...config.previousSecretEncryptionKeys.map((raw, index) => {
      const label = `AGENTHUB_SECRET_ENCRYPTION_PREVIOUS_KEYS[${index}]`;
      if (raw.length < 32) throw new Error(`${label} must be at least 32 characters`);
      return deriveKey(raw);
    })
  ];
  const key = candidates.find((candidate) => safeEqual(candidate.id, keyId));
  if (!key) throw new Error("Encrypted secret key id does not match this runtime or configured previous keys");
  return key;
}

function deriveKey(materialSource: string) {
  const material = createHash("sha256").update(materialSource).digest();
  const id = createHash("sha256").update(materialSource).digest("base64url").slice(0, 16);
  return { id, material };
}

function encryptedKeyId(value: string) {
  if (!isEncryptedSecret(value)) return undefined;
  const parts = value.split(":");
  return parts.length === 6 ? parts[2] : undefined;
}

function safeEqual(left: string, right: string | undefined) {
  if (!right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}
