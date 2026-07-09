"use strict";
function renderBoard() {
  main.innerHTML = "";
  const board = state.board;
  if (!board) { main.appendChild(el("div", "empty", "Board not available (daemon too old? restart with /restart-mail-daemon).")); return; }

  // Toolbar
  const bar = el("div", "board-toolbar");
  const sync = el("span", "sync" + (board.syncError ? " err" : ""));
  sync.textContent = board.jiraConfigured
    ? (board.syncError ? "⚠ Jira sync error: " + board.syncError : "Jira sync · last " + (board.lastSync ? fmtTime(board.lastSync) : "never"))
    : "Jira not configured — board-only mode (open Settings)";
  bar.appendChild(sync);
  const syncBtn = el("button", "btn secondary mini", "Sync now");
  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    const r = await post("/api/board/sync", {});
    syncBtn.disabled = false;
    if (r.ok) { toast("🔄 Synced with Jira"); refresh(); } else toast("❌ " + (r.error || "sync failed"), true);
  });
  bar.appendChild(syncBtn);
  const cbWrap = el("span", "checkbox");
  const cb = el("input"); cb.type = "checkbox"; cb.id = "fs"; cb.checked = boardUi.freshSession;
  cb.addEventListener("change", () => boardUi.freshSession = cb.checked);
  const cbl = el("label", null, "fresh session on assign"); cbl.setAttribute("for", "fs"); cbl.style.margin = "0";
  cbWrap.appendChild(cb); cbWrap.appendChild(cbl);
  bar.appendChild(cbWrap);
  // Status filter: show done (archived) tasks. The checkbox is a FILTER, not
  // an assignment — it reveals the Archive panel below the board.
  const archWrap = el("span", "checkbox");
  const archCb = el("input"); archCb.type = "checkbox"; archCb.id = "fa"; archCb.checked = boardUi.showArchive;
  archCb.addEventListener("change", () => { boardUi.showArchive = archCb.checked; renderBoard(); });
  const archLbl = el("label", null, "show done (archive)"); archLbl.setAttribute("for", "fa"); archLbl.style.margin = "0";
  archWrap.appendChild(archCb); archWrap.appendChild(archLbl);
  bar.appendChild(archWrap);
  // Group filter: focus the board on one project group. The operator sees
  // all groups; this just hides the others. "__all" = no filter.
  const groups = boardGroups(board);
  if (groups.length > 1 || (groups.length === 1 && groups[0] !== "(no project)")) {
    const gWrap = el("span", "checkbox");
    const gSel = el("select"); gSel.style.fontSize = "12px";
    const gAll = el("option"); gAll.value = "__all"; gAll.textContent = "all groups"; if (boardUi.groupFilter === "__all") gAll.selected = true; gSel.appendChild(gAll);
    for (const g of groups) {
      const o = el("option"); o.value = g; o.textContent = g; if (boardUi.groupFilter === g) o.selected = true; gSel.appendChild(o);
    }
    gSel.addEventListener("change", () => { boardUi.groupFilter = gSel.value; renderBoard(); });
    gWrap.appendChild(el("label", null, "group:")); gWrap.lastChild.style.margin = "0"; gWrap.lastChild.style.color = "var(--dim)";
    gWrap.appendChild(gSel);
    bar.appendChild(gWrap);
  }
  const settingsBtn = el("button", "btn secondary mini", boardUi.settingsOpen ? "Close settings" : "⚙ Settings");
  settingsBtn.addEventListener("click", async () => {
    boardUi.settingsOpen = !boardUi.settingsOpen;
    if (boardUi.settingsOpen) await ensureBoardCfg();
    else boardUi.colsDraft = null; // discard unsaved column edits on close
    renderBoard();
  });
  bar.appendChild(settingsBtn);
  const spawnBtn = el("button", "btn spawn-btn", "➕ Spawn agent");
  spawnBtn.addEventListener("click", openSpawnModal);
  bar.appendChild(spawnBtn);
  main.appendChild(bar);

  // Idle-agents summary — surfaces who's available for assignment, right on
  // the board (mirrors Agents-tab statuses, but inline where you assign).
  const idle = state.agents.filter(isIdle).map(a => a.agentName).sort();
  const idleRow = el("div", "idle-row");
  idleRow.appendChild(el("span", "idle-label", idle.length ? "🟢 Idle (" + idle.length + "):" : "🟢 Idle:"));
  if (idle.length) {
    for (const n of idle) idleRow.appendChild(el("span", "idle-chip", n));
  } else {
    idleRow.appendChild(el("span", "idle-none", "no agents idle"));
  }
  main.appendChild(idleRow);

  // Settings
  if (boardUi.settingsOpen) {
    main.appendChild(boardSettingsCard({ ...board, _cfg: boardCfgCache.cfg?.config }));
  }

  // New (local) task — supports level (epic/story/task) and a backlog flag.
  const nt = el("div", "newtask");
  const inSum = el("input"); inSum.placeholder = "New task summary…"; inSum.value = boardUi.newTask.summary;
  inSum.addEventListener("input", () => boardUi.newTask.summary = inSum.value);
  const inDesc = el("textarea"); inDesc.placeholder = "Description (optional)…"; inDesc.value = boardUi.newTask.description;
  inDesc.addEventListener("input", () => boardUi.newTask.description = inDesc.value);
  inDesc.rows = 2; inDesc.style.minHeight = "40px";
  const colPick = el("select", "agentpick");
  for (const c of board.columns) {
    const o = el("option"); o.value = c.id; o.textContent = c.name;
    if (c.id === boardUi.newTask.column) o.selected = true;
    colPick.appendChild(o);
  }
  colPick.addEventListener("change", () => boardUi.newTask.column = colPick.value);
  const lvlPick = el("select", "agentpick");
  for (const lv of ["task", "epic", "story"]) {
    const o = el("option"); o.value = lv; o.textContent = lv; if (lv === (boardUi.newTask.level || "task")) o.selected = true; lvlPick.appendChild(o);
  }
  lvlPick.title = "Issue level";
  lvlPick.addEventListener("change", () => boardUi.newTask.level = lvlPick.value);
  const blWrap = el("span", "checkbox");
  const blCb = el("input"); blCb.type = "checkbox"; blCb.id = "nbl"; blCb.checked = boardUi.newTask.backlog;
  blCb.addEventListener("change", () => { boardUi.newTask.backlog = blCb.checked; colPick.disabled = blCb.checked; });
  if (boardUi.newTask.backlog) colPick.disabled = true;
  const blLbl = el("label", null, "backlog"); blLbl.setAttribute("for", "nbl"); blLbl.style.margin = "0";
  blWrap.appendChild(blCb); blWrap.appendChild(blLbl);
  const addBtn = el("button", "btn", "Add task");
  addBtn.addEventListener("click", async () => {
    const summary = boardUi.newTask.summary.trim();
    if (!summary) { toast("Give the task a summary", true); return; }
    const payload = { summary, level: boardUi.newTask.level, backlog: boardUi.newTask.backlog };
    if (!boardUi.newTask.backlog) payload.column = colPick.value;
    const desc = boardUi.newTask.description.trim();
    if (desc) payload.description = desc;
    const r = await boardPost("/api/board/create", payload, "Task created");
    if (r.ok) { boardUi.newTask.summary = ""; boardUi.newTask.description = ""; inSum.value = ""; inDesc.value = ""; }
  });
  nt.appendChild(inSum); nt.appendChild(inDesc); nt.appendChild(lvlPick); nt.appendChild(colPick); nt.appendChild(blWrap); nt.appendChild(addBtn);
  main.appendChild(nt);

  // Backlog pool — sits ABOVE the board columns. Items here are not yet
  // placed on a column (location='backlog', columnId null). Local-only.
  const backlogTasks = (board.tasks ?? []).filter(t => (t.location ?? "board") === "backlog");
  if (backlogTasks.length || true) {
    const bl = el("div", "bcol"); bl.style.flex = "1 1 100%"; bl.style.maxWidth = "none";
    const blHead = el("div", "bhead");
    blHead.appendChild(el("span", "bname", "📥 Backlog"));
    blHead.appendChild(el("span", "badge custom", "off-board"));
    blHead.appendChild(el("span", "bcount", String(backlogTasks.length)));
    bl.appendChild(blHead);
    bl.appendChild(el("div", "binstr", "Items not yet placed on a board column. Use the card's move dropdown to place one onto a column (it then leaves the backlog)."));
    if (!backlogTasks.length) bl.appendChild(el("div", "empty", "—"));
    for (const t of backlogTasks) bl.appendChild(taskCard(t, board));
    makeDropTarget(bl, "backlog");
    main.appendChild(bl);
  }

  // Kanban columns
  const kb = el("div", "board");
  for (const c of board.columns) {
    const col = el("div", "bcol");
    const head = el("div", "bhead");
    head.appendChild(el("span", "bname", c.name));
    head.appendChild(el("span", "badge " + (c.jiraStatus ? "jira" : "custom"), c.jiraStatus ? c.jiraStatus : "board-only"));
    const tasks = orderColumnTasks((board.tasks ?? []).filter(t => (t.location ?? "board") === "board" && t.columnId === c.id && groupVisible(t)), board);
    head.appendChild(el("span", "bcount", String(tasks.length)));
    col.appendChild(head);
    if (c.instructions) col.appendChild(el("div", "binstr", c.instructions));
    if (!tasks.length) col.appendChild(el("div", "empty", "—"));
    for (const t of tasks) col.appendChild(taskCard(t, board));
    makeDropTarget(col, c.id);
    kb.appendChild(col);
  }
  main.appendChild(kb);

  // Archive panel — the "done board". Shown only when the status filter
  // (show done) is on. Archived tasks are removed from their column (incl.
  // Done) and restorable via the card's move dropdown.
  if (boardUi.showArchive) {
    const archTasks = (board.tasks ?? []).filter(t => t.location === "archive" && groupVisible(t));
    const ar = el("div", "bcol"); ar.style.flex = "1 1 100%"; ar.style.maxWidth = "none";
    const arHead = el("div", "bhead");
    arHead.appendChild(el("span", "bname", "🗄 Archive (done board)"));
    arHead.appendChild(el("span", "badge custom", "off-board"));
    arHead.appendChild(el("span", "bcount", String(archTasks.length)));
    ar.appendChild(arHead);
    if (!archTasks.length) ar.appendChild(el("div", "empty", "—"));
    for (const t of archTasks) ar.appendChild(taskCard(t, board));
    makeDropTarget(ar, "archive");
    main.appendChild(ar);
  }

  // Keep the task detail modal live across the 3s poll re-render.
  renderTaskModal();
}

