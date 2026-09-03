// Streams uploads to content-hashed disk paths and serves ownership-checked downloads safely.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { invalid, notFound, payloadTooLarge } from "../errors.js";
import { query } from "../db/pool.js";

// File metadata transport type; server-local until promoted into @aurora/shared contracts.
export type FileMetadata = {
  id: string;
  ownerId: string;
  sha256: string;
  size: number;
  mimeType: string;
  originalName: string;
  createdAt: string;
};

export const ALLOWED_MIME_PATTERN =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

export type AuroraFileEnv = {
  AURORA_UPLOAD_DIR: string;
  AURORA_MAX_UPLOAD_BYTES: number;
};

// Digests must be lowercase hex sha256; anything else is rejected before it can touch the filesystem.
export function digestToRelativePath(digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw invalid(`Invalid content digest: ${digest.slice(0, 128)}`);
  }
  return path.join(digest.slice(0, 2), digest.slice(2, 4), digest);
}

export function absoluteFilePath(uploadDir: string, digest: string): string {
  return path.join(uploadDir, digestToRelativePath(digest));
}

// Filenames are untrusted: strip control characters, quotes, and separators, then cap length.
export function sanitizeFilename(name: string): string {
  const stripped = name
    .replace(/[\x00-\x1f\x7f"\\]/g, "")
    .replace(/^\.+/, "")
    .trim();
  if (stripped.length === 0) return "file";
  return stripped.slice(0, 128);
}

export function sanitizeMimeType(mimeType: string): string {
  const candidate = mimeType.trim().toLowerCase();
  return ALLOWED_MIME_PATTERN.test(candidate)
    ? candidate
    : "application/octet-stream";
}

export type UploadResult = { digest: string; size: number };

// Hash while writing to a temp file in uploadDir/tmp; enforce the byte cap; rename into place.
export async function streamUploadToDisk(
  env: AuroraFileEnv,
  source: Readable,
): Promise<UploadResult> {
  await fs.promises.mkdir(path.join(env.AURORA_UPLOAD_DIR, "tmp"), {
    recursive: true,
  });
  const tmpPath = path.join(
    env.AURORA_UPLOAD_DIR,
    "tmp",
    `${crypto.randomUUID()}.part`,
  );
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(tmpPath, { flags: "wx" });
  let size = 0;
  try {
    for await (const chunk of source) {
      const buffer =
        typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      size += buffer.length;
      if (size > env.AURORA_MAX_UPLOAD_BYTES) {
        throw payloadTooLarge(
          `Upload exceeds AURORA_MAX_UPLOAD_BYTES (${env.AURORA_MAX_UPLOAD_BYTES})`,
        );
      }
      hash.update(buffer);
      if (!out.write(buffer)) {
        await once(out, "drain");
      }
    }
    out.end();
    await once(out, "finish");
    const digest = hash.digest("hex");
    const finalPath = absoluteFilePath(env.AURORA_UPLOAD_DIR, digest);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    // Content-addressed rename: identical bytes replace identical bytes harmlessly.
    await fs.promises.rename(tmpPath, finalPath);
    return { digest, size };
  } catch (error) {
    out.destroy();
    await fs.promises.rm(tmpPath, { force: true });
    throw error;
  }
}

export type FileRow = {
  id: string;
  owner_id: string;
  sha256: string;
  size: string | number;
  mime_type: string;
  original_name: string;
  created_at: Date;
};

export function mapFile(row: FileRow): FileMetadata {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sha256: row.sha256,
    size: Number(row.size),
    mimeType: row.mime_type,
    originalName: row.original_name,
    createdAt: row.created_at.toISOString(),
  };
}

const FILE_SELECT = `
  SELECT id, owner_id, sha256, size, mime_type, original_name, created_at
  FROM files
`;

// Upsert metadata by (owner_id, sha256); reuse the stored row when bytes already exist.
export async function upsertFileMetadata(
  ownerId: string,
  upload: {
    digest: string;
    size: number;
    mimeType: string;
    originalName: string;
  },
): Promise<FileMetadata> {
  const result = await query<FileRow>(
    `INSERT INTO files (owner_id, sha256, size, mime_type, original_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (owner_id, sha256) DO UPDATE SET original_name = EXCLUDED.original_name
     RETURNING id, owner_id, sha256, size, mime_type, original_name, created_at`,
    [ownerId, upload.digest, upload.size, upload.mimeType, upload.originalName],
  );
  return mapFile(result.rows[0]!);
}

export async function getFileMetadata(
  ownerId: string,
  fileId: string,
): Promise<FileRow> {
  const result = await query<FileRow>(
    `${FILE_SELECT} WHERE owner_id = $1 AND id = $2`,
    [ownerId, fileId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("File");
  return row;
}

export async function listFiles(
  ownerId: string,
  limit = 100,
): Promise<FileMetadata[]> {
  const result = await query<FileRow>(
    `${FILE_SELECT} WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [ownerId, limit],
  );
  return result.rows.map(mapFile);
}

export type DownloadTarget = { metadata: FileRow; absolutePath: string };

// Ownership check happens in SQL before any path is touched.
export async function openDownload(
  env: AuroraFileEnv,
  ownerId: string,
  fileId: string,
): Promise<DownloadTarget> {
  const metadata = await getFileMetadata(ownerId, fileId);
  return {
    metadata,
    absolutePath: absoluteFilePath(env.AURORA_UPLOAD_DIR, metadata.sha256),
  };
}

export function createDownloadStream(target: DownloadTarget): fs.ReadStream {
  return fs.createReadStream(target.absolutePath);
}

export async function deleteFileBytes(
  env: AuroraFileEnv,
  digest: string,
): Promise<void> {
  await fs.promises.rm(absoluteFilePath(env.AURORA_UPLOAD_DIR, digest), {
    force: true,
  });
}
