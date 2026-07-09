/**
 * CEO (top-tier manager) scheduler + reaper for the pi-mail daemon.
 *
 * The CEO is an ephemeral agent the daemon spawns on a schedule (default
 * every 120 min, when enabled). It is a pure manager — like the middle-manager
 * but one level up: it does NOT do task administration (no moving/unblocking/
 * archiving tasks). Instead it reviews the federation at a high level, decides
 * which managed (favorited) projects need a middle-manager pass, spawns MMs for
 * those, optionally tunes the favorites list, mails `human` a summary, and
 * self-exits. One CEO per cycle handles all managed projects.
 *
 * CEO replaces the daemon's fixed-interval MM timer: when `ceoEnabled` is true,
 * `mmTick` skips its own MM spawn (the CEO is the sole MM spawner); the MM
 * reaper still runs as a safety net. With `ceoEnabled` false, the existing MM
 * loop works unchanged (backward-compat). See lib/middle-manager.mjs.
 *
 * Lifecycle (ephemeral + self-deleting): the CEO is spawned fresh each cycle,
 * does its pass, mails `human` a completion summary, then calls `mail_stop_self`
 * to tear down its own tmux session + registry entry. A periodic reaper (shared
 * with the MM reaper's tick) cleans up spawned CEO sessions whose tmux session
 * has already ended, and forcibly stops any CEO session exceeding a
 * configurable max lifetime (safety bound) so dead/long-running CEOs never
 * accumulate.
 *
 * Config lives in `board.config` (per-board): `ceoEnabled` (default false),
 * `ceoIntervalMin` (default 120), `ceoModel` (optional), `ceoMaxLifetimeMin`
 * (default 15 — the CEO is a ~15-minute management thread; operator invariant
 * 7/9). Editable via the Board UI settings + set_board_config.
 *
 * Ephemerality invariant (CEO → MM → workers): every daemon-spawned session in
 * this hierarchy is ephemeral and is killed after its pass — regardless of
 * self-exit. The CEO and MMs self-delete via mail_stop_self; the reaper is the
 * backstop. Cascade cleanup is independent per tier: when a CEO is reaped
 * mid-pass, the MM/worker it spawned are not tracked as its children — each is
 * a daemon-spawned registry entry reaped on its own tier's lifetime (MM by
 * reapMiddleManagers, worker by reapWorkers), so a reaped parent can never
 * leave orphans. See the README ephemerality invariant + reapWorkers.
 */

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  HUMAN_AGENT_ID,
  HUMAN_AGENT_NAME,
  agents,
  log,
} from "./core.mjs";
import { board, setManagerAgentTest } from "./board.mjs";
import {
  spawnAgent,
  stopAgent,
  spawnRegistry,
  tmuxSessionExists,
  schedulePersistSpawn,
} from "./spawn.mjs";
import { isMiddleManager, MM_NAME_PREFIX } from "./middle-manager.mjs";

/** How often the scheduler + reaper wake up to check. The actual spawn cadence
 *  is gated on `ceoIntervalMin`; this is just the polling granularity. Reuses
 *  the MM tick interval env var so they share one timer cadence. */
const CEO_TICK_MS = parseInt(process.env.PI_MAIL_MM_TICK_MS || "60000", 10);

/** Session-name prefix for spawned CEOs, so they're identifiable in
 *  `mail_list_agents` / the web UI. The suffix is a short random id. */
const CEO_NAME_PREFIX = "ceo";

// ── CEO session tracking ────────────────────────────────────────────────────

/** Persisted across restarts in the spawn registry so the last-spawn timestamp
 *  survives a daemon restart (otherwise a restart would immediately re-spawn).
 *  Restored by loadSpawn() alongside the sessions/projects/mm keys. */
function ceoMeta() {
  if (!spawnRegistry.ceo) spawnRegistry.ceo = { lastSpawnTs: 0 };
  return spawnRegistry.ceo;
}

/** Spawned CEO sessions tracked by the daemon (registry entries with ceo:true). */
function ceoSessions() {
  return Object.entries(spawnRegistry.sessions)
    .filter(([, s]) => s.ceo)
    .map(([name, s]) => ({ name, ...s }));
}

/** CEO sessions whose tmux session is still alive (the agent is still running). */
function liveCeoSessions() {
  return ceoSessions().filter((s) => tmuxSessionExists(s.name));
}

/**
 * Predicate injected into board.mjs: true when `agentId` belongs to a currently
 * tracked CEO session OR a middle-manager session (both are managers that
 * oversee multiple projects, so the same-group partition must not hide tasks
 * from them). Composed with the MM's own predicate so a single injected fn
 * covers both tiers. Matches by agentName (the tmux session name, known the
 * moment the agent registers) so it works immediately, before the agentId is
 * stamped on the registry entry.
 */
function isCeo(agentId) {
  if (!agentId || agentId === HUMAN_AGENT_ID) return false;
  const name = agents.get(agentId)?.info?.agentName;
  if (!name) return false;
  for (const s of Object.values(spawnRegistry.sessions)) {
    if (s.ceo && s.agentName === name) return true;
  }
  return false;
}

