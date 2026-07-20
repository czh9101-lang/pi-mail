/**
 * HTTP web UI + WebSocket terminal for the pi-mail daemon.
 * Extracted from daemon.mjs. Exposes createHttpServer({ uiHtml, uiPort, uiHost })
 * which builds the httpServer (REST routes + static UI + /api/spawn/terminal
 * WS upgrade) and returns it; the caller owns .listen(). Depends on core,
 * board, board-ops, jira, and spawn modules.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  messageLog,
  messagePage,
  humanInboxCount,
  HUMAN_AGENT_ID,
  HUMAN_AGENT_NAME,
  log,
  archiveHumanMessage,
  clearMailHistory,
  sendMail,
  broadcastMail,
  federationAgents,
  AGENT_DIR,
} from "./core.mjs";
import { boardState, board, jiraCfg } from "./board.mjs";
import {
  boardMove,
  boardAssign,
  boardComment,
  boardProgress,
  boardCreate,
  boardUpdate,
  boardFlag,
  boardSetConfig,
} from "./board-ops.mjs";
import { syncBoard } from "./jira.mjs";
import { mmState } from "./middle-manager.mjs";
import { ceoState, ceoTick } from "./ceo.mjs";
import {
  spawnState,
  listSpawnDir,
  spawnAgent,
  stopAgent,
  setFavorite,
  projectsState,
  spawnRegistry,
} from "./spawn.mjs";
import { handleMcpRequest, jsonRpcError } from "./http-mcp.mjs";
import { chatPost, chatGet, chatState } from "./chat.mjs";
import { attachTerminalUpgrade } from "./http-terminal.mjs";

/** Static UI assets served from the extension dir. The filename for each
 *  route is the pathname without the leading slash (e.g. "/ui.css" ->
 *  "ui.css"); files are re-read from disk on each request so edits take
 *  effect after a browser refresh with no daemon restart. */
const UI_ASSET_TYPES = {
  "/ui.css": "text/css; charset=utf-8",
  "/ui-core.js": "text/javascript; charset=utf-8",
  "/ui-board.js": "text/javascript; charset=utf-8",
  "/ui-board-modal.js": "text/javascript; charset=utf-8",
  "/ui-board-settings.js": "text/javascript; charset=utf-8",
  "/ui-spawn.js": "text/javascript; charset=utf-8",
  "/ui-terminal.js": "text/javascript; charset=utf-8",
  "/ui-mailbox.js": "text/javascript; charset=utf-8",
  "/ui-app.js": "text/javascript; charset=utf-8",
};

// ── Federation snapshot (for the UI) ──────────────────────────────────────────

function federationState() {
  // Lean snapshot: the messageLog is no longer shipped in full here (it is
  // unbounded history). Callers fetch pages via GET /api/messages instead.
  // `messages` is now a small summary (total + human inbox count) so the UI
  // status bar / badges keep working without the dump.
  // The board excludes the archive pool by default (the UI fetches it on
  // demand via /api/board?includeArchived=true when "show done" is toggled),
  // so the 3s poll no longer ships archived tasks either.
  return {
    human: { agentId: HUMAN_AGENT_ID, agentName: HUMAN_AGENT_NAME },
    agents: federationAgents(),
    messages: { total: messageLog.length, unread: humanInboxCount() },
    board: boardState(HUMAN_AGENT_ID, { includeArchived: false }),
    spawn: spawnState(),
    ceo: { enabled: board.config.ceoEnabled === true, intervalMin: board.config.ceoIntervalMin ?? 120, lastSpawnTs: spawnRegistry.ceo?.lastSpawnTs ?? 0 },
    now: Date.now(),
  };
}


// ── HTTP web UI ───────────────────────────────────────────────────────────────

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

/** Build the HTTP server: REST routes, static UI, and the /api/spawn/terminal
 *  WebSocket upgrade. The caller owns .listen(). `uiHtmlPath` is the path to
 *  ui.html and `uiDir` is the directory holding the split UI asset files;
 *  both are re-read from disk on each request so UI edits show up after a
 *  browser refresh without restarting the daemon. */
