import { toText } from "@automation-studio/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { badRequest } from "../errors.ts";
import { authorize } from "../auth/principal.ts";
import { pkcePair, randomToken } from "../security/crypto.ts";
import { safeRequest } from "../security/ssrf.ts";
import { audit } from "../services/audit.ts";
import { insertCredentialRaw } from "../services/credentials.ts";
import { need } from "./server.ts";

function clientFor(app: AppContext, type: string): { clientId: string; clientSecret: string } {
  if (type === "google") {
    if (!app.config.google) throw badRequest("Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server (see docs/INTEGRATIONS.md).");
    return app.config.google;
  }
  throw badRequest(`OAuth is not supported for '${type}'.`);
}

const redirectUri = (app: AppContext, type: string) => `${app.config.publicUrl}/api/oauth/${type}/callback`;

/** Starts an authorization-code + PKCE flow with a single-use, user-bound state. */
export async function startOAuth(app: AppContext, req: FastifyRequest, reply: FastifyReply, type: string) {
  const p = need(req);
  authorize(p, "editor", "write");
  if (!req.sessionInfo) throw badRequest("Connect accounts from the web app (session required).");
  const ct = app.registry.getCredentialType(type);
  if (!ct?.oauth2) throw badRequest("This connection type does not support OAuth.");
  const { clientId } = clientFor(app, type);
  const state = randomToken(24);
  const { verifier, challenge } = pkcePair();
  const name = toText((req.query as Record<string, string>).name).trim().slice(0, 200) || `${ct.name} (${new Date().toISOString().slice(0, 10)})`;
  await app.db.query(
    "INSERT INTO oauth_states (state, workspace_id, user_id, credential_type, credential_name, code_verifier, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')",
    [state, p.workspaceId, p.userId, type, name, verifier],
  );
  const url = new URL(ct.oauth2.authorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri(app, type));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ct.oauth2.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(ct.oauth2.extraParams ?? {})) url.searchParams.set(k, v);
  return reply.redirect(url.toString());
}

export async function finishOAuth(app: AppContext, req: FastifyRequest, reply: FastifyReply, type: string) {
  const q = req.query as Record<string, string>;
  const fail = (msg: string) => reply.redirect(`/connections?oauth_error=${encodeURIComponent(msg)}`);
  if (q.error) return fail(q.error);
  const p = req.principal;
  if (!p || !req.sessionInfo) return fail("Sign in first, then reconnect.");
  // Single-use state, bound to the same user and workspace that started the flow.
  const rows = await app.db.query<{ workspace_id: string; user_id: string; credential_type: string; credential_name: string; code_verifier: string }>(
    "DELETE FROM oauth_states WHERE state = $1 AND expires_at > now() RETURNING workspace_id, user_id, credential_type, credential_name, code_verifier",
    [toText(q.state)],
  );
  const st = rows[0];
  if (!st || st.user_id !== p.userId || st.workspace_id !== p.workspaceId || st.credential_type !== type) return fail("Invalid or expired OAuth state.");
  const ct = app.registry.getCredentialType(type)!;
  const { clientId, clientSecret } = clientFor(app, type);
  const res = await safeRequest(app.fetch, ct.oauth2!.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: toText(q.code), redirect_uri: redirectUri(app, type), client_id: clientId, client_secret: clientSecret, code_verifier: st.code_verifier }).toString(),
  });
  const tokens = JSON.parse(res.body.toString("utf8") || "{}") as Record<string, unknown>;
  if (res.status >= 400 || !tokens.access_token) return fail(toText(tokens.error_description ?? tokens.error ?? "Token exchange failed."));
  let email: string | undefined;
  if (type === "google") {
    const info = await safeRequest(app.fetch, "https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: `Bearer ${toText(tokens.access_token)}` } });
    email = toText(JSON.parse(info.body.toString("utf8") || "{}").email) || undefined;
  }
  const data = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000, scope: tokens.scope, email };
  const id = await insertCredentialRaw(app, p.workspaceId, p.userId, st.credential_name, type, data, { authMode: "oauth", account: email, scopes: toText(tokens.scope).split(" ") });
  await audit(app, p, { workspaceId: p.workspaceId, action: "credential.oauth_connect", resourceType: "credential", resourceId: id, details: { type, account: email }, ip: p.ip });
  return reply.redirect(`/connections?connected=${encodeURIComponent(id)}`);
}
