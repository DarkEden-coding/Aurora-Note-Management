// Applies apps/server/src/db/migrations/*.sql in order exactly once and reports migration status.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getPool } from "./pool.js";

const DEFAULT_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export function listMigrationFiles(
  dir: string = DEFAULT_MIGRATIONS_DIR,
): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export async function runMigrations(
  pool: pg.Pool,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS aurora_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await client.query<{ name: string }>(
      "SELECT name FROM aurora_migrations",
    );
    const appliedNames = new Set(applied.rows.map((row) => row.name));
    const appliedNow: string[] = [];
    for (const name of listMigrationFiles(dir)) {
      if (appliedNames.has(name)) continue;
      const sql = fs.readFileSync(path.join(dir, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO aurora_migrations (name) VALUES ($1)", [
          name,
        ]);
        await client.query("COMMIT");
        appliedNow.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Aurora migration ${name} failed: ${String(error)}`);
      }
    }
    return appliedNow;
  } finally {
    client.release();
  }
}

export async function migrationStatus(
  pool: pg.Pool,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<{ name: string; applied: boolean }[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS aurora_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const applied = await pool.query<{ name: string }>(
    "SELECT name FROM aurora_migrations",
  );
  const appliedNames = new Set(applied.rows.map((row) => row.name));
  return listMigrationFiles(dir).map((name) => ({
    name,
    applied: appliedNames.has(name),
  }));
}

async function main(): Promise<void> {
  const pool = getPool();
  try {
    const appliedNow = await runMigrations(pool);
    if (appliedNow.length === 0) {
      console.log("Aurora migrations: nothing to apply");
    } else {
      console.log(`Aurora migrations applied: ${appliedNow.join(", ")}`);
    }
  } finally {
    await pool.end();
  }
}

// Run directly: apply pending migrations and exit non-zero on failure.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
