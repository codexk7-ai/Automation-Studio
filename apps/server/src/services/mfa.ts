import type { AppContext } from "../context.ts";
import { badRequest, unauthorized } from "../errors.ts";
import { randomToken, safeEqual, sha256, verifyPassword } from "../security/crypto.ts";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../security/totp.ts";
import { audit } from "./audit.ts";

const aad = (userId: string) => `totp:${userId}`;
const CHALLENGE_TTL_MS = 5 * 60_000;

interface MfaUser {
  id: string;
  email: string;
  totp_secret: string | null;
  totp_pending_secret: string | null;
  totp_enabled: boolean;
  totp_last_counter: number;
  recovery_codes: string[];
  password_hash: string;
}

async function loadUser(app: AppContext, userId: string): Promise<MfaUser> {
  const u = await app.db.one<MfaUser>(
    "SELECT id, email, totp_secret, totp_pending_secret, totp_enabled, totp_last_counter, recovery_codes, password_hash FROM users WHERE id = $1",
    [userId],
  );
  if (!u) throw unauthorized();
  return u;
}

export async function mfaStatus(app: AppContext, userId: string) {
  const u = await loadUser(app, userId);
  return { enabled: u.totp_enabled, recoveryCodesLeft: u.recovery_codes.length };
}

/** Step 1: create a pending secret (not active until confirmed with a valid code). */
export async function beginTotpSetup(app: AppContext, userId: string) {
  const u = await loadUser(app, userId);
  if (u.totp_enabled) throw badRequest("Two-factor authentication is already enabled.");
  const secret = generateTotpSecret();
  await app.db.query("UPDATE users SET totp_pending_secret = $2 WHERE id = $1", [userId, app.secrets.encrypt(secret, aad(userId))]);
  return { secret, otpauthUri: otpauthUri(secret, u.email, app.config.brandName) };
}

/** Step 2: confirm with a code; returns one-time recovery codes (stored hashed). */
export async function confirmTotpSetup(app: AppContext, userId: string, code: string) {
  const u = await loadUser(app, userId);
  if (!u.totp_pending_secret) throw badRequest("Start the two-factor setup first.");
  const secret = app.secrets.decrypt(u.totp_pending_secret, aad(userId));
  const counter = verifyTotp(secret, code);
  if (counter === null) throw badRequest("That code is not valid. Check your device's clock and try again.");
  const recovery = Array.from({ length: 10 }, () => randomToken(6).replace(/[-_]/g, "x").slice(0, 10).toLowerCase());
  await app.db.query(
    "UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled = TRUE, totp_last_counter = $2, recovery_codes = $3 WHERE id = $1",
    [userId, counter, recovery.map((c) => sha256(c))],
  );
  await audit(app, { actorType: "system" }, { workspaceId: null, action: "auth.2fa_enabled", resourceType: "user", resourceId: userId });
  return { recoveryCodes: recovery };
}

export async function disableTotp(app: AppContext, userId: string, password: string, code: string) {
  const u = await loadUser(app, userId);
  if (!(await verifyPassword(password ?? "", u.password_hash))) throw unauthorized("Password is incorrect.");
  if (u.totp_enabled && !(await checkSecondFactor(app, u, code))) throw unauthorized("Invalid two-factor code.");
  await app.db.query("UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = FALSE, totp_last_counter = 0, recovery_codes = '[]'::jsonb WHERE id = $1", [userId]);
  await audit(app, { actorType: "system" }, { workspaceId: null, action: "auth.2fa_disabled", resourceType: "user", resourceId: userId });
}

/** Accepts a TOTP code (no reuse) or a single-use recovery code. */
async function checkSecondFactor(app: AppContext, u: MfaUser, code: string): Promise<boolean> {
  if (!u.totp_secret) return false;
  const counter = verifyTotp(app.secrets.decrypt(u.totp_secret, aad(u.id)), code, Number(u.totp_last_counter));
  if (counter !== null) {
    // Conditional update makes concurrent reuse of one code fail.
    const rows = await app.db.query("UPDATE users SET totp_last_counter = $2 WHERE id = $1 AND totp_last_counter < $2 RETURNING id", [u.id, counter]);
    return rows.length > 0;
  }
  const hashed = sha256(String(code ?? "").trim().toLowerCase());
  if (u.recovery_codes.includes(hashed)) {
    await app.db.query("UPDATE users SET recovery_codes = $2 WHERE id = $1", [u.id, u.recovery_codes.filter((c) => c !== hashed)]);
    await audit(app, { actorType: "system" }, { workspaceId: null, action: "auth.recovery_code_used", resourceType: "user", resourceId: u.id });
    return true;
  }
  return false;
}

/** Short-lived signed challenge issued after a correct password when 2FA is on. */
export function issueMfaChallenge(app: AppContext, userId: string): string {
  const payload = `${userId}.${Date.now() + CHALLENGE_TTL_MS}`;
  return `${Buffer.from(payload).toString("base64url")}.${app.secrets.mac("mfa-challenge", payload)}`;
}

export async function completeMfaChallenge(app: AppContext, challenge: string, code: string): Promise<string> {
  const [encoded, sig] = String(challenge ?? "").split(".");
  if (!encoded || !sig) throw unauthorized("Sign-in expired. Enter your password again.");
  const payload = Buffer.from(encoded, "base64url").toString();
  if (!safeEqual(sig, app.secrets.mac("mfa-challenge", payload))) throw unauthorized("Sign-in expired. Enter your password again.");
  const [userId, exp] = payload.split(".");
  if (!userId || Number(exp) < Date.now()) throw unauthorized("Sign-in expired. Enter your password again.");
  const lock = await app.db.one<{ locked_until: string | null; failed_logins: number }>("SELECT locked_until, failed_logins FROM users WHERE id = $1", [userId]);
  if (lock?.locked_until && Date.parse(lock.locked_until) > Date.now()) throw unauthorized("Too many failed attempts. Try again in a few minutes.");
  const u = await loadUser(app, userId);
  if (!u.totp_enabled || !(await checkSecondFactor(app, u, code))) {
    // Failed codes count toward the same per-account lockout as passwords (guessing is spread across IPs otherwise).
    const failed = (lock?.failed_logins ?? 0) + 1;
    await app.db.query("UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1", [userId, failed >= 8 ? 0 : failed, failed >= 8 ? new Date(Date.now() + 15 * 60_000) : null]);
    await audit(app, { actorType: "system" }, { workspaceId: null, action: "auth.2fa_failed", resourceType: "user", resourceId: userId });
    throw unauthorized("Invalid two-factor code.");
  }
  await app.db.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [userId]);
  return userId;
}
