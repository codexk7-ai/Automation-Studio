import { loadConfig } from "../config.ts";
import { createDb } from "../db/index.ts";
import { migrate } from "../db/migrate.ts";
import { SecretBox } from "../security/crypto.ts";

/**
 * Re-encrypts every stored secret (connections, 2FA secrets) from
 * ENCRYPTION_KEY to NEW_ENCRYPTION_KEY in one transaction. Stop the API and
 * workers first, back up the database, run this, then set ENCRYPTION_KEY to
 * the new key and restart. Nothing is changed if any record fails to decrypt.
 *
 *   NEW_ENCRYPTION_KEY=<64 hex chars> npm run rotate-key
 */
const config = loadConfig();
const newKey = process.env.NEW_ENCRYPTION_KEY ?? "";
if (!config.encryptionKey || !newKey) {
  console.error("Set ENCRYPTION_KEY (current) and NEW_ENCRYPTION_KEY (new, 64 hex chars).");
  process.exit(1);
}
if (newKey === config.encryptionKey) {
  console.error("NEW_ENCRYPTION_KEY must differ from ENCRYPTION_KEY.");
  process.exit(1);
}
const oldBox = new SecretBox(config.encryptionKey);
const newBox = new SecretBox(newKey);
const db = await createDb(config);
try {
  await migrate(db);
  const result = await db.transaction(async (tx) => {
    let credentials = 0;
    let totp = 0;
    for (const c of await tx.query<{ id: string; workspace_id: string; encrypted_data: string }>("SELECT id, workspace_id, encrypted_data FROM credentials")) {
      const aad = `credential:${c.workspace_id}:${c.id}`;
      const plain = oldBox.decrypt(c.encrypted_data, aad);
      await tx.query("UPDATE credentials SET encrypted_data = $2 WHERE id = $1", [c.id, newBox.encrypt(plain, aad)]);
      credentials++;
    }
    for (const u of await tx.query<{ id: string; totp_secret: string | null; totp_pending_secret: string | null }>("SELECT id, totp_secret, totp_pending_secret FROM users WHERE totp_secret IS NOT NULL OR totp_pending_secret IS NOT NULL")) {
      const aad = `totp:${u.id}`;
      const re = (v: string | null) => (v ? newBox.encrypt(oldBox.decrypt(v, aad), aad) : null);
      await tx.query("UPDATE users SET totp_secret = $2, totp_pending_secret = $3 WHERE id = $1", [u.id, re(u.totp_secret), re(u.totp_pending_secret)]);
      totp++;
    }
    // Verify every record round-trips with the new key before committing.
    for (const c of await tx.query<{ id: string; workspace_id: string; encrypted_data: string }>("SELECT id, workspace_id, encrypted_data FROM credentials")) {
      newBox.decrypt(c.encrypted_data, `credential:${c.workspace_id}:${c.id}`);
    }
    return { credentials, totp };
  });
  console.log(`Re-encrypted ${result.credentials} connections and ${result.totp} two-factor secrets.`);
  console.log("Now set ENCRYPTION_KEY to the new key, keep the old key in your backups until you have verified, and restart.");
} catch (err) {
  console.error(`Rotation aborted, nothing changed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
