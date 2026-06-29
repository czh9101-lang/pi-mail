#!/usr/bin/env node
/**
 * pi-mail daemon — singleton federation server
 *
 * Manages agent registration, mailboxes, and routing.
 * Communication: newline-delimited JSON over a Unix domain socket.
 *
 * Also hosts an optional HTTP web UI (default port 1994) so a human operator
 * can browse per-agent mail history, see the live federation, and send or
 * broadcast mail as a first-class "human" agent.
 *
 * Lifecycle:
 *   - Spawned by the pi-mail extension when not already running
 *   - Stays alive as long as at least one agent is connected (or forever)
 *   - Gracefully shuts down on SIGTERM / SIGINT, removing the socket file
 *
 * Ping-pong (server-initiated):
 *   - Daemon sends { type: "ping" } every PING_INTERVAL_MS
 *   - Client must respond with { type: "pong" }
 *   - If no pong within the next ping cycle, the connection is terminated
 *
 * Mailbox durability:
 *   - Live agent mailboxes persist through disconnects (reclaim on reconnect)
 *   - A clean unregister clears that agent's live mailbox
 *   - The full message history (for the UI) is persisted to disk and survives
 *     daemon restarts; the human's inbox is derived from that history.
 */

import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ── Config ────────────────────────────────────────────────────────────────────

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SOCKET_PATH = path.join(AGENT_DIR, "mail-daemon.sock");
const PID_FILE = path.join(AGENT_DIR, "mail-daemon.pid");
const LOCK_FILE = path.join(AGENT_DIR, "mail-daemon.lock");
const HISTORY_FILE = path.join(AGENT_DIR, "mail-daemon.history.json");
const PING_INTERVAL_MS = 5_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = path.join(__dirname, "ui.html");

// HTTP UI bind settings. Override with env vars if needed.
const UI_HOST = process.env.PI_MAIL_UI_HOST || "0.0.0.0";
const UI_PORT = parseInt(process.env.PI_MAIL_UI_PORT || "1994", 10);

// ── Human agent ──────────────────────────────────────────────────────────────
//
// A fixed, well-known virtual agent so a human operator can send and receive
// mail through the web UI. It has no live socket — its "inbox" is just the
// slice of the message history addressed to this ID.

const HUMAN_AGENT_ID = "00000000-0000-0000-0000-000000000000";
const HUMAN_AGENT_NAME = "human";

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * Live agent connections.
 * @type {Map<string, { conn: net.Socket, info: AgentInfo, pingTimer: NodeJS.Timeout | null, pongPending: boolean, lastSeen: number }>}
 *
 * @typedef {{ agentId: string, agentName: string, registeredAt: number, status: string, contextPct: number | null, model: string, cwd: string, isHuman?: boolean }} AgentInfo
 */
const agents = new Map();

/**
 * Durable mailboxes (survives disconnects until unregister).
 * @type {Map<string, MailMessage[]>}
 *
 * @typedef {{ id: string, fromId: string, fromName: string, subject: string, body: string, timestamp: number, read: boolean, broadcast?: boolean, newSession?: boolean }} MailMessage
 */
const mailboxes = new Map();

/**
 * Append-only message history — the single source of truth for the web UI.
 * Each entry is a delivered message enriched with recipient info.
 *
 * @type {Array<MailMessage & { toId: string, toName: string, archived: boolean, broadcastId: string | null }>}
 */
let messageLog = [];

// ── Persistence ──────────────────────────────────────────────────────────────
//
// The history is small (federation mail is low-volume) so we rewrite the whole
// file, debounced, on each change. This keeps the UI's history across daemon
// restarts (/restart-mail-daemon, crashes, reboots).

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(messageLog));
    } catch (e) {
      log(`persist failed: ${e.message}`);
    }
  }, 300);
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    messageLog = Array.isArray(parsed) ? parsed : [];
  } catch {
    messageLog = [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(socket, msg) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(JSON.stringify(msg) + "\n");
  } catch {}
}

function log(msg) {
  process.stderr.write(`[pi-mail daemon] ${msg}\n`);
}

function agentDisplayName(agentId) {
  if (agentId === HUMAN_AGENT_ID) return HUMAN_AGENT_NAME;
  return agents.get(agentId)?.info.agentName ?? agentId;
}

/** Append a delivered message to the history log (UI source of truth). */
function logDelivery(message, toAgentId, opts = {}) {
  const entry = {
    ...message,
    toId: toAgentId,
    toName: agentDisplayName(toAgentId),
    archived: false,
    broadcastId: opts.broadcastId ?? null,
  };
  messageLog.push(entry);
  schedulePersist();
}

