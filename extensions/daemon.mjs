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
import { spawn } from "node:child_process";
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

// ── Task board + Jira sync ───────────────────────────────────────────────────
//
// A kanban-style task board shared by the whole federation, with optional
// two-way sync to a Jira sprint. Columns are configurable; a column may map to
// a Jira status (moves trigger the matching Jira transition) or be board-only
// (e.g. "Refine", "Review") with custom instructions that are mailed to the
// assignee. Assigning a task mails the assignee a full task package.

const BOARD_FILE = path.join(AGENT_DIR, "mail-board.json");
const JIRA_SYNC_INTERVAL_MS = 60_000;
const DEFAULT_JQL = "assignee = currentUser() AND sprint in openSprints() ORDER BY rank";

// ── Agent spawning (tmux) ─────────────────────────────────────────────────────
//
// The daemon can bring up a brand-new, long-running pi agent process in a
// chosen working directory, so the operator (via the board UI) and
// orchestrators (via the mail_spawn_agent tool) can spin up fresh workers
// without opening a terminal. Each spawned agent runs in its own detached
// tmux session, which gives it a PTY (interactive pi works unmodified), is
// attachable (`tmux attach -t <name>`), and survives daemon restarts — the
// daemon only tracks the session name; the tmux server owns the process.
//
// The set of daemon-spawned sessions is persisted so a /restart-mail-daemon
// keeps tracking them (and stop() only ever kills sessions the daemon itself
// spawned, never an operator-launched one).

const SPAWN_FILE = path.join(AGENT_DIR, "mail-spawn.json");
const PI_BIN = process.env.PI_MAIL_PI_BIN || "pi";
const TMUX_BIN = process.env.PI_MAIL_TMUX_BIN || "tmux";
// How long to wait for a freshly-spawned agent to register with the daemon
// before returning (the agent keeps running regardless; this only gates the
// synchronous "is it up yet?" answer + the kickoff delivery).
const SPAWN_REGISTER_TIMEOUT_MS = parseInt(process.env.PI_MAIL_SPAWN_TIMEOUT || "20000", 10);

const DEFAULT_COLUMNS = [
  {
    id: "refine",
    name: "Refine",
    jiraStatus: null,
    instructions:
      "Board-only column. Refine this task: clarify the goal, acceptance criteria and implementation approach. " +
      "Post the refined spec as a board comment, then move the task to 'To Do'.",
  },
  { id: "todo", name: "To Do", jiraStatus: "To Do", instructions: "" },
  { id: "inprogress", name: "In Progress", jiraStatus: "In Progress", instructions: "" },
  {
    id: "review",
    name: "Review",
    jiraStatus: null,
    instructions:
      "Board-only column. Review the implementation for this task: correctness, tests, scope. " +
      "Post findings as a board comment. If clean, move to 'Done'; otherwise move back to 'In Progress' with what must change.",
  },
  { id: "done", name: "Done", jiraStatus: "Done", instructions: "" },
];

/**
 * @typedef {{ id: string, name: string, jiraStatus: string | null, instructions: string }} BoardColumn
 * @typedef {{ id: string, key: string | null, origin: "jira" | "local", summary: string,
 *             description: string, url: string | null, jiraStatus: string | null,
 *             columnId: string, assignee: string | null, priority: string | null,
 *             issueType: string | null, updatedAt: number,
 *             parentId: string | null, parentKey: string | null,
 *             pinned?: boolean, flagged: { by: string, reason: string, ts: number } | null,
 *             knownCommentIds?: string[],
 *             progressSince?: number, lastProgressTs?: number, lastNudgeTs?: number,
 *             location: "board" | "backlog" | "archive",
 *             level: "epic" | "story" | "task" | "subtask",
 *             epicId?: string | null,
 *             group?: string | null,
 *             activity: Array<{ ts: number, who: string, text: string, kind?: string }> }} BoardTask
 *
 * parentId/parentKey — subtask linkage (board id and Jira key of the parent).
 * pinned — created in Jira from the board; kept synced even when it doesn't
 *          match the sprint JQL (fetched individually).
 * flagged — the "task is unclear" marker; set/cleared via board_flag.
 * knownCommentIds — Jira comment ids already mirrored into activity (dedup).
 * progressSince — ts lower bound for progress entries folded into the
 *                 description on the last move; advanced to now on each fold.
 * lastProgressTs — ts of the most recent kind:"progress" activity entry.
 * lastNudgeTs — ts of the most recent progress-nudge mail, for dedup.
 * location — where the task sits: "board" (a kanban column, columnId set),
 *            "backlog" (the shared backlog pool above the board, columnId null),
 *            or "archive" (the "done board", columnId null). Backlog + archive
 *            are LOCAL-ONLY — never pushed to Jira; Jira sync won't override a
 *            local backlog/archive placement.
 * level — issue hierarchy: epic > story > (task|subtask). Stories may carry an
 *         epicId pointing at their epic. Subtasks have a parentId (split).
 *         Local-only metadata (Jira issueType is synced separately as-is).
 * epicId — board id of the epic a story belongs to (optional; epics/stories
 *          are a local hierarchy layer, not a Jira epic-link).
 * group — the project group that owns this task (e.g. "reader",
 *         "secondbrain"). Snapshot stamped at create (creator's group) and
 *         re-stamped on assignment (assignee's group). When unset, derived
 *         live from the assignee's cwd basename. Drives same-group-only
 *         visibility for agents; the human operator sees every group.
 */
let board = {
  config: {
    baseUrl: process.env.JIRA_BASE_URL || "",
    email: process.env.JIRA_EMAIL || "",
    apiToken: process.env.JIRA_API_TOKEN || "",
    jql: process.env.JIRA_JQL || DEFAULT_JQL,
    // Project + issue types used when creating issues from the board.
    projectKey: process.env.JIRA_PROJECT_KEY || "",
    issueType: "Task",
    subtaskIssueType: "Sub-task",
    // Progress-nudge: mail in-progress assignees who haven't posted progress
    // in a while. Disableable + tunable from the board config endpoint.
    nudgeEnabled: true,
    nudgeIntervalMin: 30,
  },
  /** @type {BoardColumn[]} */
  columns: DEFAULT_COLUMNS,
  /** @type {BoardTask[]} */
  tasks: [],
  lastSync: 0,
  /** @type {string | null} */
  syncError: null,
};

let boardPersistTimer = null;
function schedulePersistBoard() {
  if (boardPersistTimer) return;
  boardPersistTimer = setTimeout(() => {
    boardPersistTimer = null;
    flushBoard();
  }, 300);
}
function flushBoard() {
  try {
    fs.writeFileSync(BOARD_FILE, JSON.stringify(board), { mode: 0o600 });
  } catch (e) {
    log(`board persist failed: ${e.message}`);
  }
}

