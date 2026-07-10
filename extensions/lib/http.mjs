/**
 * HTTP web UI + WebSocket terminal for the pi-mail daemon.
 * Extracted from daemon.mjs. Exposes createHttpServer({ uiHtml, uiPort, uiHost })
 * which builds the httpServer (REST routes + static UI + /api/spawn/terminal
 * WS upgrade) and returns it; the caller owns .listen(). Depends on core,
 * board, board-ops, jira, and spawn modules.
 */

import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  messageLog,
  HUMAN_AGENT_ID,
  HUMAN_AGENT_NAME,
  log,
  archiveHumanMessage,
  sendMail,
  broadcastMail,
  shellQuote,
  federationAgents,
} from "./core.mjs";
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
import { mmState } from "./middle-manager.mjs";
import { ceoState, ceoTick } from "./ceo.mjs";
import {
  spawnState,
  listSpawnDir,
  spawnAgent,
  stopAgent,
  spawnRegistry,
  safeSessionName,
  tmuxSessionExists,
  setFavorite,
  projectsState,
} from "./spawn.mjs";

/** Static UI assets served from the extension dir (loaded once at boot). */
const UI_ASSET_TYPES = {
  "/ui.css": "text/css; charset=utf-8",
  "/ui-core.js": "text/javascript; charset=utf-8",
  "/ui-board.js": "text/javascript; charset=utf-8",
  "/ui-app.js": "text/javascript; charset=utf-8",
};

// ── Federation snapshot (for the UI) ──────────────────────────────────────────

function federationState() {
  return {
    human: { agentId: HUMAN_AGENT_ID, agentName: HUMAN_AGENT_NAME },
    agents: federationAgents(),
    messages: messageLog,
    board: boardState(),
    spawn: spawnState(),
    now: Date.now(),
  };
}


