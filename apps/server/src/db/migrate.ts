import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./index.ts";

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Source layout: src/db/migrate.ts -> src/db/migrations; bundled: dist/main.js -> dist/migrations
  for (const candidate of [join(here, "migrations"), join(here, "db", "migrations")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Migrations directory not found near ${here}`);
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies pending SQL migrations in filename order inside a transaction each.
 * Applied migrations are recorded with a checksum; a changed checksum for an
 * applied migration aborts startup instead of silently diverging.
 */
export async function migrate(db: Db, dir = migrationsDir()): Promise<MigrationResult> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied = new Map((await db.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).map((r) => [r.name, r.checksum]));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    const checksum = createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
    const existing = applied.get(file);
    if (existing) {
      if (existing !== checksum) throw new Error(`Migration ${file} was modified after being applied (checksum mismatch). Create a new migration instead.`);
      result.alreadyApplied.push(file);
      continue;
    }
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name, checksum) VALUES ('${file.replace(/'/g, "''")}', '${checksum}');\nCOMMIT;`).catch(async (err: unknown) => {
      await db.exec("ROLLBACK").catch(() => undefined);
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    });
    result.applied.push(file);
  }
  return result;
}