function loadBoard() {
  try {
    const saved = JSON.parse(fs.readFileSync(BOARD_FILE, "utf8"));
    if (saved && typeof saved === "object") {
      // Saved config wins per-field; env vars remain fallback defaults.
      for (const k of ["baseUrl", "email", "apiToken", "jql", "projectKey", "issueType", "subtaskIssueType", "nudgeEnabled", "nudgeIntervalMin"]) {
        if (saved.config?.[k]) board.config[k] = saved.config[k];
      }
      if (Array.isArray(saved.columns) && saved.columns.length > 0) board.columns = saved.columns;
      if (Array.isArray(saved.tasks)) board.tasks = saved.tasks;
      if (typeof saved.lastSync === "number") board.lastSync = saved.lastSync;
      // Backfill location/level for tasks saved before the backlog/archive +
      // epic/story hierarchy existed. Defaults: on-board, level inferred from
      // parentage (subtask if it has a parent, else task). Lossless.
      for (const t of board.tasks) {
        if (!t.location) t.location = "board";
        if (!t.level) t.level = t.parentId || t.parentKey ? "subtask" : "task";
        if (t.epicId === undefined) t.epicId = null;
        // group is left as-is when stamped; unset tasks derive it live from
        // their assignee (see taskGroup), so no backfill needed.
      }
    }
  } catch {
    // No board file yet — defaults apply.
  }
}

function jiraCfg() {
  const c = board.config;
  return c.baseUrl && c.email && c.apiToken ? c : null;
}

function findBoardTask(spec) {
  if (!spec) return null;
  const s = String(spec);
  return (
    board.tasks.find((t) => t.id === s || t.id.startsWith(s)) ??
    board.tasks.find((t) => t.key && t.key.toLowerCase() === s.toLowerCase()) ??
    null
  );
}

function findBoardColumn(spec) {
  if (!spec) return null;
  const s = String(spec).toLowerCase();
  return (
    board.columns.find((c) => c.id.toLowerCase() === s) ??
    board.columns.find((c) => c.name.toLowerCase() === s) ??
    null
  );
}

/** Map a Jira issue type name onto our local issue level. Best-effort; unknown
 *  types default to "task". Purely a display/local hint — the real Jira issue
 *  type is kept on task.issueType untouched. */
function levelFromIssueType(name) {
  const n = String(name ?? "").toLowerCase();
  if (/^epic$/.test(n)) return "epic";
  if (/story/.test(n) || /^(user story)$/.test(n)) return "story";
  if (/sub[- ]?task/.test(n)) return "subtask";
  return "task";
}

function taskActivity(task, who, text, kind) {
  task.activity.push({ ts: Date.now(), who, text, ...(kind ? { kind } : {}) });
  if (task.activity.length > 50) task.activity.splice(0, task.activity.length - 50);
  task.updatedAt = Date.now();
  if (kind === "progress") task.lastProgressTs = task.updatedAt;
}

/** Activity entries with kind "progress" that have been recorded since the
 *  last fold (>= progressSince). Used by boardMove to fold a summary of recent
 *  progress into the task description when it moves columns. */
function progressEntriesSince(task) {
  const since = task.progressSince ?? 0;
  return (task.activity ?? []).filter((a) => (a.kind ?? "comment") === "progress" && a.ts >= since);
}

// ── Project grouping ────────────────────────────────────────────────────────
//
// Tasks are partitioned by "group" — the project group (cwd basename, e.g.
// "reader", "secondbrain") that owns them. An agent only sees/moves tasks in
// its own group; the human operator sees every group. The group is stamped on
// a task at create (the creator's group) and re-stamped on assignment (the
// assignee's group); when no stamp is present it is derived live from the
// assignee's cwd basename. Tasks with neither a stamp nor an assignable
// assignee have group null and are visible to everyone (so nothing historical
// gets hidden).

/** Project group (cwd basename) for a registered agent id. */
function agentGroup(agentId) {
  if (agentId === HUMAN_AGENT_ID) return null;
  const cwd = agents.get(agentId)?.info.cwd;
  if (!cwd) return null;
  return path.basename(cwd) || cwd;
}

/** Resolve an assignee name (as stored on a task) back to a live agent id,
 *  then to its project group. Returns null when unresolvable. */
function groupForName(name) {
  if (!name) return null;
  const id = resolveTarget(name);
  return id ? agentGroup(id) : null;
}

/** The effective group a task belongs to: stamped group, else derived live
 *  from the assignee's project, else null (visible to all). */
function taskGroup(task) {
  if (task.group) return task.group;
  return groupForName(task.assignee);
}

/** Whether actor agentId may see/modify task (same group; human sees all;
 *  ungrouped tasks are visible to all). */
function canAccessGroup(actorId, task) {
  if (actorId === HUMAN_AGENT_ID) return true;
  const g = taskGroup(task);
  if (!g) return true;
  return g === agentGroup(actorId);
}

function boardState(actorId) {
  // Agents only see their own group's tasks; the human operator sees all.
  // Ungrouped tasks (no stamped group and no derivable assignee group) are
  // shown to everyone so historical data isn't hidden.
  const tasks = actorId && actorId !== HUMAN_AGENT_ID
    ? board.tasks.filter((t) => canAccessGroup(actorId, t))
    : board.tasks;
  return {
    columns: board.columns,
    tasks,
    jiraConfigured: !!jiraCfg(),
    lastSync: board.lastSync,
    syncError: board.syncError,
    myGroup: agentGroup(actorId) ?? null,
  };
}

/** Human-readable label for where a task sits: a column name, or
 *  "Backlog"/"Archive" for off-board tasks. */
function taskLocationLabel(task) {
  if (task.location === "backlog") return "Backlog";
  if (task.location === "archive") return "Archive";
  const col = board.columns.find((c) => c.id === task.columnId);
  return col?.name ?? "?";
}

/** Mail body sent to an assignee on assignment or when their task is moved. */
function taskMailBody(task, column, actorName) {
  const locLabel = taskLocationLabel(task);
  const isOffBoard = task.location === "backlog" || task.location === "archive";
  const lines = [
    `Task: ${task.key ? `[${task.key}] ` : ""}${task.summary}`,
    `Column: ${locLabel}${
      isOffBoard ? " (off-board location)" : column?.jiraStatus ? ` (Jira status: ${column.jiraStatus})` : " (board-only column, no Jira status)"
    }`,
  ];
  if (task.url) lines.push(`Jira: ${task.url}`);
  if (task.parentKey || task.parentId) {
    const parent = board.tasks.find((t) => t.id === task.parentId || (task.parentKey && t.key === task.parentKey));
    lines.push(`Subtask of: ${task.parentKey ?? parent?.id.slice(0, 8) ?? "?"}${parent ? ` — ${parent.summary}` : ""}`);
  }
  if (task.flagged) lines.push(`⚠ Flagged unclear by ${task.flagged.by}: ${task.flagged.reason}`);
  lines.push(`Board task id: ${task.id.slice(0, 8)}`);
  lines.push("", "## Description", task.description || "(no description)");
  const children = board.tasks.filter((t) => t.parentId === task.id || (task.key && t.parentKey === task.key));
  if (children.length) {
    lines.push("", "## Subtasks");
    for (const c of children) {
      const col = board.columns.find((x) => x.id === c.columnId);
      lines.push(`- [${c.id.slice(0, 8)}]${c.key ? ` ${c.key}` : ""} ${c.summary} (${col?.name ?? "?"}${c.assignee ? `, ${c.assignee}` : ""})`);
    }
  }
  if (column?.instructions) {
    lines.push("", `## Column instructions ("${column.name}")`, column.instructions);
  }
  lines.push(
    "",
    "## Before you start",
    `Check the task is actually clear: goal, scope, acceptance criteria. If anything is ambiguous, do NOT guess — ` +
      `post your questions with board_comment_task, mark it with board_flag_task({ taskId: "${task.id.slice(0, 8)}", reason: "..." }) ` +
      `(the operator is notified), and mail "${actorName}". Only start once the task is clear.`,
    "",
    "## Working this task",
    `- board_get_task({ taskId: "${task.id.slice(0, 8)}" }) — full details and activity log`,
    `- board_move_task({ taskId: "${task.id.slice(0, 8)}", column: "<name>" }) — move as you progress. Columns: ${board.columns
      .map((c) => c.name)
      .join(", ")}`,
    `- board_comment_task({ taskId: "${task.id.slice(0, 8)}", text: "..." }) — log progress${
      task.origin === "jira" ? " (also posted to the Jira issue)" : ""
    }`,
    `- board_progress_task({ taskId: "${task.id.slice(0, 8)}", text: "..." }) — post a work-in-progress note (internal; folded into the description when the task moves). Use this before moving the task onward and if a daemon nudge reminds you.`,
    `- board_split_task({ taskId: "${task.id.slice(0, 8)}", subtasks: [...] }) — subdivide into subtasks${
      task.origin === "jira" ? " (created as real Jira sub-tasks)" : ""
    } if the task is too big for one pass`,
    `- When finished: move the task to the appropriate column and mail a short summary to "${actorName}".`
  );
  return lines.join("\n");
}

