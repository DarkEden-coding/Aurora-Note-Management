// Retention job: removes expired records and safely reclaims unreferenced upload bytes.
import { fileURLToPath } from "node:url";
import type { AuroraEnv } from "../env.js";
import { getPool, query } from "../db/pool.js";
import { deleteFileBytes } from "../files/store.js";

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

// This predicate supports both the newer explicit fileId payload and the URL-only
// image payload currently written by the web client. Query strings/fragments and
// absolute same-origin URLs are accepted because their path still ends in the ID.
export const FILE_REFERENCE_PREDICATE = `
  o.owner_id = f.owner_id
  AND (
    o.payload ->> 'fileId' = f.id::text
    OR split_part(
         split_part(COALESCE(o.payload ->> 'src', ''), '#', 1),
         '?', 1
       ) LIKE '%/api/files/' || f.id::text
  )
`;

const SNAPSHOT_FILE_REFERENCE_PREDICATE = `
  s.owner_id = f.owner_id
  AND (
    s.payload -> 'note' ->> 'pdfFileId' = f.id::text
    OR snapshot_object -> 'payload' ->> 'fileId' = f.id::text
    OR split_part(
         split_part(
           COALESCE(snapshot_object -> 'payload' ->> 'src', ''), '#', 1
         ), '?', 1
       ) LIKE '%/api/files/' || f.id::text
  )
`;

const CONFLICT_FILE_REFERENCE_PREDICATE = `
  c.owner_id = f.owner_id
  AND c.resolved_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM unnest(ARRAY[c.base_object, c.incoming_object]) conflict_object
    WHERE conflict_object -> 'payload' ->> 'fileId' = f.id::text
       OR split_part(
            split_part(
              COALESCE(conflict_object -> 'payload' ->> 'src', ''), '#', 1
            ), '?', 1
          ) LIKE '%/api/files/' || f.id::text
  )
`;

// Digest advisory locks are shared with metadata publication. They prevent a new
// metadata row for identical bytes from appearing between the final DB check and
// unlinking the content-addressed file.
export async function cleanupUnreferencedFiles(
  uploadDir: string,
): Promise<{ removed: string[]; bytesRemoved: string[] }> {
  const client = await getPool().connect();
  const lockedDigests: string[] = [];
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const candidates = await client.query<{ id: string; sha256: string }>(
      `SELECT f.id, f.sha256
       FROM files f
       WHERE NOT EXISTS (
         SELECT 1 FROM canvas_objects o WHERE ${FILE_REFERENCE_PREDICATE}
       )
         AND NOT EXISTS (
           SELECT 1 FROM notes n
           WHERE n.owner_id = f.owner_id AND n.pdf_file_id = f.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM snapshots s
           LEFT JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(s.payload -> 'objects') = 'array'
               THEN s.payload -> 'objects' ELSE '[]'::jsonb END
           ) snapshot_object ON true
           WHERE ${SNAPSHOT_FILE_REFERENCE_PREDICATE}
         )
         AND NOT EXISTS (
           SELECT 1 FROM conflicts c
           WHERE ${CONFLICT_FILE_REFERENCE_PREDICATE}
         )
       ORDER BY f.sha256, f.id`,
    );

    // Session locks deliberately survive COMMIT until byte removal completes.
    for (const digest of [
      ...new Set(candidates.rows.map((row) => row.sha256)),
    ]) {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 1096110671))",
        [digest],
      );
      lockedDigests.push(digest);
    }

    const ids = candidates.rows.map((row) => row.id);
    const removed =
      ids.length === 0
        ? { rows: [] as { id: string; sha256: string }[] }
        : await client.query<{ id: string; sha256: string }>(
            `DELETE FROM files f
             WHERE f.id = ANY($1::uuid[])
               AND NOT EXISTS (
                 SELECT 1 FROM canvas_objects o WHERE ${FILE_REFERENCE_PREDICATE}
               )
               AND NOT EXISTS (
                 SELECT 1 FROM notes n
                 WHERE n.owner_id = f.owner_id AND n.pdf_file_id = f.id
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM snapshots s
                 LEFT JOIN LATERAL jsonb_array_elements(
                   CASE WHEN jsonb_typeof(s.payload -> 'objects') = 'array'
                     THEN s.payload -> 'objects' ELSE '[]'::jsonb END
                 ) snapshot_object ON true
                 WHERE ${SNAPSHOT_FILE_REFERENCE_PREDICATE}
               )
               AND NOT EXISTS (
                 SELECT 1 FROM conflicts c
                 WHERE ${CONFLICT_FILE_REFERENCE_PREDICATE}
               )
             RETURNING f.id, f.sha256`,
            [ids],
          );
    await client.query("COMMIT");
    inTransaction = false;

    const bytesRemoved: string[] = [];
    for (const digest of [...new Set(removed.rows.map((row) => row.sha256))]) {
      const stillReferenced = await client.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM files WHERE sha256 = $1) AS exists",
        [digest],
      );
      if (!stillReferenced.rows[0]?.exists) {
        try {
          await deleteFileBytes({ AURORA_UPLOAD_DIR: uploadDir }, digest);
          bytesRemoved.push(digest);
        } catch {
          // Metadata is already gone and no live row references these bytes. A
          // later cleanup can retry; never report an unlink that did not happen.
        }
      }
    }
    return {
      removed: removed.rows.map((row) => row.id),
      bytesRemoved,
    };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK");
    throw error;
  } finally {
    try {
      for (const digest of lockedDigests.reverse()) {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 1096110671))",
          [digest],
        );
      }
    } finally {
      client.release();
    }
  }
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
