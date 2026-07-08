/**
 * The pi-mail board MCP server.
 *
 * Exposes the mail daemon's shared kanban task board to external MCP
 * clients (Claude Desktop, Cursor, …) over stdio. It is a thin shim: each
 * MCP tool maps one-to-one onto the daemon's existing HTTP board API
 * (extensions/daemon.mjs), so all board logic, Jira sync, and assignment
 * notifications stay in the daemon. The MCP surface mirrors the in-pi
 * `board_*` agent tools (extensions/index.ts) — same names, same
 * parameter shapes — so clients interact with the board the same way
 * agents do.
 *
 * Board operations run as the `human` agent (the daemon's HTTP API
 * attribute to HUMAN_AGENT_ID, same as the web UI). Configure the daemon
 * address via PI_MAIL_BASE_URL (or PI_MAIL_UI_HOST / PI_MAIL_UI_PORT).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BoardBackend, BoardOpResponse } from "./types.js";
import { httpBackend } from "./http.js";
import { findTask, renderBoard, renderOpResult, renderTask } from "./format.js";

/** Common: find a task across the board, returning a "not found" string if missing. */
async function loadTask(backend: BoardBackend, taskId: string) {
  const b = await backend.getBoard();
  const t = findTask(b, taskId);
  return { b, t };
}