/** Notify a task's assignee by mail. Non-fatal if the assignee is offline. */
function notifyAssignee(actorId, task, subjectPrefix, opts = {}) {
  if (!task.assignee) return { mailed: false };
  const column = board.columns.find((c) => c.id === task.columnId) ?? null;
  const actor = agentDisplayName(actorId);
  const r = sendMail(
    actorId,
    task.assignee,
    `${subjectPrefix}: ${task.key ? `[${task.key}] ` : ""}${task.summary}`,
    taskMailBody(task, column, actor),
    opts
  );
  if (r.error) {
    taskActivity(task, "board", `could not mail ${task.assignee}: ${r.error}`);
    return { mailed: false, warning: r.error };
  }
  return { mailed: true };
}

// ── Jira client ──────────────────────────────────────────────────────────────

async function jiraFetch(pathname, { method = "GET", body } = {}) {
  const cfg = jiraCfg();
  if (!cfg) throw new Error("Jira is not configured");
  const auth = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64");
  const res = await fetch(cfg.baseUrl.replace(/\/+$/, "") + pathname, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira ${method} ${pathname.split("?")[0]} → HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const txt = await res.text().catch(() => "");
  return txt ? JSON.parse(txt) : {};
}

/** Extract plain text from an Atlassian Document Format node. */
function adfToText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const kids = (node.content ?? []).map(adfToText).join("");
  const blocky = ["paragraph", "heading", "listItem", "codeBlock", "blockquote"];
  return blocky.includes(node.type) ? kids + "\n" : kids;
}

function textToAdf(text) {
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] }));
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [{ type: "text", text: " " }] }],
  };
}

const JIRA_FIELDS = "summary,description,status,assignee,priority,issuetype,updated,parent,comment";

async function jiraSearch(jql) {
  const issues = [];
  let pageToken = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ jql, maxResults: "100", fields: JIRA_FIELDS });
    if (pageToken) qs.set("nextPageToken", pageToken);
    const data = await jiraFetch(`/rest/api/3/search/jql?${qs}`);
    issues.push(...(data.issues ?? []));
    if (!data.nextPageToken || (data.issues ?? []).length === 0) break;
    pageToken = data.nextPageToken;
  }
  return issues;
}

/** Transition a Jira issue to the named status. Requires a valid transition. */
async function jiraTransitionTo(task, statusName) {
  const data = await jiraFetch(`/rest/api/3/issue/${task.key}/transitions`);
  const tr = (data.transitions ?? []).find(
    (t) => (t.to?.name ?? "").toLowerCase() === statusName.toLowerCase()
  );
  if (!tr) {
    throw new Error(
      `no Jira transition to "${statusName}" from "${task.jiraStatus}" (available: ${(data.transitions ?? [])
        .map((t) => t.to?.name)
        .filter(Boolean)
        .join(", ") || "none"})`
    );
  }
  await jiraFetch(`/rest/api/3/issue/${task.key}/transitions`, {
    method: "POST",
    body: { transition: { id: tr.id } },
  });
  task.jiraStatus = statusName;
}

/** @returns {Promise<string | null>} the created Jira comment id */
async function jiraAddComment(key, text) {
  const r = await jiraFetch(`/rest/api/3/issue/${key}/comment`, {
    method: "POST",
    body: { body: textToAdf(text) },
  });
  return r?.id ?? null;
}

/** Create a Jira issue (optionally a sub-task under parentKey). @returns the new key */
async function jiraCreateIssue({ projectKey, summary, description, issueType, parentKey }) {
  const r = await jiraFetch("/rest/api/3/issue", {
    method: "POST",
    body: {
      fields: {
        project: { key: projectKey },
        summary,
        issuetype: { name: issueType },
        ...(description ? { description: textToAdf(description) } : {}),
        ...(parentKey ? { parent: { key: parentKey } } : {}),
      },
    },
  });
  return r.key;
}

async function jiraUpdateIssue(key, { summary, description }) {
  const fields = {};
  if (typeof summary === "string") fields.summary = summary;
  if (typeof description === "string") fields.description = textToAdf(description);
  if (!Object.keys(fields).length) return;
  await jiraFetch(`/rest/api/3/issue/${key}`, { method: "PUT", body: { fields } });
}

/** Mirror Jira comments into the task's activity log (deduped by comment id). */
function importJiraComments(task, commentField) {
  const comments = commentField?.comments ?? [];
  if (!comments.length) return;
  task.knownCommentIds ??= [];
  for (const c of comments) {
    if (!c?.id || task.knownCommentIds.includes(c.id)) continue;
    task.knownCommentIds.push(c.id);
    const text = adfToText(c.body).trim();
    if (!text) continue;
    task.activity.push({
      ts: Date.parse(c.created) || Date.now(),
      who: `${c.author?.displayName ?? "someone"} (jira)`,
      text,
    });
  }
  task.activity.sort((a, b) => a.ts - b.ts);
  if (task.activity.length > 50) task.activity.splice(0, task.activity.length - 50);
  if (task.knownCommentIds.length > 200) task.knownCommentIds.splice(0, task.knownCommentIds.length - 200);
}

// ── Progress nudge ─────────────────────────────────────────────────────────

/**
 * Periodically mail in-progress assignees a one-line reminder when they
 * haven't posted a progress update in a while. Non-fatal: if the assignee is
 * offline sendMail just returns an error and we move on. One nudge per gap
 * is enforced via task.lastNudgeTs.
 */
