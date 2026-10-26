import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import type { AppContext } from "../context.ts";
import { AppError, badRequest } from "../errors.ts";
import { hashPassword, pkcePair, randomId, randomToken } from "../security/crypto.ts";
import { safeRequest } from "../security/ssrf.ts";
import { audit } from "./audit.ts";

/**
 * OpenID Connect sign-in (authorization code + PKCE, client_secret_post).
 * ID tokens are verified locally: signature against the provider's JWKS
 * (RS256/RS384/RS512/PS256/ES256/ES384), issuer, audience, expiry and nonce.
 */
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryCache: { at: number; doc: Discovery } | null = null;
let jwksCache: { at: number; keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }> } | null = null;

function oidc(app: AppContext) {
  if (!app.config.oidc) throw badRequest("Single sign-on is not configured on this server.");
  return app.config.oidc;
}

async function getJson<T>(app: AppContext, url: string): Promise<T> {
  const res = await safeRequest(app.fetch, url, { headers: { accept: "application/json" }, timeoutMs: 10_000, maxBytes: 1_000_000 });
  if (res.status >= 400) throw new AppError(502, "sso_error", `Identity provider returned HTTP ${res.status}.`);
  return JSON.parse(res.body.toString("utf8")) as T;
}

async function discovery(app: AppContext): Promise<Discovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < 3_600_000) return discoveryCache.doc;
  const cfg = oidc(app);
  const doc = await getJson<Discovery>(app, `${cfg.issuer}/.well-known/openid-configuration`);
  if (doc.issuer.replace(/\/$/, "") !== cfg.issuer) throw new AppError(502, "sso_error", "Identity provider issuer does not match OIDC_ISSUER.");
  discoveryCache = { at: Date.now(), doc };
  return doc;
}

async function jwks(app: AppContext, uri: string, force = false) {
  if (!force && jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const { keys } = await getJson<{ keys: Array<JsonWebKey & { kid?: string }> }>(app, uri);
  jwksCache = { at: Date.now(), keys };
  return keys;
}

export function resetSsoCaches() {
  discoveryCache = null;
  jwksCache = null;
}

const ALGS: Record<string, { hash: string; kty: string; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: "sha256", kty: "RSA" },
  RS384: { hash: "sha384", kty: "RSA" },
  RS512: { hash: "sha512", kty: "RSA" },
  PS256: { hash: "sha256", kty: "RSA", pss: true },
  ES256: { hash: "sha256", kty: "EC", ec: true },
  ES384: { hash: "sha384", kty: "EC", ec: true },
};

export async function verifyIdToken(app: AppContext, idToken: string, expected: { issuer: string; clientId: string; nonce: string; jwksUri: string }): Promise<Record<string, unknown>> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AppError(401, "sso_invalid_token", "Malformed ID token.");
  const [h, p, sig] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg?: string; kid?: string };
  const alg = ALGS[String(header.alg)];
  if (!alg) throw new AppError(401, "sso_invalid_token", `Unsupported ID token algorithm '${header.alg}'.`);
  const pick = (keys: Array<JsonWebKey & { kid?: string }>) => keys.find((k) => k.kty === alg.kty && (!header.kid || k.kid === header.kid));
  let jwk = pick(await jwks(app, expected.jwksUri));
  if (!jwk) jwk = pick(await jwks(app, expected.jwksUri, true)); // key rotation
  if (!jwk) throw new AppError(401, "sso_invalid_token", "No matching signing key from the identity provider.");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const ok = verifySignature(alg.hash, Buffer.from(`${h}.${p}`), alg.ec ? { key, dsaEncoding: "ieee-p1363" } : alg.pss ? { key, padding: 6, saltLength: 32 } : key, Buffer.from(sig, "base64url"));
  if (!ok) throw new AppError(401, "sso_invalid_token", "ID token signature is invalid.");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (String(claims.iss).replace(/\/$/, "") !== expected.issuer) throw new AppError(401, "sso_invalid_token", "ID token issuer mismatch.");
  if (!aud.includes(expected.clientId) || (aud.length > 1 && claims.azp !== expected.clientId)) throw new AppError(401, "sso_invalid_token", "ID token audience mismatch.");
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new AppError(401, "sso_invalid_token", "ID token expired.");
  if (typeof claims.iat === "number" && claims.iat > now + 300) throw new AppError(401, "sso_invalid_token", "ID token issued in the future.");
  if (claims.nonce !== expected.nonce) throw new AppError(401, "sso_invalid_token", "ID token nonce mismatch (possible replay).");
  return claims;
}