function messageRow(m, opts = {}) {
  const card = el("div", "msg");
  const head = el("div", "head");
  const subj = el("span", "subj", m.subject || "(no subject)");
  head.appendChild(subj);
  if (m.broadcast) head.appendChild(el("span", "badge broadcast", "broadcast"));
  if (m.newSession) head.appendChild(el("span", "badge newsession", "new session"));
  head.appendChild(el("span", "meta",
    (opts.showFrom ? "from " + m.fromName + "  ·  " : "") +
    (opts.showTo ? "to " + (m.toName || shortId(m.toId)) + "  ·  " : "") +
    fmtTime(m.timestamp) + "  ·  id " + shortId(m.id)
  ));
  card.appendChild(head);
  card.appendChild(el("div", "body", m.body || "(empty)"));
  if (opts.actions && opts.actions.length) {
    const ac = el("div", "actions");
    for (const a of opts.actions) ac.appendChild(a);
    card.appendChild(ac);
  }
  return card;
}

function renderMailbox() {
  main.innerHTML = "";
  const grid = el("div", "two-col");

  // Compose
  const composeCard = el("div", "card compose");
  composeCard.appendChild(el("h2", null, "Compose (as " + state.human.agentName + ")"));
  const labelTo = el("label", null, "To (agent name or id — leave blank for broadcast)");
  composeCard.appendChild(labelTo);
  const inputTo = el("input"); inputTo.value = compose.to; inputTo.placeholder = "e.g. portal-web-worker";
  composeCard.appendChild(inputTo);
  // <datalist> suggestions don't render on iOS Safari / most mobile browsers,
  // so show always-visible tappable chips of known agents instead. Tapping a
  // chip fills the recipient and keeps the field editable for free-text ids.
  const chips = el("div", "chips");
  for (const a of state.agents) {
    if (a.isHuman) continue;
    const c = el("button", "chip", a.agentName);
    if (a.cwd) c.title = projectOf(a.cwd);
    c.addEventListener("click", () => { compose.to = a.agentName; inputTo.value = a.agentName; inputTo.focus(); });
    chips.appendChild(c);
  }
  if (!chips.children.length) chips.appendChild(el("span", "empty", "No other agents connected."));
  composeCard.appendChild(chips);

  composeCard.appendChild(el("label", null, "Subject"));
  const inputSubj = el("input"); inputSubj.value = compose.subject;
  composeCard.appendChild(inputSubj);

  composeCard.appendChild(el("label", null, "Body"));
  const taBody = el("textarea"); taBody.value = compose.body;
  composeCard.appendChild(taBody);

  const cbWrap = el("div", "checkbox");
  const cb = el("input"); cb.type = "checkbox"; cb.id = "ns"; cb.checked = compose.newSession;
  const cbLabel = el("label", null, "Start fresh session on recipient (newSession)");
  cbLabel.setAttribute("for", "ns"); cbLabel.style.margin = "0";
  cbWrap.appendChild(cb); cbWrap.appendChild(cbLabel);
  composeCard.appendChild(cbWrap);

  const btnRow = el("div", "row");
  btnRow.style.marginTop = "10px";
  const sendBtn = el("button", "btn", "Send");
  const bcastBtn = el("button", "btn broadcast", "Broadcast to all");
  btnRow.appendChild(sendBtn); btnRow.appendChild(bcastBtn);
  composeCard.appendChild(btnRow);

  // keep draft in sync
  inputTo.addEventListener("input", () => compose.to = inputTo.value);
  inputSubj.addEventListener("input", () => compose.subject = inputSubj.value);
  taBody.addEventListener("input", () => compose.body = taBody.value);
  cb.addEventListener("change", () => compose.newSession = cb.checked);

  sendBtn.addEventListener("click", async () => {
    if (!compose.to.trim()) { toast("Add a recipient, or use Broadcast", true); return; }
    sendBtn.disabled = true;
    const r = await post("/api/send", { to: compose.to.trim(), subject: compose.subject, body: compose.body, newSession: compose.newSession });
    sendBtn.disabled = false;
    if (r.ok) { toast("✉ Sent to " + compose.to.trim()); compose.subject = ""; compose.body = ""; compose.newSession = false; inputSubj.value = ""; taBody.value = ""; cb.checked = false; refresh(); }
    else toast("❌ " + (r.error || "send failed"), true);
  });
  bcastBtn.addEventListener("click", async () => {
    bcastBtn.disabled = true;
    const r = await post("/api/broadcast", { subject: compose.subject, body: compose.body });
    bcastBtn.disabled = false;
    if (r.ok) { toast("📡 Broadcast to " + r.recipients + " agent" + (r.recipients === 1 ? "" : "s")); compose.subject = ""; compose.body = ""; inputSubj.value = ""; taBody.value = ""; refresh(); }
    else toast("❌ " + (r.error || "broadcast failed"), true);
  });

  grid.appendChild(composeCard);

  // Inbox + Outbox
  const right = el("div");
  const inboxCard = el("div", "card");
  inboxCard.appendChild(el("h2", null, "Inbox (mail to you)"));
  const inbox = state.messages.filter(m => m.toId === HUMAN_ID && !m.archived)
    .sort((a, b) => b.timestamp - a.timestamp);
  if (!inbox.length) inboxCard.appendChild(el("div", "empty", "No mail yet."));
  for (const m of inbox) {
    const replyBtn = el("button", "btn secondary", "Reply");
    replyBtn.addEventListener("click", () => { compose.to = m.fromName || m.fromId; inputTo.value = compose.to; compose.subject = m.subject.startsWith("Re:") ? m.subject : "Re: " + m.subject; inputSubj.value = compose.subject; compose.body = ""; taBody.value = ""; setTab("mailbox"); inputTo.scrollIntoView(); });
    const archiveBtn = el("button", "btn secondary", "Archive");
    archiveBtn.addEventListener("click", async () => { await post("/api/archive", { id: m.id }); refresh(); });
    inboxCard.appendChild(messageRow(m, { showFrom: true, actions: [replyBtn, archiveBtn] }));
  }
  right.appendChild(inboxCard);

  const outboxCard = el("div", "card");
  outboxCard.appendChild(el("h2", null, "Outbox (mail you sent)"));
  const outbox = state.messages.filter(m => m.fromId === HUMAN_ID)
    .sort((a, b) => b.timestamp - a.timestamp);
  if (!outbox.length) outboxCard.appendChild(el("div", "empty", "Nothing sent yet."));
  // Group broadcasts together.
  const groups = new Map(); // broadcastId -> [msgs]
  const standalone = [];
  for (const m of outbox) {
    if (m.broadcastId) { if (!groups.has(m.broadcastId)) groups.set(m.broadcastId, []); groups.get(m.broadcastId).push(m); }
    else standalone.push(m);
  }
  for (const m of standalone) outboxCard.appendChild(messageRow(m, { showTo: true }));
  for (const [bid, msgs] of groups) {
    const g = el("div", "group");
    g.appendChild(el("div", "gtitle", `📡 broadcast · ${msgs.length} recipient${msgs.length === 1 ? "" : "s"} · ${fmtTime(msgs[0].timestamp)}`));
    for (const m of msgs.sort((a, b) => a.toName < b.toName ? -1 : 1)) g.appendChild(messageRow(m, { showTo: true }));
    outboxCard.appendChild(g);
  }
  right.appendChild(outboxCard);

  grid.appendChild(right);
  main.appendChild(grid);
}

