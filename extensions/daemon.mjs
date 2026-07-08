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
import {
  AGENT_DIR,
  HUMAN_AGENT_ID,
  HUMAN_AGENT_NAME,
  agents,
  mailboxes,
  messageLog,
  send,
  log,
  agentDisplayName,
  logDelivery,
  deliverMail,
  makeMail,
  resolveTarget,
  sendMail,
  broadcastMail,
  archiveHumanMessage,
  schedulePersist,
  loadHistory,
  flushHistory,
  shellQuote,
} from "./lib/core.mjs";
import {
  BOARD_FILE,
  JIRA_SYNC_INTERVAL_MS,
  DEFAULT_JQL,
  DEFAULT_COLUMNS,
  board,
  boardPersistTimer,
  schedulePersistBoard,
  flushBoard,
  loadBoard,
  jiraCfg,
  findBoardTask,
  findBoardColumn,
  levelFromIssueType,
  taskActivity,
  progressEntriesSince,
  agentGroup,
  groupForName,
  taskGroup,
  canAccessGroup,
  boardState,
  taskLocationLabel,
  taskMailBody,
  notifyAssignee,
  nudgeIdleTasks,
} from "./lib/board.mjs";
import {
  loadSpawn,
  flushSpawn,
  spawnAgent,
  stopAgent,
  spawnState,
  listSpawnDir,
  spawnRegistry,
} from "./lib/spawn.mjs";

// ── Config (server/UI-only) ────────────────────────────────────────────────

const SOCKET_PATH = path.join(AGENT_DIR, "mail-daemon.sock");
const PID_FILE = path.join(AGENT_DIR, "mail-daemon.pid");
const LOCK_FILE = path.join(AGENT_DIR, "mail-daemon.lock");
const PING_INTERVAL_MS = 5_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = path.join(__dirname, "ui.html");

// HTTP UI bind settings. Override with env vars if needed.
const UI_HOST = process.env.PI_MAIL_UI_HOST || "0.0.0.0";
const UI_PORT = parseInt(process.env.PI_MAIL_UI_PORT || "1994", 10);

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
  flushSpawn();
  // Flush any pending history write before exiting.
  flushHistory();
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// Keep the process alive (it's a daemon)
process.stdin.resume();
