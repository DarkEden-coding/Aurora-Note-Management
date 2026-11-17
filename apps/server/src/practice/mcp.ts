// Mounts the practice MCP server at /mcp (stateless Streamable HTTP, JSON responses). Like every route it is tailnet-only and behind the app-wide origin guard.
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

export function registerPracticeMcpRoute(
  app: FastifyInstance,
  env: AuroraEnv,
): void {
  app.post("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
    const server = buildPracticeMcpServer(env.AURORA_ORIGIN);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
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
