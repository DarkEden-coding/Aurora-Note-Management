// Routes upload streaming and safe, ownership-checked downloads; multipart only, no JSON bodies.
import type { FastifyInstance, FastifyReply, FastifyError } from "fastify";
import { z } from "zod";
import type { AuroraEnv } from "../env.js";
import { invalid, payloadTooLarge } from "../errors.js";
import { requireSessionPreHandler } from "../auth/sessions.js";
import {
  createDownloadStream,
  listFiles,
  openDownload,
  sanitizeFilename,
  sanitizeMimeType,
  streamUploadToDisk,
  upsertFileMetadata,
} from "./store.js";

const FST_MP_FILE_SIZE_LIMIT = "FST_MP_FILE_SIZE_LIMIT";
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const idParamSchema = z.object({ id: z.string().uuid() });

export function downloadDisposition(mimeType: string): "inline" | "attachment" {
  const normalized = mimeType.trim().toLowerCase().split(";", 1)[0];
  if (normalized === "image/svg+xml") return "attachment";
  return normalized?.startsWith("image/") || normalized === "application/pdf"
    ? "inline"
    : "attachment";
}

export function registerFileRoutes(app: FastifyInstance, env: AuroraEnv): void {
  const preHandler = requireSessionPreHandler(env);

  app.post(
    "/api/files",
    { preHandler },
    async (request, reply: FastifyReply) => {
      const data = await request.file();
      if (!data) {
        throw invalid(
          "Upload requires a multipart/form-data body with one file field",
        );
      }
      const originalName = sanitizeFilename(data.filename ?? "file");
      const mimeType = sanitizeMimeType(
        data.mimetype ?? "application/octet-stream",
      );
      let upload;
      try {
        upload = await streamUploadToDisk(env, data.file);
      } catch (error) {
        if ((error as FastifyError)?.code === FST_MP_FILE_SIZE_LIMIT) {
          throw payloadTooLarge("Upload exceeds AURORA_MAX_UPLOAD_BYTES");
        }
        throw error;
      }
      const metadata = await upsertFileMetadata(
        request.ownerId!,
        {
          digest: upload.digest,
          size: upload.size,
          mimeType,
          originalName,
        },
        env.AURORA_UPLOAD_DIR,
      );
      return reply.status(201).send({ file: metadata });
    },
  );

  app.get("/api/files", { preHandler }, async (request) => {
    const { limit } = listQuerySchema.parse(request.query);
    return { files: await listFiles(request.ownerId!, limit) };
  });

  // Downloads default to attachment disposition; inline only for renderable types, always nosniff.
  app.get(
    "/api/files/:id",
    { preHandler },
    async (request, reply: FastifyReply) => {
      const { id } = idParamSchema.parse(request.params);
      const target = await openDownload(env, request.ownerId!, id);
      const mimeType = target.metadata.mime_type;
      const disposition = downloadDisposition(mimeType);
      const filename = sanitizeFilename(target.metadata.original_name);
      const stream = createDownloadStream(target);
      return reply
        .status(200)
        .header("content-type", mimeType)
        .header("content-length", Number(target.metadata.size))
        .header("content-disposition", `${disposition}; filename="${filename}"`)
        .header("x-content-type-options", "nosniff")
        .header("cross-origin-resource-policy", "same-origin")
        .send(stream);
    },
  );
}
