#!/usr/bin/env node
/**
 * pi-mail daemon — singleton federation server
 *
 * Manages agent registration, mailboxes, and routing.
 * Communication: newline-delimited JSON over a Unix domain socket.
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
 *   - Mailboxes persist through disconnects (agent can reconnect and read mail)
 *   - Mailbox is cleared on explicit unregister (clean exit)
 */

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ── Config ────────────────────────────────────────────────────────────────────

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SOCKET_PATH = path.join(AGENT_DIR, "mail-daemon.sock");
const PID_FILE = path.join(AGENT_DIR, "mail-daemon.pid");
const PING_INTERVAL_MS = 5_000;

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * Live agent connections.
 * @type {Map<string, { conn: net.Socket, info: AgentInfo, pingTimer: NodeJS.Timeout | null, pongPending: boolean }>}
 *
 * @typedef {{ agentId: string, agentName: string, registeredAt: number, status: string, contextPct: number | null }} AgentInfo
 */
const agents = new Map();

/**
 * Durable mailboxes (survives disconnects until unregister).
 * @type {Map<string, MailMessage[]>}
 *
 * @typedef {{ id: string, fromId: string, fromName: string, subject: string, body: string, timestamp: number, read: boolean }} MailMessage
 */
const mailboxes = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(socket, msg) {
  if (!socket.destroyed) {
    try {
      socket.write(JSON.stringify(msg) + "\n");
    } catch {}
  }
}

function log(msg) {
  process.stderr.write(`[pi-mail daemon] ${msg}\n`);
}

function deliverMail(toAgentId, message) {
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
  const agent = agents.get(fromAgentId);
  return {
    id: crypto.randomUUID(),
    fromId: fromAgentId,
    fromName: agent?.info.agentName ?? fromAgentId,
    subject: subject ?? "(no subject)",
    body: body ?? "",
    timestamp: Date.now(),
    read: false,
    ...extra,
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
      // Resolve target by agentId or agentName (first match)
      let targetId = null;
      for (const [id, a] of agents) {
        if (id === msg.to || id.startsWith(msg.to) || a.info.agentName === msg.to) {
          targetId = id;
          break;
        }
      }
      // Also check mailboxes for offline agents
      if (!targetId) {
        for (const [id] of mailboxes) {
          if (id === msg.to) {
            targetId = id;
            break;
          }
        }
      }
      if (!targetId) {
        reply({ type: "error", message: `Agent '${msg.to}' not found` });
        break;
      }
      const mail = makeMail(agentId, msg.subject, msg.body, msg.newSession ? { newSession: true } : {});
      deliverMail(targetId, mail);
      reply({ type: "sent", messageId: mail.id });
      break;
    }

    case "broadcast": {
      const recipients = [];
      for (const [id] of agents) {
        if (id === agentId) continue; // don't self-send
        const mail = { ...makeMail(agentId, msg.subject, msg.body), broadcast: true };
        deliverMail(id, mail);
        recipients.push(id);
      }
      reply({ type: "sent", recipients: recipients.length });
      log(
        `Broadcast from ${agents.get(agentId)?.info.agentName ?? agentId.slice(0, 8)} → ${recipients.length} agent(s)`
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

    case "list_agents": {
      const list = Array.from(agents.values()).map((a) => a.info);
      reply({ type: "agents", agents: list });
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

// ── Server ────────────────────────────────────────────────────────────────────

// Ensure dirs exist
fs.mkdirSync(AGENT_DIR, { recursive: true });

// Single-instance guard: if a live daemon already owns the socket, exit
// quietly instead of stealing it. Without this, concurrent spawn attempts
// (e.g. several agents reconnecting at once after a daemon crash) each
// unlink the socket and re-listen, leaving multiple daemons fighting over
// the path — the root cause of the reconnect loop.
await (async () => {
  try {
    await new Promise((resolve, reject) => {
      const probe = net.createConnection(SOCKET_PATH);
      probe.once("connect", () => {
        probe.destroy();
        resolve();
      });
      probe.once("error", reject);
    });
    // A daemon answered — let it keep running.
    log("Another daemon is already running; exiting");
    process.exit(0);
  } catch {
    // No live daemon — fall through and take over the socket below.
  }
})();

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

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function cleanup() {
  log("Shutting down");
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {}
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// Keep the process alive (it's a daemon)
process.stdin.resume();
