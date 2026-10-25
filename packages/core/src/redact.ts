/**
 * Secret redaction for anything that is persisted to logs, execution records,
 * or returned to clients.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(pass(word|phrase)?|secret|token|api[-_]?key|apikey|authorization|auth|cookie|session|private[-_]?key|client[-_]?secret|refresh|access[-_]?key|signature|credential)/i;
const ALLOWED_KEYS = new Set(["tokens", "token_count", "tokenCount", "maxTokens", "max_tokens", "inputTokens", "outputTokens", "totalTokens", "author", "authorId", "authorized", "auth_type", "authType"]);

const VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /\bBasic\s+[A-Za-z0-9+/]{8,}=*/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[0-9A-Za-z\-_]{30,}\b/g,
  /\bEAA[A-Za-z0-9]{40,}\b/g,
  /\bya29\.[0-9A-Za-z\-_]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function isSensitiveKey(key: string): boolean {
  return !ALLOWED_KEYS.has(key) && SENSITIVE_KEY.test(key);
}

export function redactString(s: string, knownSecrets: readonly string[] = []): string {
  let out = s;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Deep-copies a value replacing sensitive keys and known secret values.
 * `knownSecrets` are the decrypted credential values used during a run.
 */
export function redact(value: unknown, knownSecrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 40) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value, knownSecrets);
  if (Array.isArray(value)) return value.map((v) => redact(v, knownSecrets, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k) && v !== null && v !== undefined && typeof v !== "boolean" && typeof v !== "number") out[k] = REDACTED;
      else out[k] = redact(v, knownSecrets, depth + 1);
    }
    return out;
  }
  return value;
}

/** Truncates large payloads before persistence. */
export function truncateForStorage(value: unknown, maxBytes = 256_000): unknown {
  const json = JSON.stringify(value ?? null);
  if (json.length <= maxBytes) return value;
  return { truncated: true, bytes: json.length, preview: json.slice(0, Math.min(maxBytes, 4000)) };
}