export function createHttpServer({ uiHtmlPath, uiDir }) {
  const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      let uiHtml;
      try {
        uiHtml = fs.readFileSync(uiHtmlPath, "utf8");
      } catch (e) {
        log(`ui.html not found at ${uiHtmlPath}: ${e.message}`);
        json(res, 500, { error: "ui.html not available" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(uiHtml);
      return;
    }

    // Split UI assets (css/js) served as separate files so ui.html stays
    // small. Re-read from disk on each request so edits take effect after a
    // browser refresh with no daemon restart.
    if (req.method === "GET" && url.pathname in UI_ASSET_TYPES) {
      let body;
      try {
        body = fs.readFileSync(path.join(uiDir, url.pathname.slice(1)), "utf8");
      } catch (e) {
        json(res, 404, { error: "asset not found" });
        return;
      }
      res.writeHead(200, { "Content-Type": UI_ASSET_TYPES[url.pathname] });
      res.end(body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      json(res, 200, federationState());
      return;
    }

    // Paginated + filtered message history (task 312e01b3). The UI mailbox /
    // history tabs fetch pages here instead of receiving the whole log via
    // /api/state. Cursor pagination (newest-first); filters: archived
    // (include|exclude|only), to/from/involves (agent name or id). Backward-
    // compatible shape: { messages, nextCursor, hasMore, total }.
    if (req.method === "GET" && url.pathname === "/api/messages") {
      const limit = parseInt(url.searchParams.get("limit") || "", 10);
      const cursor = url.searchParams.get("cursor") || undefined;
      const archived = url.searchParams.get("archived") || undefined;
      const to = url.searchParams.get("to") || undefined;
      const from = url.searchParams.get("from") || undefined;
      const involves = url.searchParams.get("involves") || undefined;
      const opts = {
        ...(Number.isFinite(limit) ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
        ...(archived ? { archived } : {}),
        ...(to ? { to } : {}),
        ...(from ? { from } : {}),
        ...(involves ? { involves } : {}),
      };
      json(res, 200, messagePage(opts));
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

    if (req.method === "POST" && url.pathname === "/api/clear-mail") {
      clearMailHistory();
      log(`Mail history cleared (${messageLog.length} messages remaining)`);
      json(res, 200, { ok: true });
      return;
    }

    // ── Task board endpoints (actor: the human operator) ────────────────────

    if (req.method === "GET" && url.pathname === "/api/board") {
      // Optional location/archive filter (task 6586b9ca): ?location=board|backlog|archive
      // and ?includeArchived=true|false. Omit both for the full board (UI default).
      // Optional group filter (task b59e930a): ?group=all|<name>. Omit for the
      // default same-group (agent) / all-groups (human) scoping.
      const location = url.searchParams.get("location") || undefined;
      const incArch = url.searchParams.get("includeArchived");
      const group = url.searchParams.get("group") || undefined;
      const opts = { location, group, ...(incArch !== null ? { includeArchived: incArch === "true" } : {}) };
      // Drop undefined keys so the default (no filter) path stays clean.
      const clean = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
      json(res, 200, boardState(HUMAN_AGENT_ID, clean));
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
          jiraEnabled: board.config.jiraEnabled !== false,
          nudgeEnabled: board.config.nudgeEnabled !== false,
          nudgeIntervalMin: board.config.nudgeIntervalMin ?? 30,
          mmEnabled: board.config.mmEnabled === true,
          mmIntervalMin: board.config.mmIntervalMin ?? 30,
          mmModel: board.config.mmModel ?? "",
          mmMaxLifetimeMin: board.config.mmMaxLifetimeMin ?? 15,
          workerMaxLifetimeMin: board.config.workerMaxLifetimeMin ?? 30,
          ceoEnabled: board.config.ceoEnabled === true,
          ceoIntervalMin: board.config.ceoIntervalMin ?? 120,
          ceoModel: board.config.ceoModel ?? "",
          ceoMaxLifetimeMin: board.config.ceoMaxLifetimeMin ?? 15,
          chatIdleMin: board.config.chatIdleMin ?? 60,
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
        const reason = board.config.jiraEnabled === false ? "Jira is disabled" : "Jira is not configured";
        json(res, 200, { ok: false, error: reason });
        return;
      }
      const r = await syncBoard("manual");
      json(res, 200, { ok: !board.syncError, error: board.syncError ?? undefined, columns: r?.columns ?? null });
      return;
    }

    // Middle-manager status (config snapshot + live MM sessions). Read-only.
    if (req.method === "GET" && url.pathname === "/api/mm") {
      json(res, 200, mmState());
      return;
    }

    // CEO status (config snapshot + live CEO sessions). Read-only.
    if (req.method === "GET" && url.pathname === "/api/ceo") {
      json(res, 200, ceoState());
      return;
    }

    // Run a CEO cycle now (manual trigger from the Board UI). Forces a tick
    // — bypasses the interval gate — so the operator can spawn a CEO on
    // demand instead of waiting for the scheduler. Reuses the scheduler's
    // own spawnCeo (picks the first favorite cwd, uses ceoModel, respects
    // the no-overlap guard, injects the canonical ceoKickoff). Still
    // requires ceoEnabled === true (a forced tick on a disabled CEO is a
    // no-op); the UI toasts that hint. Returns the ceoTick result.
    if (req.method === "POST" && url.pathname === "/api/ceo/tick") {
      const r = ceoTick(Date.now(), true);
      json(res, 200, r.error ? { ok: false, error: r.error }
        : r.spawned ? { ok: true, name: r.name }
        : { ok: false, skipped: r.reason || r.skipped || "not spawned" });
      return;
    }

    // ── Agent spawn endpoints (actor: the human operator / orchestrators) ────

    if (req.method === "GET" && url.pathname === "/api/spawn") {
      json(res, 200, spawnState());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/spawn/projects") {
      json(res, 200, projectsState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/spawn/favorite") {
      const body = await readJsonBody(req);
      if (!body.cwd || typeof body.cwd !== "string") { json(res, 400, { ok: false, error: "Missing 'cwd'" }); return; }
      const favorite = !!body.favorite;
      const nowFav = setFavorite(body.cwd, favorite);
      json(res, 200, { ok: true, favorite: nowFav, ...projectsState() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/spawn/ls") {
      const r = listSpawnDir(url.searchParams.get("path") || os.homedir(), { hidden: url.searchParams.get("hidden") === "1" });
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, dir: r.dir, dirs: r.dirs });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/spawn") {
      const body = await readJsonBody(req);
      const r = spawnAgent({ cwd: body.cwd, name: body.name, model: body.model, kickoff: body.kickoff, favorite: body.favorite });
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, name: r.name });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/spawn/stop") {
      const body = await readJsonBody(req);
      const r = stopAgent({ name: body.name });
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true });
      return;
    }

    // ── Session logs endpoints ────────────────────────────────────────────
    // List recent pi session log files from ~/.pi/agent/sessions/. Each entry
    // is a JSONL file; the api returns a sorted list (newest first) with
    // project group, timestamp, size, and a path for content retrieval.

    if (req.method === "GET" && url.pathname === "/api/logs") {
      const max = parseInt(url.searchParams.get("max") || "", 10) || 100;
      const sessionsDir = path.join(AGENT_DIR, "sessions");
      const entries = [];
      try {
        const groups = fs.readdirSync(sessionsDir, { withFileTypes: true });
        for (const g of groups) {
          if (!g.isDirectory()) continue;
          const groupDir = path.join(sessionsDir, g.name);
          // Strip the "--" wrapper from the dir-slug for display.
          // The slug is the path with slashes replaced by hyphens; it's lossy
          // to reverse perfectly (a hyphen could be a slash or a real hyphen),
          // so we show the slug as-is which is readable and unambiguous.
          let project = g.name;
          if (project.startsWith("--")) project = project.slice(2);
          if (project.endsWith("--")) project = project.slice(0, -2);
          let files;
          try { files = fs.readdirSync(groupDir); } catch { continue; }
          for (const f of files) {
            if (!f.endsWith(".jsonl")) continue;
            const fp = path.join(groupDir, f);
            let stat;
            try { stat = fs.statSync(fp); } catch { continue; }
            // Parse timestamp from filename: YYYY-MM-DDTHH-mm-ss-...
            const tsMatch = f.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
            const ts = tsMatch
              ? new Date(tsMatch[1], tsMatch[2] - 1, tsMatch[3], tsMatch[4], tsMatch[5], tsMatch[6]).toISOString()
              : stat.mtime.toISOString();
            entries.push({
              name: f,
              project,
              path: fp,
              size: stat.size,
              ts,
            });
          }
        }
      } catch { /* sessions dir may not exist */ }
      entries.sort((a, b) => b.ts.localeCompare(a.ts));
      json(res, 200, { entries: entries.slice(0, max) });
      return;
    }

    // Serve one session log file (JSONL). Accepts ?path=<absolute-path> and
    // optionally ?tail=<lines> to return only the last N lines.
    if (req.method === "GET" && url.pathname === "/api/logs/content") {
      const fp = url.searchParams.get("path");
      if (!fp) { json(res, 400, { error: "Missing 'path'" }); return; }
      // Safety: only allow files under ~/.pi/agent/sessions/
      const sessionsDir = path.resolve(AGENT_DIR, "sessions");
      if (!path.resolve(fp).startsWith(sessionsDir + path.sep)) {
        json(res, 403, { error: "Access denied" });
        return;
      }
      let content;
      try {
        content = fs.readFileSync(fp, "utf8");
      } catch (e) {
        json(res, 404, { error: "File not found: " + (e?.message || String(e)) });
        return;
      }
      const tail = parseInt(url.searchParams.get("tail") || "", 10);
      if (tail > 0) {
        const lines = content.split("\n");
        // Drop trailing empty line
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        content = lines.slice(-tail).join("\n");
      }
      // Size guard: refuse to serve files larger than 2MB
      if (content.length > 2_000_000) {
        json(res, 413, { error: "File too large" });
        return;
      }
      json(res, 200, { content });
      return;
    }

    // ── MCP project chat endpoints (actor: the human operator / MCP client) ───
    // Multi-turn chat with a project's spawned agent over pi-mail. chat_post
    // spawns (or reuses) a chat worker for the cwd and delivers the question as
    // mail; chat_get returns the thread history, blocking until the agent has
    // replied (no polling). See lib/chat.mjs.

    if (req.method === "GET" && url.pathname === "/api/chat") {
      json(res, 200, chatState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat/post") {
      const body = await readJsonBody(req);
      if (!body.cwd || typeof body.cwd !== "string") { json(res, 400, { ok: false, error: "Missing 'cwd'" }); return; }
      if (!body.message || typeof body.message !== "string") { json(res, 400, { ok: false, error: "Missing 'message'" }); return; }
      const r = await chatPost({ cwd: body.cwd, message: body.message, threadId: body.threadId, wait: body.wait !== false, timeoutMs: body.timeoutMs });
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, ...r });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat/get") {
      const body = await readJsonBody(req);
      if (!body.threadId || typeof body.threadId !== "string") { json(res, 400, { ok: false, error: "Missing 'threadId'" }); return; }
      const r = await chatGet({ threadId: body.threadId, timeoutMs: body.timeoutMs });
      json(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, ...r });
      return;
    }

    // ── MCP server (Streamable HTTP) — hosted in-process, no separate proc ─
    // The MCP Streamable HTTP transport is served at /mcp for the full method
    // surface: POST carries JSON-RPC requests, GET opens a standalone SSE
    // keep-alive stream (406 if the client doesn't Accept text/event-stream),
    // DELETE ends a session. POST/DELETE + header validation (incl. the 405
    // Allow: GET, POST, DELETE for unsupported methods) is delegated to the SDK
    // transport; GET is served directly by http-mcp.mjs as a keep-alive stream
    // (immediate + periodic SSE comment keep-alives) because the SDK's
    // stateless GET handler emits nothing and the board server pushes no
    // notifications — without it, clients that wait for the first SSE byte
    // (e.g. bundle-mcp) hang until their connect timeout. We only pre-parse
    // the POST body (to enforce the size guard). Stateless: a fresh McpServer
    // + transport per POST/DELETE, no session id (http-mcp.mjs).
    if (url.pathname === "/mcp") {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await handleMcpRequest(req, res, body);
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e?.message ?? String(e) });
  }
});

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log(`Mail UI: port ${process.env.PI_MAIL_UI_PORT || "1994"} in use — UI disabled (set PI_MAIL_UI_PORT to change)`);
  } else {
    log(`Mail UI error: ${err.message}`);
  }
});

// WebSocket terminal upgrade (/api/spawn/terminal) — see http-terminal.mjs.
attachTerminalUpgrade(httpServer);

  return httpServer;
}
