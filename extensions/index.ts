/**
 * pi-mail — federated agent mail extension
 *
 * Registers each pi process as an agent in a shared mail federation.
 * A singleton daemon (daemon.mjs) is auto-started when needed.
 *
 * Features:
 *   - Agents discover each other via the daemon registry
 *   - Mail can be sent to a named agent or broadcast to all
 *   - Unread mail is injected as context at the start of each turn
 *   - Status bar shows unread count
 *   - Clean exit unregisters and clears mailbox; crashes preserve it for reconnect
 *
 * Commands:
 *   /mail-name [name]   — view or set your agent display name
 *   /mail-status        — show connection status
 *
 * Tools (callable by the LLM):
 *   mail_list           — list inbox
 *   mail_read           — read a message by ID
 *   mail_send           — send to a named agent
 *   mail_broadcast      — send to all connected agents
 *   mail_mark_read      — archive (remove) a message
 *   mail_list_agents    — list connected agents
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as net from "node:net";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// jiti provides __dirname for directory-based extensions
declare const __dirname: string;

// ── Config ────────────────────────────────────────────────────────────────────

const SOCKET_PATH = join(homedir(), ".pi", "agent", "mail-daemon.sock");
const PID_PATH = join(homedir(), ".pi", "agent", "mail-daemon.pid");
const DAEMON_SCRIPT = join(__dirname, "daemon.mjs");

// ── Types ─────────────────────────────────────────────────────────────────────

interface MailMessage {
  id: string;
  fromId: string;
  fromName: string;
  subject: string;
  body: string;
  timestamp: number;
  read: boolean;
  broadcast?: boolean;
  /** If true, the receiving agent should start a fresh session before acting on this mail. */
  newSession?: boolean;
}

interface AgentInfo {
  agentId: string;
  agentName: string;
  registeredAt: number;
  status?: string;
  contextPct?: number | null;
  /** Working directory of the agent process, used to group agents by project. */
  cwd?: string;
  /** Active model identifier, e.g. "anthropic/claude-sonnet-4". */
  model?: string;
}

/** Group key for listing agents: the basename of the agent's cwd. */
function projectGroupKey(cwd?: string): string {
  if (!cwd) return "(no project)";
  return basename(cwd) || cwd;
}

// ── MailClient ────────────────────────────────────────────────────────────────
//
// Wraps a Unix socket connection to the daemon.
// Protocol: newline-delimited JSON.
//
// The daemon can send two push message types at any time:
//   { type: "ping" }              — respond immediately with { type: "pong" }
//   { type: "new_mail", message } — pushed when new mail arrives
//
// All other daemon messages are responses to client requests.
// Requests are sequential (one inflight at a time); responses arrive in order.

class MailClient {
  private socket: net.Socket | null = null;
  private buf = "";
  // Map-based pending requests keyed by _reqId — immune to queue corruption
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextReqId = 1;

  /** Called when a push notification arrives */
  onNewMail: ((msg: MailMessage) => void) | null = null;
  /** Called when the socket closes (cleanly or on error) */
  onDisconnect: (() => void) | null = null;

  get connected(): boolean {
    return this.socket != null && !this.socket.destroyed;
  }

  async connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.setEncoding("utf8");

      sock.once("connect", () => {
        this.socket = sock;
        resolve();
      });

      sock.once("error", (err) => {
        if (!this.socket) reject(err);
      });

      sock.on("data", (chunk: string) => {
        this.buf += chunk;
        const lines = this.buf.split("\n");
        this.buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: { type: string; _reqId?: number; [k: string]: unknown };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }

          if (msg.type === "ping") {
            this.rawWrite({ type: "pong" });
            continue;
          }

          if (msg.type === "new_mail") {
            // Run async so the socket data handler is never blocked by callback work
            setImmediate(() => this.onNewMail?.(msg.message as MailMessage));
            continue;
          }

          // Match response to pending request by _reqId
          if (msg._reqId != null) {
            const entry = this.pending.get(msg._reqId as number);
            if (entry) {
              clearTimeout(entry.timer);
              this.pending.delete(msg._reqId as number);
              entry.resolve(msg);
            }
            // Unknown _reqId (e.g. late response after timeout) — discard safely
            continue;
          }

          // Legacy fallback: no _reqId, pick the oldest pending entry
          const first = this.pending.entries().next();
          if (!first.done) {
            const [id, entry] = first.value;
            clearTimeout(entry.timer);
            this.pending.delete(id);
            entry.resolve(msg);
          }
        }
      });

      sock.on("close", () => {
        this.socket = null;
        this.drainPending("disconnected");
        this.onDisconnect?.();
      });

      sock.on("error", (err) => {
        // Drain pending entries immediately on socket error; close event follows.
        this.drainPending(err.message);
      });
    });
  }

  private drainPending(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  // Outgoing messages that couldn't be written yet (socket unavailable / reconnecting).
  // Flushed automatically once a connection is (re)established.
  private writeQueue: string[] = [];

  flushWriteQueue(): void {
    if (!this.socket || this.socket.destroyed) return;
    const items = this.writeQueue.splice(0);
    for (const data of items) {
      try { this.socket.write(data); } catch {}
    }
  }

  private rawWrite(msg: unknown, onWriteError?: (err: Error) => void): void {
    const data = JSON.stringify(msg) + "\n";
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.write(data, (err) => {
          if (err) onWriteError?.(err);
        });
      } catch (e) {
        onWriteError?.(e instanceof Error ? e : new Error(String(e)));
      }
    } else {
      // Socket temporarily unavailable — buffer and retry after reconnect.
      // Only buffer if there's a chance of reconnect (i.e. not a fire-and-forget
      // that already has nowhere to go); callers that need reliability pass onWriteError.
      if (!onWriteError) {
        this.writeQueue.push(data);
      } else {
        onWriteError(new Error("socket not available"));
      }
    }
  }

  /** Fire-and-forget: buffers the message if not connected; sent on reconnect. */
  fire(msg: unknown): void {
    this.rawWrite(msg); // no onWriteError → buffered automatically
  }

  async request<T = { type: string; [k: string]: unknown }>(
    msg: Record<string, unknown>,
    timeoutMs = 12_000
  ): Promise<T> {
    const reqId = this.nextReqId++;
    const tagged = { ...msg, _reqId: reqId };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(reqId)) {
          reject(new Error(`Request timed out (type=${msg.type})`));
          // Don't destroy the socket — other requests may still be in flight.
        }
      }, timeoutMs);
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
      // Buffer rather than reject when socket is temporarily gone;
      // the message will be flushed once the connection is restored.
      this.rawWrite(tagged);
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

// ── Daemon bootstrap ──────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function tryConnect(socketPath: string): Promise<MailClient | null> {
  try {
    const c = new MailClient();
    await c.connect(socketPath);
    return c;
  } catch {
    return null;
  }
}