function deliverMail(toAgentId, message, opts = {}) {
  // Record in history regardless of recipient (including the human).
  logDelivery(message, toAgentId, opts);

  // The human has no live mailbox or socket — its inbox is the history slice
  // where toId === HUMAN_AGENT_ID && !archived.
  if (toAgentId === HUMAN_AGENT_ID) return;

  let box = mailboxes.get(toAgentId);
  if (!box) {
    box = [];
    mailboxes.set(toAgentId, box);
  }
  box.push(message);

  // Push to live agent — async so the sender's request handler is not blocked
  const agent = agents.get(toAgentId);
  if (agent) {
    setImmediate(() => send(agent.conn, { type: "new_mail", message }));
  }
}

function makeMail(fromAgentId, subject, body, extra = {}) {
  const fromName =
    fromAgentId === HUMAN_AGENT_ID
      ? HUMAN_AGENT_NAME
      : agents.get(fromAgentId)?.info.agentName ?? fromAgentId;
  return {
    id: crypto.randomUUID(),
    fromId: fromAgentId,
    fromName,
    subject: subject ?? "(no subject)",
    body: body ?? "",
    timestamp: Date.now(),
    read: false,
    ...extra,
  };
}

/** Resolve a recipient spec (name, full id, or id prefix) to an agentId. */
function resolveTarget(to) {
  if (!to) return null;
  // Human is always resolvable by name or id.
  if (to === HUMAN_AGENT_ID || to === HUMAN_AGENT_NAME) return HUMAN_AGENT_ID;
  for (const [id, a] of agents) {
    if (id === to || id.startsWith(to) || a.info.agentName === to) {
      return id;
    }
  }
  // Offline agents we still hold a mailbox for.
  for (const [id] of mailboxes) {
    if (id === to || id.startsWith(to)) return id;
  }
  return null;
}

/**
 * Send mail from one agent to another. Shared by the socket protocol handler
 * and the HTTP/UI send path (which sends as the human).
 * @returns {{ messageId?: string, error?: string }}
 */
function sendMail(fromId, toSpec, subject, body, opts = {}) {
  const targetId = resolveTarget(toSpec);
  if (!targetId) return { error: `Agent '${toSpec}' not found` };
  const mail = makeMail(fromId, subject, body, opts.newSession ? { newSession: true } : {});
  deliverMail(targetId, mail);
  return { messageId: mail.id };
}

/**
 * Broadcast mail from one agent to all others. The human is included as a
 * recipient whenever the sender is not the human, so the operator sees every
 * broadcast in their inbox.
 * @returns {{ recipients: number, broadcastId: string }}
 */
function broadcastMail(fromId, subject, body) {
  const broadcastId = crypto.randomUUID();
  let count = 0;
  for (const [id] of agents) {
    if (id === fromId) continue; // don't self-send
    const mail = { ...makeMail(fromId, subject, body), broadcast: true };
    deliverMail(id, mail, { broadcastId });
    count++;
  }
  // Deliver a copy to the human unless the human is the sender.
  if (fromId !== HUMAN_AGENT_ID) {
    const mail = { ...makeMail(fromId, subject, body), broadcast: true };
    deliverMail(HUMAN_AGENT_ID, mail, { broadcastId });
  }
  return { recipients: count, broadcastId };
}

// ── Human inbox operations ───────────────────────────────────────────────────

/** Archive a message addressed to the human (hide from inbox). */
function archiveHumanMessage(id) {
  if (!id) return false;
  let found = false;
  for (const m of messageLog) {
    if (m.id === id && m.toId === HUMAN_AGENT_ID && !m.archived) {
      m.archived = true;
      found = true;
    }
  }
  if (found) schedulePersist();
  return found;
}

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
    now: Date.now(),
  };
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

function startHeartbeat(agentId) {
  const agent = agents.get(agentId);
  if (!agent) return;

  const tick = () => {
    const a = agents.get(agentId);
    if (!a) return; // already removed

    if (a.pongPending) {
      log(`${a.info.agentName} (${agentId.slice(0, 8)}) timed out — removing`);
      clearInterval(a.pingTimer);
      a.conn.destroy();
      agents.delete(agentId);
      // Keep mailbox so the agent can reclaim mail on reconnect
      return;
    }

    a.pongPending = true;
    send(a.conn, { type: "ping" });
  };

  agent.pingTimer = setInterval(tick, PING_INTERVAL_MS);
}

// ── Message handler ───────────────────────────────────────────────────────────

