// Tests for the in-daemon MCP server (task c8f3cb77).
//
// The MCP server is hosted inside the pi-mail daemon (POST /mcp on its HTTP
// UI port), backed by an in-process board backend — no separate process, no
// HTTP loopback. These tests boot an isolated daemon, then drive /mcp over
// real HTTP with JSON-RPC 2.0 (initialize → tools/list → tools/call) and
// assert the board tools work end-to-end against the daemon's live board
// state.
//
// Run: npm test   (node:test runner)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn as pSpawn } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const REPO = path.resolve(import.meta.dirname, "..");
const DAEMON = path.join(REPO, "extensions", "daemon.mjs");

// ── Isolation harness ──────────────────────────────────────────────────────

let tmpHome, proc, sockPath, port;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function startDaemon() {
  return new Promise((resolve, reject) => {
    proc = pSpawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PI_MAIL_UI_HOST: "127.0.0.1",
        PI_MAIL_UI_PORT: String(port),
        // No real tmux/pi needed for the board MCP tests.
        PATH: process.env.PATH,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (c) => { stderr += c.toString(); });
    proc.on("exit", (code, sig) => {
      if (!proc.__stopped) console.error("daemon exited unexpectedly", code, sig, stderr.slice(-500));
    });
    // Wait for the socket to appear (daemon is up), then wait for HTTP.
    const tryConnect = (retries = 0) => {
      const s = net.createConnection(sockPath);
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", () => {
        if (retries > 200) return reject(new Error("daemon socket never appeared\n" + stderr));
        setTimeout(() => tryConnect(retries + 1), 30);
      });
    };
    tryConnect();
  });
}

function stopDaemon() {
  if (!proc) return Promise.resolve();
  proc.__stopped = true;
  return new Promise((r) => {
    proc.once("exit", () => { proc = null; r(); });
    proc.kill("SIGTERM");
    setTimeout(() => { if (proc) { proc.kill("SIGKILL"); proc = null; } r(); }, 3000);
  });
}

/** POST JSON-RPC to /mcp and return the parsed response.
 *  Handles both application/json and text/event-stream (SSE) responses — the
 *  SDK may answer either; for a single request the result is the one
 *  `data:` line carrying the matching JSON-RPC id. */
async function mcp(rpc) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The MCP Streamable HTTP transport requires the client to accept both.
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify(rpc),
  });
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  let body = null;
  if (ct.includes("text/event-stream")) {
    // Collect `data:` payloads from each SSE event block.
    for (const block of text.split(/\n\n+/)) {
      const dataLines = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      if (!dataLines.length) continue;
      const parsed = dataLines.join("\n");
      try {
        const obj = JSON.parse(parsed);
        // Match the request id when present (notifications have no id).
        if (obj.id === rpc.id || obj.id === undefined) { body = obj; break; }
      } catch {}
    }
  } else {
    try { body = JSON.parse(text); } catch {}
  }
  return { status: res.status, body, text };
}

let rpcId = 0;
const call = (method, params) => mcp({ jsonrpc: "2.0", id: ++rpcId, method, params });
const notify = (method, params) => mcp({ jsonrpc: "2.0", method, params });

before(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pimail-mcp-"));
  sockPath = path.join(tmpHome, ".pi", "agent", "mail-daemon.sock");
  port = await freePort();
  await startDaemon();
});

after(async () => {
  await stopDaemon();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ── initialize / tools/list ─────────────────────────────────────────────────

test("/mcp initialize handshake succeeds", async () => {
  const r = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0" },
  });
  assert.equal(r.status, 200);
  assert.ok(r.body, "response is JSON");
  assert.equal(r.body.jsonrpc, "2.0");
  assert.equal(r.body.id, 1);
  assert.ok(r.body.result, "has result");
  assert.equal(r.body.result.serverInfo.name, "pi-mail-board");
  // The daemon-hosted server must advertise the streamable HTTP transport.
  // (Presence of capabilities is enough; exact shape is SDK-version dependent.)
  assert.ok(r.body.result.capabilities, "advertises capabilities");
});