export async function startSso(app: AppContext): Promise<string> {
  const cfg = oidc(app);
  const d = await discovery(app);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const { verifier, challenge } = pkcePair();
  await app.db.query("INSERT INTO oidc_states (state, nonce, code_verifier, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')", [state, nonce, verifier]);
  const url = new URL(d.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", `${app.config.publicUrl}/api/auth/sso/callback`);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Completes sign-in; returns the local user id (linking or creating the account per policy). */
export async function finishSso(app: AppContext, code: string, state: string, ip?: string): Promise<string> {
  const cfg = oidc(app);
  const rows = await app.db.query<{ nonce: string; code_verifier: string }>("DELETE FROM oidc_states WHERE state = $1 AND expires_at > now() RETURNING nonce, code_verifier", [state]);
  const st = rows[0];
  if (!st) throw new AppError(401, "sso_state", "Sign-in session expired. Try again.");
  const d = await discovery(app);
  const res = await safeRequest(app.fetch, d.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${app.config.publicUrl}/api/auth/sso/callback`, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: st.code_verifier }).toString(),
    timeoutMs: 15_000,
  });
  const tokens = JSON.parse(res.body.toString("utf8") || "{}") as { id_token?: string; error?: string };
  if (res.status >= 400 || !tokens.id_token) throw new AppError(401, "sso_error", `Token exchange failed${tokens.error ? `: ${tokens.error}` : ""}.`);
  const claims = await verifyIdToken(app, tokens.id_token, { issuer: cfg.issuer, clientId: cfg.clientId, nonce: st.nonce, jwksUri: d.jwks_uri });

  const sub = String(claims.sub ?? "");
  const email = String(claims.email ?? "").toLowerCase();
  if (!sub) throw new AppError(401, "sso_invalid_token", "ID token has no subject.");
  const byIdentity = await app.db.one<{ id: string; is_active: boolean }>("SELECT id, is_active FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2", [cfg.issuer, sub]);
  if (byIdentity) {
    if (!byIdentity.is_active) throw new AppError(403, "forbidden", "This account is disabled.");
    return byIdentity.id;
  }
  if (!email || claims.email_verified === false) throw new AppError(403, "sso_email", "The identity provider did not supply a verified email address.");
  const domain = email.split("@")[1] ?? "";
  if (cfg.allowedDomains.length && !cfg.allowedDomains.includes(domain)) throw new AppError(403, "sso_domain", `Accounts from ${domain} are not allowed to sign in.`);
  const byEmail = await app.db.one<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [email]);
  if (byEmail) {
    await app.db.query("UPDATE users SET oidc_issuer = $2, oidc_subject = $3 WHERE id = $1", [byEmail.id, cfg.issuer, sub]);
    await audit(app, { actorType: "system" }, { workspaceId: null, action: "auth.sso_linked", resourceType: "user", resourceId: byEmail.id, ip });
    return byEmail.id;
  }
  if (!cfg.autoCreate) throw new AppError(403, "sso_no_account", "No account exists for this email. Ask an admin to add you first.");
  // New SSO user: own workspace, unusable random password (sign-in only through SSO).
  const userId = randomId("usr");
  const workspaceId = randomId("ws");
  const name = String(claims.name ?? email.split("@")[0]).slice(0, 200);
  const passwordHash = await hashPassword(randomToken(32));
  await app.db.transaction(async (tx) => {
    await tx.query("INSERT INTO users (id, email, name, password_hash, oidc_issuer, oidc_subject) VALUES ($1, $2, $3, $4, $5, $6)", [userId, email, name, passwordHash, cfg.issuer, sub]);
    await tx.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [workspaceId, `${name}'s workspace`]);
    await tx.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspaceId, userId]);
    await tx.query("INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, 'Default project')", [randomId("prj"), workspaceId]);
  });
  await audit(app, { actorType: "system" }, { workspaceId, action: "auth.sso_user_created", resourceType: "user", resourceId: userId, ip });
  return userId;
}