function renderHistory() {
  main.innerHTML = "";
  const card = el("div", "card");
  card.appendChild(el("h2", null, "Mail history per agent"));
  const pick = el("select", "agentpick");
  const def = el("option"); def.value = ""; def.textContent = "— select an agent —"; pick.appendChild(def);
  const sorted = sortAgents(state.agents);
  for (const a of sorted) {
    const o = el("option"); o.value = a.agentId;
    o.textContent = (a.isHuman ? "👤 " : "  ") + a.agentName + (a.isHuman ? " (you)" : "");
    pick.appendChild(o);
  }
  if (historyAgentId) pick.value = historyAgentId;
  card.appendChild(pick);
  card.appendChild(el("div", null, "")).style.height = "10px";

  const list = el("div"); list.style.marginTop = "8px";
  if (!historyAgentId) {
    list.appendChild(el("div", "empty", "Pick an agent to see all mail delivered to it (including archived and broadcasts)."));
  } else {
    const msgs = state.messages.filter(m => m.toId === historyAgentId)
      .sort((a, b) => b.timestamp - a.timestamp);
    if (!msgs.length) list.appendChild(el("div", "empty", "No mail for this agent."));
    for (const m of msgs) list.appendChild(messageRow(m, { showFrom: true }));
  }
  card.appendChild(list);
  main.appendChild(card);

  pick.addEventListener("change", () => { historyAgentId = pick.value; syncHash(); renderHistory(); });
}