function isManager(agentId) {
  return isMiddleManager(agentId) || isCeo(agentId);
}

// ── Reaper ───────────────────────────────────────────────────────────────────

/**
 * Reap spawned CEO sessions: stop any whose tmux session has already ended (the
 * CEO exited on its own after signalling completion), and forcibly stop any that
 * have exceeded the configured max lifetime (safety bound so a stuck CEO can't
 * run forever or accumulate). Idempotent and cheap; called on every tick.
 */
function reapCeos(now = Date.now()) {
  const maxLifetimeMs = Math.max(1, (board.config.ceoMaxLifetimeMin ?? 15)) * 60_000;
  for (const s of ceoSessions()) {
    const alive = tmuxSessionExists(s.name);
    const overLifetime = now - (s.spawnedAt ?? now) > maxLifetimeMs;
    if (!alive) {
      const r = stopAgent({ name: s.name });
      if (r.error) log(`CEO reaper: could not clean up '${s.name}': ${r.error}`);
      else log(`CEO reaper: reaped exited session '${s.name}'`);
    } else if (overLifetime) {
      const r = stopAgent({ name: s.name });
      if (r.error) log(`CEO reaper: could not stop over-lifetime '${s.name}': ${r.error}`);
      else log(`CEO reaper: stopped over-lifetime session '${s.name}' (${Math.round((now - s.spawnedAt) / 60000)}m)`);
    }
  }
}

// ── Kickoff ──────────────────────────────────────────────────────────────────

/** Build the kickoff task text delivered to a freshly-spawned CEO. The CEO is a
 *  pure manager that does NOT do task administration — it only reviews the
 *  federation overview, decides which projects need an MM pass, spawns MMs,
 *  optionally tunes favorites, mails `human` a summary, and self-exits. */
function ceoKickoff(favorites) {
  const projects = favorites.map((cwd) => {
    const group = path.basename(cwd) || cwd;
    return `  • ${cwd} (group: ${group})`;
  });
  return [
    "You are the CEO (top-tier manager) for this pi-mail federation cycle. You are a pure manager: you do NOT implement anything yourself, and you do NOT do task administration (no moving/unblocking/archiving tasks — that is the middle managers' job). You review the federation at a high level, decide which projects need a middle-manager pass, spawn middle managers for them, and keep the roster of managed projects healthy.",
    "",
    "## Your pass is a FULL pass — consider EVERY managed project before exiting",
    "A pass is NOT one action. You must review every managed (favorited) project and, for EACH one, decide whether it needs an MM pass this cycle. Do NOT stop after the first project you look at — keep going until you have made a spawn-or-skip decision for every managed project, THEN finish. If you spawn an MM for one project and are about to exit, STOP — review the rest of the managed projects first.",
    "",
    "## Tool usage — you MUST use your tools; never hand-parse JSON",
    "You MUST use your tools for every action and MUST NEVER hand-parse JSON or fabricate tool I/O. Your harness formats tool calls and returns for you — invoke each tool by name with plain parameter values and read the rendered result. Do not write or paste raw JSON tool inputs/outputs, do not JSON.parse tool results, and do not invent a tool's output and proceed as if you ran it. Only act on what a tool ACTUALLY returned; if it errored or returned nothing useful, retry it (or, for a federation-level blocker, mail human). The tools you use are: board_list_tasks (see the board — you have all-groups visibility), mail_spawn_agent (spawn a middle manager with { cwd, mm: true }), mail_send (mail human your completion summary), and mail_stop_self (tear down your own session when done). Your turn should read as a sequence of real tool calls — no JSON between you and your actions.",
    "",
    "## Managed projects (favorited)",
    "These are the projects under oversight this cycle:",
    ...projects,
    "",
    "## Your pass (do this once, then finish)",
    "1. Run mail_list_agents to see who is currently connected across the federation.",
    `2. Run board_list_tasks (you have all-groups visibility) to get a high-level overview of every project's tasks. Focus on the managed projects listed above.`,
    "3. For each managed project, decide whether it needs a middle-manager pass this cycle. Signals that it does: stuck/idle workers, flagged-unclear tasks, finished work still sitting in In Progress/Review (not yet archived), a stale board, or no live worker assigned to active tasks.",
    "4. For projects that need a pass, spawn a middle manager with mail_spawn_agent({ cwd: \"<project-dir>\", mm: true }). Spawn ONE MM at a time (the daemon's no-overlap guard allows only one live MM at a time per project; if you spawn several, only the first runs and the rest are skipped). So spawn one, let it finish, then spawn the next if another project still needs attention.",
    "5. Optionally curate the managed-projects list: use mail_set_project_favorite to add a project that clearly needs ongoing oversight, or remove (unfavorite) one whose work is fully done and archived. Be conservative — only unfavorite when there's genuinely nothing left to manage.",
    "6. Do NOT move, assign, comment on, or archive individual tasks yourself — that is the middle managers' job. Escalate task-level concerns by spawning an MM for that project.",
    "",
    "## When you're done",
    `Mail a concise completion summary to "${HUMAN_AGENT_NAME}" (mail_send to "${HUMAN_AGENT_NAME}"): what you reviewed, which projects you spawned an MM for (and why), and any favorites you added/removed. Then you're finished — call mail_stop_self to tear down your own session (your tmux session is reaped immediately; the reaper is only a fallback).`,
    "",
    "Do not start any new long-running work. This is a single FULL management pass — make a spawn-or-skip decision for every managed project, then finish.",
  ].join("\n");
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Spawn one CEO for the current cycle. Picks the first favorited project dir as
 * the CEO's cwd (the CEO is a pure manager and won't edit files; any valid
 * managed dir works). Skips (returns early) if a live CEO session is already
 * running (no overlap). Records the spawn timestamp so the next cycle is gated
 * on ceoIntervalMin even across ticks.
 */