function nudgeIdleTasks() {
  if (board.config.nudgeEnabled === false) return;
  const intervalMs = Math.max(1, (board.config.nudgeIntervalMin ?? 30)) * 60_000;
  const now = Date.now();
  for (const task of board.tasks) {
    if (!task.assignee) continue;
    const col = board.columns.find((c) => c.id === task.columnId);
    // "In progress" = a column mapped to a Jira status whose name suggests
    // active work, OR any non-board-only column between To Do and Done. We
    // keep it simple: the column's jiraStatus is one of the in-progress
    // states, or (board-only fallback) the column id is "inprogress".
    const inProgress =
      (col?.jiraStatus && /in[- ]?progress/i.test(col.jiraStatus)) ||
      col?.id === "inprogress";
    if (!inProgress) continue;
    const last = task.lastProgressTs ?? task.progressSince ?? 0;
    // Don't nudge if there's been progress, or a nudge, within the interval.
    if (now - last < intervalMs) continue;
    if (task.lastNudgeTs && now - task.lastNudgeTs < intervalMs) continue;
    const r = sendMail(
      HUMAN_AGENT_ID,
      task.assignee,
      `Progress check-in: ${task.key ? `[${task.key}] ` : ""}${task.summary}`,
      [
        `Quick nudge: you're working on "${task.summary}" (${col?.name ?? "?"}) but haven't posted a progress update in a while.`,
        `Run board_progress_task({ taskId: "${task.id.slice(0, 8)}", text: "..." }) with what you've done / what's blocking you.`,
        "",
        `This keeps the board in sync for the next agent (and folds into the description when the task moves). No reply needed if you're just heads-down — posting progress clears this nudge.`,
      ].join("\n")
    );
    task.lastNudgeTs = now;
    if (!r.error) taskActivity(task, "board", `nudged ${task.assignee} for a progress update`);
  }
  schedulePersistBoard();
}

// ── Jira sync loop (pull) ────────────────────────────────────────────────────

let boardSyncing = false;
async function syncBoard(reason = "interval") {
  const cfg = jiraCfg();
  if (!cfg || boardSyncing) return;
  boardSyncing = true;
  try {
    const issues = await jiraSearch(cfg.jql || DEFAULT_JQL);
    const have = new Set(issues.map((i) => i.key));

    // Also pull subtasks of matched issues — they usually don't match the
    // sprint/assignee JQL themselves but belong on the board under the parent.
    const parentKeys = [...have];
    for (let i = 0; i < parentKeys.length; i += 50) {
      const chunk = parentKeys.slice(i, i + 50);
      const subs = await jiraSearch(`parent in (${chunk.join(",")})`);
      for (const s of subs) {
        if (!have.has(s.key)) {
          have.add(s.key);
          issues.push(s);
        }
      }
    }

    // Pinned tasks (created in Jira from the board) are synced individually so
    // they stay on the board even when they don't match the JQL. Skip tasks in
    // backlog/archive — those are local-only locations Jira can't see.
    for (const t of board.tasks) {
      if (t.origin !== "jira" || !t.pinned || have.has(t.key)) continue;
      if (t.location === "backlog" || t.location === "archive") continue;
      try {
        const iss = await jiraFetch(`/rest/api/3/issue/${t.key}?fields=${JIRA_FIELDS}`);
        have.add(iss.key);
        issues.push(iss);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) {
          // Deleted in Jira — let the not-seen filter below remove it.
          log(`board sync: pinned ${t.key} was deleted in Jira`);
        } else {
          have.add(t.key); // transient error: keep the task, retry next sync
        }
      }
    }

    const fallbackCol = board.columns.find((c) => c.jiraStatus) ?? board.columns[0];
    const seen = new Set();
    for (const iss of issues) {
      seen.add(iss.key);
      const f = iss.fields ?? {};
      const status = f.status?.name ?? "";
      const mapped = board.columns.find(
        (c) => c.jiraStatus && c.jiraStatus.toLowerCase() === status.toLowerCase()
      );
      let task = board.tasks.find((t) => t.key === iss.key);
      if (!task) {
        task = {
          id: crypto.randomUUID(),
          key: iss.key,
          origin: "jira",
          summary: f.summary ?? iss.key,
          description: adfToText(f.description).trim(),
          url: `${cfg.baseUrl.replace(/\/+$/, "")}/browse/${iss.key}`,
          jiraStatus: status,
          columnId: (mapped ?? fallbackCol)?.id,
          assignee: null,
          priority: f.priority?.name ?? null,
          issueType: f.issuetype?.name ?? null,
          parentId: null,
          parentKey: f.parent?.key ?? null,
          flagged: null,
          knownCommentIds: [],
          updatedAt: Date.now(),
          location: "board",
          level: levelFromIssueType(f.issuetype?.name),
          epicId: null,
          activity: [{ ts: Date.now(), who: "jira", text: `imported from Jira (status: ${status})` }],
        };
        board.tasks.push(task);
      } else {
        task.summary = f.summary ?? task.summary;
        task.description = adfToText(f.description).trim();
        task.priority = f.priority?.name ?? task.priority;
        task.issueType = f.issuetype?.name ?? task.issueType;
        task.parentKey = f.parent?.key ?? task.parentKey ?? null;
        // Remote status change wins: move the card to the mapped column, even
        // out of a board-only column. Unchanged remote status leaves any local
        // (board-only) position alone. Backlog/archive are local-only locations
        // — a Jira status change does NOT pull a task out of them (the operator
        // decides placement via the board).
        if (status && status !== task.jiraStatus && task.location === "board") {
          task.jiraStatus = status;
          if (mapped) task.columnId = mapped.id;
          taskActivity(task, "jira", `Jira status changed → ${status}`);
        } else if (status && status !== task.jiraStatus) {
          // Task is in backlog/archive; record the remote status change without
          // relocating it.
          task.jiraStatus = status;
          taskActivity(task, "jira", `Jira status changed → ${status} (kept in ${task.location})`);
        }
      }
      importJiraComments(task, f.comment);
    }
    // Link subtasks to their board parent (by Jira key) for the UI/tools.
    const byKey = new Map(board.tasks.filter((t) => t.key).map((t) => [t.key, t]));
    for (const t of board.tasks) {
      if (t.parentKey && !t.parentId) t.parentId = byKey.get(t.parentKey)?.id ?? null;
    }
    // Drop Jira tasks that left the sprint / no longer match the JQL.
    const before = board.tasks.length;
    board.tasks = board.tasks.filter((t) => t.origin !== "jira" || seen.has(t.key));
    if (board.tasks.length !== before) {
      log(`board sync: removed ${before - board.tasks.length} task(s) no longer in the sprint`);
    }
    board.lastSync = Date.now();
    board.syncError = null;
    schedulePersistBoard();
  } catch (e) {
    board.syncError = e?.message ?? String(e);
    log(`board sync failed (${reason}): ${board.syncError}`);
  } finally {
    boardSyncing = false;
  }
}

// ── Board operations (shared by socket protocol and HTTP UI) ─────────────────

