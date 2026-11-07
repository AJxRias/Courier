import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// bigint columns (seq) come back as strings by default; they fit in a JS number
// for any realistic conversation length, so parse them as numbers.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;

export function createPool(url: string, max = 20): Db {
  return new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000 });
}

function migrationsDir(): string {
  // Works from src/ (tsx) and from dist/ (bundled) alike.
  const here = dirname(fileURLToPath(import.meta.url));
  return process.env.MIGRATIONS_DIR ?? join(here, "..", "migrations");
}

/** Applies any migrations not yet recorded, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  const client = await db.connect();
  try {
    // Serialize concurrent migrators (e.g. several gateways booting at once).
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(migrationsDir())).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(migrationsDir(), file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
}