/** True if a daemon process is currently alive (per its PID file). */
function isDaemonAlive(): boolean {
  try {
    const raw = readFileSync(PID_PATH, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (pid > 0) {
      process.kill(pid, 0); // throws if the process no longer exists
      return true;
    }
  } catch {
    // No PID file or process dead
  }
  return false;
}

async function ensureDaemonAndConnect(
  socketPath: string,
  daemonScript: string
): Promise<MailClient> {
  // Try an existing daemon first.
  let c = await tryConnect(socketPath);
  if (c) return c;

  // Only spawn when no daemon process is alive. When several agents reconnect
  // at once (e.g. after a daemon crash), every one of them would otherwise
  // spawn its own daemon — the daemons then fight over the socket, agents
  // briefly connect to a doomed daemon, disconnect, and reconnect again: the
  // reconnect loop. Gating the spawn on the PID file makes it single-flight.
  // (The daemon also probes the socket before taking over, so a race here is
  // safe — the loser just exits.)
  if (!isDaemonAlive()) {
    const child = spawn("node", [daemonScript], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  // Wait up to 6 s for the daemon (existing or freshly spawned) to answer.
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    c = await tryConnect(socketPath);
    if (c) return c;
  }

  throw new Error("Failed to connect to pi-mail daemon after 6 s");
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let client: MailClient | null = null;
  let agentId = randomUUID();  // may be overwritten from session entries in session_start
  let agentName = `${basename(process.cwd()) || "pi-agent"}-${agentId.slice(0, 6)}`;
  // Fixed per process — the directory pi was launched in (the "project").
  const agentCwd = process.cwd();
  let agentStatus = "";
  /** Active model string, e.g. "anthropic/claude-sonnet-4". Updated via model_select event. */
  let agentModel = "";
  // True once the agent/user has chosen an explicit name (vs. the auto slug)
  let nameCustomized = false;
  // Track whether agentId was restored from a previous session (prevents double-counting on reload)
  let agentIdRestored = false;
  /**
   * Who dispatched the task the agent is currently working on, when it arrived
   * via mail (from the human operator or another agent). `null` means the
   * operator is driving directly over the TUI. Drives the "channel" guidance
   * injected in before_agent_start, so the agent knows whether to reply via
   * mail or respond in place. Set when a mail triggers a turn; cleared when the
   * operator types directly in the TUI (see the `input` handler).
   */
  let mailTaskSender: { name: string; id: string } | null = null;
  let mailbox: MailMessage[] = [];
  let connected = false;
  // Reconnect driver: exponential backoff that keeps retrying instead of
  // giving up after a single failed attempt.
  let suppressReconnect = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  const RECONNECT_BASE_MS = 1_000;
  const RECONNECT_MAX_MS = 30_000;
  // Ensures only one in-flight connectToDaemon() at a time per process instance
  let connectingPromise: Promise<void> | null = null;

  // Stored so we can update the status bar from async callbacks
  let latestCtx: ExtensionContext | null = null;

  // ── Status bar helper ───────────────────────────────────────────────────────

  function updateStatus(ctx?: ExtensionContext | null): void {
    const c = ctx ?? latestCtx;
    if (!c) return;
    if (!connected) {
      c.ui.setStatus("pi-mail", c.ui.theme.fg("dim", "✉ offline"));
      return;
    }
    const unread = mailbox.filter((m) => !m.read).length;
    if (unread > 0) {
      const badge = c.ui.theme.fg("accent", `📬 ${unread}`);
      const name = c.ui.theme.fg("dim", ` ${agentName}`);
      c.ui.setStatus("pi-mail", badge + name);
    } else {
      const icon = c.ui.theme.fg("dim", "✉");
      const name = c.ui.theme.fg("dim", ` ${agentName}`);
      c.ui.setStatus("pi-mail", icon + name);
    }
  }

  // ── Connection management ───────────────────────────────────────────────────

  async function connectToDaemon(): Promise<void> {
    // Singleton guard: already live → nothing to do
    if (client?.connected) return;
    // In-flight guard: coalesce concurrent callers onto the same attempt
    if (connectingPromise) return connectingPromise;

    connectingPromise = _connectToDaemon().finally(() => {
      connectingPromise = null;
    });
    return connectingPromise;
  }

  function clearReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * Auto-reconnect with exponential backoff. Keeps retrying (rather than
   * giving up after one attempt) so a daemon that takes a while to come back
   * is recovered automatically. No-op while an intentional disconnect is
   * in progress or a retry is already pending.
   */
  function scheduleReconnect(): void {
    if (suppressReconnect) return;
    if (reconnectTimer) return; // already pending
    const backoff = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempts, 5)
    );
    reconnectAttempts++;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      await connectToDaemon().catch(() => {});
      // If the attempt failed (or the new connection dropped immediately),
      // keep trying with further backoff.
      if (!connected && !suppressReconnect) scheduleReconnect();
    }, backoff);
  }

  async function _connectToDaemon(): Promise<void> {
    try {
      client = await ensureDaemonAndConnect(SOCKET_PATH, DAEMON_SCRIPT);

      client.onNewMail = (msg) => {
        if (mailbox.some((m) => m.id === msg.id)) return; // already known
        mailbox.push(msg);
        updateStatus();
        // Remember who dispatched this task so the agent knows to reply via
        // mail (not via ask_user_question / the TUI). Cleared when the operator
        // types directly in the TUI again (see the `input` handler).
        mailTaskSender = { name: msg.fromName, id: msg.fromId };
        try {
          // newSession flag: orchestrator wants a fresh session before this task
          if (msg.newSession) {
            // Archive immediately so it doesn't linger in the inbox
            client?.request({ type: "mark_read", messageId: msg.id }).catch(() => {});
            mailbox = mailbox.filter((m) => m.id !== msg.id);
            updateStatus();
            // Queue /new-task as a follow-up (waits for agent to become idle first)
            const kickoff = msg.body?.trim() || "";
            pi.sendUserMessage(`/new-task ${kickoff}`.trimEnd(), { deliverAs: "followUp" });
            return;
          }

          const time = new Date(msg.timestamp).toLocaleString();
          const header = msg.broadcast
            ? `📡 **Broadcast** from **${msg.fromName}** (${msg.fromId.slice(0, 8)}): "${msg.subject}"`
            : `📬 **Mail** from **${msg.fromName}** (${msg.fromId.slice(0, 8)}): "${msg.subject}"`;
          const footer = msg.broadcast
            ? `This is a broadcast message. Only take action if this concerns you.`
            : `Please handle this mail and use \`mail_mark_read\` to archive it when done. ` +
              `This is a mail-driven task: the operator is not at your TUI. ` +
              `When complete (or if you have a question), reply to **${msg.fromName}** via \`mail_send\` — do NOT use \`ask_user_question\`.`;
          const content = [
            header,
            `Date: ${time} | ID: ${msg.id.slice(0, 8)}`,
            ``,
            msg.body,
            ``,
            footer,
          ].join("\n");
          pi.sendMessage(
            { customType: "pi-mail", content, display: true },
            { deliverAs: "steer", triggerTurn: true }
          );
        } catch {
          // Agent may not be running; ignore
        }
      };

      client.onDisconnect = () => {
        connected = false;
        client = null;
        updateStatus();
        scheduleReconnect();
      };

      // Register with the daemon
      const resp = await client.request<{ type: string; agentId?: string }>({
        type: "register",
        agentId,
        agentName,
        cwd: agentCwd,
        model: agentModel,
      });

      if (resp.type === "registered") {
        connected = true;
        // Stable connection — reset the backoff state.
        reconnectAttempts = 0;
        clearReconnect();
        // Flush any messages that were buffered while we were disconnected
        client.flushWriteQueue();
        // Restore status and model on the daemon side after (re)connecting
        if (agentStatus) {
          try {
            await client.request({ type: "set_status", status: agentStatus });
          } catch {}
        }
        if (agentModel) {
          try {
            await client.request({ type: "set_model", model: agentModel });
          } catch {}
        }
        // Load any pending mail (e.g. from a previous session or offline delivery)
        const mailResp = await client.request<{ type: string; messages?: MailMessage[] }>({
          type: "list_mail",
        });
        if (mailResp.type === "mail" && mailResp.messages) {
          mailbox = mailResp.messages;

          // Process any newSession messages that arrived while we were offline.
          // These were never seen by onNewMail (push path), so handle them now.
          // Use the last one if there are multiple (most recent task wins).
          const newSessionMsgs = mailResp.messages.filter((m) => m.newSession);
          if (newSessionMsgs.length > 0) {
            const msg = newSessionMsgs[newSessionMsgs.length - 1];
            // Archive all newSession messages so they don't re-trigger
            for (const m of newSessionMsgs) {
              client?.request({ type: "mark_read", messageId: m.id }).catch(() => {});
            }
            mailbox = mailbox.filter((m) => !m.newSession);
            mailTaskSender = { name: msg.fromName, id: msg.fromId };
            const kickoff = msg.body?.trim() || "";
            pi.sendUserMessage(`/new-task ${kickoff}`.trimEnd(), { deliverAs: "followUp" });
          }
        }
        updateStatus();
      }
    } catch {
      connected = false;
      client = null;
      // Start (or continue) the backoff retry loop so we recover once the
      // daemon is back, instead of staying offline forever after one failure.
      scheduleReconnect();
    }
  }

  async function disconnectFromDaemon(cleanExit: boolean): Promise<void> {
    // Intentional disconnect — don't let onDisconnect trigger auto-reconnect.
    suppressReconnect = true;
    clearReconnect();
    if (client && connected && cleanExit) {
      try {
        await client.request({ type: "unregister", agentId });
      } catch {}
    }
    client?.disconnect();
    client = null;
    connected = false;
    if (cleanExit) mailbox = [];
  }

  // ── Session lifecycle ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;

    // Restore agent id, name and status from session entries
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "pi-mail-id") {
        const data = entry.data as { agentId?: string } | undefined;
        if (data?.agentId) {
          agentId = data.agentId;
          agentIdRestored = true;
        }
      }
      if (entry.type === "custom" && entry.customType === "pi-mail-name") {
        const data = entry.data as { name?: string } | undefined;
        if (data?.name) {
          agentName = data.name;
          nameCustomized = true;
        }
        // Take the last stored name
      }
      if (entry.type === "custom" && entry.customType === "pi-mail-status") {
        const data = entry.data as { status?: string } | undefined;
        if (typeof data?.status === "string") agentStatus = data.status;
        // Take the last stored status
      }
    }

    // Persist agentId once (first session only — not on reload)
    if (!agentIdRestored) {
      pi.appendEntry("pi-mail-id", { agentId });
    }

    await connectToDaemon();
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // Clear latestCtx BEFORE disconnecting. The socket 'close' event fires
    // asynchronously after socket.destroy(), which would call onDisconnect ->
    // updateStatus() with the now-stale ctx, causing an uncaughtException.
    latestCtx = null;
    await disconnectFromDaemon(true);
  });

  // ── Mail injection ──────────────────────────────────────────────────────────

  // When the operator types directly in the TUI, the current task is no
  // longer mail-driven — clear the channel marker so before_agent_start tells
  // the agent to reply in place (and that ask_user_question is fine again).
  // Extension-injected messages (mail kickoffs, /new-task) keep the marker.
  pi.on("input", async (event, _ctx) => {
    if (event.source === "interactive") {
      mailTaskSender = null;
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    latestCtx = ctx;
    updateStatus(ctx);

    if (!connected) return;

    // Always nudge the agent (per task) to maintain an identity + status so an
    // orchestrator can tell who is doing what. This lives in the systemPrompt
    // only — no visible message — to avoid noise on every turn.
    const identityGuidance =
      `\n\n## Mail Federation\n` +
      `You are part of a federated agent network (pi-mail). An orchestrator and other agents can see you via mail_list_agents.\n` +
      `- Your display name: "${agentName}"${nameCustomized ? "" : " (auto-generated slug — set a short descriptive name with mail_set_name)"}.\n` +
      `- Your current status: ${agentStatus ? `"${agentStatus}"` : "(not set)"}.\n` +
      `\n**Status rules — follow these strictly:**\n` +
      `1. When you start a task: set status to a one-line description, e.g. "implementing auth refactor in portal-web".\n` +
      `2. When you finish or go idle: set status to "idle" or clear it.\n` +
      `3. Update status whenever your focus shifts to something meaningfully different.\n` +
      `4. Keep it short (<60 chars) and factual — branch name, issue key, and action are ideal.\n` +
      `Do NOT skip status updates — the orchestrator relies on them to coordinate work.\n` +
      `\nThe federation also has a shared kanban task board (optionally synced two-way with a Jira sprint). ` +
      `Tools: board_list_tasks, board_get_task, board_move_task, board_comment_task, board_progress_task, board_assign_task, board_create_task, board_split_task, board_update_task, board_flag_task. ` +
      `If a task is assigned to you (you'll get it as mail), work it via these tools: move it as you progress, post progress updates (board_progress_task) before moving it onward, comment on findings, and follow any column instructions. ` +
      `If a task is unclear, flag it with board_flag_task (with your questions) instead of guessing; if it's too big, subdivide it with board_split_task. A daemon nudge will mail you if an in-progress task of yours goes quiet for a while — reply with board_progress_task.`;

    // Tell the agent which channel the current task arrived on, so it knows
    // whether to reply via mail (operator/agent not at the TUI) or respond in
    // place. mailTaskSender is set when a mail triggers the turn and cleared
    // when the operator types directly in the TUI (see the `input` handler).
    const channelGuidance = mailTaskSender
      ? (
        `\n\n## Current task channel: mail\n` +
        `This task was dispatched to you via pi-mail from "${mailTaskSender.name}" (${mailTaskSender.id.slice(0, 8)}). ` +
        `The operator is NOT sitting at your TUI — they only see output you send as mail.\n` +
        `- When the task is complete: reply with \`mail_send\` to "${mailTaskSender.name}" with a concise summary, then archive the original with \`mail_mark_read\`.\n` +
        `- If you have a question or hit a blocker: ask via \`mail_send\` to "${mailTaskSender.name}". Do NOT use the \`ask_user_question\` tool — there is no one at the TUI to answer it.\n` +
        (mailTaskSender.name === "human"
          ? `- "human" is the operator via the web UI; replies to "human" appear in their inbox.\n`
          : `- "${mailTaskSender.name}" is another agent in the federation.\n`)
      )
      : (
        `\n\n## Current task channel: direct (TUI)\n` +
        `The operator is communicating with you directly over the TUI. Do NOT send mail (\`mail_send\` / \`mail_broadcast\`) to report on this task — respond here directly. ` +
        `You may use the \`ask_user_question\` tool when you need clarification. ` +
        `Only reach for the mail tools if you are participating in a federated multi-agent workflow (see the mail-orchestrator skill).`
      );

    const unread = mailbox.filter((m) => !m.read);
    if (unread.length === 0) {
      return { systemPrompt: event.systemPrompt + identityGuidance + channelGuidance };
    }

    const plural = unread.length === 1 ? "" : "s";
    const broadcasts = unread.filter((m) => m.broadcast);
    const broadcastNote = broadcasts.length > 0
      ? ` (${broadcasts.length} of which ${broadcasts.length === 1 ? "is" : "are"} a broadcast — only act on those if they concern you)`
      : "";
    return {
      message: {
        customType: "pi-mail",
        content:
          `📬 You have **${unread.length}** unread mail message${plural}${broadcastNote}. ` +
          `Use \`mail_list\` to see your inbox, \`mail_read\` to read, ` +
          `\`mail_send\` to reply, \`mail_broadcast\` to reach all agents, ` +
          `and \`mail_mark_read\` to archive.`,
        display: true,
      },
      systemPrompt:
        event.systemPrompt +
        identityGuidance +
        channelGuidance +
        `\n\nYou currently have ${unread.length} unread mail message${plural}${broadcastNote}. ` +
        `Check your inbox with mail_list when relevant to the current task.`,
    };
  });

  // Keep agentModel in sync whenever the model changes
  pi.on("model_select", async (event, _ctx) => {
    agentModel = `${event.model.provider}/${event.model.id}`;
    if (client && connected) {
      client.fire({ type: "set_model", model: agentModel });
    }
  });

  // Track ctx for status updates during turns
  pi.on("turn_start", async (_event, ctx) => {
    latestCtx = ctx;
  });

  // Push context saturation to daemon after each LLM turn
  pi.on("turn_end", async (_event, ctx) => {
    latestCtx = ctx;
    if (!connected || !client) return;
    const usage = ctx.getContextUsage();
    const pct = usage?.percent != null ? Math.round(usage.percent) : null;
    client.fire({ type: "set_context", pct });
  });

  // ── Commands ────────────────────────────────────────────────────────────────

  pi.registerCommand("mail-name", {
    description: "View or set your agent display name in the mail federation",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const name = args.trim();
      if (!name) {
        ctx.ui.notify(`Mail name: ${agentName} | ID: ${agentId.slice(0, 8)}`, "info");
        return;
      }
      agentName = name;
      nameCustomized = true;
      pi.appendEntry("pi-mail-name", { name });

      // Re-register with new name (daemon updates its registry)
      if (client && connected) {
        try {
          await client.request({ type: "register", agentId, agentName, cwd: agentCwd });
        } catch {}
      }

      updateStatus(ctx);
      ctx.ui.notify(`Mail name set to: ${agentName}`, "info");
    },
  });

  pi.registerCommand("restart-mail-daemon", {
    description: "Stop the mail daemon and reconnect (spawns a fresh daemon)",
    handler: async (_args, ctx) => {
      latestCtx = ctx;

      // Disconnect our own client first (without clearing our mailbox).
      // Suppress the auto-reconnect that onDisconnect would otherwise schedule,
      // since we explicitly reconnect below.
      suppressReconnect = true;
      clearReconnect();
      client?.disconnect();
      client = null;
      connected = false;
      updateStatus(ctx);

      // Kill the running daemon via its PID file
      let killed = false;
      try {
        const pid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
        if (pid > 0) {
          process.kill(pid, "SIGTERM");
          killed = true;
        }
      } catch {
        // No PID file / process already gone
      }

      // Give the old daemon a moment to release the socket
      await sleep(killed ? 500 : 100);

      // Reconnect — ensureDaemonAndConnect spawns a new daemon if needed
      suppressReconnect = false;
      await connectToDaemon().catch(() => {});
      updateStatus(ctx);

      if (connected) {
        ctx.ui.notify(
          killed ? "♻️ Mail daemon restarted and reconnected" : "✅ Mail daemon (re)started and connected",
          "info"
        );
      } else {
        ctx.ui.notify("❌ Failed to reconnect to mail daemon", "error");
      }
    },
  });

  // ── /agents — live TUI view of connected agents ──────────────────────────

  pi.registerCommand("agents", {
    description: "Show a live view of all connected agents in the mail federation",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      if (ctx.mode !== "tui") {
        // Fallback for non-TUI mode
        if (!connected || !client) {
          ctx.ui.notify("❌ Not connected to mail daemon", "error");
          return;
        }
        const resp = await client.request<{ type: string; agents?: Array<AgentInfo & { contextPct?: number | null }> }>({
          type: "list_agents",
        });
        if (resp.type === "agents" && resp.agents) {
          const sorted = [...resp.agents].sort(
            (x, y) =>
              projectGroupKey(x.cwd).localeCompare(projectGroupKey(y.cwd)) ||
              x.agentName.localeCompare(y.agentName)
          );
          const lines: string[] = [];
          let prev = "";
          for (const a of sorted) {
            const grp = projectGroupKey(a.cwd);
            if (grp !== prev) {
              prev = grp;
              lines.push(`📁 ${grp}${a.cwd && a.cwd !== grp ? `  (${a.cwd})` : ""}`);
            }
            const self = a.agentId === agentId ? " (you)" : "";
            const upSec = Math.round((Date.now() - a.registeredAt) / 1000);
            const up = upSec < 60 ? `${upSec}s` : upSec < 3600 ? `${Math.round(upSec / 60)}m` : `${Math.round(upSec / 3600)}h`;
            const ctx2 = a.contextPct != null ? ` ctx=${a.contextPct}%` : "";
            const modelStr = a.model ? ` model=${a.model}` : "";
            const st = a.status ? ` — ${a.status}` : "";
            lines.push(`  • ${a.agentName}${self} [${up}]${ctx2}${modelStr}${st}`);
          }
          ctx.ui.notify(`${resp.agents.length} agents:\n${lines.join("\n")}`, "info");
        }
        return;
      }

      type AgentRow = AgentInfo & { contextPct?: number | null };
      let agentRows: AgentRow[] = [];
      let lastRefresh = 0;
      let refreshError = "";

      const fetchAgents = async (): Promise<void> => {
        if (!connected || !client) { refreshError = "Not connected"; return; }
        try {
          const resp = await client.request<{ type: string; agents?: AgentRow[] }>({
            type: "list_agents",
          });
          if (resp.type === "agents" && resp.agents) {
            agentRows = [...resp.agents].sort(
              (x, y) =>
                projectGroupKey(x.cwd).localeCompare(projectGroupKey(y.cwd)) ||
                x.agentName.localeCompare(y.agentName)
            );
            lastRefresh = Date.now();
            refreshError = "";
          }
        } catch (e) {
          refreshError = e instanceof Error ? e.message : String(e);
        }
      };

      await fetchAgents();

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let selectedIdx = 0;
        let cachedWidth: number | undefined;
        let cachedLines: string[] | undefined;

        const fmtUptime = (registeredAt: number): string => {
          const s = Math.round((Date.now() - registeredAt) / 1000);
          return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
        };

        const fmtCtx = (pct: number | null | undefined, theme2: typeof theme): string => {
          if (pct == null) return theme2.fg("dim", "  —  ");
          const s = `${pct}%`.padStart(4);
          const color = pct >= 80 ? "error" : pct >= 50 ? "warning" : "success";
          return theme2.fg(color, s);
        };

        const invalidate = (): void => {
          cachedWidth = undefined;
          cachedLines = undefined;
        };

        const render = (width: number): string[] => {
          if (cachedLines && cachedWidth === width) return cachedLines;

          const lines: string[] = [];
          const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
          const hr = theme.fg("border", "─".repeat(width));

          // Header
          const ago = lastRefresh ? `${Math.round((Date.now() - lastRefresh) / 1000)}s ago` : "…";
          const title = refreshError
            ? theme.fg("error", `Federation — error: ${refreshError}`)
            : theme.fg("accent", `Federation — ${agentRows.length} agent${agentRows.length === 1 ? "" : "s"} `) +
              theme.fg("dim", `(refreshed ${ago})`);
          lines.push(" " + title);
          lines.push(hr);

          // Column header
          const colHdr =
            theme.fg("dim", pad("name", 26)) +
            theme.fg("dim", pad("up", 5)) +
            theme.fg("dim", " ctx  ") +
            theme.fg("dim", pad("model", 28)) +
            theme.fg("dim", "status");
          lines.push(" " + colHdr);
          lines.push(hr);

          if (agentRows.length === 0) {
            lines.push(theme.fg("muted", "  (no agents)"));
          } else {
            let prevGroup = "";
            agentRows.forEach((a, i) => {
              const grp = projectGroupKey(a.cwd);
              if (grp !== prevGroup) {
                prevGroup = grp;
                const full = a.cwd ?? "";
                const header =
                  theme.fg("accent", `📁 ${grp}`) +
                  (full && full !== grp ? theme.fg("dim", `  ${full}`) : "");
                lines.push(" " + header);
              }
              const self = a.agentId === agentId;
              const selfMark = self ? theme.fg("accent", " ←") : "   ";
              const name = self
                ? theme.fg("accent", pad(a.agentName, 24)) + selfMark
                : theme.fg("text", pad(a.agentName, 24)) + selfMark;
              const up = theme.fg("dim", pad(fmtUptime(a.registeredAt), 5));
              const ctxStr = " " + fmtCtx(a.contextPct, theme) + " ";
              const modelLabel = a.model
                ? theme.fg("dim", pad(a.model, 28))
                : theme.fg("dim", pad("—", 28));
              const status = a.status
                ? theme.fg(i === selectedIdx ? "text" : "muted", a.status)
                : theme.fg("dim", "—");

              const row = "  " + name + " " + up + ctxStr + modelLabel + status;
              if (i === selectedIdx) {
                lines.push(theme.bg("selectedBg", " " + row));
              } else {
                lines.push(" " + row);
              }
            });
          }

          lines.push(hr);
          lines.push(
            theme.fg("dim", "  ↑↓ navigate  ") +
            theme.fg("dim", "r refresh  ") +
            theme.fg("dim", "esc close")
          );

          cachedLines = lines;
          cachedWidth = width;
          return lines;
        };

        // Auto-refresh every 5s
        const refreshTimer = setInterval(async () => {
          await fetchAgents();
          invalidate();
          tui.requestRender();
        }, 5000);

        const handleInput = (data: string): void => {
          if (matchesKey(data, Key.up)) {
            if (selectedIdx > 0) { selectedIdx--; invalidate(); tui.requestRender(); }
          } else if (matchesKey(data, Key.down)) {
            if (selectedIdx < agentRows.length - 1) { selectedIdx++; invalidate(); tui.requestRender(); }
          } else if (data === "r" || data === "R") {
            fetchAgents().then(() => { invalidate(); tui.requestRender(); });
          } else if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
            clearInterval(refreshTimer);
            done();
          }
        };

        return { render, invalidate, handleInput };
      });
    },
  });

  pi.registerCommand("new-task", {
    description: "Start a fresh session, clearing all context. Optional arg = kickoff prompt for the new session.",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      await ctx.waitForIdle();
      const kickoff = args.trim();
      await ctx.newSession({
        withSession: async (newCtx) => {
          if (kickoff) {
            await newCtx.sendUserMessage(kickoff);
          } else {
            newCtx.ui.notify("✅ New session started (context cleared)", "info");
          }
        },
      });
    },
  });

  pi.registerCommand("prune-agents", {
    description: "Probe all agents, then remove ones that don't respond within 15s",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      if (!connected || !client) {
        ctx.ui.notify("❌ Not connected to pi-mail daemon", "error");
        return;
      }

      const waitSec = parseInt(args.trim(), 10) || 15;

      // 1. Broadcast a probe so live agents get a chance to reply (their pong
      //    updates lastSeen on the daemon side).
      try {
        await client.request({
          type: "broadcast",
          subject: "__probe__",
          body: `Liveness probe — please reply so you are not pruned. You have ${waitSec}s.`,
        });
      } catch {}

      ctx.ui.notify(`🔍 Probe sent — waiting ${waitSec}s for replies…`, "info");

      // 2. Wait for agents to reply.
      await new Promise<void>((r) => setTimeout(r, waitSec * 1000));

      // 3. Prune agents that haven't been seen since before the probe.
      try {
        const resp = await client.request<{ type: string; pruned?: Array<{ agentId: string; agentName: string }> }>({
          type: "prune_silent",
          olderThanMs: (waitSec + 5) * 1000,
        });
        if (resp.type === "pruned") {
          const n = resp.pruned?.length ?? 0;
          const names = resp.pruned?.map((a) => a.agentName).join(", ") ?? "";
          ctx.ui.notify(
            n === 0
              ? "✅ All agents responded — nothing pruned"
              : `🗑️ Pruned ${n} silent agent${n === 1 ? "" : "s"}: ${names}`,
            n === 0 ? "info" : "warn"
          );
        }
      } catch (err: unknown) {
        ctx.ui.notify(`Error pruning: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("mail-status", {
    description: "Show mail federation connection status and unread count",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      if (!connected) {
        ctx.ui.notify("❌ Not connected to pi-mail daemon", "error");
        return;
      }
      const unread = mailbox.filter((m) => !m.read).length;
      ctx.ui.notify(
        `✅ Connected as "${agentName}" (${agentId.slice(0, 8)}) | ${unread} unread`,
        "info"
      );
    },
  });

  // ── Tools ───────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "mail_list",
    label: "Mail: Inbox",
    description: "List all messages in your mail inbox (read and unread)",
    promptSnippet: "List your mail inbox",
    promptGuidelines: [
      "Use mail_list when the user asks about mail, messages, or other agents' communications.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) {
        return { content: [{ type: "text", text: "❌ Not connected to mail daemon" }] };
      }
      try {
        const resp = await client.request<{ type: string; messages?: MailMessage[] }>({
          type: "list_mail",
        });
        if (resp.type !== "mail" || !resp.messages) {
          return {
            content: [{ type: "text", text: `Error: ${(resp as { message?: string }).message ?? "unknown"}` }],
          };
        }
        mailbox = resp.messages;

        if (resp.messages.length === 0) {
          return { content: [{ type: "text", text: "📭 Inbox is empty" }] };
        }

        const lines = resp.messages.map((m) => {
          const status = m.read ? "✓" : "●";
          const time = new Date(m.timestamp).toLocaleString();
          const id = m.id.slice(0, 8);
          return `${status} [${id}] From: ${m.fromName} | Subject: ${m.subject} | ${time}`;
        });

        const unread = resp.messages.filter((m) => !m.read).length;
        const header = `📬 Inbox — ${resp.messages.length} message(s), ${unread} unread\n`;
        return {
          content: [{ type: "text", text: header + "\n" + lines.join("\n") }],
          details: { messages: resp.messages },
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  });

  pi.registerTool({
    name: "mail_read",
    label: "Mail: Read",
    description: "Read a mail message in full by its ID (first 8 chars are enough)",
    promptSnippet: "Read a specific mail message",
    parameters: Type.Object({
      messageId: Type.String({
        description: "Message ID or prefix (from mail_list output, e.g. 'a1b2c3d4')",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const msg = mailbox.find(
        (m) => m.id === params.messageId || m.id.startsWith(params.messageId)
      );
      if (!msg) {
        return {
          content: [{ type: "text", text: `Message not found: ${params.messageId}. Run mail_list first.` }],
        };
      }
      const time = new Date(msg.timestamp).toLocaleString();
      const text = [
        `From:    ${msg.fromName} (${msg.fromId.slice(0, 8)})`,
        `Subject: ${msg.subject}`,
        `Date:    ${time}`,
        `ID:      ${msg.id}`,
        `${"─".repeat(40)}`,
        msg.body,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { message: msg },
      };
    },
  });

  pi.registerTool({
    name: "mail_send",
    label: "Mail: Send",
    description: "Send a mail message to a specific agent by name or ID",
    promptSnippet: "Send mail to a specific agent",
    parameters: Type.Object({
      to: Type.String({
        description: "Recipient agent name or ID (use mail_list_agents to see available agents)",
      }),
      subject: Type.String({ description: "Message subject line" }),
      body: Type.String({ description: "Message body text" }),
      newSession: Type.Optional(Type.Boolean({
        description: "If true, the receiving agent will start a fresh session (cleared context) before acting on this message. Use when sending an unrelated new task.",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) {
        return { content: [{ type: "text", text: "❌ Not connected to mail daemon" }] };
      }
      try {
        const resp = await client.request<{
          type: string;
          messageId?: string;
          message?: string;
        }>({ type: "send", to: params.to, subject: params.subject, body: params.body, newSession: params.newSession });

        if (resp.type === "error") {
          return { content: [{ type: "text", text: `❌ ${resp.message}` }] };
        }
        return {
          content: [
            {
              type: "text",
              text: `✅ Sent to ${params.to} | Subject: "${params.subject}" | ID: ${resp.messageId?.slice(0, 8)}`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  });

  pi.registerTool({
    name: "mail_broadcast",
    label: "Mail: Broadcast",
    description: "Send a mail message to all currently connected agents (excluding yourself)",
    promptSnippet: "Broadcast a message to all connected agents",
    parameters: Type.Object({
      subject: Type.String({ description: "Message subject" }),
      body: Type.String({ description: "Message body" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) {
        return { content: [{ type: "text", text: "❌ Not connected to mail daemon" }] };
      }
      try {
        const resp = await client.request<{
          type: string;
          recipients?: number;
          message?: string;
        }>({ type: "broadcast", subject: params.subject, body: params.body });

        if (resp.type === "error") {
          return { content: [{ type: "text", text: `❌ ${resp.message}` }] };
        }
        const n = resp.recipients ?? 0;
        return {
          content: [
            {
              type: "text",
              text: `📡 Broadcast sent to ${n} agent${n === 1 ? "" : "s"} | Subject: "${params.subject}"`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  });

  pi.registerTool({
    name: "mail_mark_read",
    label: "Mail: Archive",
    description: "Mark a message as read and remove it from your inbox",
    promptSnippet: "Archive a mail message after reading",
    parameters: Type.Object({
      messageId: Type.String({ description: "Message ID or prefix to archive" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const msg = mailbox.find(
        (m) => m.id === params.messageId || m.id.startsWith(params.messageId)
      );
      if (!msg) {
        return {
          content: [{ type: "text", text: `Message not found: ${params.messageId}` }],
        };
      }

      if (!connected || !client) {
        return { content: [{ type: "text", text: "❌ Not connected to mail daemon" }] };
      }

      try {
        const resp = await client.request<{ type: string }>({
          type: "mark_read",
          messageId: msg.id,
        });
        if (resp.type === "ok") {
          mailbox = mailbox.filter((m) => m.id !== msg.id);
          updateStatus();
          return {
            content: [{ type: "text", text: `✅ Archived: "${msg.subject}" from ${msg.fromName}` }],
          };
        }
        return { content: [{ type: "text", text: "Failed to archive message" }] };
      } catch (err: unknown) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  });

  pi.registerTool({
    name: "mail_list_agents",
    label: "Mail: Agents",
    description: "List all agents currently connected to the mail federation",
    promptSnippet: "List connected federation agents",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) {
        return { content: [{ type: "text", text: "❌ Not connected to mail daemon" }] };
      }
      try {
        const resp = await client.request<{ type: string; agents?: Array<AgentInfo & { contextPct?: number | null }> }>({
          type: "list_agents",
        });
        if (resp.type !== "agents" || !resp.agents) {
          return {
            content: [{ type: "text", text: `Error: ${(resp as { message?: string }).message ?? "unknown"}` }],
          };
        }
        if (resp.agents.length === 0) {
          return { content: [{ type: "text", text: "🤝 No agents currently connected" }] };
        }
        const sorted = [...resp.agents].sort(
          (x, y) =>
            projectGroupKey(x.cwd).localeCompare(projectGroupKey(y.cwd)) ||
            x.agentName.localeCompare(y.agentName)
        );
        const lines: string[] = [];
        let prev = "";
        for (const a of sorted) {
          const grp = projectGroupKey(a.cwd);
          if (grp !== prev) {
            prev = grp;
            lines.push(`📁 ${grp}${a.cwd && a.cwd !== grp ? `  (${a.cwd})` : ""}`);
          }
          const self = a.agentId === agentId ? " ← you" : "";
          const upSec = Math.round((Date.now() - a.registeredAt) / 1000);
          const upTime =
            upSec < 60
              ? `${upSec}s`
              : upSec < 3600
              ? `${Math.round(upSec / 60)}m`
              : `${Math.round(upSec / 3600)}h`;
          const ctxStr = a.contextPct != null ? ` ctx=${a.contextPct}%` : "";
          const modelStr = a.model ? `\n    ↳ model: ${a.model}` : "";
          const status = a.status ? `\n    ↳ status: ${a.status}` : "";
          lines.push(`  • ${a.agentName}${self}  [online ${upTime}] id=${a.agentId.slice(0, 8)}${ctxStr}${modelStr}${status}`);
        }
        return {
          content: [
            {
              type: "text",
              text: `🤝 Federation — ${resp.agents.length} agent${resp.agents.length === 1 ? "" : "s"} connected\n\n${lines.join("\n")}`,
            },
          ],
          details: { agents: resp.agents },
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  });

  pi.registerTool({
    name: "mail_set_name",
    label: "Mail: Set Name",
    description:
      "Set your own display name in the mail federation (replaces the auto-generated id-based name). " +
      "Other agents see this name in mail_list_agents and as the sender of your messages.",
    promptSnippet: "Set your mail federation display name",
    parameters: Type.Object({
      name: Type.String({ description: "Your new display name" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const name = params.name.trim();
      if (!name) {
        return { content: [{ type: "text", text: "❌ Name cannot be empty" }] };
      }
      agentName = name;
      nameCustomized = true;
      pi.appendEntry("pi-mail-name", { name });
      if (!connected || !client) {
        return { content: [{ type: "text", text: `⚠️ Name set locally to "${name}" but not connected to daemon` }] };
      }
      try {
        await client.request({ type: "set_name", agentName: name });
        updateStatus(ctx);
        return { content: [{ type: "text", text: `✅ Display name set to "${name}"` }] };
      } catch (err: unknown) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  });

  pi.registerTool({
    name: "mail_set_status",
    label: "Mail: Set Status",
    description:
      "Set your own status line in the mail federation so other agents (e.g. an orchestrator) can see " +
      "what you are working on. Visible to others via mail_list_agents. Pass an empty string to clear it. " +
      "This is not injected into anyone's context automatically — it is only shown on request.",
    promptSnippet: "Set your mail federation status",
    promptGuidelines: [
      "Update mail_set_status when you start or finish a significant task so an orchestrator can track progress.",
      "Keep the status short, e.g. 'implementing auth refactor' or 'idle'.",
    ],
    parameters: Type.Object({
      status: Type.String({ description: "Short status text (empty string clears your status)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const status = params.status.trim();
      agentStatus = status;
      pi.appendEntry("pi-mail-status", { status });
      if (!connected || !client) {
        return { content: [{ type: "text", text: `⚠️ Status set locally but not connected to daemon` }] };
      }
      try {
        await client.request({ type: "set_status", status });
        return {
          content: [
            {
              type: "text",
              text: status ? `✅ Status set to: "${status}"` : `✅ Status cleared`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  });

  // ── Task board tools ────────────────────────────────────────────────────────
  //
  // The daemon hosts a shared kanban board (optionally two-way synced with a
  // Jira sprint). These tools let any agent read and work the board; the daemon
  // handles Jira transitions/comments and mails assignees on assignment/moves.

  interface BoardColumn {
    id: string;
    name: string;
    jiraStatus: string | null;
    instructions: string;
  }

  interface BoardTask {
    id: string;
    key: string | null;
    origin: "jira" | "local";
    summary: string;
    description: string;
    url: string | null;
    jiraStatus: string | null;
    columnId: string;
    assignee: string | null;
    priority: string | null;
    issueType: string | null;
    parentId: string | null;
    parentKey: string | null;
    flagged: { by: string; reason: string; ts: number } | null;
    updatedAt: number;
    progressSince?: number;
    lastProgressTs?: number;
    lastNudgeTs?: number;
    /** Where the task sits: a board column, the shared backlog, or the archive. */
    location?: "board" | "backlog" | "archive";
    /** Issue hierarchy level (local-only; Jira issueType is separate). */
    level?: "epic" | "story" | "task" | "subtask";
    /** Board id of the epic a story belongs to (optional). */
    epicId?: string | null;
    /** Project group that owns this task (cwd basename, e.g. "reader"). */
    group?: string | null;
    activity: Array<{ ts: number; who: string; text: string; kind?: string }>;
  }

  interface BoardStateResp {
    type: string;
    columns?: BoardColumn[];
    tasks?: BoardTask[];
    jiraConfigured?: boolean;
    lastSync?: number;
    syncError?: string | null;
    /** The caller's own project group (null for the human operator). */
    myGroup?: string | null;
    message?: string;
  }

  const errText = (err: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  });
  const notConnected = { content: [{ type: "text" as const, text: "❌ Not connected to mail daemon" }] };

  async function fetchBoard(): Promise<BoardStateResp> {
    if (!connected || !client) throw new Error("Not connected to mail daemon");
    const resp = await client.request<BoardStateResp>({ type: "board_state" });
    if (resp.type !== "board") throw new Error(resp.message ?? "unknown board error");
    return resp;
  }

  function taskLine(t: BoardTask): string {
    const key = t.key ? `${t.key} ` : "";
    const who = t.assignee ? ` → ${t.assignee}` : "";
    const status = t.jiraStatus ? ` [jira: ${t.jiraStatus}]` : "";
    const sub = t.parentKey || t.parentId ? ` ↳sub of ${t.parentKey ?? t.parentId?.slice(0, 8)}` : "";
    const flag = t.flagged ? ` ⚠unclear` : "";
    const lvl = t.level && t.level !== "task" ? ` ${t.level}` : "";
    const loc = t.location === "backlog" ? ` [backlog]` : t.location === "archive" ? ` [archive]` : "";
    const grp = t.group ? ` ⟨${t.group}⟩` : "";
    return `  • [${t.id.slice(0, 8)}] ${key}${t.summary}${lvl}${who}${status}${sub}${loc}${grp}${flag}`;
  }

  /** Result formatting shared by board mutation tools. */
  function boardOpResult(
    resp: { type: string; warning?: string; message?: string; task?: BoardTask },
    okText: string
  ) {
    if (resp.type === "error") {
      return { content: [{ type: "text" as const, text: `❌ ${resp.message}` }] };
    }
    const warn = resp.warning ? `\n⚠️ ${resp.warning}` : "";
    return { content: [{ type: "text" as const, text: `✅ ${okText}${warn}` }], details: { task: resp.task } };
  }

  pi.registerTool({
    name: "board_list_tasks",
    label: "Board: Tasks",
    description:
      "List all tasks on the shared kanban task board, grouped by column, plus the Backlog and Archive pools. " +
      "Shows task id, Jira key, summary, assignee and Jira status. Use 'mine: true' to only see tasks assigned to you. " +
      "By default archived tasks are hidden; pass includeArchived: true to see them. Pass location to filter to 'board'|'backlog'|'archive'.",
    promptSnippet: "List tasks on the shared task board",
    promptGuidelines: [
      "Use board_list_tasks to see sprint/board work, e.g. when asked what to work on or to check task state.",
    ],
    parameters: Type.Object({
      mine: Type.Optional(Type.Boolean({ description: "Only show tasks assigned to you" })),
      location: Type.Optional(Type.String({
        description: "Filter by location: 'board' (on a column), 'backlog', or 'archive'. Omit to see board + backlog (archive hidden unless includeArchived).",
      })),
      level: Type.Optional(Type.String({ description: "Filter to a level: 'epic' | 'story' | 'task' | 'subtask'" })),
      includeArchived: Type.Optional(Type.Boolean({ description: "Include archived tasks (location='archive') in the listing" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const b = await fetchBoard();
        let tasks = b.tasks ?? [];
        if (params.mine) tasks = tasks.filter((t) => t.assignee === agentName);
        if (params.level) tasks = tasks.filter((t) => (t.level ?? "task") === params.level);
        const wantLoc = params.location;
        const showArchive = !!params.includeArchived || wantLoc === "archive";
        // Default view: board + backlog, archive hidden (it's a filter, per operator).
        tasks = tasks.filter((t) => {
          const loc = t.location ?? "board";
          if (wantLoc) return loc === wantLoc;
          return loc !== "archive" || showArchive;
        });
        const cols = b.columns ?? [];
        const lines: string[] = [];
        // Backlog pool (sits above the board) — show first when in default/board view.
        if (!wantLoc || wantLoc === "backlog") {
          const inBacklog = tasks.filter((t) => (t.location ?? "board") === "backlog");
          if (params.mine ? inBacklog.length : true) {
            lines.push(`▌ Backlog — ${inBacklog.length} item${inBacklog.length === 1 ? "" : "s"}`);
            if (!inBacklog.length) lines.push("  (empty)");
            for (const t of inBacklog) lines.push(taskLine(t));
          }
        }
        for (const col of cols) {
          const inCol = tasks.filter((t) => (t.location ?? "board") === "board" && t.columnId === col.id);
          if (params.mine && inCol.length === 0) continue;
          const jira = col.jiraStatus ? ` (jira: ${col.jiraStatus})` : " (board-only)";
          lines.push(`▌ ${col.name}${jira} — ${inCol.length} task${inCol.length === 1 ? "" : "s"}`);
          if (col.instructions) lines.push(`  ↳ instructions: ${col.instructions.split("\n")[0].slice(0, 100)}…`);
          for (const t of inCol) lines.push(taskLine(t));
        }
        if (showArchive && (!wantLoc || wantLoc === "archive")) {
          const inArch = tasks.filter((t) => t.location === "archive");
          lines.push(`▌ Archive (done board) — ${inArch.length} item${inArch.length === 1 ? "" : "s"}`);
          if (!inArch.length) lines.push("  (empty)");
          for (const t of inArch) lines.push(taskLine(t));
        }
        const sync = b.jiraConfigured
          ? b.syncError
            ? `⚠️ Jira sync error: ${b.syncError}`
            : `Jira sync: last ${b.lastSync ? new Date(b.lastSync).toLocaleString() : "never"}`
          : "Jira: not configured (board-only mode)";
        const scope = b.myGroup ? ` · group: ${b.myGroup} (same-group view)` : " · all groups (operator view)";
        return {
          content: [{ type: "text", text: `📋 Task board — ${tasks.length} task(s)\n${sync}${scope}\n\n${lines.join("\n")}` }],
          details: { columns: b.columns, tasks },
        };
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_get_task",
    label: "Board: Task",
    description: "Get full details of one board task by id (8-char prefix ok) or Jira key: description, column, assignee, activity log.",
    promptSnippet: "Read a board task in full",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix (from board_list_tasks) or Jira key (e.g. PROJ-123)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const b = await fetchBoard();
        const s = params.taskId.toLowerCase();
        const t = (b.tasks ?? []).find(
          (x) => x.id === params.taskId || x.id.startsWith(params.taskId) || (x.key && x.key.toLowerCase() === s)
        );
        if (!t) return { content: [{ type: "text", text: `Task not found: ${params.taskId}. Run board_list_tasks first.` }] };
        const col = (b.columns ?? []).find((c) => c.id === t.columnId);
        const loc = t.location ?? "board";
        const locLabel = loc === "backlog" ? "Backlog" : loc === "archive" ? "Archive" : (col?.name ?? t.columnId ?? "?");
        const epic = t.epicId ? (b.tasks ?? []).find((e) => e.id === t.epicId) : null;
        const lines = [
          `Task:     ${t.key ? `[${t.key}] ` : ""}${t.summary}`,
          `Id:       ${t.id}`,
          `Location: ${locLabel}${loc === "board" ? (col?.jiraStatus ? ` (jira: ${col.jiraStatus})` : " (board-only)") : " (off-board)"}`,
          `Level:    ${t.level ?? "task"}${epic ? ` · epic: ${epic.key ?? epic.id.slice(0, 8)} — ${epic.summary}` : ""}`,
          `Assignee: ${t.assignee ?? "—"}`,
          `Group:    ${t.group ?? "—"}${t.assignee ? "" : " (none — visible to all groups)"}`,
          `Origin:   ${t.origin}${t.jiraStatus ? ` | Jira status: ${t.jiraStatus}` : ""}${t.priority ? ` | Priority: ${t.priority}` : ""}${t.issueType ? ` | Type: ${t.issueType}` : ""}`,
          ...(t.parentKey || t.parentId ? [`Parent:   ${t.parentKey ?? t.parentId?.slice(0, 8)}`] : []),
          ...(t.flagged ? [`⚠ FLAGGED UNCLEAR by ${t.flagged.by}: ${t.flagged.reason}`] : []),
          ...(t.url ? [`Jira:     ${t.url}`] : []),
          "─".repeat(40),
          t.description || "(no description)",
        ];
        const children = (b.tasks ?? []).filter((x) => x.parentId === t.id || (t.key && x.parentKey === t.key));
        if (children.length) {
          lines.push("", "## Subtasks");
          for (const c of children) lines.push(taskLine(c));
        }
        if (col?.instructions) lines.push("", `## Column instructions ("${col.name}")`, col.instructions);
        if (t.activity?.length) {
          lines.push("", "## Activity");
          for (const a of t.activity.slice(-15)) {
            const mark = a.kind === "progress" ? " 📈" : "";
            lines.push(`- ${new Date(a.ts).toLocaleString()} — ${a.who}:${mark} ${a.text}`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { task: t } };
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_move_task",
    label: "Board: Move",
    description:
      "Move a board task to another column. Moving into a Jira-mapped column also transitions the Jira issue. " +
      "Moving a task assigned to someone else notifies them by mail (including the column's instructions). " +
      "The column may also be 'backlog' (park off-board in the shared backlog) or 'archive' (the done board — removes the task from its column incl. Done; restorable). Backlog/archive are local-only (never pushed to Jira).",
    promptSnippet: "Move a task on the shared board",
    promptGuidelines: [
      "Move your assigned board task as you progress: to the in-progress column when starting, and onward when done.",
      "Move to 'archive' when a task is finished and you want it off the active board (the done board); it's restorable.",
      "Move to 'backlog' to park a task off-board without archiving it.",
    ],
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      column: Type.String({ description: "Target column name/id, or 'backlog'/'archive'" }),
      note: Type.Optional(Type.String({ description: "Short note recorded in the task's activity log" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) return notConnected;
      try {
        const resp = await client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
          { type: "board_move", taskId: params.taskId, column: params.column, note: params.note },
          30_000
        );
        return boardOpResult(resp, `Moved ${resp.task?.key ?? params.taskId} → ${params.column}`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_comment_task",
    label: "Board: Comment",
    description:
      "Add a comment to a board task's activity log. For Jira-synced tasks the comment is also posted to the Jira issue.",
    promptSnippet: "Comment on a board task",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      text: Type.String({ description: "Comment text" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) return notConnected;
      try {
        const resp = await client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
          { type: "board_comment", taskId: params.taskId, text: params.text },
          30_000
        );
        return boardOpResult(resp, `Comment added to ${resp.task?.key ?? params.taskId}`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_progress_task",
    label: "Board: Progress",
    description:
      "Post a progress update on a board task you're working on. Progress is internal (not posted to Jira); it shows in the task detail view and is folded into the description when the task moves columns, so the next agent inherits a snapshot. Use this to report what's done / what's blocking, especially before moving the task onward.",
    promptSnippet: "Post progress on a board task",
    promptGuidelines: [
      "Post a board_progress_task update before moving a task to the next column, so the next agent (and the operator) see what was done.",
      "Use board_progress_task for work-in-progress notes (kept internal); use board_comment_task for decisions/answers that belong on the Jira issue too.",
    ],
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      text: Type.String({ description: "What you've done since the last update, and anything blocking you" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) return notConnected;
      try {
        const resp = await client.request<{ type: string; message?: string; task?: BoardTask }>(
          { type: "board_progress", taskId: params.taskId, text: params.text },
          30_000
        );
        return boardOpResult(resp, `Progress posted on ${resp.task?.key ?? params.taskId}`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_assign_task",
    label: "Board: Assign",
    description:
      "Assign a board task to an agent (by name, from mail_list_agents). The assignee is mailed the full task package " +
      "including the column's instructions. Pass an empty assignee to unassign. Reassigning a task to a different agent " +
      "automatically clears that agent's context (delivered as a fresh-session task); first assignment only clears context " +
      "when newSession is true.",
    promptSnippet: "Assign a board task to an agent",
    promptGuidelines: [
      "When orchestrating, assign board tasks instead of ad-hoc mail so progress is visible on the board.",
    ],
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      assignee: Type.String({ description: "Agent name to assign (empty string to unassign)" }),
      newSession: Type.Optional(Type.Boolean({
        description: "If true, the assignee starts a fresh session (cleared context) for this task. On reassignment to a different agent this happens automatically regardless.",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) return notConnected;
      try {
        const resp = await client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
          { type: "board_assign", taskId: params.taskId, assignee: params.assignee, newSession: params.newSession },
          30_000
        );
        const who = params.assignee.trim() || "(unassigned)";
        return boardOpResult(resp, `${resp.task?.key ?? params.taskId} assigned to ${who}`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_create_task",
    label: "Board: Create",
    description:
      "Create a new task on the shared board. With 'parent' it becomes a subtask; when the parent is a Jira issue " +
      "(or inJira is true) a real Jira issue is created and kept in sync. Otherwise the task is board-only. " +
      "Pass backlog:true to create straight into the Backlog pool (off-board, local-only). " +
      "Use level to set the issue hierarchy: 'epic' | 'story' | 'task' | 'subtask' (default 'task', or 'subtask' when parent is given). " +
      "A story may reference an epic by id via epicId.",
    promptSnippet: "Create a task on the shared board",
    parameters: Type.Object({
      summary: Type.String({ description: "One-line task summary" }),
      description: Type.Optional(Type.String({ description: "Full task description" })),
      column: Type.Optional(Type.String({ description: "Column name or id (defaults to the parent's column, else the first column). Ignored when backlog:true." })),
      parent: Type.Optional(Type.String({ description: "Parent task id prefix or Jira key — makes this a subtask" })),
      inJira: Type.Optional(Type.Boolean({ description: "Create a Jira issue for a top-level task (needs a project key in board settings)" })),
      level: Type.Optional(Type.String({ description: "Issue level: 'epic' | 'story' | 'task' | 'subtask' (default inferred from parent)" })),
      epicId: Type.Optional(Type.String({ description: "For a story: the board id (or prefix) of its epic" })),
      backlog: Type.Optional(Type.Boolean({ description: "Create in the Backlog pool (off-board, local-only) instead of a column" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) return notConnected;
      try {
        const resp = await client.request<{ type: string; message?: string; task?: BoardTask }>(
          {
            type: "board_create",
            summary: params.summary,
            description: params.description,
            column: params.column,
            parent: params.parent,
            inJira: params.inJira,
            level: params.level,
            epicId: params.epicId,
            backlog: params.backlog,
          },
          30_000
        );
        const jiraNote = resp.task?.key ? ` (Jira: ${resp.task.key})` : "";
        const locNote = resp.task?.location === "backlog" ? " in Backlog" : "";
        return boardOpResult(resp, `Created task [${resp.task?.id.slice(0, 8)}]${jiraNote}${locNote} "${params.summary}"`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_split_task",
    label: "Board: Split",
    description:
      "Subdivide a board task into subtasks. Each subtask lands in the parent's column; for Jira parents they are " +
      "created as real Jira sub-tasks. Use when a task is too big for one pass — then assign the subtasks out.",
    promptSnippet: "Split a board task into subtasks",
    promptGuidelines: [
      "Prefer board_split_task over ad-hoc notes when decomposing a board task — subtasks stay visible and assignable.",
    ],
    parameters: Type.Object({
      taskId: Type.String({ description: "Parent task id prefix or Jira key" }),
      subtasks: Type.Array(
        Type.Object({
          summary: Type.String({ description: "Subtask summary" }),
          description: Type.Optional(Type.String({ description: "Subtask description" })),
        }),
        { description: "Subtasks to create", minItems: 1 }
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) return notConnected;
      const made: string[] = [];
      const failed: string[] = [];
      for (const s of params.subtasks) {
        try {
          const resp = await client.request<{ type: string; message?: string; task?: BoardTask }>(
            { type: "board_create", summary: s.summary, description: s.description, parent: params.taskId },
            30_000
          );
          if (resp.type === "error") failed.push(`"${s.summary}": ${resp.message}`);
          else made.push(`[${resp.task?.id.slice(0, 8)}]${resp.task?.key ? ` ${resp.task.key}` : ""} ${s.summary}`);
        } catch (err: unknown) {
          failed.push(`"${s.summary}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const lines = [
        `${made.length ? "✅" : "❌"} Split ${params.taskId}: ${made.length}/${params.subtasks.length} subtask(s) created`,
        ...made.map((m) => `  • ${m}`),
        ...failed.map((f) => `  ❌ ${f}`),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "board_flag_task",
    label: "Board: Flag",
    description:
      "Flag a board task as unclear (goal/scope/acceptance criteria ambiguous). The human operator is notified by mail " +
      "with your reason. Use BEFORE starting work you'd otherwise have to guess at. Pass clear: true to remove the flag.",
    promptSnippet: "Flag a board task as unclear",
    promptGuidelines: [
      "If an assigned board task is ambiguous, flag it with your questions instead of guessing.",
    ],
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      reason: Type.Optional(Type.String({ description: "What is unclear / your questions (required unless clearing)" })),
      clear: Type.Optional(Type.Boolean({ description: "Remove the unclear flag instead of setting it" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) return notConnected;
      try {
        const resp = await client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
          { type: "board_flag", taskId: params.taskId, reason: params.reason, clear: params.clear },
          30_000
        );
        return boardOpResult(
          resp,
          params.clear
            ? `Cleared unclear flag on ${resp.task?.key ?? params.taskId}`
            : `Flagged ${resp.task?.key ?? params.taskId} as unclear — operator notified`
        );
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_update_task",
    label: "Board: Update",
    description:
      "Update a board task's summary and/or description. For Jira-synced tasks the edit is also pushed to the Jira issue. " +
      "Use this to make a vague task clear (e.g. after refining: goal, scope, acceptance criteria).",
    promptSnippet: "Edit a board task",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      summary: Type.Optional(Type.String({ description: "New summary" })),
      description: Type.Optional(Type.String({ description: "New description" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) return notConnected;
      try {
        const resp = await client.request<{ type: string; message?: string; task?: BoardTask }>(
          { type: "board_update", taskId: params.taskId, summary: params.summary, description: params.description },
          30_000
        );
        return boardOpResult(resp, `Updated ${resp.task?.key ?? params.taskId}`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  // ── Agent spawning (orchestrator surface) ──────────────────────────────────
  //
  // These let an orchestrator bring up a brand-new, long-running pi agent in
  // a chosen working directory (a fresh worker for a project), then drive it
  // with board_assign_task / mail_send newSession:true. The daemon spawns the
  // agent in a detached tmux session (PTY, attachable, survives daemon
  // restarts). Only daemon-spawned sessions can be stopped.

  pi.registerTool({
    name: "mail_spawn_agent",
    label: "Mail: Spawn Agent",
    description:
      "Spawn a fresh, long-running pi agent in a chosen working directory (a new worker for that project). The agent runs in a detached tmux session and registers with the federation within a few seconds; you can then assign it board tasks or mail it (newSession:true) to give it work. Returns the new agent's name. The cwd may be any directory on the filesystem (no allowlist). Use this to scale out orchestration to a new project directory instead of messaging an already-running agent.",
    promptSnippet: "Spawn a fresh pi agent in a directory",
    promptGuidelines: [
      "Use mail_spawn_agent to bring up a new worker in a project dir, then board_assign_task / mail_send(newSession:true) to give it work.",
      "The agent name defaults to <dir-basename>-<id6>; pass a name only if you need a specific one (tmux session name, no '.' or ':').",
    ],
    parameters: Type.Object({
      cwd: Type.String({ description: "Absolute working directory for the new agent (any directory on the filesystem)" }),
      name: Type.Optional(Type.String({ description: "Optional agent/session name (defaults to <dir-basename>-<id6>)" })),
      model: Type.Optional(Type.String({ description: "Optional model, e.g. 'anthropic/claude-sonnet-4' (defaults to pi's default)" })),
      kickoff: Type.Optional(Type.String({ description: "Optional kickoff prompt; delivered to the new agent as a new-session task once it registers" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) return notConnected;
      try {
        const resp = await client.request<{ type: string; name?: string; message?: string }>(
          { type: "spawn", cwd: params.cwd, name: params.name, model: params.model, kickoff: params.kickoff },
          45_000
        );
        if (resp.type === "error") return { content: [{ type: "text" as const, text: `❌ ${resp.message}` }] };
        const name = resp.name ?? "";
        const kick = params.kickoff ? ` (kickoff delivered as new-session task)` : "";
        return {
          content: [{ type: "text" as const, text: `✅ Spawned agent '${name}' in ${params.cwd}${kick}. It will appear in mail_list_agents shortly; assign it work with board_assign_task or mail_send(newSession:true).` }],
          details: { name, cwd: params.cwd },
        };
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "mail_stop_agent",
    label: "Mail: Stop Agent",
    description:
      "Stop a daemon-spawned agent (kills its tmux session). Only stops agents the daemon itself spawned via mail_spawn_agent — never an operator-launched agent. Use to tear down a worker when its work is done.",
    promptSnippet: "Stop a spawned agent",
    promptGuidelines: [
      "Use mail_stop_agent only for agents you spawned with mail_spawn_agent; it will refuse operator-launched agents.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the daemon-spawned agent to stop" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!connected || !client) return notConnected;
      try {
        const resp = await client.request<{ type: string; message?: string }>(
          { type: "spawn_stop", name: params.name },
          15_000
        );
        if (resp.type === "error") return { content: [{ type: "text" as const, text: `❌ ${resp.message}` }] };
        return { content: [{ type: "text" as const, text: `✅ Stopped agent '${params.name}'` }] };
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });
}