test("tools/list exposes the board tools", async () => {
  // initialize first (most clients require it, though stateless server is permissive)
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  const r = await call("tools/list");
  assert.equal(r.status, 200);
  const names = (r.body.result.tools ?? []).map((t) => t.name);
  for (const expected of [
    "board_list_tasks", "board_get_task", "board_move_task", "board_comment_task",
    "board_progress_task", "board_assign_task", "board_create_task", "board_split_task",
    "board_update_task", "board_flag_task", "get_board_config", "set_board_config", "sync_board",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
});

test("GET /mcp is rejected (stateless server, POST only)", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(res.status, 405);
});

// ── board tool calls (in-process backend → live board state) ───────────────

test("board_list_tasks on an empty board", async () => {
  const r = await call("tools/call", { name: "board_list_tasks", arguments: {} });
  assert.equal(r.status, 200);
  assert.ok(!r.body.result.isError, "tool returned an error: " + (r.body.result.content?.[0]?.text ?? ""));
  const text = r.body.result.content[0].text;
  assert.match(text, /Board is empty/);
});

test("board_create_task then board_get_task round-trip", async () => {
  const create = await call("tools/call", {
    name: "board_create_task",
    arguments: { summary: "MCP test task", description: "created via the in-daemon MCP server" },
  });
  assert.equal(create.status, 200);
  assert.ok(!create.body.result.isError, "tool returned an error: " + (create.body.result.content?.[0]?.text ?? ""));
  const createText = create.body.result.content[0].text;
  const idMatch = createText.match(/\[([0-9a-f]{8})\]/);
  assert.ok(idMatch, `create result mentions an id: ${createText}`);
  const id = idMatch[1];

  const get = await call("tools/call", { name: "board_get_task", arguments: { taskId: id } });
  assert.equal(get.status, 200);
  const getText = get.body.result.content[0].text;
  assert.match(getText, /MCP test task/);
  assert.match(getText, /created via the in-daemon MCP server/);
});

test("board_move_task moves a task to 'To Do'", async () => {
  await call("tools/call", { name: "board_create_task", arguments: { summary: "move me" } });
  const list = await call("tools/call", { name: "board_list_tasks", arguments: {} });
  const id = list.body.result.content[0].text.match(/\[([0-9a-f]{8})\]/)[1];
  const r = await call("tools/call", { name: "board_move_task", arguments: { taskId: id, column: "To Do" } });
  assert.ok(!r.body.result.isError, "tool returned an error: " + (r.body.result.content?.[0]?.text ?? ""));
  assert.match(r.body.result.content[0].text, /Moved/);
});

test("board_flag_task sets the unclear flag", async () => {
  await call("tools/call", { name: "board_create_task", arguments: { summary: "flag me" } });
  const list = await call("tools/call", { name: "board_list_tasks", arguments: {} });
  const id = list.body.result.content[0].text.match(/\[([0-9a-f]{8})\]/)[1];
  const r = await call("tools/call", { name: "board_flag_task", arguments: { taskId: id, reason: "ambiguous scope" } });
  assert.ok(!r.body.result.isError, "tool returned an error: " + (r.body.result.content?.[0]?.text ?? ""));
  assert.match(r.body.result.content[0].text, /flagged unclear/);
});

test("get_board_config returns column list", async () => {
  const r = await call("tools/call", { name: "get_board_config", arguments: {} });
  assert.ok(!r.body.result.isError, "tool returned an error: " + (r.body.result.content?.[0]?.text ?? ""));
  const cfg = JSON.parse(r.body.result.content[0].text);
  assert.ok(Array.isArray(cfg.columns) && cfg.columns.length > 0);
  assert.equal(cfg.config.apiTokenSet, false);
});
