/**
 * Thin HTTP client for the pi-mail daemon's board API.
 *
 * The mail daemon already implements the full board HTTP surface used by
 * its web UI (extensions/daemon.mjs, default port 1994). This module maps
 * each board operation onto the matching endpoint so the MCP server is a
 * pure shim — no board logic is duplicated here. All Jira sync, column
 * resolution, assignment notifications etc. stay in the daemon.
 *
 * Base URL is configured via PI_MAIL_BASE_URL, falling back to
 * http://127.0.0.1:${PI_MAIL_UI_PORT || 1994}.
 */

import type { BoardState, BoardOpResponse, BoardBackend, CreateTaskBody, UpdateTaskBody } from "./types.js";

/** Resolve the daemon base URL from env (with sensible defaults). */
export function daemonBaseUrl(): string {
  const explicit = process.env.PI_MAIL_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = process.env.PI_MAIL_UI_HOST ?? "127.0.0.1";
  const port = process.env.PI_MAIL_UI_PORT ?? "1994";
  return `http://${host}:${port}`;
}

/** A board API error (non-2xx response or transport failure). */
export class BoardApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BoardApiError";
  }
}

/** GET /api/board — the full board state (columns + tasks). */
export async function getBoard(): Promise<BoardState> {
  return request<BoardState>("GET", "/api/board");
}

/** GET /api/board/config — board + Jira config (apiToken redacted server-side). */
export async function getBoardConfig(): Promise<unknown> {
  return request<unknown>("GET", "/api/board/config");
}

/** POST /api/board/config — update board/Jira config. */
export async function setBoardConfig(config: Record<string, unknown>): Promise<unknown> {
  return request<unknown>("POST", "/api/board/config", config);
}

/** POST /api/board/sync — trigger a manual Jira sync. */
export async function syncBoard(): Promise<unknown> {
  return request<unknown>("POST", "/api/board/sync");
}

/** POST /api/board/move — move a task to a column. */
export async function moveTask(taskId: string, column: string, note?: string): Promise<BoardOpResponse> {
  return request<BoardOpResponse>("POST", "/api/board/move", { taskId, column, note });
}

/** POST /api/board/comment — add an activity comment. */
export async function commentTask(taskId: string, text: string): Promise<BoardOpResponse> {
  return request<BoardOpResponse>("POST", "/api/board/comment", { taskId, text });
}

/** POST /api/board/progress — post an internal progress update. */
export async function progressTask(taskId: string, text: string): Promise<BoardOpResponse> {
  return request<BoardOpResponse>("POST", "/api/board/progress", { taskId, text });
}

/** POST /api/board/assign — assign a task (mails the assignee). */
export async function assignTask(taskId: string, assignee: string, newSession?: boolean): Promise<BoardOpResponse> {
  return request<BoardOpResponse>("POST", "/api/board/assign", { taskId, assignee, newSession });
}

/** POST /api/board/create — create a task / subtask. */
export async function createTask(body: CreateTaskBody): Promise<BoardOpResponse> {
  return request<BoardOpResponse>("POST", "/api/board/create", body);
}

/** POST /api/board/update — edit a task's summary/description (pushes to Jira for jira tasks). */
export async function updateTask(
  taskId: string,
  body: UpdateTaskBody,
): Promise<BoardOpResponse> {
  return request<BoardOpResponse>("POST", "/api/board/update", { taskId, ...body });
}

/** POST /api/board/flag — set/clear the "unclear" flag (notifies the operator on set). */
export async function flagTask(taskId: string, reason?: string, clear?: boolean): Promise<BoardOpResponse> {
  return request<BoardOpResponse>("POST", "/api/board/flag", { taskId, reason, clear });
}

/** Default backend: a thin HTTP client over the daemon's `/api/board*` endpoints. */
export const httpBackend: BoardBackend = {
  getBoard,
  getBoardConfig,
  setBoardConfig,
  syncBoard,
  moveTask,
  commentTask,
  progressTask,
  assignTask,
  createTask,
  updateTask,
  flagTask,
};

// ── internals ─────────────────────────────────────────────────────────────────

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = daemonBaseUrl() + path;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Transport failure (daemon not running, wrong port, etc.).
    throw new BoardApiError(
      `could not reach mail daemon at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new BoardApiError(`daemon ${method} ${path} → HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // Some endpoints return non-JSON on degenerate input; surface as an error.
    throw new BoardApiError(`daemon ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`, res.status);
  }
}
