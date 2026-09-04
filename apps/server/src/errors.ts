// Defines Aurora's domain errors and maps them to HTTP responses for Fastify error handling.
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

export class DomainError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const notFound = (what: string): DomainError =>
  new DomainError(
    404,
    "not_found",
    `${what} was not found in this owner scope`,
  );

export const forbidden = (what: string): DomainError =>
  new DomainError(403, "forbidden", `${what} is outside this owner scope`);

export const conflict = (message: string): DomainError =>
  new DomainError(409, "conflict", message);

export const invalid = (message: string): DomainError =>
  new DomainError(422, "invalid", message);

export const unauthorized = (
  message = "A valid session is required",
): DomainError => new DomainError(401, "unauthorized", message);

export const payloadTooLarge = (message: string): DomainError =>
  new DomainError(413, "payload_too_large", message);

function toErrorPayload(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof DomainError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof ZodError) {
    const issues = error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return {
      status: 422,
      code: "invalid",
      message: `Invalid request payload: ${issues}`,
    };
  }
  return {
    status: 500,
    code: "internal_error",
    message: "Aurora server internal error",
  };
}

export function registerErrorHandler(
  app: FastifyInstance,
  options: { spaIndexFile?: string } = {},
): void {
  app.setErrorHandler((error, _request, reply) => {
    const payload = toErrorPayload(error);
    if (payload.status >= 500) {
      app.log.error(error, "Aurora server request failed");
    }
    return reply.status(payload.status).send({
      error: { code: payload.code, message: payload.message },
    });
  });
  // Without a hosted web build every unknown path is a JSON 404; with one, unknown
  // non-API paths fall back to the SPA index so client-side routing works.
  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? "";
    const isPrivateRoute = url.startsWith("/api") || url.startsWith("/sync/ws");
    if (!isPrivateRoute && options.spaIndexFile) {
      return reply
        .status(200)
        .type("text/html")
        .send(createReadStream(options.spaIndexFile));
    }
    return reply.status(404).send({
      error: { code: "not_found", message: "Aurora server route not found" },
    });
  });
}
