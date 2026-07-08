"use strict";
// ── Task board ───────────────────────────────────────────────────────────────

async function boardPost(path, payload, okMsg) {
  const r = await post(path, payload);
  if (r.ok) {
    if (r.warning) toast("⚠ " + r.warning, true);
    else if (okMsg) toast(okMsg);
    await refresh();
  } else {
    toast("❌ " + (r.error || "failed"), true);
  }
  return r;
}

function agentNames() {
  return state.agents.filter(a => !a.isHuman).map(a => a.agentName).sort();
}

/** An agent counts as "idle" (available for assignment) when it has no status
 *  set or its status starts with "idle" (set via mail_set_status, possibly
 *  with a trailing note like "idle (recon done)"). Any other status text means
 *  the agent is busy with something. */
function isIdle(a) {
  return !a.isHuman && (!a.status || a.status.trim().toLowerCase().startsWith("idle"));
}

/** Non-human agents as {name, idle}, idle-first then alphabetical — used by
 *  the board's assign dropdown so available agents surface at the top. */
function agentPickList() {
  return state.agents
    .filter(a => !a.isHuman)
    .map(a => ({ name: a.agentName, idle: isIdle(a) }))
    .sort((x, y) => (x.idle === y.idle ? x.name.localeCompare(y.name) : x.idle ? -1 : 1));
}

function isSubtask(t) { return !!(t.parentId || t.parentKey); }
function childrenOf(t, board) {
  return (board.tasks ?? []).filter(x => x.parentId === t.id || (t.key && x.parentKey === t.key));
}

function taskCard(t, board) {
  const card = el("div", "tcard" + (t.flagged ? " flagged" : "") + (isSubtask(t) ? " subtask" : ""));
  const sum = el("div", "tsum");
  if (t.key) {
    const k = el(t.url ? "a" : "span", "tkey", "[" + t.key + "]");
    if (t.url) { k.href = t.url; k.target = "_blank"; k.addEventListener("click", e => e.stopPropagation()); }
    sum.appendChild(k);
  }
  sum.appendChild(document.createTextNode(t.summary));
  sum.addEventListener("click", () => openTaskModal(t.id));
  card.appendChild(sum);

  const meta = el("div", "tmeta");
  meta.appendChild(el("span", "assignee" + (t.assignee ? "" : " none"), t.assignee || "unassigned"));
  if (t.flagged) {
    const fb = el("span", "badge flag", "⚠ unclear");
    fb.title = "Flagged by " + t.flagged.by + ": " + t.flagged.reason;
    meta.appendChild(fb);
  }
  if (isSubtask(t)) meta.appendChild(el("span", "badge sub", "↳ " + (t.parentKey || "subtask")));
  const kids = childrenOf(t, board);
  if (kids.length) {
    const doneCol = board.columns.length ? board.columns[board.columns.length - 1].id : null;
    meta.appendChild(el("span", "badge sub", kids.filter(k => k.columnId === doneCol).length + "/" + kids.length + " sub"));
  }
  if (t.jiraStatus) meta.appendChild(el("span", "badge jira", t.jiraStatus));
  if (t.origin === "local") meta.appendChild(el("span", "badge custom", "local"));
  if (t.level && t.level !== "task") meta.appendChild(el("span", "badge sub", t.level));
  if (t.priority) meta.appendChild(el("span", "badge", t.priority));
  const g = taskGroup(t);
  if (g && g !== "(no project)") meta.appendChild(el("span", "badge sub", "⟨" + g + "⟩"));

  // Move select — includes the Backlog/Archive pseudo-locations so a card can
  // be parked off-board or sent to the done board from anywhere.
  const mv = el("select");
  const loc = t.location ?? "board";
  const mkOpt = (val, label, sel) => { const o = el("option"); o.value = val; o.textContent = label; if (sel) o.selected = true; return o; };
  if (loc === "backlog") mv.appendChild(mkOpt("backlog", "📥 Backlog", true));
  if (loc === "archive") mv.appendChild(mkOpt("archive", "🗄 Archive", true));
  for (const c of board.columns) mv.appendChild(mkOpt(c.id, c.name, loc === "board" && c.id === t.columnId));
  if (loc !== "backlog") mv.appendChild(mkOpt("backlog", "📥 Backlog", false));
  if (loc !== "archive") mv.appendChild(mkOpt("archive", "🗄 Archive", false));
  mv.title = "Move to column / backlog / archive";
  mv.addEventListener("change", () => boardPost("/api/board/move", { taskId: t.id, column: mv.value }, "Moved"));
  meta.appendChild(mv);

  // Assign select
  const as = el("select");
  const optNone = el("option"); optNone.value = ""; optNone.textContent = "→ assign…"; as.appendChild(optNone);
  const optClear = el("option"); optClear.value = "__unassign__"; optClear.textContent = "(unassign)"; as.appendChild(optClear);
  for (const p of agentPickList()) {
    const o = el("option"); o.value = p.name; o.textContent = p.name + (p.idle ? " · idle" : "");
    if (p.name === t.assignee) o.selected = true;
    as.appendChild(o);
  }
  as.title = "Assign to agent (mails them the task)";
  as.addEventListener("change", () => {
    if (!as.value) return;
    const assignee = as.value === "__unassign__" ? "" : as.value;
    boardPost("/api/board/assign", { taskId: t.id, assignee, newSession: boardUi.freshSession },
      assignee ? "Assigned to " + assignee + " (mailed)" : "Unassigned");
  });
  meta.appendChild(as);
  card.appendChild(meta);

  // A small "open details" affordance; the full detail (description, full
  // activity timeline, comment/progress/flag/subtask actions) lives in a
  // modal opened by clicking the summary or this button.
  const det = el("div", "tmeta");
  const openBtn = el("button", "btn secondary mini", "Details");
  openBtn.addEventListener("click", () => openTaskModal(t.id));
  det.appendChild(openBtn);
  card.appendChild(det);

  return card;
}

