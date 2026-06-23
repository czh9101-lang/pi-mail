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
import { existsSync, readFileSync } from "node:fs";

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

async function ensureDaemonAndConnect(
  socketPath: string,
  daemonScript: string
): Promise<MailClient> {
  // Try existing daemon first
  const existing = await tryConnect(socketPath);
  if (existing) return existing;

  // Spawn daemon as detached process
  const child = spawn("node", [daemonScript], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait up to 3 s for the socket to appear
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (existsSync(socketPath)) {
      const c = await tryConnect(socketPath);
      if (c) return c;
    }
  }

  throw new Error("Failed to connect to pi-mail daemon after 3 s");
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let client: MailClient | null = null;
  let agentId = randomUUID();  // may be overwritten from session entries in session_start
  let agentName = `${basename(process.cwd()) || "pi-agent"}-${agentId.slice(0, 6)}`;
  let agentStatus = "";
  // True once the agent/user has chosen an explicit name (vs. the auto slug)
  let nameCustomized = false;
  // Track whether agentId was restored from a previous session (prevents double-counting on reload)
  let agentIdRestored = false;
  let mailbox: MailMessage[] = [];
  let connected = false;
  let reconnecting = false;
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

  async function _connectToDaemon(): Promise<void> {
    try {
      client = await ensureDaemonAndConnect(SOCKET_PATH, DAEMON_SCRIPT);

      client.onNewMail = (msg) => {
        if (mailbox.some((m) => m.id === msg.id)) return; // already known
        mailbox.push(msg);
        updateStatus();
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
            : `Please handle this mail and use \`mail_mark_read\` to archive it when done.`;
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
        // Attempt reconnect with backoff
        if (!reconnecting) {
          reconnecting = true;
          setTimeout(async () => {
            reconnecting = false;
            await connectToDaemon().catch(() => {});
          }, 3000);
        }
      };

      // Register with the daemon
      const resp = await client.request<{ type: string; agentId?: string }>({
        type: "register",
        agentId,
        agentName,
      });

      if (resp.type === "registered") {
        connected = true;
        // Flush any messages that were buffered while we were disconnected
        client.flushWriteQueue();
        // Restore status on the daemon side after (re)connecting
        if (agentStatus) {
          try {
            await client.request({ type: "set_status", status: agentStatus });
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
            const kickoff = msg.body?.trim() || "";
            pi.sendUserMessage(`/new-task ${kickoff}`.trimEnd(), { deliverAs: "followUp" });
          }
        }
        updateStatus();
      }
    } catch {
      connected = false;
      client = null;
    }
  }

  async function disconnectFromDaemon(cleanExit: boolean): Promise<void> {
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
      `Do NOT skip status updates — the orchestrator relies on them to coordinate work.`;

    const unread = mailbox.filter((m) => !m.read);
    if (unread.length === 0) {
      return { systemPrompt: event.systemPrompt + identityGuidance };
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
        `\n\nYou currently have ${unread.length} unread mail message${plural}${broadcastNote}. ` +
        `Check your inbox with mail_list when relevant to the current task.`,
    };
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
          await client.request({ type: "register", agentId, agentName });
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

      // Disconnect our own client first (without clearing our mailbox)
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
          const lines = resp.agents.map((a) => {
            const self = a.agentId === agentId ? " (you)" : "";
            const upSec = Math.round((Date.now() - a.registeredAt) / 1000);
            const up = upSec < 60 ? `${upSec}s` : upSec < 3600 ? `${Math.round(upSec / 60)}m` : `${Math.round(upSec / 3600)}h`;
            const ctx2 = a.contextPct != null ? ` ctx=${a.contextPct}%` : "";
            const st = a.status ? ` — ${a.status}` : "";
            return `${a.agentName}${self} [${up}]${ctx2}${st}`;
          });
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
            agentRows = resp.agents;
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
            theme.fg("dim", "status");
          lines.push(" " + colHdr);
          lines.push(hr);

          if (agentRows.length === 0) {
            lines.push(theme.fg("muted", "  (no agents)"));
          } else {
            agentRows.forEach((a, i) => {
              const self = a.agentId === agentId;
              const selfMark = self ? theme.fg("accent", " ←") : "   ";
              const rawName = a.agentName + (self ? "" : "");
              const name = self
                ? theme.fg("accent", pad(rawName, 24)) + selfMark
                : theme.fg("text", pad(rawName, 24)) + selfMark;
              const up = theme.fg("dim", pad(fmtUptime(a.registeredAt), 5));
              const ctxStr = " " + fmtCtx(a.contextPct, theme) + " ";
              const status = a.status
                ? theme.fg(i === selectedIdx ? "text" : "muted", a.status)
                : theme.fg("dim", "—");

              const row = name + " " + up + ctxStr + status;
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
        const lines = resp.agents.map((a) => {
          const self = a.agentId === agentId ? " ← you" : "";
          const upSec = Math.round((Date.now() - a.registeredAt) / 1000);
          const upTime =
            upSec < 60
              ? `${upSec}s`
              : upSec < 3600
              ? `${Math.round(upSec / 60)}m`
              : `${Math.round(upSec / 3600)}h`;
          const ctxStr = a.contextPct != null ? ` ctx=${a.contextPct}%` : "";
          const status = a.status ? `\n    ↳ status: ${a.status}` : "";
          return `• ${a.agentName}${self}  [online ${upTime}] id=${a.agentId.slice(0, 8)}${ctxStr}${status}`;
        });
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
}
