// Owns the PostgreSQL connection pool and exposes query/transaction helpers to server modules.
import pg from "pg";

let pool: pg.Pool | null = null;

function resolveConnectionString(connectionString?: string): string {
  const value = connectionString ?? process.env.DATABASE_URL;
  if (!value) {
    throw new Error("Aurora server is missing DATABASE_URL configuration");
  }
  return value;
}

export function getPool(connectionString?: string): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: resolveConnectionString(connectionString),
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export async function query<T extends pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(sql, params);
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end();
  }
}
