/**
 * In-process MCP server (Streamable HTTP) hosted by the pi-mail daemon.
 * Extracted from http.mjs. The daemon serves POST /mcp via the MCP
 * Streamable HTTP transport, backed by an IN-PROCESS board backend that calls
 * the daemon's own board functions directly (no HTTP loopback, no second
 * process). It reuses the same createBoardMcpServer() the standalone stdio
 * bridge (mcp/index.js) builds, so the tool surface is identical. The SDK +
 * compiled board-mcp.js are imported lazily so the daemon keeps working if the
 * MCP build or its npm deps are absent (graceful 503 on /mcp in that case).
 *
 * Stateless mode: a fresh McpServer + transport per request (the stateless
 * Streamable HTTP transport is single-use — see SDK docs). Method dispatch
 * (POST = JSON-RPC, GET = standalone SSE stream, DELETE = session close,
 * anything else = 405 with Allow: GET, POST, DELETE) is delegated to the SDK
 * transport, so the daemon does not gate on method itself. Board operations
 * run as the human agent, same as the web UI and the socket protocol's board_*
 * cases.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardState, board, jiraCfg } from "./board.mjs";
import {
  boardMove,
  boardAssign,
  boardComment,
  boardProgress,
  boardCreate,
  boardUpdate,
  boardFlag,
  boardSetConfig,
} from "./board-ops.mjs";
import { syncBoard } from "./jira.mjs";

const HUMAN_AGENT_ID = "00000000-0000-0000-0000-000000000000";

const MCP_BUILD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "mcp", "build", "board-mcp.js",
);

/**
 * In-process board backend for the hosted MCP server. Each method calls the
 * daemon's board functions directly and returns the SAME response shape the
 * daemon's /api/board* HTTP endpoints return, so the MCP tool formatters
 * (which expect those shapes) work unchanged.
 */
const inProcessBoardBackend = {
  async getBoard(opts) {
    return boardState(HUMAN_AGENT_ID, opts);
  },
  async getBoardConfig() {
    return {
      config: {
        baseUrl: board.config.baseUrl,
        email: board.config.email,
        jql: board.config.jql,
        projectKey: board.config.projectKey,
        issueType: board.config.issueType,
        subtaskIssueType: board.config.subtaskIssueType,
        apiTokenSet: !!board.config.apiToken,
        nudgeEnabled: board.config.nudgeEnabled !== false,
        nudgeIntervalMin: board.config.nudgeIntervalMin ?? 30,
        mmEnabled: board.config.mmEnabled === true,
        mmIntervalMin: board.config.mmIntervalMin ?? 30,
        mmModel: board.config.mmModel ?? "",
        mmMaxLifetimeMin: board.config.mmMaxLifetimeMin ?? 15,
        workerMaxLifetimeMin: board.config.workerMaxLifetimeMin ?? 30,
        ceoEnabled: board.config.ceoEnabled === true,
        ceoIntervalMin: board.config.ceoIntervalMin ?? 120,
        ceoModel: board.config.ceoModel ?? "",
        ceoMaxLifetimeMin: board.config.ceoMaxLifetimeMin ?? 15,
      },
      columns: board.columns,
    };
  },
  async setBoardConfig(config) {
    // The MCP tool passes a config record; boardSetConfig expects {config, columns}.
    return boardSetConfig({ config });
  },
  async syncBoard() {
    if (!jiraCfg()) return { ok: false, error: "Jira is not configured" };
    await syncBoard("manual");
    return { ok: !board.syncError, error: board.syncError ?? undefined };
  },
  async moveTask(taskId, column, note) {
    const r = await boardMove(HUMAN_AGENT_ID, taskId, column, note);
    return r.error ? { ok: false, error: r.error } : { ok: true, warning: r.warning };
  },
  async commentTask(taskId, text) {
    const r = await boardComment(HUMAN_AGENT_ID, taskId, text);
    return r.error ? { ok: false, error: r.error } : { ok: true, warning: r.warning };
  },
  async progressTask(taskId, text) {
    const r = await boardProgress(HUMAN_AGENT_ID, taskId, text);
    return r.error ? { ok: false, error: r.error } : { ok: true };
  },
  async assignTask(taskId, assignee, newSession) {
    const r = boardAssign(HUMAN_AGENT_ID, taskId, assignee, !!newSession);
    return r.error ? { ok: false, error: r.error } : { ok: true, warning: r.warning };
  },
  async createTask(body) {
    const r = await boardCreate(HUMAN_AGENT_ID, body);
    return r.error
      ? { ok: false, error: r.error }
      : { ok: true, taskId: r.task.id, key: r.task.key ?? undefined };
  },
  async updateTask(taskId, body) {
    const r = await boardUpdate(HUMAN_AGENT_ID, taskId, body);
    return r.error ? { ok: false, error: r.error } : { ok: true, warning: r.warning };
  },
  async flagTask(taskId, reason, clear) {
    const r = boardFlag(HUMAN_AGENT_ID, taskId, reason, !!clear);
    return r.error ? { ok: false, error: r.error } : { ok: true, warning: r.warning };
  },
};

let mcpDepsPromise = null;
/** Lazily import the MCP SDK + compiled board-mcp.js (cached). Throws if the
 *  build or deps are unavailable. */
async function ensureMcp() {
  if (mcpDepsPromise) return mcpDepsPromise;
  mcpDepsPromise = (async () => {
    const [{ McpServer }, { StreamableHTTPServerTransport }, mod] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
      import(MCP_BUILD_PATH),
    ]);
    return { McpServer, StreamableHTTPServerTransport, createBoardMcpServer: mod.createBoardMcpServer };
  })().catch((e) => {
    mcpDepsPromise = null; // allow retry on transient failure
    throw e;
  });
  return mcpDepsPromise;
}

/** JSON-RPC error response (used by the MCP /mcp route). */
function jsonRpcError(res, httpStatus, code, message) {
  if (res.headersSent) return;
  res.writeHead(httpStatus, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** Handle a /mcp request (any method — POST/GET/DELETE/…) using the in-process
 *  backend. Stateless: a fresh McpServer + transport per request. `parsedBody`
 *  is only meaningful for POST (pre-parsed by the caller to enforce the size
 *  guard); pass undefined for non-POST. */
export async function handleMcpRequest(req, res, parsedBody) {
  let deps;
  try {
    deps = await ensureMcp();
  } catch (e) {
    jsonRpcError(res, 503, -32603, `MCP server unavailable: ${e?.message ?? String(e)}`);
    return;
  }
  const server = deps.createBoardMcpServer(inProcessBoardBackend);
  const transport = new deps.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (e) {
    if (!res.headersSent) jsonRpcError(res, 500, -32603, `Internal error: ${e?.message ?? String(e)}`);
  }
}

export { jsonRpcError };
