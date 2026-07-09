/**
 * Task board state, helpers, project grouping, and progress-nudge for the
 * pi-mail daemon. Extracted from daemon.mjs. Depends on lib/core.mjs only.
 */

import fs from "node:fs";
import path from "node:path";
import {
  AGENT_DIR,
  HUMAN_AGENT_ID,
  agents,
  log,
  agentDisplayName,
  sendMail,
  resolveTarget,
} from "./core.mjs";

// ── Task board + Jira sync ───────────────────────────────────────────────────
//
// A kanban-style task board shared by the whole federation, with optional
// two-way sync to a Jira sprint. Columns are configurable; a column may map to
// a Jira status (moves trigger the matching Jira transition) or be board-only
// (e.g. "Refine", "Review") with custom instructions that are mailed to the
// assignee. Assigning a task mails the assignee a full task package.

export const BOARD_FILE = path.join(AGENT_DIR, "mail-board.json");
export const JIRA_SYNC_INTERVAL_MS = 60_000;
export const DEFAULT_JQL = "assignee = currentUser() AND sprint in openSprints() ORDER BY rank";

export const DEFAULT_COLUMNS = [
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
export let board = {
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
    // Middle-manager: an ephemeral agent spawned on a schedule that reviews
    // the board for the favorited (managed) projects, unblocks stuck workers,
    // and shepherds finished tasks into Done/Archive. Disabled by default;
    // no spawn when the favorites list is empty. See lib/middle-manager.mjs.
    mmEnabled: false,
    mmIntervalMin: 30,
    mmModel: "",
    mmMaxLifetimeMin: 15,
    // Worker reaper safety bound. A daemon-spawned worker (any plain spawn —
    // not an MM or CEO) that does not self-exit (mail_stop_self) within this
    // many minutes is force-killed by the reaper so hung/forgotten workers
    // never leak. Workers often run longer than a management pass, so the
    // default is generous (30); the reaper is a backstop, not the primary
    // path. See lib/middle-manager.mjs (reapWorkers) + the ephemerality
    // invariant in the README.
    workerMaxLifetimeMin: 30,
    // CEO (top-tier manager): an ephemeral agent spawned on a schedule that
    // reviews the federation at a higher level and spawns middle managers on
    // demand. When enabled, it REPLACES the daemon's fixed-interval MM timer
    // (the CEO becomes the sole MM spawner); the MM reaper still runs. See
    // lib/ceo.mjs. Disabled by default.
    ceoEnabled: false,
    ceoIntervalMin: 120,
    ceoModel: "",
    // The CEO is a ~15-minute management thread (operator invariant 7/9). This
    // is the hard safety bound: a CEO that does not self-exit within 15 min is
    // force-killed by the reaper. See lib/ceo.mjs + README ephemerality.
    ceoMaxLifetimeMin: 15,
  },
  /** @type {BoardColumn[]} */
  columns: DEFAULT_COLUMNS,
  /** @type {BoardTask[]} */
  tasks: [],
  lastSync: 0,
  /** @type {string | null} */
  syncError: null,
};

export let boardPersistTimer = null;
export function schedulePersistBoard() {
  if (boardPersistTimer) return;
  boardPersistTimer = setTimeout(() => {
    boardPersistTimer = null;
    flushBoard();
  }, 300);
}
export function flushBoard() {
  try {
    fs.writeFileSync(BOARD_FILE, JSON.stringify(board), { mode: 0o600 });
  } catch (e) {
    log(`board persist failed: ${e.message}`);
  }
}