function handleMessage(agentId, msg, socket) {
  // Echo _reqId back so the client can match responses to requests by ID
  const reqId = msg._reqId;
  const reply = (payload) => send(socket, reqId != null ? { ...payload, _reqId: reqId } : payload);

  switch (msg.type) {
    case "register": {
      // Allow re-registration (e.g. reconnect or reload with same agentId)
      const existing = agents.get(msg.agentId);
      if (existing) {
        clearInterval(existing.pingTimer);
        // Close the old socket so it doesn't linger without heartbeat monitoring
        if (existing.conn !== socket) existing.conn.destroy();
      }
      const info = {
        agentId: msg.agentId,
        agentName: msg.agentName ?? msg.agentId,
        registeredAt: existing?.info.registeredAt ?? Date.now(),
        // Preserve a previously set status across reconnects / re-registration
        status: existing?.info.status ?? "",
        contextPct: existing?.info.contextPct ?? null,
        // Working directory of the agent process, used to group agents by
        // project. Updated on every (re)register so a moved dir is reflected.
        cwd: msg.cwd ?? existing?.info.cwd ?? "",
        model: msg.model ?? existing?.info.model ?? "",
      };
      agents.set(msg.agentId, {
        conn: socket,
        info,
        pingTimer: null,
        pongPending: false,
        lastSeen: Date.now(),
      });
      startHeartbeat(msg.agentId);
      reply({ type: "registered", agentId: msg.agentId });
      log(`Registered: ${info.agentName} (${msg.agentId.slice(0, 8)})`);
      break;
    }

    case "unregister": {
      const agent = agents.get(agentId);
      // Only honour unregister if this socket is still the active connection.
      // Guards against a reload race where the old socket unregisters after the
      // new socket has already taken over the same agentId.
      if (agent && agent.conn === socket) {
        clearInterval(agent.pingTimer);
        agents.delete(agentId);
        mailboxes.delete(agentId); // Clean exit clears mailbox
        log(`Unregistered: ${agent.info.agentName}`);
      }
      reply({ type: "ok" });
      break;
    }

    case "send": {
      const r = sendMail(agentId, msg.to, msg.subject, msg.body, {
        newSession: !!msg.newSession,
      });
      if (r.error) {
        reply({ type: "error", message: r.error });
      } else {
        reply({ type: "sent", messageId: r.messageId });
      }
      break;
    }

    case "broadcast": {
      const r = broadcastMail(agentId, msg.subject, msg.body);
      reply({ type: "sent", recipients: r.recipients });
      log(
        `Broadcast from ${agents.get(agentId)?.info.agentName ?? agentId.slice(0, 8)} → ${r.recipients} agent(s)`
      );
      break;
    }

    case "list_mail": {
      const messages = mailboxes.get(agentId) ?? [];
      reply({ type: "mail", messages });
      break;
    }

    case "set_name": {
      const agent = agents.get(agentId);
      if (agent) {
        agent.info.agentName = msg.agentName ?? agent.info.agentName;
        log(`Renamed ${agentId.slice(0, 8)} → ${agent.info.agentName}`);
      }
      reply({ type: "ok" });
      break;
    }

    case "set_status": {
      const agent = agents.get(agentId);
      if (agent) {
        agent.info.status = msg.status ?? "";
      }
      reply({ type: "ok" });
      break;
    }

    case "set_context": {
      const agent = agents.get(agentId);
      if (agent) {
        agent.info.contextPct = typeof msg.pct === "number" ? msg.pct : null;
      }
      // fire-and-forget: no response needed
      break;
    }

    case "set_model": {
      const agent = agents.get(agentId);
      if (agent) {
        agent.info.model = msg.model ?? "";
      }
      // fire-and-forget: no response needed
      break;
    }

    case "list_agents": {
      // Include the human so agents can discover and reply to the operator.
      reply({ type: "agents", agents: federationState().agents });
      break;
    }

    case "prune_silent": {
      // Remove agents that haven't responded to a ping in `olderThanMs` ms.
      // The caller (slash command) typically waits N seconds after a broadcast
      // probe before calling this, giving live agents time to respond.
      const threshold = typeof msg.olderThanMs === "number" ? msg.olderThanMs : 20_000;
      const cutoff = Date.now() - threshold;
      const pruned = [];
      for (const [id, a] of agents) {
        if (id === agentId) continue; // don't self-prune
        if (a.lastSeen < cutoff) {
          clearInterval(a.pingTimer);
          a.conn.destroy();
          agents.delete(id);
          // Preserve mailbox so reconnected agent can reclaim messages
          pruned.push({ agentId: id, agentName: a.info.agentName });
          log(`Pruned silent agent: ${a.info.agentName} (${id.slice(0, 8)}) — silent for ${Math.round((Date.now() - a.lastSeen) / 1000)}s`);
        }
      }
      reply({ type: "pruned", pruned });
      break;
    }

    case "mark_read": {
      const box = mailboxes.get(agentId);
      if (box) {
        const idx = box.findIndex((m) => m.id === msg.messageId);
        if (idx !== -1) box.splice(idx, 1);
      }
      reply({ type: "ok" });
      break;
    }

    default:
      reply({ type: "error", message: `Unknown message type: ${msg.type}` });
  }
}