function spawnCeo(now = Date.now()) {
  if (liveCeoSessions().length > 0) return { skipped: "live CEO already running" };
  const favorites = spawnRegistry.projects.favorites ?? [];
  if (favorites.length === 0) return { skipped: "no managed projects (favorites empty)" };
  const cwd = favorites.find((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  if (!cwd) {
    log("CEO scheduler: all managed (favorited) dirs are missing — skipping cycle");
    return { skipped: "all managed dirs missing" };
  }
  const model = board.config.ceoModel && String(board.config.ceoModel).trim()
    ? String(board.config.ceoModel).trim()
    : undefined;
  const kickoff = ceoKickoff(favorites);
  const name = `${CEO_NAME_PREFIX}-${crypto.randomUUID().slice(0, 6)}`;
  const r = spawnAgent({ cwd, name, model, kickoff, ceo: true });
  if (r.error) {
    log(`CEO scheduler: spawn failed: ${r.error}`);
    return { error: r.error };
  }
  ceoMeta().lastSpawnTs = now;
  schedulePersistSpawn();
  log(`CEO scheduler: spawned ceo '${r.name}' for ${favorites.length} project(s)`);
  return { ok: true, name: r.name };
}

/**
 * One scheduler tick. Spawns a CEO when enabled + favorites non-empty + no live
 * CEO + the interval has elapsed; reaps dead/over-lifetime sessions either way.
 * `force` bypasses the interval-elapsed check (an operator "run a cycle now").
 * `now` (default real time) is used for both gating and the recorded spawn ts,
 * so callers can drive time-based gates deterministically (tests). Exported
 * for testing (with a controllable "now").
 */
function ceoTick(now = Date.now(), force = false) {
  // Always reap — even when disabled, so a previously-spawned CEO that's still
  // tracked gets cleaned up if it exits or overstays.
  reapCeos(now);
  if (board.config.ceoEnabled !== true) return { reaped: true, spawned: false };
  const favorites = spawnRegistry.projects.favorites ?? [];
  if (favorites.length === 0) return { reaped: true, spawned: false, reason: "no favorites" };
  if (liveCeoSessions().length > 0) return { reaped: true, spawned: false, reason: "live CEO running" };
  const intervalMs = Math.max(1, (board.config.ceoIntervalMin ?? 120)) * 60_000;
  if (!force && now - (ceoMeta().lastSpawnTs ?? 0) < intervalMs) {
    return { reaped: true, spawned: false, reason: "interval not elapsed" };
  }
  const r = spawnCeo(now);
  return { reaped: true, spawned: !!r.ok, ...r };
}

/** Snapshot of CEO state, for inspection / the UI / tests. */
function ceoState() {
  const sessions = ceoSessions().map((s) => ({
    name: s.name,
    cwd: s.cwd,
    spawnedAt: s.spawnedAt,
    alive: tmuxSessionExists(s.name),
  }));
  return {
    enabled: board.config.ceoEnabled === true,
    intervalMin: board.config.ceoIntervalMin ?? 120,
    model: board.config.ceoModel ?? "",
    maxLifetimeMin: board.config.ceoMaxLifetimeMin ?? 15,
    lastSpawnTs: ceoMeta().lastSpawnTs ?? 0,
    managedProjects: (spawnRegistry.projects.favorites ?? []).slice(),
    sessions,
  };
}

/** Start the periodic scheduler + reaper loop. Called once from daemon.mjs at
 *  boot. Also injects the combined all-groups predicate (MM or CEO) into
 *  board.mjs so spawned managers can see every project's tasks. */
let ceoTimer = null;
function startCeoLoop() {
  setManagerAgentTest(isManager);
  if (ceoTimer) clearInterval(ceoTimer);
  ceoTimer = setInterval(() => {
    try {
      ceoTick();
    } catch (e) {
      log(`CEO scheduler error: ${e?.message ?? String(e)}`);
    }
  }, CEO_TICK_MS);
  // Reap any leftover CEO sessions from a previous run immediately on boot.
  reapCeos();
}

export {
  ceoTick,
  spawnCeo,
  reapCeos,
  isCeo,
  isManager,
  ceoKickoff,
  ceoState,
  startCeoLoop,
  CEO_NAME_PREFIX,
};