// ── HTTP web UI ───────────────────────────────────────────────────────────────

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy(); // guard against huge bodies
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** JSON-RPC error response (used by the MCP /mcp route). */
function jsonRpcError(res, httpStatus, code, message) {
  if (res.headersSent) return;
  res.writeHead(httpStatus, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

// ── MCP server (hosted in-process — no separate process) ───────────────────────
//
// The daemon serves POST /mcp: the MCP Streamable HTTP transport, backed by
// an IN-PROCESS board backend that calls the daemon's own board functions
// directly (no HTTP loopback, no second process). It reuses the same
// createBoardMcpServer() the standalone stdio bridge (mcp/index.js) builds,
// so the tool surface is identical. The SDK + compiled board-mcp.js are
// imported lazily so the daemon keeps working if the MCP build or its npm
// deps are absent (graceful 503 on /mcp in that case).
//
// Stateless mode: a fresh McpServer + transport per request (the stateless
// Streamable HTTP transport is single-use — see SDK docs). Board operations
// run as the human agent, same as the web UI and the socket protocol's
// board_* cases.

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

/** Handle a POST /mcp request using the in-process backend. Stateless: a
 *  fresh McpServer + transport per request. */
async function handleMcpRequest(req, res, parsedBody) {
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

/** Build the HTTP server: REST routes, static UI, and the /api/spawn/terminal
 *  WebSocket upgrade. The caller owns .listen(). `uiHtml` is the pre-loaded
 *  ui.html document (read by the daemon at boot). */
export function createHttpServer({ uiHtml, uiAssets }) {
  const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      if (!uiHtml) {
        json(res, 500, { error: "ui.html not available" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(uiHtml);
      return;
    }

    // Split UI assets (css/js) served as separate files so ui.html stays small.
    if (req.method === "GET" && url.pathname in UI_ASSET_TYPES) {
      const body = uiAssets && uiAssets[url.pathname];
      if (!body) { json(res, 404, { error: "asset not found" }); return; }
      res.writeHead(200, { "Content-Type": UI_ASSET_TYPES[url.pathname] });
      res.end(body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      json(res, 200, federationState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      const body = await readJsonBody(req);
      if (!body.to || typeof body.to !== "string") {
        json(res, 400, { ok: false, error: "Missing 'to'" });
        return;
      }
      const r = sendMail(HUMAN_AGENT_ID, body.to, body.subject, body.body, {
        newSession: !!body.newSession,
      });
      if (r.error) {
        json(res, 200, { ok: false, error: r.error });
      } else {
        json(res, 200, { ok: true, messageId: r.messageId });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/broadcast") {
      const body = await readJsonBody(req);
      const r = broadcastMail(HUMAN_AGENT_ID, body.subject, body.body);
      json(res, 200, { ok: true, recipients: r.recipients });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/archive") {
      const body = await readJsonBody(req);
      const ok = archiveHumanMessage(body.id);
      json(res, 200, { ok });
      return;
    }

    // ── Task board endpoints (actor: the human operator) ────────────────────

    if (req.method === "GET" && url.pathname === "/api/board") {
      // Optional location/archive filter (task 6586b9ca): ?location=board|backlog|archive
      // and ?includeArchived=true|false. Omit both for the full board (UI default).
      // Optional group filter (task b59e930a): ?group=all|<name>. Omit for the
      // default same-group (agent) / all-groups (human) scoping.
      const location = url.searchParams.get("location") || undefined;
      const incArch = url.searchParams.get("includeArchived");
      const group = url.searchParams.get("group") || undefined;
      const opts = { location, group, ...(incArch !== null ? { includeArchived: incArch === "true" } : {}) };
      // Drop undefined keys so the default (no filter) path stays clean.
      const clean = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
      json(res, 200, boardState(HUMAN_AGENT_ID, clean));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/board/move") {
      const body = await readJsonBody(req);
      const r = await boardMove(HUMAN_AGENT_ID, body.taskId, body.column, body.note);
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, warning: r.warning });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/board/assign") {
      const body = await readJsonBody(req);
      const r = boardAssign(HUMAN_AGENT_ID, body.taskId, body.assignee, !!body.newSession);
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, warning: r.warning });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/board/comment") {
      const body = await readJsonBody(req);
      const r = await boardComment(HUMAN_AGENT_ID, body.taskId, body.text);
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, warning: r.warning });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/board/progress") {
      const body = await readJsonBody(req);
      const r = await boardProgress(HUMAN_AGENT_ID, body.taskId, body.text);
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/board/create") {
      const body = await readJsonBody(req);
      const r = await boardCreate(HUMAN_AGENT_ID, body);
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, taskId: r.task.id, key: r.task.key ?? undefined });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/board/update") {
      const body = await readJsonBody(req);
      const r = await boardUpdate(HUMAN_AGENT_ID, body.taskId, body);
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, warning: r.warning });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/board/flag") {
      const body = await readJsonBody(req);
      const r = boardFlag(HUMAN_AGENT_ID, body.taskId, body.reason, !!body.clear);
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, warning: r.warning });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/board/config") {
      json(res, 200, {
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
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/board/config") {
      const body = await readJsonBody(req);
      const r = boardSetConfig(body);
      json(res, 200, r);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/board/sync") {
      if (!jiraCfg()) {
        json(res, 200, { ok: false, error: "Jira is not configured" });
        return;
      }
      await syncBoard("manual");
      json(res, 200, { ok: !board.syncError, error: board.syncError ?? undefined });
      return;
    }

    // Middle-manager status (config snapshot + live MM sessions). Read-only.
    if (req.method === "GET" && url.pathname === "/api/mm") {
      json(res, 200, mmState());
      return;
    }

    // CEO status (config snapshot + live CEO sessions). Read-only.
    if (req.method === "GET" && url.pathname === "/api/ceo") {
      json(res, 200, ceoState());
      return;
    }

    // Run a CEO cycle now (manual trigger from the Board UI). Forces a tick
    // — bypasses the interval gate — so the operator can spawn a CEO on
    // demand instead of waiting for the scheduler. Reuses the scheduler's
    // own spawnCeo (picks the first favorite cwd, uses ceoModel, respects
    // the no-overlap guard, injects the canonical ceoKickoff). Still
    // requires ceoEnabled === true (a forced tick on a disabled CEO is a
    // no-op); the UI toasts that hint. Returns the ceoTick result.
    if (req.method === "POST" && url.pathname === "/api/ceo/tick") {
      const r = ceoTick(Date.now(), true);
      json(res, 200, r.error ? { ok: false, error: r.error }
        : r.spawned ? { ok: true, name: r.name }
        : { ok: false, skipped: r.reason || r.skipped || "not spawned" });
      return;
    }

    // ── Agent spawn endpoints (actor: the human operator / orchestrators) ────

    if (req.method === "GET" && url.pathname === "/api/spawn") {
      json(res, 200, spawnState());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/spawn/projects") {
      json(res, 200, projectsState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/spawn/favorite") {
      const body = await readJsonBody(req);
      if (!body.cwd || typeof body.cwd !== "string") { json(res, 400, { ok: false, error: "Missing 'cwd'" }); return; }
      const favorite = !!body.favorite;
      const nowFav = setFavorite(body.cwd, favorite);
      json(res, 200, { ok: true, favorite: nowFav, ...projectsState() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/spawn/ls") {
      const r = listSpawnDir(url.searchParams.get("path") || os.homedir(), { hidden: url.searchParams.get("hidden") === "1" });
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, dir: r.dir, dirs: r.dirs });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/spawn") {
      const body = await readJsonBody(req);
      const r = spawnAgent({ cwd: body.cwd, name: body.name, model: body.model, kickoff: body.kickoff, favorite: body.favorite });
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, name: r.name });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/spawn/stop") {
      const body = await readJsonBody(req);
      const r = stopAgent({ name: body.name });
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true });
      return;
    }

    // ── MCP server (Streamable HTTP) — hosted in-process, no separate proc ─
    // POST /mcp is the MCP Streamable HTTP transport. Stateless: POST only
    // (no SSE / no session). Backed by inProcessBoardBackend above.
    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        jsonRpcError(res, 405, -32000, `Method not allowed: ${req.method} (stateless server; use POST)`);
        return;
      }
      const body = await readJsonBody(req);
      await handleMcpRequest(req, res, body);
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e?.message ?? String(e) });
  }
});

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log(`Mail UI: port ${process.env.PI_MAIL_UI_PORT || "1994"} in use — UI disabled (set PI_MAIL_UI_PORT to change)`);
  } else {
    log(`Mail UI error: ${err.message}`);
  }
});

