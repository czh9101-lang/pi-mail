#!/usr/bin/env node
/**
 * pi-mail board MCP server — HTTP (Streamable HTTP) entrypoint.
 *
 * Exposes the shared task board to MCP clients over the MCP Streamable
 * HTTP transport (POST /mcp). A thin shim over the mail daemon's
 * existing HTTP board API; all board logic / Jira sync stays in the
 * daemon. The tool names + parameter shapes mirror the in-pi board_*
 * agent tools.
 *
 * Stateless mode: a fresh McpServer + transport is built per request
 * (the stateless Streamable HTTP transport is single-use — see SDK
 * docs). No session id, no in-memory session state.
 *
 * Board operations run as the `human` agent (the daemon's HTTP API
 * attributes to HUMAN_AGENT_ID, same as the web UI).
 *
 * ## Run
 *
 *   node ./mcp/build/index.js                # HTTP on 127.0.0.1:8787
 *   PI_MAIL_MCP_PORT=9000 node ./mcp/build/index.js
 *
 * Daemon address: PI_MAIL_BASE_URL (default http://127.0.0.1:1994).
 * MCP listen addr: PI_MAIL_MCP_HOST / PI_MAIL_MCP_PORT (default
 * 127.0.0.1:8787). `GET /healthz` answers `{ok:true}`.
 *
 * ## Claude Desktop / remote MCP config
 *
 *   { "mcpServers": { "pi-mail-board": {
 *       "url": "http://127.0.0.1:8787/mcp"
 *   } } }
 *
 * (Pass `--stdio` as the first arg to fall back to the classic stdio
 * transport for local subprocess clients.)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBoardMcpServer } from "./board-mcp.js";

/** Read the JSON body of a Node IncomingMessage (null if empty / non-JSON). */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1 << 20) {
        // Cap at 1 MiB to avoid unbounded buffering.
        req.destroy();
        resolve(null);
      }
    });
    req.on("end", () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/** Send a JSON-RPC error response (used for transport-level rejections). */
function jsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(httpStatus, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** Run the server over the Streamable HTTP transport (stateless, per-request). */
async function runHttp(): Promise<void> {
  const host = process.env.PI_MAIL_MCP_HOST ?? "127.0.0.1";
  const port = Number(process.env.PI_MAIL_MCP_PORT ?? 8787);

  const httpServer = createServer(async (req, res) => {
    // Health probe for container/orchestration; answers before MCP handshake.
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: "pi-mail-board", transport: "http" }));
      return;
    }

    const path = req.url?.split("?")[0];
    if (path !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found", hint: "POST /mcp" }));
      return;
    }

    // Stateless mode supports POST only (no server-initiated SSE streams,
    // no session teardown).
    if (req.method !== "POST") {
      jsonRpcError(res, 405, -32000, `Method not allowed: ${req.method} (stateless server)`);
      return;
    }

    const body = await readBody(req);
    if (body === null) {
      jsonRpcError(res, 400, -32700, "Parse error: invalid or missing JSON body");
      return;
    }

    // A fresh server + transport per request — the stateless Streamable HTTP
    // transport is single-use (SDK invariants). Tools are cheap to register.
    const server = createBoardMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`pi-mail board MCP server (HTTP) listening on http://${host}:${port}/mcp`);
  });

  const stop = (sig: string) => {
    console.error(`pi-mail board MCP: received ${sig}, shutting down`);
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

/** Run the server over stdio (fallback for local subprocess clients). */
async function runStdio(): Promise<void> {
  const server = createBoardMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("pi-mail board MCP server running on stdio");
}

async function main(): Promise<void> {
  if (process.argv[2] === "--stdio") {
    await runStdio();
  } else {
    await runHttp();
  }
}

main().catch((err) => {
  console.error("pi-mail board MCP server error:", err);
  process.exit(1);
});

// Exported for potential reuse / testing.
export { McpServer };
