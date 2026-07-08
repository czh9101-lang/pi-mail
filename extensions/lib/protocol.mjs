/**
 * Socket protocol message handler for the pi-mail daemon.
 * Extracted from daemon.mjs. Depends on core, board-ops, and spawn modules.
 */

import {
  agents,
  mailboxes,
  send,
  sendMail,
  broadcastMail,
  log,
  startHeartbeat,
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
import {
  spawnAgent,
  stopAgent,
  spawnState,
  listSpawnDir,
  setFavorite,
  projectsState,
} from "./spawn.mjs";
import os from "node:os";

// ── Message handler ───────────────────────────────────────────────────────────

export function handleMessage(agentId, msg, socket) {
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

    // ── Task board ──────────────────────────────────────────────────────────

    case "board_state": {
      reply({ type: "board", ...boardState(agentId) });
      break;
    }

    case "board_move": {
      boardMove(agentId, msg.taskId, msg.column, msg.note)
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task, warning: r.warning }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }

    case "board_assign": {
      const r = boardAssign(agentId, msg.taskId, msg.assignee, !!msg.newSession);
      reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task, warning: r.warning });
      break;
    }

    case "board_comment": {
      boardComment(agentId, msg.taskId, msg.text)
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task, warning: r.warning }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }

    case "board_progress": {
      boardProgress(agentId, msg.taskId, msg.text)
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }

    case "board_create": {
      boardCreate(agentId, {
        summary: msg.summary,
        description: msg.description,
        column: msg.column,
        parent: msg.parent,
        inJira: !!msg.inJira,
        level: msg.level,
        epicId: msg.epicId,
        backlog: !!msg.backlog,
      })
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }

    case "board_update": {
      boardUpdate(agentId, msg.taskId, { summary: msg.summary, description: msg.description })
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task, warning: r.warning }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }

    case "board_flag": {
      const r = boardFlag(agentId, msg.taskId, msg.reason, !!msg.clear);
      reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task, warning: r.warning });
      break;
    }

    // ── Agent spawn (orchestrator tools) ────────────────────────────────────
    case "spawn": {
      const r = spawnAgent({ cwd: msg.cwd, name: msg.name, model: msg.model, kickoff: msg.kickoff, favorite: msg.favorite });
      reply(r.error ? { type: "error", message: r.error } : { type: "spawned", name: r.name });
      break;
    }
    case "spawn_stop": {
      const r = stopAgent({ name: msg.name });
      reply(r.error ? { type: "error", message: r.error } : { type: "ok" });
      break;
    }
    case "spawn_state": {
      reply({ type: "spawn", ...spawnState() });
      break;
    }
    // List recent + favorite project dirs (the spawn-agent "history/favorites").
    case "spawn_projects": {
      reply({ type: "spawn_projects", ...projectsState() });
      break;
    }
    // Star/unstar a project dir as a favorite. `favorite` is a boolean.
    case "spawn_favorite": {
      const nowFav = setFavorite(msg.cwd, !!msg.favorite);
      reply({ type: "ok", favorite: nowFav, ...projectsState() });
      break;
    }
    case "spawn_ls": {
      const r = listSpawnDir(msg.path || os.homedir(), { hidden: !!msg.hidden });
      reply(r.error ? { type: "error", message: r.error } : { type: "spawn_ls", dir: r.dir, dirs: r.dirs });
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
