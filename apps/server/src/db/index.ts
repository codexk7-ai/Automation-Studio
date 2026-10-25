import { mkdirSync } from "node:fs";
import type { AppConfig } from "../config.ts";

/**
 * Minimal database abstraction over PostgreSQL. Two drivers implement it:
 * node-postgres (`pg`) for a real server, and PGlite (Postgres compiled to
 * WASM) for zero-setup local development and tests. All queries use
 * positional parameters ($1, $2...) — never string interpolation of values.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  readonly driver: "pg" | "pglite";
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Executes multiple statements without parameters (migrations only). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

function normalizeParams(params: unknown[] = []): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (p !== null && typeof p === "object" && !(p instanceof Date) && !(p instanceof Uint8Array)) return JSON.stringify(p);
    return p;
  });
}

async function createPgDb(url: string): Promise<Db> {
  const pg = await import("pg");
  const Pool = pg.default?.Pool ?? (pg as unknown as { Pool: typeof import("pg").Pool }).Pool;
  // Return BIGINT/NUMERIC as JS numbers where safe (counts, ids).
  pg.default.types.setTypeParser(20, (v: string) => Number(v));
  pg.default.types.setTypeParser(1700, (v: string) => Number(v));
  const pool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
  const db: Db = {
    driver: "pg",
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, normalizeParams(params));
      return res.rows as T[];
    },
    async one<T>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, normalizeParams(params));
      return res.rows[0] as T | undefined;
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          async query<R>(sql: string, params?: unknown[]) {
            return (await client.query(sql, normalizeParams(params))).rows as R[];
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
  return db;
}

async function createPgliteDb(dataDir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const inMemory = dataDir === "memory://" || dataDir === "";
  if (!inMemory) mkdirSync(dataDir, { recursive: true });
  const pglite = inMemory ? new PGlite() : new PGlite(dataDir);
  await pglite.waitReady;
  // PGlite is single-connection: serialize transactions so concurrent async
  // callers cannot interleave statements inside another caller's transaction.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const parseRows = <T>(rows: unknown[]): T[] => rows.map((r) => fixBigints(r)) as T[];
  const db: Db = {
    driver: "pglite",
    query<T>(sql: string, params?: unknown[]) {
      return serialize(async () => parseRows<T>((await pglite.query(sql, normalizeParams(params))).rows));
    },
    one<T>(sql: string, params?: unknown[]) {
      return serialize(async () => parseRows<T>((await pglite.query(sql, normalizeParams(params))).rows)[0]);
    },
    transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      return serialize(() =>
        pglite.transaction(async (tx) =>
          fn({
            async query<R>(sql: string, params?: unknown[]) {
              return parseRows<R>((await tx.query(sql, normalizeParams(params))).rows);
            },
          }),
        ),
      );
    },
    exec(sql: string) {
      return serialize(async () => {
        await pglite.exec(sql);
      });
    },
    async close() {
      await serialize(() => pglite.close());
    },
  };
  return db;
}

function fixBigints(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const out = row as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (typeof v === "bigint") out[k] = Number(v);
  return out;
}

export async function createDb(config: Pick<AppConfig, "databaseUrl" | "pgliteDataDir">): Promise<Db> {
  return config.databaseUrl ? createPgDb(config.databaseUrl) : createPgliteDb(config.pgliteDataDir);
}