// ── URL routing + tabs + polling ─────────────────────────────────────────────
// The active tab (and the selected agent in History) live in the URL hash so
// a page refresh — or browser back/forward — restores the view instead of
// always dropping back onto the Agents tab. setTab updates state, renders
// synchronously (so immediate follow-ups like scrollIntoView still work), and
// pushes the hash; the hashchange listener handles navigations that arrive
// from outside setTab (back/forward, initial deep-link) and no-ops when the
// hash already matches in-memory state (no render loop).
const VALID_TABS = ["agents", "board", "mailbox", "history"];

function routeFor(tab, agentId) {
  if (tab === "history" && agentId) return "history/" + agentId;
  return tab;
}
function parseRoute(hash) {
  const h = (hash || "").replace(/^#\/?/, ""); // strip leading "#" and optional "/"
  const [tab, agentId] = h.split("/");
  if (!VALID_TABS.includes(tab)) return { tab: "agents", agentId: "" };
  return { tab, agentId: agentId || "" };
}
// Apply the URL hash to in-memory state; returns true if it changed anything
// (so the caller can skip a redundant re-render). Does not touch the hash.
function applyRouteFromHash() {
  const { tab, agentId } = parseRoute(location.hash);
  let changed = false;
  if (tab !== currentTab) { currentTab = tab; changed = true; }
  if (tab === "history" && agentId && agentId !== historyAgentId) { historyAgentId = agentId; changed = true; }
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("active", x.dataset.tab === currentTab));
  return changed;
}
// Push the current tab (+ history selection) into the URL hash. No-op if it
// already matches, so this never triggers a hashchange→render loop. Uses the
// "/" prefix so the fragment never matches a real element id (no scroll jump).
function syncHash() {
  const want = "#/" + routeFor(currentTab, currentTab === "history" ? historyAgentId : "");
  if (location.hash !== want) location.hash = want;
}

function setTab(name) {
  currentTab = name;
  if (name !== "board") closeTaskModal();
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("active", x.dataset.tab === name));
  syncHash();
  render();
}

document.querySelectorAll("nav button").forEach(b => {
  b.addEventListener("click", () => setTab(b.dataset.tab));
});

window.addEventListener("hashchange", () => { if (applyRouteFromHash()) render(); });

// Restore the view from the URL before the first render so a refresh keeps
// you on the page you were on (instead of always landing on Agents).
applyRouteFromHash();
refresh();
pollTimer = setInterval(refresh, 3000);