function openTaskModal(id) {
  boardUi.taskModalId = id;
  renderTaskModal();
}
function closeTaskModal() {
  boardUi.taskModalId = null;
  const m = $("#task-modal");
  if (m) m.remove();
}
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && boardUi.taskModalId) closeTaskModal();
});

/** Render the task detail modal overlay. Shows summary/key, meta, the full
 *  description (incl. any folded progress section), the COMPLETE activity
 *  timeline (all entries, progress marked distinctly), and actions: comment,
 *  add progress, move, flag/clear, assign, +subtask. Re-rendered each poll so
 *  it stays live; the comment draft is preserved in boardUi.draftComments. */
function renderTaskModal() {
  let m = $("#task-modal");
  if (!boardUi.taskModalId) { if (m) m.remove(); return; }
  const board = state.board;
  const t = (board?.tasks ?? []).find(x => x.id === boardUi.taskModalId);
  if (!t) { closeTaskModal(); return; } // task disappeared (moved off board / deleted)
  if (!m) {
    m = el("div", "task-modal"); m.id = "task-modal";
    m.addEventListener("click", e => { if (e.target === m) closeTaskModal(); });
    document.body.appendChild(m);
  }
  const card = el("div", "card");
  // Head
  const head = el("div", "tm-head");
  const h3 = el("h3");
  if (t.key) {
    const k = t.url ? el("a", "tm-key", "[" + t.key + "]") : el("span", "tm-key", "[" + t.key + "]");
    if (t.url) { k.href = t.url; k.target = "_blank"; }
    h3.appendChild(k);
  }
  h3.appendChild(document.createTextNode(t.summary));
  head.appendChild(h3);
  const close = el("button", "tm-close", "✕");
  close.addEventListener("click", closeTaskModal);
  head.appendChild(close);
  card.appendChild(head);
  // Meta badges
  const meta = el("div", "tm-meta");
  const col = (board.columns ?? []).find(c => c.id === t.columnId);
  const loc = t.location ?? "board";
  const locLabel = loc === "backlog" ? "📥 Backlog" : loc === "archive" ? "🗄 Archive" : (col?.name ?? t.columnId ?? "?");
  meta.appendChild(el("span", "badge " + (loc === "board" && col?.jiraStatus ? "jira" : "custom"), locLabel));
  if (t.level && t.level !== "task") meta.appendChild(el("span", "badge sub", t.level));
  meta.appendChild(el("span", "assignee" + (t.assignee ? "" : " none"), t.assignee || "unassigned"));
  if (t.jiraStatus) meta.appendChild(el("span", "badge jira", t.jiraStatus));
  if (t.origin === "local") meta.appendChild(el("span", "badge custom", "local"));
  if (t.priority) meta.appendChild(el("span", "badge", t.priority));
  const mg = taskGroup(t);
  if (mg && mg !== "(no project)") meta.appendChild(el("span", "badge sub", "⟨" + mg + "⟩"));
  if (t.flagged) {
    const fb = el("span", "badge flag", "⚠ unclear");
    fb.title = "Flagged by " + t.flagged.by + ": " + t.flagged.reason;
    meta.appendChild(fb);
  }
  if (isSubtask(t)) meta.appendChild(el("span", "badge sub", "↳ " + (t.parentKey || "subtask")));
  card.appendChild(meta);
  if (t.url) card.appendChild(el("div", "sync", "Jira: " + t.url));
  if (t.flagged) {
    const fr = el("div", "binstr", "⚠ Flagged unclear by " + t.flagged.by + " (" + fmtTime(t.flagged.ts) + "):\n" + t.flagged.reason);
    fr.style.borderLeftColor = "var(--error)";
    card.appendChild(fr);
  }
  // Description (incl. any folded "Progress so far" block)
  const dsec = el("div", "tm-section");
  dsec.appendChild(el("div", "gtitle", "Description"));
  dsec.appendChild(el("div", "tm-desc", t.description || "(no description)"));
  card.appendChild(dsec);
  // Subtasks
  const kids = childrenOf(t, board);
  if (kids.length) {
    const ssec = el("div", "tm-section");
    ssec.appendChild(el("div", "gtitle", "Subtasks"));
    for (const c of kids) {
      const cc = board.columns.find(x => x.id === c.columnId);
      const line = el("div", "a", "- [" + shortId(c.id) + "]" + (c.key ? " " + c.key : "") + " " + c.summary + " (" + (cc?.name ?? "?") + (c.assignee ? ", " + c.assignee : "") + ")");
      ssec.appendChild(line);
    }
    card.appendChild(ssec);
  }
  // Column instructions (if any)
  if (col?.instructions) {
    const isec = el("div", "tm-section");
    isec.appendChild(el("div", "gtitle", "Column instructions (" + col.name + ")"));
    isec.appendChild(el("div", "binstr", col.instructions));
    card.appendChild(isec);
  }
  // FULL activity timeline, rendered by kind (progress marked distinctly)
  const asec = el("div", "tm-section");
  asec.appendChild(el("div", "gtitle", "Activity (" + (t.activity?.length ?? 0) + ")"));
  const act = el("div", "tm-act");
  if (t.activity?.length) {
    for (const a of t.activity) {
      const row = el("div", "a" + (a.kind === "progress" ? " progress" : ""));
      if (a.kind === "progress") row.appendChild(el("span", "akind", "progress"));
      const b = el("b", null, a.who); row.appendChild(b);
      row.appendChild(document.createTextNode(" · " + fmtTime(a.ts) + "\n" + a.text));
      act.appendChild(row);
    }
  } else {
    act.appendChild(el("div", "empty", "—"));
  }
  asec.appendChild(act);
  card.appendChild(asec);
  // Action row: comment / progress textarea + buttons + move + assign + flag + subtask
  const fsec = el("div", "tm-section");
  const ta = el("textarea");
  ta.placeholder = "Add a comment or progress note…";
  ta.value = boardUi.draftComments[t.id] || "";
  ta.addEventListener("input", () => boardUi.draftComments[t.id] = ta.value);
  fsec.appendChild(ta);
  const actions = el("div", "tm-actions");
  const cbtn = el("button", "btn secondary mini", "💬 Comment");
  cbtn.title = "Posted to the activity log" + (t.origin === "jira" ? " and the Jira issue" : "");
  cbtn.addEventListener("click", async () => {
    const text = ta.value.trim(); if (!text) return;
    const r = await boardPost("/api/board/comment", { taskId: t.id, text }, "Comment added");
    if (r.ok) { delete boardUi.draftComments[t.id]; }
  });
  actions.appendChild(cbtn);
  const pbtn = el("button", "btn mini", "📈 Progress");
  pbtn.title = "Internal progress note (not posted to Jira); folded into the description when the task moves";
  pbtn.addEventListener("click", async () => {
    const text = ta.value.trim(); if (!text) return;
    const r = await boardPost("/api/board/progress", { taskId: t.id, text }, "Progress posted");
    if (r.ok) { delete boardUi.draftComments[t.id]; }
  });
  actions.appendChild(pbtn);
  // Move select — includes Backlog/Archive pseudo-locations.
  const mv = el("select");
  const tloc = t.location ?? "board";
  const mkOpt = (val, label, sel) => { const o = el("option"); o.value = val; o.textContent = label; if (sel) o.selected = true; return o; };
  if (tloc === "backlog") mv.appendChild(mkOpt("backlog", "📥 Backlog", true));
  if (tloc === "archive") mv.appendChild(mkOpt("archive", "🗄 Archive", true));
  for (const c of board.columns) mv.appendChild(mkOpt(c.id, c.name, tloc === "board" && c.id === t.columnId));
  if (tloc !== "backlog") mv.appendChild(mkOpt("backlog", "📥 Backlog", false));
  if (tloc !== "archive") mv.appendChild(mkOpt("archive", "🗄 Archive", false));
  mv.title = "Move to column / backlog / archive";
  mv.addEventListener("change", () => boardPost("/api/board/move", { taskId: t.id, column: mv.value }, "Moved"));
  actions.appendChild(mv);
  // Assign select
  const as = el("select");
  const optNone = el("option"); optNone.value = ""; optNone.textContent = "→ assign…"; as.appendChild(optNone);
  const optClear = el("option"); optClear.value = "__unassign__"; optClear.textContent = "(unassign)"; as.appendChild(optClear);
  for (const p of agentPickList()) {
    const o = el("option"); o.value = p.name; o.textContent = p.name + (p.idle ? " · idle" : "");
    if (p.name === t.assignee) o.selected = true;
    as.appendChild(o);
  }
  as.title = "Assign to agent (mails them the task)";
  as.addEventListener("change", () => {
    if (!as.value) return;
    const assignee = as.value === "__unassign__" ? "" : as.value;
    boardPost("/api/board/assign", { taskId: t.id, assignee, newSession: boardUi.freshSession },
      assignee ? "Assigned to " + assignee + " (mailed)" : "Unassigned");
  });
  actions.appendChild(as);
  // Flag / clear
  if (t.flagged) {
    const clr = el("button", "btn secondary mini", "Clear ⚠");
    clr.addEventListener("click", () => boardPost("/api/board/flag", { taskId: t.id, clear: true }, "Flag cleared"));
    actions.appendChild(clr);
  } else {
    const flg = el("button", "btn secondary mini", "Flag ⚠");
    flg.title = "Uses the text box as the reason";
    flg.addEventListener("click", () => {
      const reason = ta.value.trim() || "needs clarification";
      boardPost("/api/board/flag", { taskId: t.id, reason }, "Flagged as unclear").then(r => { if (r.ok) delete boardUi.draftComments[t.id]; });
    });
    actions.appendChild(flg);
  }
  // Subtask
  const sub = el("button", "btn secondary mini", "＋ Subtask");
  sub.addEventListener("click", () => {
    const summary = prompt("Subtask summary" + (t.origin === "jira" ? " (created as a Jira sub-task)" : "") + ":");
    if (summary && summary.trim()) boardPost("/api/board/create", { summary: summary.trim(), parent: t.id }, "Subtask created");
  });
  actions.appendChild(sub);
  fsec.appendChild(actions);
  card.appendChild(fsec);
  // Preserve scroll positions of the description + activity containers and
  // the textarea's focus/selection across the poll-driven rebuild, so reading
  // a long activity log isn't reset to the top every 3s. (The focus guard in
  // refresh() already suppresses re-render while typing; this covers passive
  // reading and any render that slips through.)
  let descScroll = 0, actScroll = 0, taFocus = false, taStart = 0, taEnd = 0;
  {
    const oldDesc = m.querySelector(".tm-desc"); if (oldDesc) descScroll = oldDesc.scrollTop;
    const oldAct = m.querySelector(".tm-act"); if (oldAct) actScroll = oldAct.scrollTop;
    const oldTa = m.querySelector("textarea");
    if (oldTa) {
      taFocus = document.activeElement === oldTa;
      taStart = oldTa.selectionStart ?? 0; taEnd = oldTa.selectionEnd ?? 0;
    }
  }
  m.innerHTML = "";
  m.appendChild(card);
  const newDesc = m.querySelector(".tm-desc"); if (newDesc) newDesc.scrollTop = descScroll;
  const newAct = m.querySelector(".tm-act"); if (newAct) newAct.scrollTop = actScroll;
  if (taFocus) {
    const newTa = m.querySelector("textarea");
    if (newTa) { newTa.focus(); try { newTa.setSelectionRange(taStart, taEnd); } catch {} }
  }
}

