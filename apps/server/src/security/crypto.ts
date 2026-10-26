import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export function randomId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256(key: string | Buffer, value: string | Buffer, encoding: "hex" | "base64" = "hex"): string {
  return createHmac("sha256", key).update(value).digest(encoding);
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Passwords: scrypt with per-user salt.

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Credential encryption: AES-256-GCM with a random 96-bit IV per record.
// Envelope: v1.<iv>.<tag>.<ciphertext> (base64url segments).

export class SecretBox {
  private readonly key: Buffer;

  constructor(rawKey: string) {
    const key = decodeKey(rawKey);
    if (key.length !== 32) throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes (use 64 hex chars or 44 base64 chars).");
    this.key = key;
  }

  encrypt(plaintext: string, aad = ""): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  }

  decrypt(envelope: string, aad = ""): string {
    const [version, iv, tag, ct] = envelope.split(".");
    if (version !== "v1" || !iv || !tag || ct === undefined) throw new Error("Unsupported credential envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  }

  /** HMAC-SHA256 under a purpose-specific key derived from the encryption key. */
  mac(purpose: string, value: string): string {
    const derived = createHmac("sha256", this.key).update(`purpose:${purpose}`).digest();
    return createHmac("sha256", derived).update(value).digest("hex");
  }

  encryptJson(value: unknown, aad = ""): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T = Record<string, unknown>>(envelope: string, aad = ""): T {
    return JSON.parse(this.decrypt(envelope, aad)) as T;
  }
}

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  return Buffer.from(trimmed, "base64");
}

export function generateEncryptionKey(): string {
  return randomBytes(32).toString("hex");
}

/** PKCE helpers for OAuth 2.0 authorization code flows. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
