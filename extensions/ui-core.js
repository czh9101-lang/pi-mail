"use strict";
"use strict";
const HUMAN_ID = "00000000-0000-0000-0000-000000000000";
let state = { agents: [], messages: [], board: null, human: { agentId: HUMAN_ID, agentName: "human" }, now: Date.now() };
let currentTab = "agents";
let historyAgentId = "";        // selected agent in History tab
let compose = { to: "", subject: "", body: "", newSession: false }; // sticky compose draft
// Board UI state that must survive re-renders (poll every 3s)
let boardUi = {
  taskModalId: null,            // task whose detail modal is open
  settingsOpen: false,
  freshSession: true,           // newSession flag used when assigning
  newTask: { summary: "", column: "", level: "task", backlog: false },
  draftComments: {},            // taskId -> comment draft
  colsDraft: null,              // unsaved column edits while settings are open
  showArchive: false,           // status filter: show done (archived) tasks
  groupFilter: "__all",         // "__all" = every group, else a project group
};
let pollTimer = null;
let lastSig = null;

const $ = (sel) => document.querySelector(sel);
const main = $("#main");
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString();
}
function fmtUptime(registeredAt, now) {
  if (!registeredAt) return "—";
  const s = Math.max(0, Math.round((now - registeredAt) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
}
function esc(s) { return String(s ?? ""); }
function shortId(id) { return id ? id.slice(0, 8) : ""; }
function projectOf(cwd) {
  if (!cwd) return "(no project)";
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}
/** Project group for a board task: the stamped group wins, else derived from
 *  the assignee's cwd via state.agents, else null (ungrouped/no-project). */
function taskGroup(t) {
  if (t.group) return t.group;
  if (t.assignee) {
    const a = (state.agents ?? []).find(x => x.agentName === t.assignee);
    if (a?.cwd) return projectOf(a.cwd);
  }
  return null;
}
/** Whether a task passes the current group filter (boardUi.groupFilter). */
function groupVisible(t) {
  if (boardUi.groupFilter === "__all") return true;
  return (taskGroup(t) ?? "(no project)") === boardUi.groupFilter;
}
/** All distinct groups present across the current board, sorted, plus a
 *  leading "(no project)" entry for ungrouped tasks. */
function boardGroups(board) {
  const set = new Set();
  for (const t of (board?.tasks ?? [])) {
    const g = taskGroup(t);
    set.add(g ?? "(no project)");
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
function ctxClass(pct) {
  if (pct == null) return "";
  if (pct >= 80) return "high";
  if (pct >= 50) return "mid";
  return "low";
}
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", !!isErr);
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 3500);
}

// ── Data fetch ──────────────────────────────────────────────────────────────
async function refresh() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const next = await r.json();
    state = next;
    $("#status").innerHTML = "";
    const n = state.agents.filter(a => !a.isHuman).length;
    const span = el("span", "pulse", "● live");
    $("#status").appendChild(span);
    $("#status").appendChild(document.createTextNode(`  ·  ${n} agent${n === 1 ? "" : "s"}  ·  ${state.messages.length} message${state.messages.length === 1 ? "" : "s"} in history`));
    // Re-rendering wipes the whole DOM tree in <main>, which on mobile
    // dismisses the on-screen keyboard every poll. So:
    //  - never re-render while the user is focused inside <main> (typing),
    //  - and skip when nothing actually changed.
    const focusedInMain = document.activeElement && main.contains(document.activeElement);
    // Also suppress the poll re-render while the task detail modal is open and
    // focused — the modal lives in <body> (not #main), so the guard above
    // misses it and the 3s rebuild would dismiss the on-screen keyboard and
    // reset scroll every tick.
    const taskModal = document.getElementById("task-modal");
    const focusedInModal = !!taskModal && document.activeElement && taskModal.contains(document.activeElement);
    const sig = JSON.stringify([state.agents, state.messages, state.board]);
    if (focusedInMain || focusedInModal) { lastSig = sig; return; }
    if (sig !== lastSig) { lastSig = sig; render(); }
  } catch (e) {
    $("#status").innerHTML = "";
    $("#status").appendChild(el("span", "", "⚠ disconnected (" + esc(e.message) + ")"));
  }
}

async function post(path, payload) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({ ok: false, error: "invalid response" }));
}

// ── Rendering ────────────────────────────────────────────────────────────────
function render() {
  if (currentTab === "agents") renderAgents();
  else if (currentTab === "board") renderBoard();
  else if (currentTab === "mailbox") renderMailbox();
  else if (currentTab === "history") renderHistory();
}

