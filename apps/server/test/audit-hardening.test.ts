// Focused source/pure regressions for database guarantees that have no PostgreSQL test harness yet.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { FILE_REFERENCE_PREDICATE } from "../src/jobs/cleanup.js";
import { downloadDisposition } from "../src/files/routes.js";
import { localFileIdFromPayload } from "../src/canvas/objects.js";
import { nextRestoredObjectRevision } from "../src/history/snapshots.js";

function source(relativePath: string): string {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("upload hardening", () => {
  it("preserves explicit and current URL-only canvas file references", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(FILE_REFERENCE_PREDICATE).toContain("payload ->> 'fileId'");
    expect(FILE_REFERENCE_PREDICATE).toContain("payload ->> 'src'");
    expect(FILE_REFERENCE_PREDICATE).toContain("/api/files/");
    const cleanupSource = source("../src/jobs/cleanup.ts");
    expect(cleanupSource).toContain("FROM snapshots s");
    expect(cleanupSource).toContain("FROM conflicts c");
    expect(localFileIdFromPayload({ fileId: id })).toBe(id);
    expect(localFileIdFromPayload({ src: `/api/files/${id}?download=1` })).toBe(
      id,
    );
    expect(
      localFileIdFromPayload({ src: "https://example.test/image.png" }),
    ).toBeNull();
  });

  it("never serves SVG inline", () => {
    expect(downloadDisposition("image/svg+xml")).toBe("attachment");
    expect(downloadDisposition("IMAGE/SVG+XML; charset=utf-8")).toBe(
      "attachment",
    );
    expect(downloadDisposition("image/png")).toBe("inline");
    expect(downloadDisposition("application/pdf")).toBe("inline");
  });
});

describe("SQL concurrency and ownership guards", () => {
  it("guards canvas conflict updates by owner", () => {
    expect(source("../src/canvas/objects.ts")).toContain(
      "WHERE canvas_objects.owner_id = EXCLUDED.owner_id",
    );
  });

  it("locks bootstrap creation and the complete migration run", () => {
    expect(source("../src/auth/bootstrap.ts")).toContain(
      "pg_advisory_xact_lock",
    );
    const migrations = source("../src/db/migrate.ts");
    expect(migrations.indexOf("pg_advisory_lock")).toBeLessThan(
      migrations.indexOf("CREATE TABLE IF NOT EXISTS aurora_migrations"),
    );
    expect(migrations).toContain("pg_advisory_unlock");
  });
});

describe("recovery contract corrections", () => {
  it("restores note metadata, pages, and objects in the transaction", () => {
    const snapshots = source("../src/history/snapshots.ts");
    expect(snapshots).toContain("UPDATE notes SET");
    expect(snapshots).toContain("DELETE FROM pages");
    expect(snapshots).toContain("INSERT INTO pages");
    expect(snapshots).toContain("pdf_file_id = $12");
    expect(nextRestoredObjectRevision(undefined, 12)).toBe(13);
    expect(nextRestoredObjectRevision(20, 12)).toBe(21);
  });

  it("offers an explicitly metadata-only repeatable-read export", () => {
    const exportSource = source("../src/backup/export.ts");
    expect(exportSource).toContain(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(exportSource).toContain("recoverableBackup: false");
    expect(exportSource).toContain('app.get("/api/export"');
    expect(exportSource).not.toContain('app.get("/api/backup"');
    expect(exportSource).toContain('type: "note-link"');
    expect(exportSource).toContain('type: "snapshot"');
  });
});