async function boardMove(actorId, taskSpec, columnSpec, note) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  if (!canAccessGroup(actorId, task)) return { error: `Task '${taskSpec}' is in a different group's board` };
  const actor = agentDisplayName(actorId);
  const target = String(columnSpec ?? "").trim().toLowerCase();

  // Pseudo-locations: "backlog" parks a task off-board in the shared backlog
  // pool; "archive" is the "done board" — it removes the task from its column
  // (incl. Done) while keeping the record queryable + restorable. Both are
  // LOCAL-ONLY: never pushed to Jira, and Jira sync won't override them.
  if (target === "backlog" || target === "archive") {
    const from = board.columns.find((c) => c.id === task.columnId);
    const prevLoc = task.location ?? "board";
    if (prevLoc !== target || note) {
      task.location = target;
      task.columnId = null;
      const label = target === "archive" ? "Archive" : "Backlog";
      const fromLabel = from ? `${from.name} → ` : prevLoc !== "board" ? `${prevLoc} → ` : "→ ";
      taskActivity(task, actor, `moved ${fromLabel}${label}${note ? ` — ${note}` : ""}`);
    }
    schedulePersistBoard();
    return { ok: true, task };
  }

  const column = findBoardColumn(columnSpec);
  if (!column) {
    return { error: `Column '${columnSpec}' not found (columns: ${board.columns.map((c) => c.name).join(", ")}, or 'backlog'/'archive')` };
  }
  const from = board.columns.find((c) => c.id === task.columnId);
  const prevLoc = task.location ?? "board";
  const restoring = prevLoc !== "board";
  // Moving to a real column always (re)homes the task on the board.
  task.location = "board";
  if (task.columnId !== column.id) {
    task.columnId = column.id;
    const fromLabel = restoring ? `${prevLoc} → ` : from ? `${from.name} → ` : "→ ";
    taskActivity(task, actor, `moved ${fromLabel}${column.name}${note ? ` — ${note}` : ""}`);
  } else if (note) {
    taskActivity(task, actor, note);
  }

  let warning;
  // Fold progress entries recorded since the last fold into the description,
  // so the next column inherits a snapshot of what was done. Only when the
  // task actually moved column (a no-op move + note shouldn't rewrite it).
  let folded = 0;
  if (from && from.id !== column.id) {
    const entries = progressEntriesSince(task);
    folded = entries.length;
    if (folded) {
      const stamp = new Date().toLocaleString();
      const block = [
        `## Progress so far (→ ${column.name}, ${stamp})`,
        ...entries.map((e) => `- ${e.who}: ${e.text}`),
      ].join("\n");
      task.description = (task.description ? task.description.trimEnd() + "\n\n" : "") + block;
      task.progressSince = Date.now();
    }
  }
  // Push the matching Jira transition when moving into a Jira-mapped column.
  if (column.jiraStatus && task.origin === "jira" && jiraCfg() &&
      column.jiraStatus.toLowerCase() !== (task.jiraStatus ?? "").toLowerCase()) {
    try {
      await jiraTransitionTo(task, column.jiraStatus);
      taskActivity(task, "jira", `transitioned to "${column.jiraStatus}"`);
    } catch (e) {
      warning = `Jira transition failed: ${e.message}`;
      taskActivity(task, "board", warning);
    }
  }
  // Push the folded description to Jira too (the transition above only moves
  // status; the new "Progress so far" block is part of the spec to carry over).
  if (folded && task.origin === "jira" && jiraCfg()) {
    try {
      await jiraUpdateIssue(task.key, { description: task.description });
    } catch (e) {
      const w = `folded description not pushed to Jira: ${e.message}`;
      taskActivity(task, "board", w);
      if (!warning) warning = w;
    }
  }
  if (folded) taskActivity(task, "board", `folded ${folded} progress entr${folded === 1 ? "y" : "ies"} into description`);
  // Tell the assignee their task moved (unless they moved it themselves) —
  // this is what makes board-only columns like "Refine"/"Review" actionable.
  if (task.assignee && task.assignee !== actor) {
    const n = notifyAssignee(actorId, task, "Task moved");
    if (n.warning && !warning) warning = `assignee not mailed: ${n.warning}`;
  }
  schedulePersistBoard();
  return { ok: true, task, warning };
}

function boardAssign(actorId, taskSpec, assignee, newSession) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  const actor = agentDisplayName(actorId);
  const name = String(assignee ?? "").trim();
  // Same-group visibility: an agent may only touch tasks in its own group.
  // (The human operator can assign anything.)
  if (!canAccessGroup(actorId, task)) {
    return { error: `Task '${taskSpec}' is in a different group's board` };
  }
  if (!name) {
    const prev = task.assignee;
    task.assignee = null;
    // When unassigned, fall back to the stamped group (creator's); keep the
    // existing stamp so the task stays on its board rather than vanishing.
    taskActivity(task, actor, prev ? `unassigned ${prev}` : "cleared assignee");
    schedulePersistBoard();
    return { ok: true, task };
  }
  // Resolve to a canonical live-agent name when possible (accepts id prefixes).
  const targetId = resolveTarget(name);
  // An agent can only assign within its own group; the human can assign across.
  const newGroup = targetId ? agentGroup(targetId) : null;
  if (actorId !== HUMAN_AGENT_ID && newGroup != null && newGroup !== agentGroup(actorId)) {
    return { error: `Cannot assign to ${name}: ${name} is in a different project group` };
  }
  const prevAssignee = task.assignee;
  task.assignee = targetId ? agentDisplayName(targetId) : name;
  // Re-stamp the owning group from the new assignee's project (human-assigned
  // tasks land on that agent's board; unresolvable names keep the prior stamp).
  if (newGroup != null) task.group = newGroup;
  // Reassigning to a DIFFERENT agent: the new assignee has no context for this
  // task, so clear their session (deliver as a new-session task). First
  // assignment keeps the caller's newSession choice; re-assigning the same
  // agent (e.g. just to re-notify) does not clear context.
  const reassigning = prevAssignee != null && prevAssignee !== task.assignee;
  const clearContext = !!(newSession || reassigning);
  taskActivity(
    task,
    actor,
    `assigned to ${task.assignee}${reassigning ? " (context cleared for new assignee)" : ""}`
  );
  let warning;
  if (task.assignee !== actor) {
    const n = notifyAssignee(
      actorId,
      task,
      reassigning ? "Task reassigned" : "Task assigned",
      clearContext ? { newSession: true } : {}
    );
    if (n.warning) warning = `assignee not mailed: ${n.warning}`;
  }
  schedulePersistBoard();
  return { ok: true, task, warning };
}

