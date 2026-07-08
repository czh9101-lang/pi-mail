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
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { MailClient, projectGroupKey } from "./lib/mail-client.js";
import { ensureDaemonAndConnect, isDaemonAlive, sleep } from "./lib/daemon-bootstrap.js";
import { registerCommands } from "./lib/commands.js";
import { registerMailTools } from "./lib/mail-tools.js";
import { registerBoardAndSpawnTools } from "./lib/board-tools.js";
import type { MailMessage, AgentInfo } from "./lib/mail-client.js";

// jiti provides __dirname for directory-based extensions
declare const __dirname: string;

// ── Config ────────────────────────────────────────────────────────────────────

const SOCKET_PATH = join(homedir(), ".pi", "agent", "mail-daemon.sock");
const PID_PATH = join(homedir(), ".pi", "agent", "mail-daemon.pid");
const DAEMON_SCRIPT = join(__dirname, "daemon.mjs");

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

  // Live (getter/setter-backed) state alias passed to the extracted command +
  // tool modules (lib/commands, lib/mail-tools, lib/board-tools). Getters+setters
  // over the `let` vars above so inline code (bare `agentName`) and the
  // extracted modules (st.agentName) always read/write the SAME bindings.
  const st = {
    get client() { return client; },
    get connected() { return connected; },
    get agentId() { return agentId; },
    get agentName() { return agentName; }, set agentName(v) { agentName = v; },
    get agentStatus() { return agentStatus; }, set agentStatus(v) { agentStatus = v; },
    get agentModel() { return agentModel; },
    get agentCwd() { return agentCwd; },
    get nameCustomized() { return nameCustomized; }, set nameCustomized(v) { nameCustomized = v; },
    get mailbox() { return mailbox; },
    get suppressReconnect() { return suppressReconnect; }, set suppressReconnect(v) { suppressReconnect = v; },
    get latestCtx() { return latestCtx; }, set latestCtx(v) { latestCtx = v; },
    get updateStatus() { return updateStatus; },
    get connectToDaemon() { return connectToDaemon; },
    get clearReconnect() { return clearReconnect; },
    notConnected: { content: [{ type: "text" as const, text: "❌ Not connected to mail daemon" }] },
    pidPath: PID_PATH,
  };

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
      client = await ensureDaemonAndConnect(SOCKET_PATH, DAEMON_SCRIPT, PID_PATH);

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

  // Slash commands, mail tools, and board/spawn tools are extracted into
  // lib/commands.ts, lib/mail-tools.ts, lib/board-tools.ts. All share this
  // live client/connection state (st is getter-backed over the closure vars).
  registerCommands(pi, st);
  registerMailTools(pi, st);
  registerBoardAndSpawnTools(pi, st);
}
