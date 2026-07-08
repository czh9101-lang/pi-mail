/**
 * Core shared state + helpers for the pi-mail daemon.
 *
 * Holds the federation's mutable state (live agents, durable mailboxes, the
 * append-only message history) and the mail-routing helpers built on top of it
 * (send, deliverMail, sendMail, broadcastMail, …). Extracted into its own
 * module so the board, Jira, spawn, protocol, and HTTP modules can depend on a
 * single source of truth without circular imports — this module depends on
 * nothing else in the daemon.
 *
 * ESM live bindings: `messageLog` is a `let` rebound by `loadHistory()`; other
 * modules import the binding and always see the current array.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ── Config (shared paths) ────────────────────────────────────────────────────

export const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
export const HISTORY_FILE = path.join(AGENT_DIR, "mail-daemon.history.json");

// ── Human agent ──────────────────────────────────────────────────────────────
//
// A fixed, well-known virtual agent so a human operator can send and receive
// mail through the web UI. It has no live socket — its "inbox" is just the
// slice of the message history addressed to this ID.

export const HUMAN_AGENT_ID = "00000000-0000-0000-0000-000000000000";
export const HUMAN_AGENT_NAME = "human";

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * Live agent connections.
 * @type {Map<string, { conn: import("node:net").Socket, info: AgentInfo, pingTimer: NodeJS.Timeout | null, pongPending: boolean, lastSeen: number }>}
 *
 * @typedef {{ agentId: string, agentName: string, registeredAt: number, status: string, contextPct: number | null, model: string, cwd: string, isHuman?: boolean }} AgentInfo
 */
export const agents = new Map();

/**
 * Durable mailboxes (survives disconnects until unregister).
 * @type {Map<string, MailMessage[]>}
 *
 * @typedef {{ id: string, fromId: string, fromName: string, subject: string, body: string, timestamp: number, read: boolean, broadcast?: boolean, newSession?: boolean }} MailMessage
 */
export const mailboxes = new Map();

/**
 * Append-only message history — the single source of truth for the web UI.
 * Each entry is a delivered message enriched with recipient info.
 *
 * @type {Array<MailMessage & { toId: string, toName: string, archived: boolean, broadcastId: string | null }>}
 */
export let messageLog = [];

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

/** Flush any pending history write immediately (used on shutdown). */
function flushHistory() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(messageLog));
  } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function send(socket, msg) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(JSON.stringify(msg) + "\n");
  } catch {}
}

export function log(msg) {
  process.stderr.write(`[pi-mail daemon] ${msg}\n`);
}

export function agentDisplayName(agentId) {
  if (agentId === HUMAN_AGENT_ID) return HUMAN_AGENT_NAME;
  return agents.get(agentId)?.info.agentName ?? agentId;
}

/** Append a delivered message to the history log (UI source of truth). */
export function logDelivery(message, toAgentId, opts = {}) {
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

export function deliverMail(toAgentId, message, opts = {}) {
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

export function makeMail(fromAgentId, subject, body, extra = {}) {
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
export function resolveTarget(to) {
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
export function sendMail(fromId, toSpec, subject, body, opts = {}) {
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
export function broadcastMail(fromId, subject, body) {
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
export function archiveHumanMessage(id) {
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

export { schedulePersist, loadHistory, flushHistory };
