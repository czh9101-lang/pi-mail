"use strict";
// ── Mailbox tab (Outlook-style conversation view) ───────────────────────────
// Extracted from ui-app.js. messageRow renders one mail card; renderMailbox
// shows a conversation list (left) + thread + compose (right). A conversation
// is keyed by the agent pair (human↔agent, or agent↔agent when toggled).

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

/** A small "try again" row shown inside the mailbox list when a page fetch
 *  fails (first-load or load-more). Keeps the rest of the list usable. */
function mailboxRetryRow(msg, onRetry) {
  const row = el("div", "empty");
  row.appendChild(document.createTextNode(msg + " "));
  const btn = el("button", "btn secondary mini", "Try again");
  btn.addEventListener("click", onRetry);
  row.appendChild(btn);
  return row;
}

function renderMailbox() {
  // Preserve the conversation-list scroll position across the 3s poll
  // re-render so infinite-scroll position isn't yanked back to the top when
  // an unrelated slice of state (agent status, board, new mail) changes.
  const prevList = main.querySelector(".mb-conv-list");
  const prevTop = prevList ? prevList.scrollTop : 0;
  main.innerHTML = "";
  const grid = el("div", "mb-grid");

  // ── Left pane: conversation list ──────────────────────────────────────
  const left = el("div", "mb-left");
  const leftHead = el("div", "mb-left-head");
  leftHead.appendChild(el("h2", null, "Conversations"));
  left.appendChild(leftHead);

  // Toggle: include inter-agent (agent↔agent) conversations. When off (default)
  // the list shows only conversations that involve the human, grouped per
  // peer agent (Outlook-style: one row per correspondent). When on, also
  // shows agent↔agent threads.
  const toggleWrap = el("div", "checkbox");
  const tCb = el("input"); tCb.type = "checkbox"; tCb.id = "mb-ia"; tCb.checked = mailboxUi.showInterAgent;
  tCb.addEventListener("change", () => { mailboxUi.showInterAgent = tCb.checked; renderMailbox(); });
  const tLbl = el("label", null, "Show inter-agent messages"); tLbl.setAttribute("for", "mb-ia"); tLbl.style.margin = "0";
  toggleWrap.appendChild(tCb); toggleWrap.appendChild(tLbl);
  left.appendChild(toggleWrap);

  const convList = el("div", "mb-conv-list");

  // Build conversations. A conversation is keyed by the agent pair. For
  // human↔agent threads the key is the agent id; for agent↔agent threads the
  // key is the sorted "a|b" pair (so both directions collapse into one row).
  // Each row shows the last message's snippet + timestamp so the list is
  // scannable like an Outlook message list.
  const convMap = new Map(); // key -> { msgs: [...], label, sortTs }
  const consider = (m, key, label) => {
    if (!convMap.has(key)) convMap.set(key, { msgs: [], label, sortTs: 0 });
    const c = convMap.get(key);
    c.msgs.push(m);
    if (m.timestamp > c.sortTs) c.sortTs = m.timestamp;
  };

  // Messages come from the paginated /api/messages endpoint (cached in
  // mailboxUi.messages), not the full log in /api/state. Older pages are
  // appended on scroll (infinite scroll, task 276b3643); new mail is
  // prepended on the 3s poll refresh.
  for (const m of mailboxUi.messages) {
    const hFrom = m.fromId === HUMAN_ID;
    const hTo = m.toId === HUMAN_ID;
    if (hFrom || hTo) {
      const peerId = hFrom ? m.toId : m.fromId;
      const peerName = hFrom ? (m.toName || shortId(m.toId)) : (m.fromName || m.fromId);
      consider(m, peerId, peerName);
    } else if (mailboxUi.showInterAgent) {
      const pair = [m.fromId, m.toId].sort().join("|");
      const label = (m.fromName || shortId(m.fromId)) + " ↔ " + (m.toName || shortId(m.toId));
      consider(m, pair, label);
    }
  }

  const convs = [...convMap.entries()].map(([key, c]) => ({ key, ...c })).sort((a, b) => b.sortTs - a.sortTs);

  if (!convs.length) {
    if (mailboxUi.loading) {
      convList.appendChild(el("div", "empty", "Loading…"));
    } else if (mailboxUi.error) {
      convList.appendChild(mailboxRetryRow(mailboxUi.error, () => { loadMailboxPage().then(render); }));
    } else {
      convList.appendChild(el("div", "empty", mailboxUi.showInterAgent ? "No messages." : "No conversations yet. Toggle inter-agent messages to see agent↔agent threads."));
    }
  }
  for (const c of convs) {
    const last = c.msgs.slice().sort((a, b) => b.timestamp - a.timestamp)[0];
    const lastDir = last.fromId === HUMAN_ID ? "→ " : "← ";
    const snippet = (last.subject || "(no subject)") + " — " + (last.body || "").replace(/\s+/g, " ").slice(0, 60);
    const row = el("div", "mb-conv-row" + (c.key === mailboxUi.selectedKey ? " active" : ""));
    const nm = el("div", "mb-conv-name", c.label);
    const sn = el("div", "mb-conv-snippet", lastDir + snippet);
    const ts = el("div", "mb-conv-ts", fmtTime(last.timestamp).split(",")[0]);
    row.appendChild(nm); row.appendChild(sn); row.appendChild(ts);
    row.addEventListener("click", () => { mailboxUi.selectedKey = c.key; syncHash(); renderMailbox(); });
    convList.appendChild(row);
  }

  // Infinite-scroll footer + scroll wiring. When the list has conversations
  // we show a trailing row for the load-more state (loading / end / error),
  // and attach a scroll listener that fetches the next cursor page when the
  // user nears the bottom. (task 276b3643)
  if (convs.length) {
    if (mailboxUi.loadingMore) {
      convList.appendChild(el("div", "mb-more", "Loading more…"));
    } else if (mailboxUi.error) {
      convList.appendChild(mailboxRetryRow(mailboxUi.error, () => { loadMoreMailbox().then(render); }));
    } else if (!mailboxUi.cursor) {
      convList.appendChild(el("div", "mb-more", "No more messages"));
    }
  }
  convList.addEventListener("scroll", () => {
    if (mailboxUi.loadingMore || mailboxUi.loading || !mailboxUi.cursor) return;
    if (convList.scrollTop + convList.clientHeight >= convList.scrollHeight - 240) {
      const p = loadMoreMailbox();
      render();        // show the "Loading more…" footer right away
      p.then(render);  // then render the appended page when it lands
    }
  });

  left.appendChild(convList);
  grid.appendChild(left);

  // ── Right pane: conversation thread + compose ─────────────────────────
  const right = el("div", "mb-right");

  const sel = convs.find(c => c.key === mailboxUi.selectedKey);
  if (!sel) {
    const empty = el("div", "card mb-empty");
    empty.appendChild(el("h2", null, "Select a conversation"));
    empty.appendChild(el("div", "empty", "Pick a conversation from the left to see the full thread and compose a reply."));
    right.appendChild(empty);
    grid.appendChild(right);
    main.appendChild(grid);
    convList.scrollTop = prevTop;
    return;
  }

  const selConv = sel;
  // Auto-select the peer as the compose recipient (human↔agent threads).
  if (selConv.msgs.some(m => m.fromId === HUMAN_ID || m.toId === HUMAN_ID)) {
    const sample = selConv.msgs.find(m => m.fromId === HUMAN_ID || m.toId === HUMAN_ID);
    const peer = sample.fromId === HUMAN_ID ? sample.toName : sample.fromName;
    if (peer && compose.to !== peer) compose.to = peer;
  }

  const thread = selConv.msgs.sort((a, b) => a.timestamp - b.timestamp);
  const threadHead = el("div", "mb-thread-head");
  threadHead.appendChild(el("h2", null, selConv.label));
  threadHead.appendChild(el("span", "mb-thread-count", thread.length + " message" + (thread.length === 1 ? "" : "s")));
  right.appendChild(threadHead);

  const threadCard = el("div", "card mb-thread");
  for (const m of thread) {
    const opts = {
      showFrom: m.toId === HUMAN_ID,
      showTo: m.fromId === HUMAN_ID,
      actions: []
    };
    if (m.toId === HUMAN_ID && !m.archived) {
      const replyBtn = el("button", "btn secondary", "Reply");
      replyBtn.addEventListener("click", () => {
        compose.to = m.fromName || m.fromId;
        compose.subject = (m.subject || "").startsWith("Re:") ? m.subject : "Re: " + (m.subject || "");
        compose.body = "";
        syncHash(); renderMailbox();
        const ta = right.querySelector(".compose textarea"); if (ta) ta.focus();
      });
      const archiveBtn = el("button", "btn secondary", "Archive");
      archiveBtn.addEventListener("click", async () => { await post("/api/archive", { id: m.id }); refresh(); });
      opts.actions.push(replyBtn, archiveBtn);
    }
    threadCard.appendChild(messageRow(m, opts));
  }
  right.appendChild(threadCard);

  // ── Compose (reply) ───────────────────────────────────────────────────
  const composeCard = el("div", "card compose");
  composeCard.appendChild(el("h2", null, "Compose (as " + state.human.agentName + ")"));
  const labelTo = el("label", null, "To (agent name or id — leave blank for broadcast)");
  composeCard.appendChild(labelTo);
  const inputTo = el("input"); inputTo.value = compose.to; inputTo.placeholder = "e.g. portal-web-worker";
  composeCard.appendChild(inputTo);
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

  right.appendChild(composeCard);
  grid.appendChild(right);
  main.appendChild(grid);
  convList.scrollTop = prevTop;
}

/** Conversation key for a single message: the peer agent id for human↔agent
 *  threads, or the sorted "fromId|toId" pair for inter-agent threads. */
function convOf(m) {
  if (m.fromId === HUMAN_ID) return m.toId;
  if (m.toId === HUMAN_ID) return m.fromId;
  return [m.fromId, m.toId].sort().join("|");
}