/** Order a column's tasks so subtasks follow their parent when co-located. */
function orderColumnTasks(tasks, board) {
  const inCol = new Set(tasks.map(t => t.id));
  const isTop = t => !isSubtask(t) || !(board.tasks ?? []).some(p =>
    inCol.has(p.id) && (p.id === t.parentId || (t.parentKey && p.key === t.parentKey)));
  const tops = tasks.filter(isTop).sort((a, b) => b.updatedAt - a.updatedAt);
  const out = [];
  for (const t of tops) {
    out.push(t);
    for (const c of tasks) {
      if (c !== t && (c.parentId === t.id || (t.key && c.parentKey === t.key))) out.push(c);
    }
  }
  return out;
}

function boardSettingsCard(board) {
  const card = el("div", "card board-settings");
  card.appendChild(el("h2", null, "Board settings"));

  // Jira connection
  card.appendChild(el("label", null, "Jira base URL (e.g. https://yourorg.atlassian.net)"));
  const inUrl = el("input"); inUrl.value = board._cfg?.baseUrl ?? ""; card.appendChild(inUrl);
  card.appendChild(el("label", null, "Jira account email"));
  const inMail = el("input"); inMail.value = board._cfg?.email ?? ""; card.appendChild(inMail);
  card.appendChild(el("label", null, "API token" + (board._cfg?.apiTokenSet ? " (set — leave blank to keep)" : "")));
  const inTok = el("input"); inTok.type = "password"; inTok.placeholder = board._cfg?.apiTokenSet ? "••••••••" : "paste a Jira API token";
  card.appendChild(inTok);
  card.appendChild(el("label", null, "JQL (which issues to sync)"));
  const inJql = el("input"); inJql.value = board._cfg?.jql ?? ""; card.appendChild(inJql);
  card.appendChild(el("label", null, "Project key — used when creating top-level Jira issues from the board (e.g. PROJ)"));
  const inProj = el("input"); inProj.value = board._cfg?.projectKey ?? ""; card.appendChild(inProj);

  // Columns editor — draft lives in boardUi so poll re-renders don't wipe edits
  card.appendChild(el("label", null, "Columns — order matters; blank Jira status = board-only column with instructions"));
  const colWrap = el("div");
  if (!boardUi.colsDraft) boardUi.colsDraft = board.columns.map(c => ({ ...c }));
  const rows = boardUi.colsDraft;
  const renderCols = () => {
    colWrap.innerHTML = "";
    rows.forEach((c, i) => {
      const r = el("div", "colrow");
      const rr = el("div", "rr");
      const inName = el("input"); inName.value = c.name; inName.placeholder = "Column name";
      inName.addEventListener("input", () => c.name = inName.value);
      const inStatus = el("input"); inStatus.value = c.jiraStatus ?? ""; inStatus.placeholder = "Jira status (blank = board-only)";
      inStatus.addEventListener("input", () => c.jiraStatus = inStatus.value);
      rr.appendChild(inName); rr.appendChild(inStatus);
      const up = el("button", "btn secondary mini", "↑");
      up.addEventListener("click", () => { if (i > 0) { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); renderCols(); } });
      const down = el("button", "btn secondary mini", "↓");
      down.addEventListener("click", () => { if (i < rows.length - 1) { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); renderCols(); } });
      const del = el("button", "btn secondary mini", "✕");
      del.addEventListener("click", () => { rows.splice(i, 1); renderCols(); });
      rr.appendChild(up); rr.appendChild(down); rr.appendChild(del);
      r.appendChild(rr);
      const inInstr = el("textarea"); inInstr.value = c.instructions ?? ""; inInstr.placeholder = "Instructions mailed to the assignee when a task lands here (optional)";
      inInstr.addEventListener("input", () => c.instructions = inInstr.value);
      r.appendChild(inInstr);
      colWrap.appendChild(r);
    });
  };
  renderCols();
  card.appendChild(colWrap);

  const btnRow = el("div", "row"); btnRow.style.display = "flex"; btnRow.style.gap = "8px"; btnRow.style.marginTop = "10px";
  const addCol = el("button", "btn secondary", "+ Column");
  addCol.addEventListener("click", () => { rows.push({ id: "", name: "New column", jiraStatus: null, instructions: "" }); renderCols(); });
  const save = el("button", "btn", "Save settings");
  save.addEventListener("click", async () => {
    save.disabled = true;
    const r = await post("/api/board/config", {
      config: { baseUrl: inUrl.value, email: inMail.value, apiToken: inTok.value, jql: inJql.value, projectKey: inProj.value },
      columns: rows,
    });
    save.disabled = false;
    if (r.ok) { toast("✅ Board settings saved — syncing"); delete boardCfgCache.cfg; boardUi.settingsOpen = false; boardUi.colsDraft = null; refresh(); }
    else toast("❌ " + (r.error || "save failed"), true);
  });
  btnRow.appendChild(addCol); btnRow.appendChild(save);
  card.appendChild(btnRow);
  return card;
}

