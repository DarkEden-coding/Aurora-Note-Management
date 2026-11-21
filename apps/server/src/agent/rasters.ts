// Raster content for agent page images: uploaded images and imported PDF pages (via poppler's pdftoppm), as data URIs by object id.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CanvasObject } from "@aurora/shared";
import { query } from "../db/pool.js";
import { localFileIdFromPayload } from "../canvas/objects.js";
import { absoluteFilePath } from "../files/store.js";

const run = promisify(execFile);
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const PDF_TIMEOUT_MS = 20_000;

/** One PDF page as PNG at the given pixel width; null when pdftoppm is missing or fails. */
export async function pdfPagePng(
  file: string,
  pageNumber: number,
  widthPx: number,
): Promise<Buffer | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aurora-pdf-"));
  try {
    const out = path.join(dir, "page");
    await run(
      "pdftoppm",
      [
        "-f",
        `${pageNumber}`,
        "-l",
        `${pageNumber}`,
        "-png",
        "-singlefile",
        "-scale-to-x",
        `${Math.round(widthPx)}`,
        "-scale-to-y",
        "-1",
        file,
        out,
      ],
      { timeout: PDF_TIMEOUT_MS },
    );
    return await fs.readFile(`${out}.png`);
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Data URIs for the image and pdf-page-reference objects in `objects`, rendered at `scale`
 * pixels per page unit. Objects whose file is missing or unreadable are left out (drawn as boxes).
 */
export async function objectRasters(
  ownerId: string,
  objects: CanvasObject[],
  uploadDir: string,
  scale: number,
): Promise<Map<string, string>> {
  const rasters = new Map<string, string>();
  const wanted = objects
    .filter((o) => o.kind === "image" || o.kind === "pdf-page-reference")
    .map((object) => ({
      object,
      fileId: localFileIdFromPayload(object.payload),
    }))
    .filter(
      (item): item is { object: CanvasObject; fileId: string } =>
        item.fileId !== null,
    );
  if (wanted.length === 0) return rasters;
  const files = await query<{ id: string; sha256: string; mime_type: string }>(
    "SELECT id, sha256, mime_type FROM files WHERE owner_id = $1 AND id = ANY($2)",
    [ownerId, wanted.map((item) => item.fileId)],
  );
  const byId = new Map(files.rows.map((row) => [row.id, row]));
  for (const { object, fileId } of wanted) {
    const file = byId.get(fileId);
    if (!file) continue;
    const filePath = absoluteFilePath(uploadDir, file.sha256);
    let bytes: Buffer | null = null;
    let mime = "image/png";
    if (
      object.kind === "pdf-page-reference" &&
      file.mime_type === "application/pdf"
    ) {
      const pageNumber = Number(object.payload.pageNumber);
      if (Number.isInteger(pageNumber) && pageNumber > 0) {
        bytes = await pdfPagePng(
          filePath,
          pageNumber,
          object.bounds.width * scale,
        );
      }
    } else if (object.kind === "image" && IMAGE_TYPES.has(file.mime_type)) {
      bytes = await fs.readFile(filePath).catch(() => null);
      mime = file.mime_type;
    }
    if (bytes)
      rasters.set(object.id, `data:${mime};base64,${bytes.toString("base64")}`);
  }
  return rasters;
}
