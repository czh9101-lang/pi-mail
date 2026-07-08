/**
 * Jira REST client + sprint sync (pull) for the pi-mail daemon.
 * Extracted from daemon.mjs. Depends on lib/board.mjs (board state + helpers)
 * and lib/core.mjs (log).
 */

import { log } from "./core.mjs";
import {
  board,
  DEFAULT_JQL,
  jiraCfg,
  findBoardTask,
  findBoardColumn,
  levelFromIssueType,
  taskActivity,
  schedulePersistBoard,
} from "./board.mjs";

// ── Jira client ──────────────────────────────────────────────────────────────

export async function jiraFetch(pathname, { method = "GET", body } = {}) {
  const cfg = jiraCfg();
  if (!cfg) throw new Error("Jira is not configured");
  const auth = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64");
  const res = await fetch(cfg.baseUrl.replace(/\/+$/, "") + pathname, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira ${method} ${pathname.split("?")[0]} → HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const txt = await res.text().catch(() => "");
  return txt ? JSON.parse(txt) : {};
}

/** Extract plain text from an Atlassian Document Format node. */
export function adfToText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const kids = (node.content ?? []).map(adfToText).join("");
  const blocky = ["paragraph", "heading", "listItem", "codeBlock", "blockquote"];
  return blocky.includes(node.type) ? kids + "\n" : kids;
}

export function textToAdf(text) {
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] }));
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [{ type: "text", text: " " }] }],
  };
}

export const JIRA_FIELDS = "summary,description,status,assignee,priority,issuetype,updated,parent,comment";

export async function jiraSearch(jql) {
  const issues = [];
  let pageToken = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ jql, maxResults: "100", fields: JIRA_FIELDS });
    if (pageToken) qs.set("nextPageToken", pageToken);
    const data = await jiraFetch(`/rest/api/3/search/jql?${qs}`);
    issues.push(...(data.issues ?? []));
    if (!data.nextPageToken || (data.issues ?? []).length === 0) break;
    pageToken = data.nextPageToken;
  }
  return issues;
}

/** Transition a Jira issue to the named status. Requires a valid transition. */
export async function jiraTransitionTo(task, statusName) {
  const data = await jiraFetch(`/rest/api/3/issue/${task.key}/transitions`);
  const tr = (data.transitions ?? []).find(
    (t) => (t.to?.name ?? "").toLowerCase() === statusName.toLowerCase()
  );
  if (!tr) {
    throw new Error(
      `no Jira transition to "${statusName}" from "${task.jiraStatus}" (available: ${(data.transitions ?? [])
        .map((t) => t.to?.name)
        .filter(Boolean)
        .join(", ") || "none"})`
    );
  }
  await jiraFetch(`/rest/api/3/issue/${task.key}/transitions`, {
    method: "POST",
    body: { transition: { id: tr.id } },
  });
  task.jiraStatus = statusName;
}

/** @returns {Promise<string | null>} the created Jira comment id */
export async function jiraAddComment(key, text) {
  const r = await jiraFetch(`/rest/api/3/issue/${key}/comment`, {
    method: "POST",
    body: { body: textToAdf(text) },
  });
  return r?.id ?? null;
}

/** Create a Jira issue (optionally a sub-task under parentKey). @returns the new key */
export async function jiraCreateIssue({ projectKey, summary, description, issueType, parentKey }) {
  const r = await jiraFetch("/rest/api/3/issue", {
    method: "POST",
    body: {
      fields: {
        project: { key: projectKey },
        summary,
        issuetype: { name: issueType },
        ...(description ? { description: textToAdf(description) } : {}),
        ...(parentKey ? { parent: { key: parentKey } } : {}),
      },
    },
  });
  return r.key;
}

export async function jiraUpdateIssue(key, { summary, description }) {
  const fields = {};
  if (typeof summary === "string") fields.summary = summary;
  if (typeof description === "string") fields.description = textToAdf(description);
  if (!Object.keys(fields).length) return;
  await jiraFetch(`/rest/api/3/issue/${key}`, { method: "PUT", body: { fields } });
}

/** Mirror Jira comments into the task's activity log (deduped by comment id). */
export function importJiraComments(task, commentField) {
  const comments = commentField?.comments ?? [];
  if (!comments.length) return;
  task.knownCommentIds ??= [];
  for (const c of comments) {
    if (!c?.id || task.knownCommentIds.includes(c.id)) continue;
    task.knownCommentIds.push(c.id);
    const text = adfToText(c.body).trim();
    if (!text) continue;
    task.activity.push({
      ts: Date.parse(c.created) || Date.now(),
      who: `${c.author?.displayName ?? "someone"} (jira)`,
      text,
    });
  }
  task.activity.sort((a, b) => a.ts - b.ts);
  if (task.activity.length > 50) task.activity.splice(0, task.activity.length - 50);
  if (task.knownCommentIds.length > 200) task.knownCommentIds.splice(0, task.knownCommentIds.length - 200);
}

// ── Jira sync loop (pull) ────────────────────────────────────────────────────