export function loadBoard() {
  try {
    const saved = JSON.parse(fs.readFileSync(BOARD_FILE, "utf8"));
    if (saved && typeof saved === "object") {
      // Saved config wins per-field; env vars remain fallback defaults.
      // Booleans (nudgeEnabled/mmEnabled) are restored even when false, so an
      // intentionally-disabled setting survives a restart.
      for (const k of ["baseUrl", "email", "apiToken", "jql", "projectKey", "issueType", "subtaskIssueType"]) {
        if (saved.config?.[k]) board.config[k] = saved.config[k];
      }
      for (const k of ["nudgeEnabled", "mmEnabled", "ceoEnabled"]) {
        if (typeof saved.config?.[k] === "boolean") board.config[k] = saved.config[k];
      }
      for (const k of ["nudgeIntervalMin", "mmIntervalMin", "mmMaxLifetimeMin", "workerMaxLifetimeMin", "ceoIntervalMin", "ceoMaxLifetimeMin"]) {
        if (typeof saved.config?.[k] === "number" && Number.isFinite(saved.config[k])) board.config[k] = saved.config[k];
      }
      if (typeof saved.config?.mmModel === "string") board.config.mmModel = saved.config.mmModel;
      if (typeof saved.config?.ceoModel === "string") board.config.ceoModel = saved.config.ceoModel;
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

export function jiraCfg() {
  const c = board.config;
  return c.baseUrl && c.email && c.apiToken ? c : null;
}

export function findBoardTask(spec) {
  if (!spec) return null;
  const s = String(spec);
  return (
    board.tasks.find((t) => t.id === s || t.id.startsWith(s)) ??
    board.tasks.find((t) => t.key && t.key.toLowerCase() === s.toLowerCase()) ??
    null
  );
}

export function findBoardColumn(spec) {
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
export function levelFromIssueType(name) {
  const n = String(name ?? "").toLowerCase();
  if (/^epic$/.test(n)) return "epic";
  if (/story/.test(n) || /^(user story)$/.test(n)) return "story";
  if (/sub[- ]?task/.test(n)) return "subtask";
  return "task";
}

export function taskActivity(task, who, text, kind) {
  task.activity.push({ ts: Date.now(), who, text, ...(kind ? { kind } : {}) });
  if (task.activity.length > 50) task.activity.splice(0, task.activity.length - 50);
  task.updatedAt = Date.now();
  if (kind === "progress") task.lastProgressTs = task.updatedAt;
}

/** Activity entries with kind "progress" that have been recorded since the
 *  last fold (>= progressSince). Used by boardMove to fold a summary of recent
 *  progress into the task description when it moves columns. */
export function progressEntriesSince(task) {
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
export function agentGroup(agentId) {
  if (agentId === HUMAN_AGENT_ID) return null;
  const cwd = agents.get(agentId)?.info.cwd;
  if (!cwd) return null;
  return path.basename(cwd) || cwd;
}

/** Resolve an assignee name (as stored on a task) back to a live agent id,
 *  then to its project group. Returns null when unresolvable. */
export function groupForName(name) {
  if (!name) return null;
  const id = resolveTarget(name);
  return id ? agentGroup(id) : null;
}

/** The effective group a task belongs to: stamped group, else derived live
 *  from the assignee's project, else null (visible to all). */
export function taskGroup(task) {
  if (task.group) return task.group;
  return groupForName(task.assignee);
}

/** Whether actor agentId may see/modify task (same group; human sees all;
 *  ungrouped tasks are visible to all). Manager agents (middle-manager OR
 *  CEO, registered via lib/middle-manager.mjs / lib/ceo.mjs) also see all
 *  groups — they oversee multiple projects, so the same-group partition must
 *  not hide tasks from them. The predicate is injected at startup to avoid a
 *  circular import (board.mjs ← manager modules ← board.mjs). */
export let managerAgentTest = null;
export function setManagerAgentTest(fn) { managerAgentTest = fn; }
/** Legacy alias kept for backward-compat with the MM module's own injection. */
export function setMmAgentTest(fn) { managerAgentTest = fn; }

export function canAccessGroup(actorId, task) {
  if (actorId === HUMAN_AGENT_ID) return true;
  if (managerAgentTest && managerAgentTest(actorId)) return true;
  const g = taskGroup(task);
  if (!g) return true;
  return g === agentGroup(actorId);
}

export function boardState(actorId) {
  // Agents only see their own group's tasks; the human operator sees all.
  // Manager agents (injected predicate) also see all groups — they oversee
  // multiple projects in a single pass.
  // Ungrouped tasks (no stamped group and no derivable assignee group) are
  // shown to everyone so historical data isn't hidden.
  const seesAll = !actorId || actorId === HUMAN_AGENT_ID || (managerAgentTest && managerAgentTest(actorId));
  const tasks = seesAll
    ? board.tasks
    : board.tasks.filter((t) => canAccessGroup(actorId, t));
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
export function taskLocationLabel(task) {
  if (task.location === "backlog") return "Backlog";
  if (task.location === "archive") return "Archive";
  const col = board.columns.find((c) => c.id === task.columnId);
  return col?.name ?? "?";
}

/** Mail body sent to an assignee on assignment or when their task is moved. */
export function taskMailBody(task, column, actorName) {
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
export function notifyAssignee(actorId, task, subjectPrefix, opts = {}) {
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

// ── Progress nudge ─────────────────────────────────────────────────────────

/**
 * Periodically mail in-progress assignees a one-line reminder when they
 * haven't posted a progress update in a while. Non-fatal: if the assignee is
 * offline sendMail just returns an error and we move on. One nudge per gap
 * is enforced via task.lastNudgeTs.
 */
export function nudgeIdleTasks() {
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