const boardCfgCache = {};
async function ensureBoardCfg() {
  if (!boardCfgCache.cfg) {
    try { boardCfgCache.cfg = await (await fetch("/api/board/config", { cache: "no-store" })).json(); } catch { boardCfgCache.cfg = null; }
  }
  return boardCfgCache.cfg;
}

// ── Spawn agent modal + web terminal ────────────────────────────────────────

/** State for the directory picker: current path + cached ls results. */
const spawnUi = { path: "", dirs: [], manualMode: false, loadingLs: false };

/** Open the spawn modal with the directory picker. */
async function openSpawnModal() {
  // Default to the filesystem root; the picker can browse anywhere.
  if (!spawnUi.path) spawnUi.path = "/";
  await spawnLs(spawnUi.path);
  renderSpawnModal();
}

/** Fetch a directory listing for `path` (any directory on the filesystem). */
async function spawnLs(path) {
  spawnUi.loadingLs = true;
  if (document.getElementById("spawnModal")) renderSpawnModal();
  try {
    const hidden = spawnUi.showHidden ? "&hidden=1" : "";
    const r = await fetch("/api/spawn/ls?path=" + encodeURIComponent(path) + hidden).then(r => r.json());
    if (r.ok) { spawnUi.path = r.dir; spawnUi.dirs = r.dirs; spawnUi.manualMode = false; }
    else { spawnUi.dirs = []; toast("❌ " + (r.error || "ls failed"), true); }
  } catch (e) { toast("❌ ls failed: " + e.message, true); }
  spawnUi.loadingLs = false;
  if (document.getElementById("spawnModal")) renderSpawnModal();
}

