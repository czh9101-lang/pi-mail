"use strict";
// ── Task board: card rendering + drag-and-drop ──────────────────────────────
// Board helpers (boardPost, agent idle/pick lists, subtask detection), the
// task card renderer (with HTML5 drag-and-drop), column drop targets, and
// column task ordering. The task detail modal lives in ui-board-modal.js, the
// settings card in ui-board-settings.js, the spawn modal in ui-spawn.js, and
// the web terminal in ui-terminal.js.

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

/** Attach HTML5 drag-and-drop handlers to a column element so task cards can
 *  be dropped onto it. Reuses the existing /api/board/move endpoint with the
 *  given column spec (a column id, or "backlog"/"archive"). A depth counter
 *  tracks dragenter/dragleave across child elements so the highlight doesn't
 *  flicker as the pointer moves over cards inside the column. */
function makeDropTarget(colEl, columnSpec) {
  let depth = 0;
  colEl.addEventListener("dragenter", (e) => {
    if (!boardUi.dragTaskId) return;
    e.preventDefault();
    depth++;
    colEl.classList.add("drag-over");
  });
  colEl.addEventListener("dragover", (e) => {
    if (!boardUi.dragTaskId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  colEl.addEventListener("dragleave", () => {
    depth--;
    if (depth <= 0) { depth = 0; colEl.classList.remove("drag-over"); }
  });
  colEl.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    colEl.classList.remove("drag-over");
    let id = boardUi.dragTaskId;
    if (!id) { try { id = e.dataTransfer.getData("text/plain") || null; } catch { id = null; } }
    boardUi.dragTaskId = null;
    if (id) boardPost("/api/board/move", { taskId: id, column: columnSpec }, "Moved");
  });
}
function childrenOf(t, board) {
  return (board.tasks ?? []).filter(x => x.parentId === t.id || (t.key && x.parentKey === t.key));
}

function taskCard(t, board) {
  const card = el("div", "tcard" + (t.flagged ? " flagged" : "") + (isSubtask(t) ? " subtask" : ""));
  // Drag-and-drop: make the card draggable. The drop is handled by the
  // column (see makeDropTarget), which calls /api/board/move with the task
  // id and the target column id. dragTaskId also suppresses the 3s poll
  // re-render so the dragged element isn't rebuilt mid-drag.
  card.draggable = true;
  card.addEventListener("dragstart", (e) => {
    boardUi.dragTaskId = t.id;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", t.id); } catch {}
  });
  card.addEventListener("dragend", () => {
    boardUi.dragTaskId = null;
    card.classList.remove("dragging");
    document.querySelectorAll(".bcol.drag-over").forEach(c => c.classList.remove("drag-over"));
  });
  const sum = el("div", "tsum");
  if (t.key) {
    const k = el(t.url ? "a" : "span", "tkey", "[" + t.key + "]");
    if (t.url) { k.href = t.url; k.target = "_blank"; k.addEventListener("click", e => e.stopPropagation()); }
    sum.appendChild(k);
  }
  sum.appendChild(document.createTextNode(t.summary));
  sum.addEventListener("click", () => openTaskModal(t.id));
  card.appendChild(sum);

  // Description preview — a few clamped lines so the board is scannable
  // without opening every card. Click opens the full detail modal.
  if (t.description && t.description.trim()) {
    const d = el("div", "tdesc");
    d.textContent = t.description;
    d.title = t.description;
    d.addEventListener("click", () => openTaskModal(t.id));
    card.appendChild(d);
  }

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
