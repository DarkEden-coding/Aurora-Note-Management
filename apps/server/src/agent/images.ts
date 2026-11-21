// Pictures an agent puts into notes: decodes base64 PNG/JPEG/WebP/GIF/SVG, rasterizes SVG to PNG so every renderer (web, Android, server page images) can draw it, and stores the bytes as an ordinary upload.
import { Readable } from "node:stream";
import { Resvg } from "@resvg/resvg-js";
import { invalid, payloadTooLarge } from "../errors.js";
import { streamUploadToDisk, upsertFileMetadata } from "../files/store.js";

export const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024;
// Base64 is 4/3 of the bytes; allow a data: URL prefix on top.
export const MAX_AGENT_IMAGE_BASE64 =
  Math.ceil((MAX_AGENT_IMAGE_BYTES * 4) / 3) + 100;
// SVGs are drawn at twice their placed width (crisp when zoomed), capped at this many pixels.
const SVG_MAX_PIXELS = 2048;

export type DecodedImage = { bytes: Buffer; mimeType: string };

/** The image type from the file's first bytes; null for anything else. */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) {
    return "image/jpeg";
  }
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString("latin1"))) {
    return "image/gif";
  }
  const head = bytes.subarray(0, 1024).toString("utf8").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) {
    return "image/svg+xml";
  }
  return null;
}

/**
 * SVG as PNG. Only in-document (#id) links and embedded raster data: images are allowed, so
 * nothing outside the SVG is read (resvg would otherwise load file paths).
 */
export function rasterizeSvg(svg: string, widthPx: number): Buffer {
  const external =
    /\b(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/(?:png|jpe?g|gif|webp)[;,])/i;
  if (external.test(svg)) {
    throw invalid(
      "SVG images may only link to #ids and data: PNG/JPEG/GIF/WebP images",
    );
  }
  try {
    const image = new Resvg(svg, {
      fitTo: {
        mode: "width",
        value: Math.min(SVG_MAX_PIXELS, Math.max(1, Math.round(widthPx))),
      },
      font: { loadSystemFonts: true, fontDirs: ["/usr/share/fonts"] },
      logLevel: "off",
    }).render();
    return image.asPng();
  } catch {
    throw invalid("The SVG could not be read");
  }
}

/**
 * Decodes base64 (optionally a data: URL) into a stored-ready image. SVG becomes a PNG drawn
 * for `widthUnits` page units.
 */
export function decodeAgentImage(
  data: string,
  widthUnits: number,
): DecodedImage {
  const base64 = data.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (base64.length > MAX_AGENT_IMAGE_BASE64) {
    throw payloadTooLarge(
      `Images are limited to ${MAX_AGENT_IMAGE_BYTES / 1024 / 1024} MB`,
    );
  }
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(base64)) {
    throw invalid("Image data must be base64");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_AGENT_IMAGE_BYTES) {
    throw payloadTooLarge(
      `Images are limited to ${MAX_AGENT_IMAGE_BYTES / 1024 / 1024} MB`,
    );
  }
  const mimeType = sniffImageType(bytes);
  if (!mimeType) {
    throw invalid("Image data is not a PNG, JPEG, WebP, GIF or SVG image");
  }
  if (mimeType !== "image/svg+xml") return { bytes, mimeType };
  return {
    bytes: rasterizeSvg(bytes.toString("utf8"), widthUnits * 2),
    mimeType: "image/png",
  };
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Stores the image as an upload of the owner (deduplicated by content) and returns its file id. */
export async function storeAgentImage(
  ownerId: string,
  uploadDir: string,
  image: DecodedImage,
): Promise<string> {
  const upload = await streamUploadToDisk(
    {
      AURORA_UPLOAD_DIR: uploadDir,
      AURORA_MAX_UPLOAD_BYTES: image.bytes.length,
    },
    Readable.from([image.bytes]),
  );
  const file = await upsertFileMetadata(
    ownerId,
    {
      ...upload,
      mimeType: image.mimeType,
      originalName: `agent-image.${EXTENSIONS[image.mimeType] ?? "png"}`,
    },
    uploadDir,
  );
  return file.id;
}