// ── HTTP web UI ───────────────────────────────────────────────────────────────

let UI_HTML = "";
try {
  UI_HTML = fs.readFileSync(UI_HTML_PATH, "utf8");
} catch (e) {
  log(`ui.html not found at ${UI_HTML_PATH}: ${e.message}`);
}

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

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      if (!UI_HTML) {
        json(res, 500, { error: "ui.html not available" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(UI_HTML);
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

// ── Server ────────────────────────────────────────────────────────────────────

// Ensure dirs exist
fs.mkdirSync(AGENT_DIR, { recursive: true });

// Restore history before serving (so the UI shows prior mail immediately)
loadHistory();

// Single-instance guard: if a live daemon already owns the socket, exit
// quietly instead of stealing it. Without this, concurrent spawn attempts
// (e.g. several agents reconnecting at once after a daemon crash) each
// unlink the socket and re-listen, leaving multiple daemons fighting over
// the path — the root cause of the reconnect loop.
//
// The takeover (probe → unlink stale socket → listen) is wrapped in an
// OS-atomic exclusive lock file held for the process lifetime, so two
// concurrent spawns can't both pass the probe and end up running side by
// side. The socket probe remains as a defence-in-depth liveness check.
let lockFd = null;
function acquireInstanceLock() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 'wx' = O_CREAT | O_EXCL: atomic create-only; fails if the file exists.
      lockFd = fs.openSync(LOCK_FILE, "wx", 0o600);
      fs.writeFileSync(lockFd, String(process.pid) + "\n");
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Lock exists — check whether its owner is still alive.
      let stale = false;
      try {
        const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
        if (!pid || !pidAlive(pid)) stale = true;
      } catch {
        stale = true;
      }
      if (!stale) return false; // a live daemon holds the lock
      try { fs.unlinkSync(LOCK_FILE); } catch {} // reap stale lock and retry
    }
  }
  return false;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0); // throws if no such process
    return true;
  } catch {
    return false;
  }
}

if (!acquireInstanceLock()) {
  log("Another daemon is already running; exiting");
  process.exit(0);
}

// Secondary check: even with the lock, confirm no live listener on the socket.
try {
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(SOCKET_PATH);
    probe.once("connect", () => { probe.destroy(); resolve(); });
    probe.once("error", reject);
  });
  log("Another daemon is already running; exiting");
  process.exit(0);
} catch {
  // No live daemon — fall through and take over the socket below.
}

// Remove stale socket from previous run
try {
  fs.unlinkSync(SOCKET_PATH);
} catch {}

const server = net.createServer((socket) => {
  let agentId = null;
  let buf = "";

  socket.setEncoding("utf8");

  socket.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send(socket, { type: "error", message: "Invalid JSON" });
        continue;
      }

      // register sets the agentId for this connection
      if (msg.type === "register") {
        agentId = msg.agentId;
        handleMessage(agentId, msg, socket);
        continue;
      }

      // pong is a heartbeat response — handle inline, not via handleMessage
      if (msg.type === "pong") {
        if (agentId) {
          const a = agents.get(agentId);
          // Only accept pong from the currently registered socket for this agentId
          if (a && a.conn === socket) {
            a.pongPending = false;
            a.lastSeen = Date.now();
          }
        }
        continue;
      }

      if (!agentId) {
        send(socket, { type: "error", message: "Must register first" });
        continue;
      }

      handleMessage(agentId, msg, socket);
    }
  });

  socket.on("close", () => {
    if (!agentId) return;
    const a = agents.get(agentId);
    if (a && a.conn === socket) {
      clearInterval(a.pingTimer);
      agents.delete(agentId);
      // Mailbox is intentionally preserved for reconnect
      log(`Disconnected: ${a.info.agentName} — mailbox preserved`);
    }
  });

  socket.on("error", (err) => {
    if (err.code !== "ECONNRESET") {
      log(`Socket error: ${err.message}`);
    }
  });
});

server.listen(SOCKET_PATH, () => {
  log(`Listening on ${SOCKET_PATH} (PID ${process.pid})`);
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
  try {
    fs.chmodSync(SOCKET_PATH, 0o600); // owner-only
  } catch {}
});

server.on("error", (err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});

// Start the web UI. Non-fatal if it fails (the mail daemon still works).
httpServer.listen(UI_PORT, UI_HOST, () => {
  log(`Mail UI: http://${UI_HOST}:${UI_PORT}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function cleanup() {
  log("Shutting down");
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {}
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
  try {
    if (lockFd != null) { fs.closeSync(lockFd); fs.unlinkSync(LOCK_FILE); }
  } catch {}
  // Flush any pending history write before exiting.
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(messageLog));
    } catch {}
  }
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// Keep the process alive (it's a daemon)
process.stdin.resume();