async function boardComment(actorId, taskSpec, text) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  if (!canAccessGroup(actorId, task)) return { error: `Task '${taskSpec}' is in a different group's board` };
  const body = String(text ?? "").trim();
  if (!body) return { error: "Comment text is empty" };
  const actor = agentDisplayName(actorId);
  taskActivity(task, actor, body);
  let warning;
  if (task.origin === "jira" && jiraCfg()) {
    try {
      const commentId = await jiraAddComment(task.key, `[${actor} via pi-mail board]\n\n${body}`);
      // Remember our own comment id so the pull sync doesn't re-import it.
      if (commentId) (task.knownCommentIds ??= []).push(commentId);
    } catch (e) {
      warning = `comment not synced to Jira: ${e.message}`;
      taskActivity(task, "board", warning);
    }
  }
  // Mail the comment to the assignee so new info (e.g. an operator note added
  // on the website) reaches the agent working the task. The session is left
  // intact (no newSession) — a comment is a follow-up, not a fresh task.
  // Skip when there's no assignee or the commenter is the assignee themselves.
  if (task.assignee && task.assignee !== actor) {
    const column = board.columns.find((c) => c.id === task.columnId) ?? null;
    const subject = `Comment on task: ${task.key ? `[${task.key}] ` : ""}${task.summary}`;
    const mailBody = [
      `${actor} added a comment to a board task assigned to you:`,
      "",
      body,
      "",
      `Board task id: ${task.id.slice(0, 8)}`,
      `Column: ${taskLocationLabel(task)}${column?.jiraStatus ? ` (Jira status: ${column.jiraStatus})` : ""}`,
      `Run board_get_task({ taskId: "${task.id.slice(0, 8)}" }) for full details and the activity log.`,
    ].join("\n");
    const r = sendMail(actorId, task.assignee, subject, mailBody);
    if (r.error) {
      const w = `comment not mailed to ${task.assignee}: ${r.error}`;
      taskActivity(task, "board", w);
      if (!warning) warning = w;
    }
  }
  schedulePersistBoard();
  return { ok: true, task, warning };
}

/**
 * Post a progress update on a task. Progress is an internal activity entry
 * (kind "progress") — it is NOT posted as a Jira comment (unlike
 * board_comment). It shows up in the task detail modal and, when the task is
 * moved to the next column, recent progress entries are folded into the
 * description (and that fold IS pushed to Jira). Progress also resets the
 * nudge clock for this task.
 */
async function boardProgress(actorId, taskSpec, text) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  if (!canAccessGroup(actorId, task)) return { error: `Task '${taskSpec}' is in a different group's board` };
  const body = String(text ?? "").trim();
  if (!body) return { error: "Progress text is empty" };
  const actor = agentDisplayName(actorId);
  taskActivity(task, actor, body, "progress");
  // A progress post clears any pending nudge gap for this task.
  task.lastNudgeTs = Date.now();
  schedulePersistBoard();
  return { ok: true, task };
}

/**
 * Create a board task. With `parent`, it becomes a subtask of that task; when
 * the parent is a Jira issue (or `inJira` is set), a real Jira issue is
 * created too and kept in sync (pinned, so it survives JQL filtering).
 */
async function boardCreate(actorId, { summary, description, column, parent, inJira, level, epicId, backlog } = {}) {
  const s = String(summary ?? "").trim();
  if (!s) return { error: "Summary is required" };
  const parentTask = parent ? findBoardTask(parent) : null;
  if (parent && !parentTask) return { error: `Parent task '${parent}' not found` };
  const toBacklog = !!backlog && !parentTask;
  const col = toBacklog
    ? null
    : (findBoardColumn(column) ??
      (parentTask ? board.columns.find((c) => c.id === parentTask.columnId) : null) ??
      board.columns[0]);
  const actor = agentDisplayName(actorId);
  // Level: explicit > inferred from parentage. A subtask (has a parent) is
  // "subtask"; an epic's child passed via parent is still a subtask. Epics and
  // stories are set explicitly by the caller (UI/MCP/agent tool).
  const lvl = String(level ?? "").trim().toLowerCase();
  const validLevels = new Set(["epic", "story", "task", "subtask"]);
  const finalLevel = validLevels.has(lvl)
    ? lvl
    : parentTask ? "subtask" : "task";
  // epicId: optional — links a story to its epic (board id). Validated loosely.
  let epicRef = null;
  if (epicId) {
    const epic = findBoardTask(epicId);
    if (epic) epicRef = epic.id;
  }
  const task = {
    id: crypto.randomUUID(),
    key: null,
    origin: "local",
    summary: s,
    description: String(description ?? "").trim(),
    url: null,
    jiraStatus: null,
    columnId: col ? col.id : null,
    assignee: null,
    priority: null,
    issueType: null,
    parentId: parentTask?.id ?? null,
    parentKey: parentTask?.key ?? null,
    flagged: null,
    knownCommentIds: [],
    updatedAt: Date.now(),
    location: toBacklog ? "backlog" : "board",
    level: finalLevel,
    epicId: epicRef,
    // Stamp the owning group: subtasks inherit their parent's group, otherwise
    // the creator's project group (human-created tasks get null here and are
    // (re)stamped when assigned to an agent).
    group: parentTask ? taskGroup(parentTask) : agentGroup(actorId),
    activity: [
      {
        ts: Date.now(),
        who: actor,
        text: toBacklog
          ? `created in Backlog${parentTask ? ` as subtask of ${parentTask.key ?? parentTask.id.slice(0, 8)}` : ""}`
          : `created in ${col.name}${parentTask ? ` as subtask of ${parentTask.key ?? parentTask.id.slice(0, 8)}` : ""}`,
      },
    ],
  };

  // Create the Jira twin when the parent is a Jira issue or explicitly asked.
  const cfg = jiraCfg();
  if (inJira && !cfg) return { error: "Cannot create in Jira: Jira is not configured (board settings)" };
  if (cfg && (inJira || parentTask?.origin === "jira")) {
    const projectKey = parentTask?.key ? parentTask.key.split("-")[0] : board.config.projectKey;
    if (!projectKey) {
      return { error: "Cannot create in Jira: set a project key in board settings (or create under a Jira parent)" };
    }
    try {
      const key = await jiraCreateIssue({
        projectKey,
        summary: s,
        description: task.description,
        issueType: parentTask ? board.config.subtaskIssueType || "Sub-task" : board.config.issueType || "Task",
        parentKey: parentTask?.key ?? undefined,
      });
      task.key = key;
      task.origin = "jira";
      task.pinned = true;
      task.url = `${cfg.baseUrl.replace(/\/+$/, "")}/browse/${key}`;
      taskActivity(task, "jira", `created in Jira as ${key}`);
    } catch (e) {
      return { error: `Jira create failed: ${e.message}` };
    }
  }

  board.tasks.push(task);
  if (parentTask) taskActivity(parentTask, actor, `added subtask ${task.key ?? task.id.slice(0, 8)}: ${s}`);
  schedulePersistBoard();
  return { ok: true, task };
}

async function boardUpdate(actorId, taskSpec, { summary, description } = {}) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  if (!canAccessGroup(actorId, task)) return { error: `Task '${taskSpec}' is in a different group's board` };
  const actor = agentDisplayName(actorId);
  const changes = [];
  if (typeof summary === "string" && summary.trim()) {
    task.summary = summary.trim();
    changes.push("summary");
  }
  if (typeof description === "string") {
    task.description = description;
    changes.push("description");
  }
  if (!changes.length) return { error: "Nothing to update (pass summary and/or description)" };
  let warning;
  if (task.origin === "jira" && jiraCfg()) {
    try {
      await jiraUpdateIssue(task.key, {
        summary: changes.includes("summary") ? task.summary : undefined,
        description: changes.includes("description") ? task.description : undefined,
      });
    } catch (e) {
      warning = `edit not pushed to Jira: ${e.message}`;
      taskActivity(task, "board", warning);
    }
  }
  taskActivity(task, actor, `updated ${changes.join(", ")}${task.origin === "jira" && !warning ? " (pushed to Jira)" : ""}`);
  schedulePersistBoard();
  return { ok: true, task, warning };
}

