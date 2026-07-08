// Tests for the agent-spawn feature (board subtask 4ab67b6b / task 1c582a88).
//
// Runs a fully isolated mail-daemon: a throwaway HOME (so the socket + spawn
// registry live in a temp dir), a fake `tmux` bin that records has/new/kill-
// session against a state dir, a free UI port, and a short spawn register
// timeout. Everything is driven over the daemon socket — no real tmux/pi is
// spawned and nothing touches the operator's ~/.pi.
//
// Run: npm test   (uses node:test, the stdlib runner — no new dependency)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn as pSpawn } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const REPO = path.resolve(import.meta.dirname, "..");
const DAEMON = path.join(REPO, "extensions", "daemon.mjs");

// ── Isolation harness ──────────────────────────────────────────────────────

let tmpHome, tmpState, fakeTmux, proc, sockPath, client;

function mkFakeTmux() {
  // A tmux stand-in. `new-session` records the session; `has-session` reports
  // it; `kill-session` removes it. The actual command tmux would run (pi) is
  // ignored — we never launch a real agent.
  const script = `#!/bin/sh
STATE="$TMUX_STATE_DIR"
case "$1" in
  has-session)
    name="$3"
    [ -f "$STATE/sessions/$name" ] && exit 0 || exit 1 ;;
  new-session)
    name=""
    while [ $# -gt 0 ]; do
      case "$1" in -s) name="$2"; shift 2 ;; *) shift ;; esac
    done
    mkdir -p "$STATE/sessions"
    touch "$STATE/sessions/$name"
    exit 0 ;;
  kill-session)
    name="$3"
    rm -f "$STATE/sessions/$name"
    exit 0 ;;
  *)
    exit 0 ;;
esac
`;
  fs.writeFileSync(fakeTmux, script, { mode: 0o755 });
}