/** Wrap an async handler so thrown BoardApiErrors surface as MCP tool errors. */
function toolError(err: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const msg = err instanceof Error ? `❌ ${err.message}` : `❌ ${String(err)}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

/** ok result helper. */
function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Build the MCP server with all board tools registered.
 *  `backend` defaults to the HTTP-fetch backend (standalone stdio bridge);
 *  the daemon passes an in-process backend when it hosts /mcp directly. */
export function createBoardMcpServer(backend: BoardBackend = httpBackend): McpServer {
  const server = new McpServer({
    name: "pi-mail-board",
    version: "1.0.0",
  });
  const http = backend;

  // ── board_list_tasks ──────────────────────────────────────────────────────
  server.tool(
    "board_list_tasks",
    "List tasks on the shared pi-mail board, grouped by location/column (Backlog pool, then columns, then Archive when shown). By default archived tasks are hidden; pass includeArchived:true to see them. Use location to filter to 'board'|'backlog'|'archive', and level for 'epic'|'story'|'task'|'subtask'. mine:true shows only tasks assigned to the human agent.",
    {
      mine: z.boolean().optional().describe("Only show tasks assigned to the human agent (the MCP operator)"),
      location: z.string().optional().describe("Filter by location: 'board' (on a column), 'backlog', or 'archive'. Omit to see board + backlog (archive hidden unless includeArchived)."),
      level: z.string().optional().describe("Filter to a level: 'epic' | 'story' | 'task' | 'subtask'"),
      includeArchived: z.boolean().optional().describe("Include archived tasks (location='archive') in the listing"),
    },
    async ({ mine, location, level, includeArchived }) => {
      try {
        const b = await http.getBoard();
        return ok(renderBoard(b, { mineAssignee: mine ? "human" : null, location, level, includeArchived }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_get_task ────────────────────────────────────────────────────────
  server.tool(
    "board_get_task",
    "Get full details of one board task by id (8-char prefix ok) or Jira key: description, column, assignee, subtasks, column instructions, and recent activity.",
    {
      taskId: z.string().describe("Task id prefix (from board_list_tasks) or Jira key (e.g. PROJ-123)"),
    },
    async ({ taskId }) => {
      try {
        const { b, t } = await loadTask(http, taskId);
        if (!t) return ok(`Task not found: ${taskId}. Run board_list_tasks first.`);
        return ok(renderTask(t, b));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_move_task ───────────────────────────────────────────────────────
  server.tool(
    "board_move_task",
    "Move a board task to a column (by name or id) or to the 'backlog' / 'archive' pool. For Jira-mapped columns this also transitions the Jira issue; backlog/archive are local-only (never pushed to Jira). The assignee is mailed the new column's instructions.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      column: z.string().describe("Destination column name or id"),
      note: z.string().optional().describe("Optional note added to the activity log"),
    },
    async ({ taskId, column, note }) => {
      try {
        const resp = await http.moveTask(taskId, column, note);
        const { b, t } = await loadTask(http, taskId);
        const colName = t ? (b.columns.find((c) => c.id === t.columnId)?.name ?? column) : column;
        return ok(renderOpResult(resp, `Moved ${taskId} → ${colName}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_comment_task ────────────────────────────────────────────────────
  server.tool(
    "board_comment_task",
    "Add a comment to a board task's activity log. For Jira-synced tasks the comment is also posted to the Jira issue.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      text: z.string().describe("Comment text"),
    },
    async ({ taskId, text }) => {
      try {
        const resp = await http.commentTask(taskId, text);
        return ok(renderOpResult(resp, `Comment added to ${taskId}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_progress_task ───────────────────────────────────────────────────
  server.tool(
    "board_progress_task",
    "Post a progress update on a board task you're working on. Progress is internal (not posted to Jira); it shows in the task detail view and is folded into the description when the task moves columns, so the next agent inherits a snapshot. Use this to report what's done / what's blocking, especially before moving the task onward.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      text: z.string().describe("What you've done since the last update, and anything blocking you"),
    },
    async ({ taskId, text }) => {
      try {
        const resp = await http.progressTask(taskId, text);
        return ok(renderOpResult(resp, `Progress posted on ${taskId}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_assign_task ────────────────────────────────────────────────────
  server.tool(
    "board_assign_task",
    "Assign a board task to a federation agent by name. The assignee is mailed the full task package (description + column instructions + tool crib). Use newSession:true to start them on a fresh session.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      assignee: z.string().describe("Agent display name (from mail_list_agents) or id prefix"),
      newSession: z.boolean().optional().describe("Start the assignee on a fresh session"),
    },
    async ({ taskId, assignee, newSession }) => {
      try {
        const resp = await http.assignTask(taskId, assignee, newSession);
        return ok(renderOpResult(resp, `Assigned ${taskId} to ${assignee}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_create_task ────────────────────────────────────────────────────
  server.tool(
    "board_create_task",
    "Create a new task on the shared board. With `parent` it becomes a subtask; when the parent is a Jira issue (or inJira is true) a real Jira issue is created and kept in sync. Otherwise board-only.",
    {
      summary: z.string().describe("One-line task summary"),
      description: z.string().optional().describe("Full task description"),
      column: z.string().optional().describe("Column name or id (defaults to the parent's column, else the first column). Ignored when backlog:true."),
      parent: z.string().optional().describe("Parent task id prefix or Jira key — makes this a subtask"),
      inJira: z.boolean().optional().describe("Create a Jira issue for a top-level task (needs a project key in board settings)"),
      level: z.string().optional().describe("Issue hierarchy: 'epic' | 'story' | 'task' | 'subtask' (local-only; defaults to 'task', or 'subtask' with a parent)"),
      epicId: z.string().optional().describe("Board id/prefix of the epic a story belongs to"),
      backlog: z.boolean().optional().describe("Create in the Backlog pool (off-board, local-only) instead of a column"),
    },
    async ({ summary, description, column, parent, inJira, level, epicId, backlog }) => {
      try {
        const resp: BoardOpResponse = await http.createTask({ summary, description, column, parent, inJira, level, epicId, backlog });
        const id = (resp.taskId ?? resp.task?.id ?? "?").slice(0, 8);
        const key = resp.key ?? resp.task?.key;
        const jiraNote = key ? ` (Jira: ${key})` : "";
        return ok(renderOpResult(resp, `Created task [${id}]${jiraNote} "${summary}"`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_split_task ─────────────────────────────────────────────────────
  server.tool(
    "board_split_task",
    "Subdivide a board task into subtasks. Each subtask lands in the parent's column; for Jira parents they are created as real Jira sub-tasks. Use when a task is too big for one pass — then assign the subtasks out.",
    {
      taskId: z.string().describe("Parent task id prefix or Jira key"),
      subtasks: z
        .array(
          z.object({
            summary: z.string().describe("Subtask summary"),
            description: z.string().optional().describe("Subtask description"),
          }),
        )
        .min(1)
        .describe("Subtasks to create"),
    },
    async ({ taskId, subtasks }) => {
      const made: string[] = [];
      const failed: string[] = [];
      for (const s of subtasks) {
        try {
          const resp = await http.createTask({ summary: s.summary, description: s.description, parent: taskId });
          if (resp.error) {
            failed.push(`"${s.summary}": ${resp.error}`);
          } else {
            const id = (resp.taskId ?? resp.task?.id ?? "?").slice(0, 8);
            const key = resp.key ?? resp.task?.key;
            made.push(`[${id}]${key ? ` ${key}` : ""} ${s.summary}`);
          }
        } catch (err) {
          failed.push(`"${s.summary}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const lines = [
        `${made.length ? "✅" : "❌"} Split ${taskId}: ${made.length}/${subtasks.length} subtask(s) created`,
        ...made.map((m) => `  • ${m}`),
        ...failed.map((f) => `  ❌ ${f}`),
      ];
      return ok(lines.join("\n"));
    },
  );

  // ── board_update_task ────────────────────────────────────────────────────
  server.tool(
    "board_update_task",
    "Edit a board task's summary and/or description. For Jira tasks the edit is pushed to the Jira issue — treat the description as the shared spec.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      summary: z.string().optional().describe("New summary"),
      description: z.string().optional().describe("New description"),
    },
    async ({ taskId, summary, description }) => {
      try {
        const resp = await http.updateTask(taskId, { summary, description });
        return ok(renderOpResult(resp, `Updated ${taskId}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_flag_task ──────────────────────────────────────────────────────
  server.tool(
    "board_flag_task",
    "Mark a board task as unclear (notifies the operator) or clear the flag once refined. Set with a reason before guessing; clear it after the spec is written into the description.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      reason: z.string().optional().describe("Why the task is unclear (required to set; ignored when clearing)"),
      clear: z.boolean().optional().describe("Clear an existing unclear flag"),
    },
    async ({ taskId, reason, clear }) => {
      try {
        const resp = await http.flagTask(taskId, reason, clear);
        const action = clear ? "cleared unclear flag" : `flagged unclear${reason ? `: ${reason}` : ""}`;
        return ok(renderOpResult(resp, `${taskId} ${action}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── get_board_config ─────────────────────────────────────────────────────
  server.tool(
    "get_board_config",
    "Read the board + Jira configuration (columns, JQL, project key, whether the API token is set, last sync).",
    {},
    async () => {
      try {
        const cfg = await http.getBoardConfig();
        return ok(JSON.stringify(cfg, null, 2));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── set_board_config ─────────────────────────────────────────────────────
  server.tool(
    "set_board_config",
    "Update board + Jira configuration (baseUrl, email, apiToken, jql, projectKey, issueType, subtaskIssueType, columns). Use to enable Jira sync.",
    {
      config: z.record(z.unknown()).describe("Partial board config object"),
    },
    async ({ config }) => {
      try {
        const resp = await http.setBoardConfig(config);
        return ok(`✅ Board config updated\n${JSON.stringify(resp, null, 2)}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── sync_board ────────────────────────────────────────────────────────────
  server.tool(
    "sync_board",
    "Trigger a manual Jira sync (pull remote changes, push local moves). Only when Jira is configured.",
    {},
    async () => {
      try {
        const resp = await http.syncBoard();
        return ok(`✅ Board sync triggered\n${JSON.stringify(resp, null, 2)}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  return server;
}
