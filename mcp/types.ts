/**
 * Shared types for the pi-mail board MCP server.
 *
 * These mirror the shapes returned by the mail daemon's HTTP board API
 * (extensions/daemon.mjs `/api/board*`). They are deliberately a minimal
 * subset — enough to render tool output — rather than a full client SDK.
 * The daemon is the source of truth; if it adds fields we don't model
 * here, they are simply ignored.
 */

/** A single kanban column on the board. */
export interface BoardColumn {
  id: string;
  name: string;
  /** Jira status this column maps to (null = board-only column). */
  jiraStatus: string | null;
  /** Column instructions (board-only columns often carry workflow guidance). */
  instructions: string;
}

/** The "unclear" flag on a task (set via board_flag). */
export interface TaskFlag {
  by: string;
  reason: string;
  ts: number;
}

/** One activity-log entry on a task. */
export interface TaskActivity {
  ts: number;
  who: string;
  text: string;
  /** "progress" for board_progress_task updates; otherwise unset (treated as a comment/system event). */
  kind?: string;
}

/** A board task. `id` is the canonical uuid; `key` is the Jira key when origin=jira. */
export interface BoardTask {
  id: string;
  key: string | null;
  origin: "local" | "jira";
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
  flagged: TaskFlag | null;
  updatedAt: number;
  /** ts lower bound for progress entries already folded into the description. */
  progressSince?: number;
  /** ts of the most recent kind:"progress" activity entry. */
  lastProgressTs?: number;
  /** ts of the most recent progress-nudge mail (dedup). */
  lastNudgeTs?: number;
  activity: TaskActivity[];
  /** Where the task sits: "board" (a column), "backlog" (off-board pool), or "archive" (the done board). Older tasks backfill to "board". */
  location?: "board" | "backlog" | "archive";
  /** Issue hierarchy: epic > story > (task|subtask). Backfills to "task" (or "subtask" when it has a parent). */
  level?: "epic" | "story" | "task" | "subtask";
  /** Board id of the epic a story belongs to (local-only). */
  epicId?: string | null;
}

/** Response from GET /api/board — the whole board state. */
export interface BoardState {
  columns: BoardColumn[];
  tasks: BoardTask[];
  jiraConfigured: boolean;
  lastSync: number | null;
  syncError: string | null;
}

/** Normalized result from a board mutation HTTP call. */
export interface BoardOpResponse {
  ok: boolean;
  error?: string;
  warning?: string;
  message?: string;
  task?: BoardTask;
  taskId?: string;
  key?: string;
}