function startDaemon() {
  return new Promise((resolve, reject) => {
    proc = pSpawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        HOME: tmpHome,                 // socket + registry land in tmpHome/.pi/agent
        PI_MAIL_TMUX_BIN: fakeTmux,
        PI_MAIL_PI_BIN: "/bin/true",   // never actually run (fake tmux ignores it)
        PI_MAIL_UI_PORT: "0",          // OS-picked UI port; we don't use the UI here
        PI_MAIL_UI_HOST: "127.0.0.1",
        PI_MAIL_SPAWN_TIMEOUT: "1500", // fast register-wait for the timeout test
        TMUX_STATE_DIR: tmpState,
        PATH: `${path.dirname(fakeTmux)}:${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (c) => { stderr += c.toString(); });
    proc.on("exit", (code, sig) => {
      if (!proc.__stopped) console.error("daemon exited unexpectedly", code, sig, stderr.slice(-500));
    });
    // Wait for the socket to appear, then resolve.
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

// Minimal newline-delimited JSON socket client (matches the extension).
function mkClient() {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath);
    s.setEncoding("utf8");
    let buf = "";
    let nextId = 1;
    const pending = new Map();
    const onNewMail = [];
    s.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.type === "ping") { s.write(JSON.stringify({ type: "pong" }) + "\n"); continue; }
        if (m.type === "new_mail") { onNewMail.forEach((cb) => cb(m.message)); continue; }
        if (m._reqId != null && pending.has(m._reqId)) {
          const e = pending.get(m._reqId); clearTimeout(e.t); pending.delete(m._reqId); e.res(m);
        }
      }
    });
    s.once("connect", () => resolve({
      request(msg, timeoutMs = 5000) {
        const id = nextId++;
        return new Promise((res, rej) => {
          const t = setTimeout(() => { pending.delete(id); rej(new Error("timeout: " + msg.type)); }, timeoutMs);
          pending.set(id, { res, rej, t });
          s.write(JSON.stringify({ ...msg, _reqId: id }) + "\n");
        });
      },
      onNewMail(cb) { onNewMail.push(cb); },
      close() { s.destroy(); },
    }));
    s.once("error", reject);
  });
}

// Register as an agent (required before board/spawn RPCs).
async function register(c, name, cwd = tmpHome) {
  return c.request({ type: "register", agentId: crypto.randomUUID(), agentName: name, cwd });
}

before(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pimail-home-"));
  tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "pimail-tmux-"));
  fakeTmux = path.join(tmpHome, "fake-tmux");
  mkFakeTmux();
  sockPath = path.join(tmpHome, ".pi", "agent", "mail-daemon.sock");
  await startDaemon();
  client = await mkClient();
  await register(client, "test-orchestrator");
});

after(async () => {
  client?.close();
  await stopDaemon();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpState, { recursive: true, force: true });
});

// Helper: spawn and return the reply.
const spawn = (c, o) => c.request({ type: "spawn", cwd: o.cwd, name: o.name, model: o.model, kickoff: o.kickoff });
const spawnStop = (c, name) => c.request({ type: "spawn_stop", name });
const spawnState = (c) => c.request({ type: "spawn_state" });

// ── validateSpawnCwd ────────────────────────────────────────────────────────

test("spawn rejects a non-existent cwd", async () => {
  const r = await spawn(client, { cwd: path.join(tmpHome, "nope-does-not-exist") });
  assert.equal(r.type, "error");
  assert.match(r.message, /not a directory/);
});

test("spawn rejects a cwd outside the allowed roots", async () => {
  // NOTE (flagged to operator): task 1c582a88 asks to test "outside allowlist"
  // rejection, but the spawn allowlist was REMOVED from daemon.mjs (uncommitted)
  // while this task was in progress — validateSpawnCwd now only checks that the
  // path is a real directory. So a real dir outside $HOME is currently ACCEPTED.
  // This test pins the CURRENT behaviour; if the allowlist is restored, flip
  // the assertion to expect {type:"error", /outside the allowed roots/}.
  const r = await spawn(client, { cwd: "/etc", name: "etc-currently-allowed" });
  assert.equal(r.type, "spawned", `expected /etc to be allowed (allowlist removed); got ${JSON.stringify(r)}`);
  await spawnStop(client, "etc-currently-allowed");
});

test("spawn accepts a cwd under the allowlist", async () => {
  const r = await spawn(client, { cwd: tmpHome, name: "allowlist-ok" });
  assert.equal(r.type, "spawned");
  await spawnStop(client, "allowlist-ok");
});

// ── name derivation + sanitisation ─────────────────────────────────────────

test("default name is <dir-basename>-<6hex> when no name given", async () => {
  const subdir = path.join(tmpHome, "myproject");
  fs.mkdirSync(subdir, { recursive: true });
  const r = await spawn(client, { cwd: subdir });
  assert.equal(r.type, "spawned");
  assert.match(r.name, /^myproject-[a-f0-9]{6}$/, `got ${r.name}`);
  await spawnStop(client, r.name);
});

test("explicit name with '.' and ':' is sanitised", async () => {
  const r = await spawn(client, { cwd: tmpHome, name: "my.agent:1" });
  assert.equal(r.type, "spawned");
  assert.equal(r.name, "my-agent-1");
  await spawnStop(client, r.name);
});

test("duplicate spawn name is rejected", async () => {
  const r = await spawn(client, { cwd: tmpHome, name: "dup-name" });
  assert.equal(r.type, "spawned");
  const r2 = await spawn(client, { cwd: tmpHome, name: "dup-name" });
  assert.equal(r2.type, "error");
  assert.match(r2.message, /already exists/);
  await spawnStop(client, "dup-name");
});

// ── register-wait timeout + kickoff ─────────────────────────────────────────

test("spawn returns ok even if the agent never registers (register-wait timeout)", async () => {
  // No one registers as this name, so waitForRegistration times out. The reply
  // must still be {type:"spawned"} (kickoff delivery is best-effort, non-blocking)
  // and the daemon must stay alive.
  const r = await spawn(client, { cwd: tmpHome, name: "never-registers", kickoff: "do nothing" });
  assert.equal(r.type, "spawned");
  assert.equal(r.name, "never-registers");
  // Daemon survives the timeout: a trivial RPC still works.
  const st = await spawnState(client);
  assert.equal(st.type, "spawn");
  await spawnStop(client, "never-registers");
});

test("kickoff is delivered once the spawned name registers", async () => {
  // A fresh client registers as the spawned agentName and should receive the
  // kickoff mail (waitForRegistration resolves → sendMail with newSession:true).
  const kickoff = "trivial: reply 'ok' then stop";
  await spawn(client, { cwd: tmpHome, name: "will-register", kickoff });
  const worker = await mkClient();
  const mail = new Promise((res) => worker.onNewMail((m) => res(m)));
  await register(worker, "will-register");
  const got = await mail;
  assert.equal(got.subject.includes("Task:"), true, `subject was ${got.subject}`);
  assert.equal(got.body, kickoff);
  assert.equal(got.newSession, true, "kickoff must be a fresh-session task");
  worker.close();
  await spawnStop(client, "never-registers").catch(() => {});
  await spawnStop(client, "will-register");
});

// ── stop-only-tracked-sessions ──────────────────────────────────────────────

test("spawn_stop refuses a name the daemon did not spawn", async () => {
  const r = await spawnStop(client, "some-operator-agent");
  assert.equal(r.type, "error");
  assert.match(r.message, /not a daemon-spawned agent/);
});

test("spawn_stop stops a daemon-spawned session", async () => {
  const r = await spawn(client, { cwd: tmpHome, name: "to-stop" });
  assert.equal(r.type, "spawned");
  const st = await spawnState(client);
  assert.ok(st.sessions.some((s) => s.name === "to-stop"));
  const stop = await spawnStop(client, "to-stop");
  assert.equal(stop.type, "ok");
  const st2 = await spawnState(client);
  assert.ok(!st2.sessions.some((s) => s.name === "to-stop"), "session still present after stop");
});

test("stopped session's tmux session is killed", async () => {
  const r = await spawn(client, { cwd: tmpHome, name: "kill-check" });
  assert.equal(r.type, "spawned");
  // fake-tmux recorded the session file on new-session:
  assert.ok(fs.existsSync(path.join(tmpState, "sessions", "kill-check")));
  await spawnStop(client, "kill-check");
  assert.ok(!fs.existsSync(path.join(tmpState, "sessions", "kill-check")), "tmux session file should be gone after stop");
});

// ── happy path + restart survival ───────────────────────────────────────────

test("happy path: spawn → visible in state → stop → gone", async () => {
  const r = await spawn(client, { cwd: tmpHome, name: "happy", model: "anthropic/claude-sonnet-4" });
  assert.equal(r.type, "spawned");
  const st = await spawnState(client);
  const s = st.sessions.find((x) => x.name === "happy");
  assert.ok(s, "happy not in spawn state");
  assert.equal(s.cwd, tmpHome);
  assert.equal(s.model, "anthropic/claude-sonnet-4");
  assert.equal(s.alive, true);
  await spawnStop(client, "happy");
  const st2 = await spawnState(client);
  assert.ok(!st2.sessions.find((x) => x.name === "happy"));
});

test("survival: spawned session survives a daemon restart", async () => {
  const r = await spawn(client, { cwd: tmpHome, name: "survivor" });
  assert.equal(r.type, "spawned");
  client.close();
  await stopDaemon();
  // Restart with the SAME HOME/env so the registry + fake-tmux state persist.
  await startDaemon();
  client = await mkClient();
  await register(client, "test-orchestrator-2");
  const st = await spawnState(client);
  const s = st.sessions.find((x) => x.name === "survivor");
  assert.ok(s, "spawned session did not survive daemon restart");
  assert.equal(s.alive, true, "reconciled session should be alive (fake-tmux has-session=true)");
  // And it can still be stopped.
  const stop = await spawnStop(client, "survivor");
  assert.equal(stop.type, "ok");
});

// ── spawn_ls respects the allowlist ─────────────────────────────────────────

test("spawn_ls lists a directory (allowlist removed)", async () => {
  // The allowlist check was removed from listSpawnDir too, so /etc (a real
  // dir) is listable. If the allowlist is restored, flip this to expect an
  // "outside the allowed roots" error for /etc.
  const r = await client.request({ type: "spawn_ls", path: "/etc" });
  assert.equal(r.type, "spawn_ls");
  assert.equal(r.dir, "/etc");
  assert.ok(Array.isArray(r.dirs));
});

// ── no mail / board regression (spawn feature must not break core RPCs) ──────

test("regression: mail send + list still works", async () => {
  const w = await mkClient();
  await register(w, "regression-worker");
  const got = new Promise((res) => w.onNewMail((m) => res(m)));
  const r = await client.request({ type: "send", to: "regression-worker", subject: "regression", body: "hello" });
  assert.ok(r.messageId || r.type === "sent", `send failed: ${JSON.stringify(r)}`);
  const m = await got;
  assert.equal(m.subject, "regression");
  assert.equal(m.body, "hello");
  const inbox = await w.request({ type: "list_mail" });
  assert.ok((inbox.messages || []).some((x) => x.subject === "regression"));
  w.close();
});

test("regression: board state still works", async () => {
  const r = await client.request({ type: "board_state" });
  assert.equal(r.type, "board");
  assert.ok(Array.isArray(r.columns) && r.columns.length > 0, "board columns missing");
  assert.ok(Array.isArray(r.tasks), "board tasks missing");
});
