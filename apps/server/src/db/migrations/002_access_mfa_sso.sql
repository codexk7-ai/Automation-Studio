-- Per-record permissions, TOTP two-factor authentication and OpenID Connect SSO.

-- Record ownership. Tables with row_access = 'own' only show members (below admin)
-- the rows they own; admins, owners and workflows see every row.
ALTER TABLE data_tables ADD COLUMN row_access TEXT NOT NULL DEFAULT 'all' CHECK (row_access IN ('all', 'own'));
ALTER TABLE data_rows ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;
UPDATE data_rows SET owner_id = created_by WHERE created_by IN (SELECT id FROM users);
CREATE INDEX data_rows_owner_idx ON data_rows (table_id, owner_id);

-- TOTP (RFC 6238). Secrets are AES-GCM encrypted like credentials; recovery codes are hashed.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN totp_last_counter BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN recovery_codes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- SSO identities.
ALTER TABLE users ADD COLUMN oidc_issuer TEXT;
ALTER TABLE users ADD COLUMN oidc_subject TEXT;
CREATE UNIQUE INDEX users_oidc_idx ON users (oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL;

CREATE TABLE oidc_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Workspace policy: require two-factor authentication for password sign-ins.
-- (stored in workspaces.settings.require2fa; no schema change needed)