function sortAgents(list) {
  return [...list].sort((a, b) => {
    if (a.isHuman !== b.isHuman) return a.isHuman ? 1 : -1;
    const pa = projectOf(a.cwd), pb = projectOf(b.cwd);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.agentName < b.agentName ? -1 : 1;
  });
}

function renderAgents() {
  main.innerHTML = "";
  const card = el("div", "card");
  card.appendChild(el("h2", null, "Connected agents"));
  const wrap = el("div");
  wrap.style.overflowX = "auto";
  const table = el("table");
  const thead = el("thead"); const trh = el("tr");
  for (const h of ["Name", "Project", "Status", "Ctx", "Model", "Uptime", "ID", "Actions"]) {
    trh.appendChild(el("th", null, h));
  }
  thead.appendChild(trh); table.appendChild(thead);
  const tbody = el("tbody");
  let prevGroup = "";
  for (const a of sortAgents(state.agents)) {
    const grp = a.isHuman ? "operator" : projectOf(a.cwd);
    if (grp !== prevGroup) {
      prevGroup = grp;
      const gr = el("tr"); gr.className = "group-row"; const gtd = el("td"); gtd.colSpan = 8;
      gtd.style.color = "var(--accent)";
      gtd.style.background = "#11161d";
      gtd.textContent = (a.isHuman ? "👤 " : "📁 ") + grp + (a.cwd && !a.isHuman ? "   " + a.cwd : "");
      gr.appendChild(gtd); tbody.appendChild(gr);
    }
    const tr = el("tr");
    // Name
    const tdN = el("td"); tdN.dataset.label = "Name";
    const name = a.agentName + (a.isHuman ? "  (you)" : "");
    tdN.appendChild(el("span", a.isHuman ? "human-tag" : "", name));
    tr.appendChild(tdN);
    // Project
    const tdP = el("td", null, a.isHuman ? "—" : projectOf(a.cwd)); tdP.dataset.label = "Project"; tr.appendChild(tdP);
    // Status
    const tdS = el("td", null, a.status || "—"); tdS.dataset.label = "Status"; tr.appendChild(tdS);
    // Ctx
    const tdC = el("td", "ctx " + ctxClass(a.contextPct), a.contextPct == null ? "—" : a.contextPct + "%"); tdC.dataset.label = "Ctx"; tr.appendChild(tdC);
    // Model
    const tdM = el("td", null, a.model || "—"); tdM.dataset.label = "Model"; tr.appendChild(tdM);
    // Uptime
    const tdU = el("td", null, a.isHuman ? "—" : fmtUptime(a.registeredAt, state.now)); tdU.dataset.label = "Uptime"; tr.appendChild(tdU);
    // ID
    const tdI = el("td", null, shortId(a.agentId)); tdI.dataset.label = "ID"; tr.appendChild(tdI);
    // Actions
    const tdA = el("td"); tdA.className = "no-label"; tdA.dataset.label = "";
    if (!a.isHuman) {
      const sendBtn = el("button", "btn secondary", "Send mail");
      sendBtn.addEventListener("click", () => {
        compose.to = a.agentName;
        setTab("mailbox");
        document.querySelector(".compose input")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      tdA.appendChild(sendBtn);
      // Spawned agents get a Terminal + Stop button. state.spawn.sessions is
      // the daemon's tracked set (only those it spawned), so the buttons
      // only appear for spawn-managed agents — never for operator-launched ones.
      const spawned = (state.spawn?.sessions || []).find(s => s.name === a.agentName || s.agentName === a.agentName);
      if (spawned) {
        const termBtn = el("button", "btn secondary mini", "Terminal");
        termBtn.addEventListener("click", () => openTerminal(spawned.name));
        tdA.appendChild(termBtn);
        if (spawned.alive) {
          const stopBtn = el("button", "btn secondary mini", "Stop");
          stopBtn.style.borderColor = "var(--error)"; stopBtn.style.color = "var(--error)";
          stopBtn.addEventListener("click", async () => {
            if (!confirm(`Stop agent '${spawned.name}'? (kills its tmux session)`)) return;
            const r = await post("/api/spawn/stop", { name: spawned.name });
            if (r.ok) { toast("✅ Stopped " + spawned.name); refresh(); } else toast("❌ " + (r.error || "failed"), true);
          });
          tdA.appendChild(stopBtn);
        }
      }
    } else {
      tdA.appendChild(el("span", "empty", "\u2014"));
    }
    tr.appendChild(tdA);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody); wrap.appendChild(table); card.appendChild(wrap);
  main.appendChild(card);
}

