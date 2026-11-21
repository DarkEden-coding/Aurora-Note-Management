// Mounts the practice MCP server at /mcp (stateless Streamable HTTP; JSON responses, or SSE when a request carries a progress token). Like every route it is tailnet-only and behind the app-wide origin guard.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuroraEnv } from "../env.js";
import { buildPracticeMcpServer } from "./mcp-tools.js";

function rpcError(reply: FastifyReply, status: number, message: string) {
  return reply.status(status).send({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

/** True when any JSON-RPC message in the body asks for progress (params._meta.progressToken). */
export function wantsProgress(body: unknown): boolean {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const params = (message as { params?: { _meta?: unknown } }).params;
    const meta = params?._meta;
    return (
      typeof meta === "object" &&
      meta !== null &&
      (meta as { progressToken?: unknown }).progressToken !== undefined
    );
  });
}

export function registerPracticeMcpRoute(
  app: FastifyInstance,
  env: AuroraEnv,
): void {
  app.post("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
    const server = buildPracticeMcpServer(
      env.AURORA_ORIGIN,
      env.AURORA_PRACTICE_WAIT_MAX_SECONDS,
      env.AURORA_UPLOAD_DIR,
    );
    // Plain JSON keeps simple clients working; a progress token switches this response to SSE
    // so practice_wait can stream keepalive progress notifications during a long wait.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: !wantsProgress(request.body),
    });
    reply.hijack();
    // Closing aborts in-flight tool calls, so a disconnected practice_wait stops waiting.
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error(error, "Practice MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  });

  // Stateless server: no SSE stream to open and no session to delete.
  const methodNotAllowed = async (
    _request: FastifyRequest,
    reply: FastifyReply,
  ) => rpcError(reply.header("allow", "POST"), 405, "Method not allowed");
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
}
