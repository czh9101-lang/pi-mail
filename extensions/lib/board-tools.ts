/**
 * Task-board + agent-spawn tool registrations for the pi-mail extension.
 * Extracted from index.ts. Registered via registerBoardAndSpawnTools(pi, ctx)
 * where ctx is a live (getter-backed) state object from the extension closure.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MailClient } from "./mail-client.js";
interface BoardColumn { id: string; name: string; jiraStatus: string | null; instructions: string; }
interface BoardTask { id: string; key: string | null; origin: "jira" | "local"; summary: string; description: string; url: string | null; jiraStatus: string | null; columnId: string; assignee: string | null; priority: string | null; issueType: string | null; updatedAt: number; parentId: string | null; parentKey: string | null; pinned?: boolean; flagged: { by: string; reason: string; ts: number } | null; knownCommentIds?: string[]; progressSince?: number; lastProgressTs?: number; lastNudgeTs?: number; location: "board" | "backlog" | "archive"; level: "epic" | "story" | "task" | "subtask"; epicId?: string | null; group?: string | null; activity: Array<{ ts: number; who: string; text: string; kind?: string }>; }
interface BoardStateResp { type: string; message?: string; columns: BoardColumn[]; tasks: BoardTask[]; jiraConfigured: boolean; lastSync: number; syncError: string | null; myGroup: string | null; }
export interface BoardToolCtx { client: MailClient | null; connected: boolean; agentName: string; notConnected: { content: { type: "text"; text: string }[] }; }
function errText(err: unknown) { return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }; }
function taskLine(t: BoardTask): string { const key = t.key ? `${t.key} ` : ""; const who = t.assignee ? ` → ${t.assignee}` : ""; const status = t.jiraStatus ? ` [jira: ${t.jiraStatus}]` : ""; const sub = t.parentKey || t.parentId ? ` ↳sub of ${t.parentKey ?? t.parentId?.slice(0, 8)}` : ""; const flag = t.flagged ? ` ⚠unclear` : ""; const lvl = t.level && t.level !== "task" ? ` ${t.level}` : ""; const loc = t.location === "backlog" ? ` [backlog]` : t.location === "archive" ? ` [archive]` : ""; const grp = t.group ? ` ⟨${t.group}⟩` : ""; return `  • [${t.id.slice(0, 8)}] ${key}${t.summary}${lvl}${who}${status}${sub}${loc}${grp}${flag}`; }
function boardOpResult(resp: { type: string; warning?: string; message?: string; task?: BoardTask }, okText: string) { if (resp.type === "error") { return { content: [{ type: "text" as const, text: `❌ ${resp.message}` }] }; } const warn = resp.warning ? `\n⚠️ ${resp.warning}` : ""; return { content: [{ type: "text" as const, text: `✅ ${okText}${warn}` }], details: { task: resp.task } }; }
async function fetchBoard(ctx: BoardToolCtx, opts: { location?: string; includeArchived?: boolean } = {}): Promise<BoardStateResp> { if (!ctx.connected || !ctx.client) throw new Error("Not connected to mail daemon"); const resp = await ctx.client.request<BoardStateResp>({ type: "board_state", ...opts }); if (resp.type !== "board") throw new Error(resp.message ?? "unknown board error"); return resp; }
export function registerBoardAndSpawnTools(pi: ExtensionAPI, ctx: BoardToolCtx): void {
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
        // Delegate location/archive filtering to the daemon's boardState (task
        // 6586b9ca) — single source of truth. Default (no params) hides the
        // archive (includeArchived defaults to false); backlog + board columns
        // are shown. `mine`/`level` stay here (presentation/agent-specific).
        const b = await fetchBoard(ctx, { location: params.location, includeArchived: params.includeArchived ?? false });
        let tasks = b.tasks ?? [];
        if (params.mine) tasks = tasks.filter((t) => t.assignee === ctx.agentName);
        if (params.level) tasks = tasks.filter((t) => (t.level ?? "task") === params.level);
        const wantLoc = params.location;
        const showArchive = !!params.includeArchived || wantLoc === "archive";
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
        const b = await fetchBoard(ctx);
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
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
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
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
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
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; message?: string; task?: BoardTask }>(
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
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
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
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; message?: string; task?: BoardTask }>(
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
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      const made: string[] = [];
      const failed: string[] = [];
      for (const s of params.subtasks) {
        try {
          const resp = await ctx.client.request<{ type: string; message?: string; task?: BoardTask }>(
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
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
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
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; message?: string; task?: BoardTask }>(
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
      favorite: Type.Optional(Type.Boolean({ description: "If true, mark this project dir as a favorite (shown at the top of mail_list_projects and the UI picker). Use for projects you spawn into often." })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; name?: string; message?: string }>(
          { type: "spawn", cwd: params.cwd, name: params.name, model: params.model, kickoff: params.kickoff, favorite: params.favorite },
          45_000
        );
        if (resp.type === "error") return { content: [{ type: "text" as const, text: `❌ ${resp.message}` }] };
        const name = resp.name ?? "";
        const fav = params.favorite ? " · ⭐ favorited" : "";
        const kick = params.kickoff ? ` (kickoff delivered as new-session task)` : "";
        return {
          content: [{ type: "text" as const, text: `✅ Spawned agent '${name}' in ${params.cwd}${kick}${fav}. It will appear in mail_list_agents shortly; assign it work with board_assign_task or mail_send(newSession:true).` }],
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
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; message?: string }>(
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

  // ── Project history + favorites (spawn-agent “recent projects”) ──────────────
  //
  // The daemon tracks every dir you spawn an agent into (recent history) plus
  // a starred set (favorites), shared across the federation and persisted to
  // disk. mail_list_projects surfaces them so an orchestrator can pick a cwd
  // to spawn into without browsing the filesystem each time. mail_set_project_favorite
  // stars/unstars a dir (also doable in one shot via mail_spawn_agent's `favorite` param).

  pi.registerTool({
    name: "mail_list_projects",
    label: "Mail: Projects",
    description:
      "List recently-spawned project directories (history) and favorited project directories, tracked by the daemon across the federation. Each entry shows the cwd, whether a spawned agent is currently running in it, and (for history) the last spawn time + count. Use to pick a working directory for mail_spawn_agent instead of browsing the filesystem each time.",
    promptSnippet: "List recent + favorite spawn project dirs",
    promptGuidelines: [
      "Use mail_list_projects before mail_spawn_agent to find a known project dir quickly.",
      "Favorites persist and are shared federation-wide; star dirs you spawn into often with mail_set_project_favorite or the `favorite` param on mail_spawn_agent.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; favorites?: Array<{ cwd: string; alive: boolean }>; history?: Array<{ cwd: string; alive: boolean; lastSpawnedAt: number; count: number; lastName?: string }> }>(
          { type: "spawn_projects" },
          10_000
        );
        if (resp.type === "error") return { content: [{ type: "text" as const, text: `❌ ${(resp as { message?: string }).message ?? "unknown"}` }] };
        const favs = resp.favorites ?? [];
        const hist = resp.history ?? [];
        const lines: string[] = [];
        if (favs.length) {
          lines.push(`⭐ Favorites (${favs.length})`);
          for (const f of favs) lines.push(`  • ${f.cwd}${f.alive ? "  · live agent running" : ""}`);
          lines.push("");
        }
        if (hist.length) {
          lines.push(`🕒 Recent projects (${hist.length})`);
          for (const h of hist) {
            const when = new Date(h.lastSpawnedAt).toLocaleString();
            lines.push(`  • ${h.cwd}${h.alive ? "  · live" : ""}  · ${when} (×${h.count}${h.lastName ? `, last “${h.lastName}”` : ""})`);
          }
        }
        if (!lines.length) lines.push("(no projects yet — spawn an agent to start tracking recent dirs)");
        const body = `📂 Projects — ${favs.length} favorite${favs.length === 1 ? "" : "s"}, ${hist.length} recent\n\n${lines.join("\n")}`;
        return {
          content: [{ type: "text" as const, text: body }],
          details: { favorites: favs, history: hist },
        };
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "mail_set_project_favorite",
    label: "Mail: Favorite Project",
    description:
      "Star or unstar a project directory as a favorite (tracked by the daemon, shared federation-wide). Favorited dirs appear at the top of mail_list_projects and the web UI spawn picker. Use to mark project dirs you spawn agents into often. Returns the updated projects list.",
    promptSnippet: "Star/unstar a spawn project dir",
    promptGuidelines: [
      "Favorite a project dir with mail_set_project_favorite when you expect to spawn agents into it repeatedly.",
      "You can also favorite at spawn time via the `favorite` param on mail_spawn_agent.",
    ],
    parameters: Type.Object({
      cwd: Type.String({ description: "Absolute project directory to favorite/unfavorite" }),
      favorite: Type.Boolean({ description: "true to add to favorites, false to remove" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; favorite?: boolean; message?: string }>(
          { type: "spawn_favorite", cwd: params.cwd, favorite: params.favorite },
          10_000
        );
        if (resp.type === "error") return { content: [{ type: "text" as const, text: `❌ ${resp.message}` }] };
        const state = resp.favorite ? "⭐ favorited" : "unfavorited";
        return { content: [{ type: "text" as const, text: `✅ ${params.cwd} — ${state}` }] };
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });
}