// ── WebSocket terminal: stream a spawned agent's tmux session ────────────────
//
// The browser opens a WebSocket at /api/spawn/terminal?name=<session>. The
// daemon attaches to the tmux session via `script -qec 'tmux attach -t <name>'`
// which gives a real PTY pair; stdout bytes are forwarded to the WS as binary
// frames, and incoming WS bytes are written to the PTY stdin (so the browser
// can type into the live pi TUI). Only sessions the daemon spawned are
// attachable (defence-in-depth: the picker/stop already gate on tracking).
//
// The WS protocol is the minimal one: raw bytes both directions. The browser
// uses xterm.js to render. No subprotocol, no JSON framing — keeps it cheap.
httpServer.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/api/spawn/terminal") {
    socket.destroy();
    return;
  }
  const name = safeSessionName(url.searchParams.get("name") || "");
  if (!name || !spawnRegistry.sessions[name]) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!tmuxSessionExists(name)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  // Minimal RFC6455 server handshake (no deps). The browser speaks standard WS.
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    "\r\n"
  );

  // Attach to the tmux session through a PTY (script -qec '<cmd>' /dev/null).
  // -q: quiet (no "Script started" header). -e <cmd>: run cmd under a PTY.
  const child = spawn("script", ["-qec", `tmux attach -t ${shellQuote(name)}`, "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  log(`Terminal WS attached to '${name}'`);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { child.kill(); } catch {}
    try { socket.destroy(); } catch {}
  };

  // tmux stdout → WS: frame as binary (opcode 2).
  const sendFrame = (buf) => {
    if (closed || socket.destroyed) return;
    // Frame: FIN(1) + opcode(2) + mask(0) + len + payload. Server→client is
    // unmasked per RFC6455.
    let header;
    const len = buf.length;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x82; // FIN + binary
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x82;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x82;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, buf]));
  };
  child.stdout.on("data", (b) => sendFrame(b));
  child.stderr.on("data", (b) => sendFrame(b));
  child.on("exit", () => {
    // Send a close frame and tear down.
    if (!closed) { try { socket.write(Buffer.from([0x88, 0x00])); } catch {} }
    cleanup();
    log(`Terminal WS detached from '${name}' (tmux attach exited)`);
  });

  // WS → tmux stdin: decode incoming frames (client→server is masked).
  let inBuf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    inBuf = Buffer.concat([inBuf, chunk]);
    while (inBuf.length >= 2) {
      const b0 = inBuf[0];
      const b1 = inBuf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let idx = 2;
      if (len === 126) { if (inBuf.length < 4) return; len = inBuf.readUInt16BE(2); idx = 4; }
      else if (len === 127) { if (inBuf.length < 10) return; len = Number(inBuf.readBigUInt64BE(2)); idx = 10; }
      let mask = Buffer.alloc(0);
      if (masked) { if (inBuf.length < idx + 4) return; mask = inBuf.subarray(idx, idx + 4); idx += 4; }
      if (inBuf.length < idx + len) return;
      let payload = inBuf.subarray(idx, idx + len);
      if (masked) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      inBuf = inBuf.subarray(idx + len);
      if (opcode === 0x8) { cleanup(); return; } // close
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) { // text / binary / continuation
        if (child.stdin && !child.stdin.destroyed) child.stdin.write(payload);
      }
      if (opcode === 0x9) { // ping → pong
        const pong = Buffer.alloc(2 + payload.length);
        pong[0] = 0x8a; pong[1] = payload.length; payload.copy(pong, 2);
        try { socket.write(pong); } catch {}
      }
    }
  });
  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

  return httpServer;
}