/** Flag a task as unclear (notifies the human operator) or clear the flag. */
function boardFlag(actorId, taskSpec, reason, clear) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  if (!canAccessGroup(actorId, task)) return { error: `Task '${taskSpec}' is in a different group's board` };
  const actor = agentDisplayName(actorId);
  if (clear) {
    task.flagged = null;
    taskActivity(task, actor, "cleared the unclear flag");
    schedulePersistBoard();
    return { ok: true, task };
  }
  const why = String(reason ?? "").trim() || "needs clarification";
  task.flagged = { by: actor, reason: why, ts: Date.now() };
  taskActivity(task, actor, `⚠ flagged unclear: ${why}`);
  let warning;
  if (actorId !== HUMAN_AGENT_ID) {
    const r = sendMail(
      actorId,
      HUMAN_AGENT_NAME,
      `Task unclear: ${task.key ? `[${task.key}] ` : ""}${task.summary}`,
      [
        `${actor} flagged a board task as unclear.`,
        "",
        `Task: ${task.key ? `[${task.key}] ` : ""}${task.summary}`,
        task.url ? `Jira: ${task.url}` : null,
        `Board task id: ${task.id.slice(0, 8)}`,
        "",
        `## Reason / questions`,
        why,
        "",
        `Reply by mail, comment on the task, or clarify the description — then clear the flag on the board.`,
      ]
        .filter((l) => l != null)
        .join("\n")
    );
    if (r.error) warning = `operator not mailed: ${r.error}`;
  }
  schedulePersistBoard();
  return { ok: true, task, warning };
}

