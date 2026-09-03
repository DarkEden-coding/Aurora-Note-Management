// Retention job: removes expired records while leaving content-addressed bytes untouched to prevent upload cleanup races.
import { fileURLToPath } from "node:url";
import type { AuroraEnv } from "../env.js";
import { query } from "../db/pool.js";

export async function cleanupExpiredTrash(
  retentionDays: number,
): Promise<number> {
  const result = await query<{ id: string }>(
    `DELETE FROM notes
     WHERE trashed_at IS NOT NULL AND trashed_at < now() - ($1 || ' days')::interval
     RETURNING id`,
    [String(retentionDays)],
  );
  return result.rows.length;
}

export async function cleanupSessions(retentionDays: number): Promise<number> {
  const result = await query<{ id: string }>(
    `DELETE FROM sessions
     WHERE expires_at < now()
        OR revoked_at < now() - ($1 || ' days')::interval
     RETURNING id`,
    [String(retentionDays)],
  );
  await query(
    "DELETE FROM auth_challenges WHERE expires_at < now() OR consumed_at IS NOT NULL",
  );
  return result.rows.length;
}

export async function cleanupOperations(
  retentionDays: number,
): Promise<number> {
  const result = await query<{ id: string }>(
    `DELETE FROM operations
     WHERE created_at < now() - ($1 || ' days')::interval
     RETURNING id`,
    [String(retentionDays)],
  );
  return result.rows.length;
}

export async function cleanupSnapshots(retentionDays: number): Promise<number> {
  const result = await query<{ id: string }>(
    `DELETE FROM snapshots
     WHERE created_at < now() - ($1 || ' days')::interval
     RETURNING id`,
    [String(retentionDays)],
  );
  return result.rows.length;
}

// Files become unreferenced when no object payload and no pdf note points at them.
export async function cleanupUnreferencedFiles(
  _uploadDir: string,
): Promise<{ removed: string[]; bytesRemoved: string[] }> {
  const removed = await query<{ id: string; sha256: string }>(
    `DELETE FROM files f
     WHERE NOT EXISTS (
       SELECT 1 FROM canvas_objects o
       WHERE o.owner_id = f.owner_id AND o.payload ->> 'fileId' = f.id::text
     )
       AND NOT EXISTS (
       SELECT 1 FROM notes n
       WHERE n.pdf_file_id = f.id
     )
     RETURNING id, sha256`,
  );
  // ponytail: orphaned bytes may grow with repeated deleted uploads; add a
  // digest advisory lock shared by upload publication and cleanup before
  // deleting bytes automatically.
  return { removed: removed.rows.map((row) => row.id), bytesRemoved: [] };
}

export type CleanupReport = {
  trashRemoved: number;
  sessionsRemoved: number;
  operationsRemoved: number;
  snapshotsRemoved: number;
  filesRemoved: number;
  bytesRemoved: number;
};

export async function runCleanup(env: AuroraEnv): Promise<CleanupReport> {
  const trashRemoved = await cleanupExpiredTrash(
    env.AURORA_TRASH_RETENTION_DAYS,
  );
  const sessionsRemoved = await cleanupSessions(
    env.AURORA_SESSION_RETENTION_DAYS,
  );
  const operationsRemoved = await cleanupOperations(
    env.AURORA_OPERATION_RETENTION_DAYS,
  );
  const snapshotsRemoved = await cleanupSnapshots(
    env.AURORA_SNAPSHOT_RETENTION_DAYS,
  );
  const { removed, bytesRemoved } = await cleanupUnreferencedFiles(
    env.AURORA_UPLOAD_DIR,
  );
  return {
    trashRemoved,
    sessionsRemoved,
    operationsRemoved,
    snapshotsRemoved,
    filesRemoved: removed.length,
    bytesRemoved: bytesRemoved.length,
  };
}

// Standalone entry point: run the retention cleanup once and print a summary.
export async function main(): Promise<void> {
  const { loadEnv } = await import("../env.js");
  const report = await runCleanup(loadEnv());
  console.log(
    `Aurora cleanup: trash=${report.trashRemoved} sessions=${report.sessionsRemoved} operations=${report.operationsRemoved} snapshots=${report.snapshotsRemoved} files=${report.filesRemoved} bytes=${report.bytesRemoved}`,
  );
}

// Run directly: execute cleanup and exit non-zero on failure.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
