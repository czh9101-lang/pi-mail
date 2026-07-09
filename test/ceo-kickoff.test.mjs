// Tests for the CEO kickoff's "tool usage" mandate (task 62386ffc).
//
// The CEO must use its tools (board_list_tasks, mail_spawn_agent, mail_send,
// mail_stop_self) for every action and must NEVER hand-parse JSON or fabricate
// tool I/O. These assertions pin that mandate directly against ceoKickoff()
// — no daemon, no tmux, no network — so the contract holds regardless of the
// surrounding CEO-config plumbing (which is tested separately in ceo.test.mjs).
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { ceoKickoff } from "../extensions/lib/ceo.mjs";

const KICKOFF = ceoKickoff(["/tmp/managed-proj"]);

test("ceoKickoff names the favorited project + group (no regression)", () => {
  assert.ok(KICKOFF.includes("/tmp/managed-proj"), "kickoff names the project cwd");
  assert.ok(KICKOFF.includes("group: managed-proj"), "kickoff names the project group");
});

test("ceoKickoff requires using tools for every action (62386ffc)", () => {
  assert.match(KICKOFF, /you MUST use your tools/i, "kickoff explicitly requires tool use");
  // Every tool the CEO is allowed to use is named in the kickoff.
  for (const tool of ["board_list_tasks", "mail_spawn_agent", "mail_send", "mail_stop_self"]) {
    assert.ok(KICKOFF.includes(tool), `kickoff names the ${tool} tool`);
  }
  // Spawning an MM is the CEO's escalation mechanism — must stay (a64c902d sliver:
  // "document the tool better so the CEO knows to email the agent after spawning").
  assert.match(KICKOFF, /mail_spawn_agent.*mm: true|spawn.*middle manager/i, "kickoff documents spawning an MM via mail_spawn_agent({ cwd, mm: true })");
});

test("ceoKickoff forbids hand-parsing JSON + fabricating tool I/O (62386ffc)", () => {
  assert.match(KICKOFF, /never hand-parse JSON/i, "kickoff forbids hand-parsing JSON");
  assert.match(KICKOFF, /fabricate tool I\/O/i, "kickoff forbids fabricating tool I/O");
  // Concrete anti-patterns are called out so the CEO can't interpret around the rule.
  assert.match(KICKOFF, /JSON\.parse/i, "kickoff calls out JSON.parse as forbidden");
  assert.match(KICKOFF, /do not.*invent.*tool.*output|never.*fabricate/i, "kickoff forbids inventing tool output");
  assert.match(KICKOFF, /ACTUALLY returned|actually returned/i, "kickoff requires acting only on real tool output");
});

test("ceoKickoff still instructs mailing human + self-exit (no regression)", () => {
  assert.ok(KICKOFF.includes("human"), "kickoff instructs mailing human");
  assert.ok(KICKOFF.includes("mail_stop_self"), "kickoff instructs calling mail_stop_self");
  assert.match(KICKOFF, /no.*task administration|do not.*move|do not.*archive/i, "kickoff still forbids task administration");
});
