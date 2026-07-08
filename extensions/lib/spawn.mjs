/**
 * Agent spawning (tmux) for the pi-mail daemon.
 *
 * The daemon can bring up a brand-new, long-running pi agent process in a
 * chosen working directory, so the operator (via the board UI) and
 * orchestrators (via the mail_spawn_agent tool) can spin up fresh workers
 * without opening a terminal. Each spawned agent runs in its own detached tmux
 * session, which gives it a PTY (interactive pi works unmodified), is
 * attachable (`tmux attach -t <name>`), and survives daemon restarts — the
 * daemon only tracks the session name; the tmux server owns the process.
 *
 * The set of daemon-spawned sessions is persisted so a /restart-mail-daemon
 * keeps tracking them (and stop() only ever kills sessions the daemon itself
 * spawned, never an operator-launched one). Extracted from daemon.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { AGENT_DIR, HUMAN_AGENT_ID, log, sendMail, resolveTarget, shellQuote } from "./core.mjs";

const SPAWN_FILE = path.join(AGENT_DIR, "mail-spawn.json");
const PI_BIN = process.env.PI_MAIL_PI_BIN || "pi";
const TMUX_BIN = process.env.PI_MAIL_TMUX_BIN || "tmux";
// How long to wait for a freshly-spawned agent to register with the daemon
// before returning (the agent keeps running regardless; this only gates the
// synchronous "is it up yet?" answer + the kickoff delivery).
const SPAWN_REGISTER_TIMEOUT_MS = parseInt(process.env.PI_MAIL_SPAWN_TIMEOUT || "20000", 10);

/**
 * Persisted spawn registry. Maps a tmux session name → metadata about a
 * daemon-spawned agent (cwd, model, spawnedAt, optional kickoff). The daemon
 * only ever stops sessions listed here, so an operator-launched tmux/pi is
 * never killed by stop(). Survives daemon restarts so /restart-mail-daemon
 * keeps tracking (and can still stop) previously-spawned agents.
 */
let spawnRegistry = {
  /** @type {Record<string, { cwd: string, model?: string, kickoff?: string, spawnedAt: number, agentName?: string, agentId?: string }>} */
  sessions: {},
  /** Recently-spawned project dirs (history) + starred dirs (favorites),
   *  shared across the federation and persisted alongside the sessions. */
  projects: { history: [], favorites: [] },
};

/** Cap on how many recent projects we keep in history. */
const PROJECT_HISTORY_MAX = 50;

let spawnPersistTimer = null;
function schedulePersistSpawn() {
  if (spawnPersistTimer) return;
  spawnPersistTimer = setTimeout(() => {
    spawnPersistTimer = null;
    flushSpawn();
  }, 300);
}
/** Flush the spawn registry to disk immediately (also used on shutdown). */
function flushSpawn() {
  if (spawnPersistTimer) {
    clearTimeout(spawnPersistTimer);
    spawnPersistTimer = null;
  }
  try {
    fs.writeFileSync(SPAWN_FILE, JSON.stringify(spawnRegistry), { mode: 0o600 });
  } catch (e) {
    log(`spawn persist failed: ${e.message}`);
  }
}
function loadSpawn() {
  try {
    const saved = JSON.parse(fs.readFileSync(SPAWN_FILE, "utf8"));
    if (saved && typeof saved === "object") {
      if (saved.sessions && typeof saved.sessions === "object") spawnRegistry.sessions = saved.sessions;
    if (saved.projects && typeof saved.projects === "object") {
      if (Array.isArray(saved.projects.history)) spawnRegistry.projects.history = saved.projects.history;
      if (Array.isArray(saved.projects.favorites)) spawnRegistry.projects.favorites = saved.projects.favorites;
    }
    }
  } catch {
    // No spawn file yet — defaults apply.
  }
  // Reconcile with live tmux: drop tracked sessions whose tmux session no
  // longer exists (e.g. the agent exited on its own, or tmux was killed
  // out-of-band). Cheap and keeps the registry honest across restarts.
  for (const name of Object.keys(spawnRegistry.sessions)) {
    if (!tmuxSessionExists(name)) delete spawnRegistry.sessions[name];
  }
}

/** Resolve and validate a cwd: must be a real directory anywhere on the
 *  filesystem. The picker can browse and spawn from any path — there is no
 *  allowlist (the former "allowed root" restriction was removed). */
function validateSpawnCwd(cwd) {
  if (!cwd || typeof cwd !== "string") return { error: "cwd is required" };
  let resolved;
  try {
    resolved = path.resolve(cwd);
  } catch {
    return { error: `invalid path: ${cwd}` };
  }
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    return { error: `not a directory: ${resolved}` };
  }
  if (!st.isDirectory()) return { error: `not a directory: ${resolved}` };
  return { resolved };
}