function boardSetConfig({ config, columns } = {}) {
  if (config && typeof config === "object") {
    for (const k of ["baseUrl", "email", "jql", "projectKey", "issueType", "subtaskIssueType"]) {
      if (typeof config[k] === "string") board.config[k] = config[k].trim();
    }
    if (typeof config.nudgeEnabled === "boolean") board.config.nudgeEnabled = config.nudgeEnabled;
    if (typeof config.nudgeIntervalMin === "number" && Number.isFinite(config.nudgeIntervalMin)) {
      board.config.nudgeIntervalMin = Math.max(1, Math.floor(config.nudgeIntervalMin));
    }
    // Empty token means "keep the existing one" so the UI never has to echo it.
    if (typeof config.apiToken === "string" && config.apiToken.trim()) {
      board.config.apiToken = config.apiToken.trim();
    }
    if (!board.config.jql) board.config.jql = DEFAULT_JQL;
  }
  if (Array.isArray(columns) && columns.length > 0) {
    const cleaned = [];
    for (const c of columns) {
      const name = String(c?.name ?? "").trim();
      if (!name) continue;
      cleaned.push({
        id: String(c.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).trim(),
        name,
        jiraStatus: c.jiraStatus ? String(c.jiraStatus).trim() : null,
        instructions: String(c.instructions ?? ""),
      });
    }
    if (cleaned.length) {
      board.columns = cleaned;
      // Re-home ON-BOARD tasks whose column disappeared. Tasks in backlog or
      // archive (columnId null) stay put — they're intentionally off-board.
      const ids = new Set(cleaned.map((c) => c.id));
      for (const t of board.tasks) {
        if (t.columnId && !ids.has(t.columnId)) t.columnId = cleaned[0].id;
      }
    }
  }
  schedulePersistBoard();
  if (jiraCfg()) syncBoard("config change");
  return { ok: true };
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
    board: boardState(),
    spawn: spawnState(),
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
      const r = spawnAgent({ cwd: msg.cwd, name: msg.name, model: msg.model, kickoff: msg.kickoff });
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
    case "spawn_ls": {
      const r = listSpawnDir(msg.path || os.homedir());
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

// ── HTTP web UI ───────────────────────────────────────────────────────────────

let UI_HTML = "";
try {
  UI_HTML = fs.readFileSync(UI_HTML_PATH, "utf8");
} catch (e) {
  log(`ui.html not found at ${UI_HTML_PATH}: ${e.message}`);
}

// ── Agent spawning (tmux) ─────────────────────────────────────────────────────

/**
 * Persisted spawn registry. Maps a tmux session name → metadata about a
 * daemon-spawned agent (cwd, model, spawnedAt, optional kickoff). The daemon
 * only ever stops sessions listed here, so an operator-launched tmux/pi is
 * never killed by stop(). Survives daemon restarts so /restart-mail-daemon
 * keeps tracking (and can still stop) previously-spawned agents.
 */
let spawnRegistry = {
  /** @type {Record<string, { cwd: string, model?: string, kickoff?: string, spawnedAt: number, agentName?: string }>} */
  sessions: {},
};

let spawnPersistTimer = null;
function schedulePersistSpawn() {
  if (spawnPersistTimer) return;
  spawnPersistTimer = setTimeout(() => {
    spawnPersistTimer = null;
    flushSpawn();
  }, 300);
}
function flushSpawn() {
  try {
    fs.writeFileSync(SPAWN_FILE, JSON.stringify(spawnRegistry), { mode: 0o600 });
  } catch (e) {
    log(`spawn persist failed: ${e.message}`);
  }
}
function loadSpawn() {
  try {
    const saved = JSON.parse(fs.readFileSync(SPAWN_FILE, "utf8"));
    if (saved && typeof saved === "object") {
      if (saved.sessions && typeof saved.sessions === "object") spawnRegistry.sessions = saved.sessions;
    }
  } catch {
    // No spawn file yet — defaults apply.
  }
  // Reconcile with live tmux: drop tracked sessions whose tmux session no
  // longer exists (e.g. the agent exited on its own, or tmux was killed
  // out-of-band). Cheap and keeps the registry honest across restarts.
  for (const name of Object.keys(spawnRegistry.sessions)) {
    if (!tmuxSessionExists(name)) delete spawnRegistry.sessions[name];
  }
}

/** Resolve and validate a cwd: must be a real directory anywhere on the
 *  filesystem. The picker can browse and spawn from any path — there is no
 *  allowlist (the former "allowed root" restriction was removed). */
function validateSpawnCwd(cwd) {
  if (!cwd || typeof cwd !== "string") return { error: "cwd is required" };
  let resolved;
  try {
    resolved = path.resolve(cwd);
  } catch {
    return { error: `invalid path: ${cwd}` };
  }
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    return { error: `not a directory: ${resolved}` };
  }
  if (!st.isDirectory()) return { error: `not a directory: ${resolved}` };
  return { resolved };
}

/** Sanitise a name for use as a tmux session name (tmux disallows '.' and ':'). */
function safeSessionName(name) {
  return String(name || "").replace(/[.:\\]/g, "-").replace(/\s+/g, "-").slice(0, 80);
}

/** Default agent name: <dir-basename>-<id6>, matching the extension's auto-slug. */
function defaultSpawnName(cwd) {
  const base = path.basename(cwd) || "pi-agent";
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

function tmuxSessionExists(name) {
  try {
    const r = spawnSync(TMUX_BIN, ["has-session", "-t", name]);
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Spawn a fresh pi agent in a tmux session.
 * @returns {{ ok?: true, name?: string, agentId?: string, warning?: string, error?: string }}
 */
function spawnAgent({ cwd, name, model, kickoff }) {
  const v = validateSpawnCwd(cwd);
  if (v.error) return { error: v.error };
  const dir = v.resolved;

  const session = safeSessionName(name?.trim() || defaultSpawnName(dir));
  if (!session) return { error: "invalid name" };
  if (spawnRegistry.sessions[session]) {
    return { error: `a spawned agent named '${session}' already exists` };
  }
  if (tmuxSessionExists(session)) {
    return { error: `a tmux session named '${session}' already exists (not tracked by the daemon)` };
  }

  // Build the pi invocation. -n sets the session display name (also the
  // federation agent name once the extension registers). --approve trusts
  // project-local files for an unattended launch.
  const args = ["-n", session, "--approve"];
  if (model && String(model).trim()) args.push("--model", String(model).trim());
  const piCmd = `${shellQuote(PI_BIN)} ${args.map(shellQuote).join(" ")}`;

  let r;
  try {
    // tmux new-session -d: detached. The quoted command runs in the chosen cwd.
    r = spawnSync(TMUX_BIN, ["new-session", "-d", "-s", session, "-c", dir, piCmd], { cwd: dir });
  } catch (e) {
    return { error: `failed to spawn tmux: ${e?.message ?? String(e)}` };
  }
  if (r.error || r.status !== 0) {
    const stderr = (r.stderr ? r.stderr.toString().trim() : "");
    const hint = r.error?.code === "ENOENT" ? ` (tmux not found at '${TMUX_BIN}')` : "";
    return { error: `tmux spawn failed${hint}${stderr ? ": " + stderr : ""}` };
  }

  spawnRegistry.sessions[session] = {
    cwd: dir,
    model: model && String(model).trim() ? String(model).trim() : undefined,
    kickoff: kickoff && String(kickoff).trim() ? String(kickoff).trim() : undefined,
    spawnedAt: Date.now(),
    agentName: session,
  };
  schedulePersistSpawn();
  log(`Spawned agent '${session}' in ${dir}`);

  // Best-effort: wait for the agent to register, then deliver the kickoff as a
  // new-session task. Non-blocking on the reply path — the caller gets the
  // session name immediately; kickoff delivery is logged in the activity.
  const kickoffText = spawnRegistry.sessions[session].kickoff;
  waitForRegistration(session, SPAWN_REGISTER_TIMEOUT_MS)
    .then((agentId) => {
      if (agentId) {
        spawnRegistry.sessions[session].agentId = agentId;
        schedulePersistSpawn();
      }
      if (kickoffText) {
        // Deliver as the human so the agent treats it as a mail-driven task.
        const m = sendMail(HUMAN_AGENT_ID, session, "Task: " + kickoffText.split("\n")[0].slice(0, 80), kickoffText, { newSession: true });
        if (m.error) log(`kickoff delivery to '${session}' failed: ${m.error}`);
      }
    })
    .catch(() => {});

  return { ok: true, name: session, warning: kickoffText ? undefined : undefined };
}

/**
 * Stop a daemon-spawned agent: kill its tmux session. Refuses to kill a
 * session the daemon did not spawn (defence against clobbering operator work).
 * @returns {{ ok?: true, error?: string }}
 */
function stopAgent({ name }) {
  const session = safeSessionName(name?.trim ? name.trim() : String(name || ""));
  if (!session) return { error: "name is required" };
  if (!spawnRegistry.sessions[session]) {
    return { error: `'${session}' is not a daemon-spawned agent (the daemon only stops agents it spawned)` };
  }
  let r;
  try {
    r = spawnSync(TMUX_BIN, ["kill-session", "-t", session]);
  } catch (e) {
    return { error: `failed to kill tmux: ${e?.message ?? String(e)}` };
  }
  // status 1 + "can't find session" is fine — it already exited. Anything else
  // is a real failure.
  if (r.error || (r.status !== 0 && !/no (such|session)|can't find|not found/i.test(r.stderr ? r.stderr.toString() : ""))) {
    const stderr = r.stderr ? r.stderr.toString().trim() : "";
    return { error: `tmux kill-session failed${stderr ? ": " + stderr : ""}` };
  }
  delete spawnRegistry.sessions[session];
  schedulePersistSpawn();
  log(`Stopped agent '${session}'`);
  return { ok: true };
}

/**
 * Resolve a recipient spec to an agentId, waiting up to timeoutMs for an agent
 * matching `name` to register. Used by spawnAgent so the kickoff is delivered
 * to the freshly-registered agent rather than bouncing as "not found".
 */
function waitForRegistration(name, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const id = resolveTarget(name);
      if (id) return resolve(id);
      if (Date.now() - start >= timeoutMs) return resolve(null);
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** Directory listing for the picker: subdirectories of `dir` (any path on the
 *  filesystem). validateSpawnCwd only checks it's a real directory. */
function listSpawnDir(dir) {
  const v = validateSpawnCwd(dir);
  if (v.error) return { error: v.error };
  const resolved = v.resolved;
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { dir: resolved, dirs };
  } catch (e) {
    return { error: `could not read ${resolved}: ${e?.message ?? String(e)}` };
  }
}

/** Spawned sessions, for the UI/tools: name + cwd + model + live status. */
function spawnState() {
  const sessions = Object.entries(spawnRegistry.sessions).map(([name, s]) => ({
    name,
    cwd: s.cwd,
    model: s.model || "",
    kickoff: s.kickoff || "",
    spawnedAt: s.spawnedAt,
    agentName: s.agentName || name,
    alive: tmuxSessionExists(name),
  }));
  return { sessions };
}

// Minimal sync helpers (used for tmux probes / spawn). spawnSync is imported
// lazily so the daemon doesn't pay for it unless spawning is used.
import { spawnSync } from "node:child_process";

/** Quote a string for safe inclusion in a shell command line. */
function shellQuote(s) {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
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
      const r = listSpawnDir(url.searchParams.get("path") || os.homedir());
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

// ── Server ────────────────────────────────────────────────────────────────────

// Ensure dirs exist
fs.mkdirSync(AGENT_DIR, { recursive: true });

// Restore history before serving (so the UI shows prior mail immediately)
loadHistory();
loadBoard();
loadSpawn();

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

// Jira pull loop — no-op until Jira is configured.
if (jiraCfg()) syncBoard("startup");
setInterval(() => syncBoard("interval"), JIRA_SYNC_INTERVAL_MS);

// Progress-nudge loop — mails in-progress assignees who haven't posted
// progress in a while. Runs every minute; each task gates itself on its own
// interval.
setInterval(nudgeIdleTasks, 60_000);

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
  // Flush any pending board write before exiting.
  if (boardPersistTimer) {
    clearTimeout(boardPersistTimer);
    boardPersistTimer = null;
    flushBoard();
  }
  // Flush any pending spawn registry write before exiting.
  if (spawnPersistTimer) {
    clearTimeout(spawnPersistTimer);
    spawnPersistTimer = null;
    flushSpawn();
  }
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
