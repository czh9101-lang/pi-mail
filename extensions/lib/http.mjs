/**
 * HTTP web UI + WebSocket terminal for the pi-mail daemon.
 * Extracted from daemon.mjs. Exposes createHttpServer({ uiHtml, uiPort, uiHost })
 * which builds the httpServer (REST routes + static UI + /api/spawn/terminal
 * WS upgrade) and returns it; the caller owns .listen(). Depends on core,
 * board, board-ops, jira, and spawn modules.
 */

import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  agents,
  messageLog,
  HUMAN_AGENT_ID,
  HUMAN_AGENT_NAME,
  log,
  archiveHumanMessage,
  sendMail,
  broadcastMail,
  shellQuote,
} from "./core.mjs";
import { boardState } from "./board.mjs";
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
import {
  spawnState,
  listSpawnDir,
  spawnAgent,
  stopAgent,
  spawnRegistry,
  safeSessionName,
  tmuxSessionExists,
} from "./spawn.mjs";

// ── Federation snapshot (for the UI) ──────────────────────────────────────────

function federationState() {
  const list = Array.from(agents.values()).map((a) => a.info);
  // Always expose the human as a virtual, discoverable agent.
  list.push({
    agentId: HUMAN_AGENT_ID,
    agentName: HUMAN_AGENT_NAME,
    registeredAt: 0,
    status: "human operator",
    contextPct: null,
    cwd: "",
    model: "",
    isHuman: true,
  });
  return {
    human: { agentId: HUMAN_AGENT_ID, agentName: HUMAN_AGENT_NAME },
    agents: list,
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

/** Build the HTTP server: REST routes, static UI, and the /api/spawn/terminal
 *  WebSocket upgrade. The caller owns .listen(). `uiHtml` is the pre-loaded
 *  ui.html document (read by the daemon at boot). */
export function createHttpServer({ uiHtml }) {
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
      json(res, 200, boardState(HUMAN_AGENT_ID));
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

    // ── Agent spawn endpoints (actor: the human operator / orchestrators) ────

    if (req.method === "GET" && url.pathname === "/api/spawn") {
      json(res, 200, spawnState());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/spawn/ls") {
      const r = listSpawnDir(url.searchParams.get("path") || os.homedir(), { hidden: url.searchParams.get("hidden") === "1" });
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, dir: r.dir, dirs: r.dirs });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/spawn") {
      const body = await readJsonBody(req);
      const r = spawnAgent({ cwd: body.cwd, name: body.name, model: body.model, kickoff: body.kickoff });
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, name: r.name });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/spawn/stop") {
      const body = await readJsonBody(req);
      const r = stopAgent({ name: body.name });
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e?.message ?? String(e) });
  }
});

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log(`Mail UI: port ${UI_PORT} in use — UI disabled (set PI_MAIL_UI_PORT to change)`);
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
