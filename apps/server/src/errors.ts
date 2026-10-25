/** Errors surfaced to API clients. Messages must never contain secrets. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "bad_request", message, details);
export const unauthorized = (message = "Authentication required.") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to do that.") => new AppError(403, "forbidden", message);
export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found.`);
export const conflict = (message: string) => new AppError(409, "conflict", message);

/**
 * Normalized step error. `transient` errors are retried according to the
 * node's retry policy; everything else fails the step immediately.
 */
export type StepErrorKind = "transient" | "permanent" | "config" | "auth" | "rate_limit" | "timeout" | "cancelled" | "policy";

export class StepError extends Error {
  constructor(
    readonly kind: StepErrorKind,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "StepError";
  }

  get retryable(): boolean {
    return this.kind === "transient" || this.kind === "rate_limit" || this.kind === "timeout";
  }

  toJSON() {
    return { kind: this.kind, message: this.message, details: this.details, retryable: this.retryable };
  }
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

/** Maps an HTTP status from a provider API to a step error kind. */
export function errorKindForStatus(status: number): StepErrorKind {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status >= 500) return "transient";
  return "permanent";
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 3_600_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.min(date - Date.now(), 3_600_000));
}

export function normalizeError(err: unknown): StepError {
  if (err instanceof StepError) return err;
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code;
  if (e?.name === "OutboundPolicyError") return new StepError("policy", e.message ?? "Blocked by outbound network policy");
  if (e?.name === "ExpressionError") return new StepError("config", `Expression error: ${e.message}`);
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return new StepError("timeout", e.message || "Operation timed out");
  if (code && TRANSIENT_CODES.has(code)) return new StepError("transient", `Network error (${code})`);
  if (e?.name === "ZodError") return new StepError("config", e.message ?? "Invalid input");
  return new StepError("permanent", e?.message ? String(e.message).slice(0, 2000) : "Unknown error");
}
