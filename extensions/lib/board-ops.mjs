/**
 * Board operations (move / assign / comment / progress / create / update /
 * flag / config) shared by the socket protocol and the HTTP UI. Extracted
 * from daemon.mjs. Depends on lib/core.mjs, lib/board.mjs, lib/jira.mjs.
 */

import {
  HUMAN_AGENT_ID,
  HUMAN_AGENT_NAME,
  agentDisplayName,
  log,
  sendMail,
  resolveTarget,
} from "./core.mjs";
import {
  board,
  DEFAULT_JQL,
  DEFAULT_COLUMNS,
  jiraCfg,
  findBoardTask,
  findBoardColumn,
  levelFromIssueType,
  taskActivity,
  progressEntriesSince,
  agentGroup,
  taskGroup,
  canAccessGroup,
  taskLocationLabel,
  taskMailBody,
  notifyAssignee,
  schedulePersistBoard,
  flushBoard,
} from "./board.mjs";
import {
  jiraTransitionTo,
  jiraAddComment,
  jiraCreateIssue,
  jiraUpdateIssue,
  syncBoard,
} from "./jira.mjs";

// ── Board operations (shared by socket protocol and HTTP UI) ─────────────────

export async function boardMove(actorId, taskSpec, columnSpec, note) {
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

export function boardAssign(actorId, taskSpec, assignee, newSession) {
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

export async function boardComment(actorId, taskSpec, text) {
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
export async function boardProgress(actorId, taskSpec, text) {
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
export async function boardCreate(actorId, { summary, description, column, parent, inJira, level, epicId, backlog } = {}) {
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

export async function boardUpdate(actorId, taskSpec, { summary, description } = {}) {
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
export function boardFlag(actorId, taskSpec, reason, clear) {
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

export function boardSetConfig({ config, columns } = {}) {
  if (config && typeof config === "object") {
    for (const k of ["baseUrl", "email", "jql", "projectKey", "issueType", "subtaskIssueType"]) {
      if (typeof config[k] === "string") board.config[k] = config[k].trim();
    }
    if (typeof config.nudgeEnabled === "boolean") board.config.nudgeEnabled = config.nudgeEnabled;
    if (typeof config.nudgeIntervalMin === "number" && Number.isFinite(config.nudgeIntervalMin)) {
      board.config.nudgeIntervalMin = Math.max(1, Math.floor(config.nudgeIntervalMin));
    }
    // Middle-manager config (per-board). mmEnabled defaults false; the daemon
    // scheduler skips spawning when disabled or when the favorites list is
    // empty. See lib/middle-manager.mjs.
    if (typeof config.mmEnabled === "boolean") board.config.mmEnabled = config.mmEnabled;
    if (typeof config.mmIntervalMin === "number" && Number.isFinite(config.mmIntervalMin)) {
      board.config.mmIntervalMin = Math.max(1, Math.floor(config.mmIntervalMin));
    }
    if (typeof config.mmMaxLifetimeMin === "number" && Number.isFinite(config.mmMaxLifetimeMin)) {
      board.config.mmMaxLifetimeMin = Math.max(1, Math.floor(config.mmMaxLifetimeMin));
    }
    // Worker reaper safety bound (per-board). A daemon-spawned worker that
    // does not self-exit within this many minutes is force-killed so
    // hung/forgotten workers never leak. Default 30. See lib/middle-manager.mjs
    // (reapWorkers) + the README ephemerality invariant.
    if (typeof config.workerMaxLifetimeMin === "number" && Number.isFinite(config.workerMaxLifetimeMin)) {
      board.config.workerMaxLifetimeMin = Math.max(1, Math.floor(config.workerMaxLifetimeMin));
    }
    if (typeof config.mmModel === "string") board.config.mmModel = config.mmModel.trim();
    // CEO config (per-board). ceoEnabled defaults false. When enabled the CEO
    // replaces the daemon's fixed-interval MM timer (CEO becomes the sole MM
    // spawner); the MM reaper still runs. See lib/ceo.mjs.
    if (typeof config.ceoEnabled === "boolean") board.config.ceoEnabled = config.ceoEnabled;
    if (typeof config.ceoIntervalMin === "number" && Number.isFinite(config.ceoIntervalMin)) {
      board.config.ceoIntervalMin = Math.max(1, Math.floor(config.ceoIntervalMin));
    }
    if (typeof config.ceoMaxLifetimeMin === "number" && Number.isFinite(config.ceoMaxLifetimeMin)) {
      board.config.ceoMaxLifetimeMin = Math.max(1, Math.floor(config.ceoMaxLifetimeMin));
    }
    if (typeof config.ceoModel === "string") board.config.ceoModel = config.ceoModel.trim();
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