/** Sanitise a name for use as a tmux session name (tmux disallows '.' and ':'). */
function safeSessionName(name) {
  return String(name || "").replace(/[.:\\]/g, "-").replace(/\s+/g, "-").slice(0, 80);
}

/** Default agent name: <dir-basename>-<id6>, matching the extension's auto-slug. */
function defaultSpawnName(cwd) {
  const base = path.basename(cwd) || "pi-agent";
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

function tmuxSessionExists(name) {
  try {
    const r = spawnSync(TMUX_BIN, ["has-session", "-t", name]);
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Spawn a fresh pi agent in a tmux session.
 * @returns {{ ok?: true, name?: string, agentId?: string, warning?: string, error?: string }}
 */
function spawnAgent({ cwd, name, model, kickoff, favorite }) {
  const v = validateSpawnCwd(cwd);
  if (v.error) return { error: v.error };
  const dir = v.resolved;

  const session = safeSessionName(name?.trim() || defaultSpawnName(dir));
  if (!session) return { error: "invalid name" };
  if (spawnRegistry.sessions[session]) {
    return { error: `a spawned agent named '${session}' already exists` };
  }
  if (tmuxSessionExists(session)) {
    return { error: `a tmux session named '${session}' already exists (not tracked by the daemon)` };
  }

  // Build the pi invocation. -n sets the session display name (also the
  // federation agent name once the extension registers). --approve trusts
  // project-local files for an unattended launch.
  const args = ["-n", session, "--approve"];
  if (model && String(model).trim()) args.push("--model", String(model).trim());
  const piCmd = `${shellQuote(PI_BIN)} ${args.map(shellQuote).join(" ")}`;

  let r;
  try {
    // tmux new-session -d: detached. The quoted command runs in the chosen cwd.
    r = spawnSync(TMUX_BIN, ["new-session", "-d", "-s", session, "-c", dir, piCmd], { cwd: dir });
  } catch (e) {
    return { error: `failed to spawn tmux: ${e?.message ?? String(e)}` };
  }
  if (r.error || r.status !== 0) {
    const stderr = (r.stderr ? r.stderr.toString().trim() : "");
    const hint = r.error?.code === "ENOENT" ? ` (tmux not found at '${TMUX_BIN}')` : "";
    return { error: `tmux spawn failed${hint}${stderr ? ": " + stderr : ""}` };
  }

  spawnRegistry.sessions[session] = {
    cwd: dir,
    model: model && String(model).trim() ? String(model).trim() : undefined,
    kickoff: kickoff && String(kickoff).trim() ? String(kickoff).trim() : undefined,
    spawnedAt: Date.now(),
    agentName: session,
  };
  // Track the project dir in recent history (shared across the federation)
  // and optionally star it as a favorite.
  recordProject(dir, session);
  if (favorite) setFavorite(dir, true);
  schedulePersistSpawn();
  log(`Spawned agent '${session}' in ${dir}`);

  // Best-effort: wait for the agent to register, then deliver the kickoff as a
  // new-session task. Non-blocking on the reply path — the caller gets the
  // session name immediately; kickoff delivery is logged in the activity.
  const kickoffText = spawnRegistry.sessions[session].kickoff;
  waitForRegistration(session, SPAWN_REGISTER_TIMEOUT_MS)
    .then((agentId) => {
      if (agentId) {
        spawnRegistry.sessions[session].agentId = agentId;
        schedulePersistSpawn();
      }
      if (kickoffText) {
        // Deliver as the human so the agent treats it as a mail-driven task.
        const m = sendMail(HUMAN_AGENT_ID, session, "Task: " + kickoffText.split("\n")[0].slice(0, 80), kickoffText, { newSession: true });
        if (m.error) log(`kickoff delivery to '${session}' failed: ${m.error}`);
      }
    })
    .catch(() => {});

  return { ok: true, name: session, warning: kickoffText ? undefined : undefined };
}

/**
 * Stop a daemon-spawned agent: kill its tmux session. Refuses to kill a
 * session the daemon did not spawn (defence against clobbering operator work).
 * @returns {{ ok?: true, error?: string }}
 */
function stopAgent({ name }) {
  const session = safeSessionName(name?.trim ? name.trim() : String(name || ""));
  if (!session) return { error: "name is required" };
  if (!spawnRegistry.sessions[session]) {
    return { error: `'${session}' is not a daemon-spawned agent (the daemon only stops agents it spawned)` };
  }
  let r;
  try {
    r = spawnSync(TMUX_BIN, ["kill-session", "-t", session]);
  } catch (e) {
    return { error: `failed to kill tmux: ${e?.message ?? String(e)}` };
  }
  // status 1 + "can't find session" is fine — it already exited. Anything else
  // is a real failure.
  if (r.error || (r.status !== 0 && !/no (such|session)|can't find|not found/i.test(r.stderr ? r.stderr.toString() : ""))) {
    const stderr = r.stderr ? r.stderr.toString().trim() : "";
    return { error: `tmux kill-session failed${stderr ? ": " + stderr : ""}` };
  }
  delete spawnRegistry.sessions[session];
  schedulePersistSpawn();
  log(`Stopped agent '${session}'`);
  return { ok: true };
}

/**
 * Resolve a recipient spec to an agentId, waiting up to timeoutMs for an agent
 * matching `name` to register. Used by spawnAgent so the kickoff is delivered
 * to the freshly-registered agent rather than bouncing as "not found".
 */
function waitForRegistration(name, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const id = resolveTarget(name);
      if (id) return resolve(id);
      if (Date.now() - start >= timeoutMs) return resolve(null);
      setTimeout(tick, 250);
    };
    tick();
  });
}

// ── Project history + favorites ─────────────────────────────────────────────

/** Is there at least one live daemon-spawned session currently running in
 *  `cwd`? Lets the list-projects tool / UI mark a project as “active”. */
function cwdAlive(cwd) {
  return Object.entries(spawnRegistry.sessions).some(
    ([name, s]) => s.cwd === cwd && tmuxSessionExists(name)
  );
}

/** Record a spawn into the recent-projects history (deduped, newest first,
 *  capped at PROJECT_HISTORY_MAX). Called on every successful spawn. */
function recordProject(cwd, name) {
  if (!cwd) return;
  const p = spawnRegistry.projects;
  const existing = p.history.find((h) => h.cwd === cwd);
  const count = (existing?.count || 0) + 1;
  p.history = p.history.filter((h) => h.cwd !== cwd);
  p.history.unshift({
    cwd,
    lastSpawnedAt: Date.now(),
    count,
    lastName: name || existing?.lastName || "",
  });
  if (p.history.length > PROJECT_HISTORY_MAX) p.history.length = PROJECT_HISTORY_MAX;
  schedulePersistSpawn();
}

/** Explicitly set whether a project dir is a favorite (add/remove). Returns
 *  the new favorite state. */
function setFavorite(cwd, favorite) {
  if (!cwd) return false;
  const p = spawnRegistry.projects;
  const i = p.favorites.indexOf(cwd);
  if (favorite) { if (i === -1) p.favorites.push(cwd); }
  else { if (i !== -1) p.favorites.splice(i, 1); }
  schedulePersistSpawn();
  return p.favorites.includes(cwd);
}

/** Projects for the UI/tools: favorites + recent history, each tagged with
 *  whether a live spawned agent is currently running in that dir. */
function projectsState() {
  const p = spawnRegistry.projects;
  return {
    favorites: p.favorites.map((cwd) => ({ cwd, alive: cwdAlive(cwd) })),
    history: p.history.map((h) => ({ ...h, alive: cwdAlive(h.cwd) })),
  };
}

/** Directory listing for the picker: subdirectories of `dir` (any path on the
 *  filesystem). validateSpawnCwd only checks it's a real directory. When
 *  `hidden` is true, dot-directories (e.g. .git, .config) are included too. */
function listSpawnDir(dir, { hidden = false } = {}) {
  const v = validateSpawnCwd(dir);
  if (v.error) return { error: v.error };
  const resolved = v.resolved;
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && (hidden || !e.name.startsWith(".")))
      .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { dir: resolved, dirs };
  } catch (e) {
    return { error: `could not read ${resolved}: ${e?.message ?? String(e)}` };
  }
}

/** Spawned sessions, for the UI/tools: name + cwd + model + live status, plus
 *  the recent/favorite projects registry. */
function spawnState() {
  const sessions = Object.entries(spawnRegistry.sessions).map(([name, s]) => ({
    name,
    cwd: s.cwd,
    model: s.model || "",
    kickoff: s.kickoff || "",
    spawnedAt: s.spawnedAt,
    agentName: s.agentName || name,
    alive: tmuxSessionExists(name),
  }));
  return { sessions, projects: projectsState() };
}

export {
  loadSpawn,
  flushSpawn,
  spawnAgent,
  stopAgent,
  spawnState,
  listSpawnDir,
  spawnRegistry,
  safeSessionName,
  tmuxSessionExists,
  recordProject,
  setFavorite,
  projectsState,
};