function renderSpawnModal() {
  closeModal("spawnModal");
  const overlay = el("div", "spawn-modal"); overlay.id = "spawnModal";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  const card = el("div", "card");
  card.appendChild(el("h3", null, "➕ Spawn a fresh agent"));

  // Directory picker
  card.appendChild(el("label", null, "Working directory (cwd)"));
  const picker = el("div", "picker");
  // Up-to-parent navigation: go to the parent directory (disabled at /).
  const upBtn = el("button", "btn secondary mini", "↑");
  upBtn.title = "Go to parent directory";
  upBtn.disabled = spawnUi.path === "/";
  upBtn.addEventListener("click", () => {
    if (spawnUi.path !== "/") {
      const parent = spawnUi.path.replace(/\/[^/]+\/?$/, "") || "/";
      spawnLs(parent);
    }
  });
  picker.appendChild(upBtn);
  // Subdirectory select (navigate into).
  const dirSel = el("select"); dirSel.size = 8; dirSel.style.flex = "2 1 240px";
  if (spawnUi.loadingLs) { const o = el("option", null, "loading…"); dirSel.appendChild(o); }
  else if (!spawnUi.dirs.length) { const o = el("option", null, "(no subdirectories)"); dirSel.appendChild(o); }
  else { for (const d of spawnUi.dirs) { const o = el("option", null, "📁 " + d.name); o.value = d.path; dirSel.appendChild(o); } }
  dirSel.addEventListener("change", () => {
    if (dirSel.value) spawnLs(dirSel.value);
  });
  picker.appendChild(dirSel);
  card.appendChild(picker);
  // Crumbs + manual path input
  const crumbs = el("div", "crumbs"); crumbs.textContent = spawnUi.path || "(pick a directory)";
  card.appendChild(crumbs);
  const manualWrap = el("div"); manualWrap.style.marginTop = "6px";
  const manualIn = el("input"); manualIn.placeholder = "…or type an absolute path"; manualIn.value = spawnUi.manualMode ? spawnUi.path : "";
  manualIn.addEventListener("change", () => { if (manualIn.value.trim()) { spawnUi.manualMode = true; spawnLs(manualIn.value.trim()); } });
  manualWrap.appendChild(manualIn);
  card.appendChild(manualWrap);

  // Name / model / kickoff
  const nameL = el("label", null, "Agent name (optional — defaults to <dir>-<id6>)");
  card.appendChild(nameL);
  const nameIn = el("input"); nameIn.placeholder = "e.g. reader-worker-1"; card.appendChild(nameIn);
  const modelL = el("label", null, "Model (optional)");
  card.appendChild(modelL);
  const modelIn = el("input"); modelIn.placeholder = "e.g. anthropic/claude-sonnet-4"; card.appendChild(modelIn);
  const kickL = el("label", null, "Kickoff prompt (optional — sent as a new-session task once the agent registers)");
  card.appendChild(kickL);
  const kickIn = el("textarea"); kickIn.rows = 3; kickIn.placeholder = "e.g. /new-task Implement the auth refactor"; card.appendChild(kickIn);

  // Show hidden (dot-) directories in the picker above. Off by default so the
  // list stays tidy; toggle re-fetches the current directory.
  const hidWrap = el("span", "checkbox");
  const hidCb = el("input"); hidCb.type = "checkbox"; hidCb.id = "sh"; hidCb.checked = !!spawnUi.showHidden;
  hidCb.addEventListener("change", () => { spawnUi.showHidden = hidCb.checked; spawnLs(spawnUi.path); });
  const hidLab = el("label"); hidLab.htmlFor = "sh"; hidLab.textContent = "Show hidden directories";
  hidWrap.appendChild(hidCb); hidWrap.appendChild(hidLab);
  card.appendChild(hidWrap);

  const row = el("div", "row");
  const cancel = el("button", "btn secondary", "Cancel");
  cancel.addEventListener("click", () => closeModal("spawnModal"));
  row.appendChild(cancel);
  const spawnGo = el("button", "btn spawn-btn", "Spawn");
  spawnGo.addEventListener("click", async () => {
    const cwd = spawnUi.manualMode ? manualIn.value.trim() : spawnUi.path;
    if (!cwd) { toast("❌ pick a working directory", true); return; }
    spawnGo.disabled = true; spawnGo.textContent = "Spawning…";
    const r = await post("/api/spawn", { cwd, name: nameIn.value.trim() || undefined, model: modelIn.value.trim() || undefined, kickoff: kickIn.value.trim() || undefined });
    spawnGo.disabled = false; spawnGo.textContent = "Spawn";
    if (r.ok) { toast("✅ Spawned " + (r.name || "agent") + " — it'll appear in the Agents table"); closeModal("spawnModal"); refresh(); }
    else toast("❌ " + (r.error || "spawn failed"), true);
  });
  row.appendChild(spawnGo);
  card.appendChild(row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

function closeModal(id) { const m = document.getElementById(id); if (m) m.remove(); }

/** Open a web terminal (xterm.js) over a WebSocket to a spawned tmux session. */
function openTerminal(name) {
  closeModal("termOverlay");
  if (typeof Terminal === "undefined") { toast("❌ xterm.js failed to load (offline?); cannot open terminal", true); return; }
  const overlay = el("div", "term-overlay"); overlay.id = "termOverlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeTerminal(); });
  const card = el("div", "card");
  const bar = el("div", "bar");
  bar.appendChild(el("h3", null, "🖥 Terminal — " + name));
  const closeBtn = el("button", "btn secondary mini", "Close"); closeBtn.addEventListener("click", closeTerminal);
  bar.appendChild(closeBtn);
  card.appendChild(bar);
  const host = el("div"); host.id = "xterm-host";
  card.appendChild(host);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "monospace", scrollback: 5000 });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  try { fit.fit(); } catch {}
  term.writeln("Connecting to " + name + "…");

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/spawn/terminal?name=${encodeURIComponent(name)}`);
  ws.binaryType = "arraybuffer";
  term.termWs = ws; term.termFit = fit; // stash for teardown
  termOpen = term;

  ws.onopen = () => { /* stream starts */ };
  ws.onmessage = (ev) => {
    const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data;
    term.write(data);
  };
  ws.onclose = () => { try { term.writeln("\r\n[disconnected]"); } catch {} };
  ws.onerror = () => { try { term.writeln("\r\n[error]"); } catch {} };
  term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d)); });

  // Refit on window resize.
  const onResize = () => { try { fit.fit(); } catch {} };
  window.addEventListener("resize", onResize);
  term.termOnResize = onResize;
}

let termOpen = null;
function closeTerminal() {
  if (termOpen) {
    try { if (termOpen.termWs) termOpen.termWs.close(); } catch {}
    try { if (termOpen.termOnResize) window.removeEventListener("resize", termOpen.termOnResize); } catch {}
    try { termOpen.dispose(); } catch {}
    termOpen = null;
  }
  closeModal("termOverlay");
}