export let boardSyncing = false;
export async function syncBoard(reason = "interval") {
  const cfg = jiraCfg();
  if (!cfg || boardSyncing) return;
  boardSyncing = true;
  try {
    const issues = await jiraSearch(cfg.jql || DEFAULT_JQL);
    const have = new Set(issues.map((i) => i.key));

    // Also pull subtasks of matched issues — they usually don't match the
    // sprint/assignee JQL themselves but belong on the board under the parent.
    const parentKeys = [...have];
    for (let i = 0; i < parentKeys.length; i += 50) {
      const chunk = parentKeys.slice(i, i + 50);
      const subs = await jiraSearch(`parent in (${chunk.join(",")})`);
      for (const s of subs) {
        if (!have.has(s.key)) {
          have.add(s.key);
          issues.push(s);
        }
      }
    }

    // Pinned tasks (created in Jira from the board) are synced individually so
    // they stay on the board even when they don't match the JQL. Skip tasks in
    // backlog/archive — those are local-only locations Jira can't see.
    for (const t of board.tasks) {
      if (t.origin !== "jira" || !t.pinned || have.has(t.key)) continue;
      if (t.location === "backlog" || t.location === "archive") continue;
      try {
        const iss = await jiraFetch(`/rest/api/3/issue/${t.key}?fields=${JIRA_FIELDS}`);
        have.add(iss.key);
        issues.push(iss);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) {
          // Deleted in Jira — let the not-seen filter below remove it.
          log(`board sync: pinned ${t.key} was deleted in Jira`);
        } else {
          have.add(t.key); // transient error: keep the task, retry next sync
        }
      }
    }

    const fallbackCol = board.columns.find((c) => c.jiraStatus) ?? board.columns[0];
    const seen = new Set();
    for (const iss of issues) {
      seen.add(iss.key);
      const f = iss.fields ?? {};
      const status = f.status?.name ?? "";
      const mapped = board.columns.find(
        (c) => c.jiraStatus && c.jiraStatus.toLowerCase() === status.toLowerCase()
      );
      let task = board.tasks.find((t) => t.key === iss.key);
      if (!task) {
        task = {
          id: crypto.randomUUID(),
          key: iss.key,
          origin: "jira",
          summary: f.summary ?? iss.key,
          description: adfToText(f.description).trim(),
          url: `${cfg.baseUrl.replace(/\/+$/, "")}/browse/${iss.key}`,
          jiraStatus: status,
          columnId: (mapped ?? fallbackCol)?.id,
          assignee: null,
          priority: f.priority?.name ?? null,
          issueType: f.issuetype?.name ?? null,
          parentId: null,
          parentKey: f.parent?.key ?? null,
          flagged: null,
          knownCommentIds: [],
          updatedAt: Date.now(),
          location: "board",
          level: levelFromIssueType(f.issuetype?.name),
          epicId: null,
          activity: [{ ts: Date.now(), who: "jira", text: `imported from Jira (status: ${status})` }],
        };
        board.tasks.push(task);
      } else {
        task.summary = f.summary ?? task.summary;
        task.description = adfToText(f.description).trim();
        task.priority = f.priority?.name ?? task.priority;
        task.issueType = f.issuetype?.name ?? task.issueType;
        task.parentKey = f.parent?.key ?? task.parentKey ?? null;
        // Remote status change wins: move the card to the mapped column, even
        // out of a board-only column. Unchanged remote status leaves any local
        // (board-only) position alone. Backlog/archive are local-only locations
        // — a Jira status change does NOT pull a task out of them (the operator
        // decides placement via the board).
        if (status && status !== task.jiraStatus && task.location === "board") {
          task.jiraStatus = status;
          if (mapped) task.columnId = mapped.id;
          taskActivity(task, "jira", `Jira status changed → ${status}`);
        } else if (status && status !== task.jiraStatus) {
          // Task is in backlog/archive; record the remote status change without
          // relocating it.
          task.jiraStatus = status;
          taskActivity(task, "jira", `Jira status changed → ${status} (kept in ${task.location})`);
        }
      }
      importJiraComments(task, f.comment);
    }
    // Link subtasks to their board parent (by Jira key) for the UI/tools.
    const byKey = new Map(board.tasks.filter((t) => t.key).map((t) => [t.key, t]));
    for (const t of board.tasks) {
      if (t.parentKey && !t.parentId) t.parentId = byKey.get(t.parentKey)?.id ?? null;
    }
    // Drop Jira tasks that left the sprint / no longer match the JQL.
    const before = board.tasks.length;
    board.tasks = board.tasks.filter((t) => t.origin !== "jira" || seen.has(t.key));
    if (board.tasks.length !== before) {
      log(`board sync: removed ${before - board.tasks.length} task(s) no longer in the sprint`);
    }
    board.lastSync = Date.now();
    board.syncError = null;
    schedulePersistBoard();
  } catch (e) {
    board.syncError = e?.message ?? String(e);
    log(`board sync failed (${reason}): ${board.syncError}`);
  } finally {
    boardSyncing = false;
  }
}

