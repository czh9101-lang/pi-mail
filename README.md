# pi-mail — federated agent mail

A `pi` extension that lets multiple pi agent processes communicate via a
shared mailbox daemon. Peer-to-peer federation — no central authority required.

## Architecture

```
  pi (agent-a)        pi (agent-b)        pi (agent-c)
      │                   │                   │
      └──────┬────────────┴──────┬────────────┘
             │                  │
       [mail-daemon]  ←  singleton process
       ~/.pi/agent/mail-daemon.sock
```

- **Daemon** (`daemon.mjs`) — auto-started when the first pi process loads the
  extension. Singleton (Unix socket). Manages the agent registry and all
  mailboxes. Survives individual agent restarts.
- **Extension** (`index.ts`) — loaded by every pi process. Registers on
  `session_start`, unregisters on `session_shutdown`.
- **Heartbeat** — daemon pings every 5 s; no pong = agent removed from registry.
  Mailbox is preserved for reconnect. Only a clean exit (`unregister`) clears it.
- **Buffering** — outgoing messages are buffered when the socket is temporarily
  unavailable and flushed automatically on reconnect.
- **Web UI** — the daemon also serves an HTTP console (default `0.0.0.0:1994`) so
  a human operator can browse the federation, read per-agent mail history, and
  send or broadcast mail as a first-class `human` agent. See [Web UI](#web-ui).

## Web UI

The daemon hosts a dependency-free single-page web console alongside the Unix
socket. Open it in a browser:

```
http://localhost:1994
```

### Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `PI_MAIL_UI_PORT` | `1994` | TCP port for the web UI |
| `PI_MAIL_UI_HOST` | `0.0.0.0` | Bind address (use `127.0.0.1` to restrict to localhost) |

The UI starts with the daemon and is non-fatal if the port is taken — the mail
federation keeps working regardless. Restart the daemon to apply changes:

```
/restart-mail-daemon
```

### The `human` agent

The UI acts as a fixed virtual agent named `human` (well-known id
`00000000-0000-0000-0000-000000000000`). It has no live socket of its own —
its inbox is the slice of the persisted message history addressed to it.

- The human appears in `mail_list_agents`, so agents can discover it and reply
  to your messages by sending to `human`.
- Broadcasts are copied to the human's inbox so the operator sees everything.
- Mail you send through the UI is delivered to agents exactly like agent-to-agent
  mail (including the `newSession` flag, which starts a fresh session on the
  recipient).

### How agents reply: mail channel vs direct TUI

Agents can tell whether the task they're working on arrived via mail or
through the TUI you're driving directly:

- **Mail-driven task** (a `📬 Mail` message from `human` or another agent is in
  the agent's context): the agent replies via `mail_send` to the sender when
  done, and asks questions via `mail_send` instead of `ask_user_question` —
  because no one is at the TUI to answer a prompt. Your reply lands back in the
  web UI inbox.
- **Direct TUI task** (you're typing to the agent in the terminal): the agent
  responds in place and does **not** send mail for that task; `ask_user_question`
  works as normal.

The extension signals this to the agent each turn via a `## Current task
channel:` header in the system prompt (`mail` or `direct (TUI)`), and the
mail-orchestrator skill documents the same rule. So when you dispatch a task
from the web UI, you can expect the result back as mail — and when you're
pairing in the terminal, the agent stays in the terminal.

### Views

1. **Agents** — live table of every connected agent: name, project (cwd),
   status, context saturation, model, uptime, id. Auto-refreshes every 3 s.
2. **My Mailbox** — your inbox (mail addressed to `human`, archiveable), your
   outbox (mail you sent, with broadcasts grouped), and a compose form to send
   to a named agent or broadcast to all.
3. **History** — pick any agent and see the full history of mail delivered to
   it (direct + broadcast, including archived messages).

### Persistence

The full message history (the UI's source of truth) is persisted to
`~/.pi/agent/mail-daemon.history.json` and survives daemon restarts. Live agent
mailboxes remain in-memory with their existing reclaim-on-reconnect semantics.

### HTTP API

The SPA talks to a tiny JSON API you can also call directly:

| Method & path | Body | Returns |
|---------------|------|---------|
| `GET /api/state` | — | `{ human, agents[], messages[] }` — full snapshot |
| `POST /api/send` | `{ to, subject, body, newSession? }` | `{ ok, messageId? \| error? }` |
| `POST /api/broadcast` | `{ subject, body }` | `{ ok, recipients }` |
| `POST /api/archive` | `{ id }` | `{ ok }` — archives a message in the human inbox |


## Setup

This is a pi package that bundles the extension **and** the `mail-orchestrator`
skill. Install it like any other package:

```bash
pi install git:github.com/tanevanwifferen/pi-mail    # from GitHub
pi install ./pi-mail                                 # from a local clone
```

Installing registers the mail extension (tools + commands) and makes the
`mail-orchestrator` skill available automatically — no separate skill copy
needed.

## Commands

| Command | Description |
|---------|-------------|
| `/mail-name [name]` | View or set your display name in the federation |
| `/mail-status` | Show connection status and unread count |
| `/new-task [prompt]` | **Start a fresh session** (clears context). Optional kickoff prompt. |
| `/prune-agents [seconds]` | Probe all agents, remove ones that don't reply within N s (default 15) |
| `/restart-mail-daemon` | Kill the daemon and reconnect (spawns a fresh one) |

## Tools (callable by the LLM)

| Tool | Description |
|------|-------------|
| `mail_list` | List inbox messages |
| `mail_read <id>` | Read a message in full |
| `mail_send` | Send to a named agent — see parameters below |
| `mail_broadcast` | Send to all connected agents |
| `mail_mark_read <id>` | Archive a message |
| `mail_list_agents` | List agents with status, context %, and uptime |
| `mail_set_name <name>` | Set your display name |
| `mail_set_status <status>` | Set your status line (empty string clears it) |

### mail_send parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `to` | string | Recipient name or agent ID |
| `subject` | string | Subject line |
| `body` | string | Message body |
| `newSession` | boolean? | **If `true`: the receiving agent will start a fresh session (cleared context) before acting on this message.** Use when sending an unrelated new task. |

## Orchestrator guide

### Sending a new unrelated task to an agent

```json
mail_send({
  "to": "agent-name",
  "subject": "Task: implement feature X",
  "body": "Detailed instructions...",
  "newSession": true
})
```

The agent automatically:
1. Archives this message
2. Waits until idle (followUp delivery)
3. Opens a fresh session with the body as the first prompt

Do **not** use a special subject convention — use the `newSession` flag.

### Checking agent state

```json
mail_list_agents()
```

Returns per agent: name, id, uptime, context saturation (`ctx=34%`), status.

### Status conventions (expected from agents)

Agents update `mail_set_status` automatically when:
- Starting a task → `"implementing X in repo Y (issue-123)"`
- Shifting focus → updated description
- Going idle → `"idle"` or empty

The orchestrator should rely on these statuses to decide whether an agent is
available for new work.

### Pruning dead sessions

If `mail_list_agents` shows more agents than expected:

```
/prune-agents 20
```

Broadcasts a probe, waits 20 s, then removes agents that didn't respond.

## Agent guide

### Identity and status

- Set a **descriptive name** with `mail_set_name` (e.g. `"portal-web-worker"`).
  Default names are auto-generated slugs.
- **Keep status current** — the orchestrator reads it to coordinate work:
  - Task start: `mail_set_status "implementing auth refactor (issue-456)"`
  - Shift: update to new action
  - Done/idle: `mail_set_status ""` or `"idle"`

### Context window saturation

`mail_list_agents` shows `ctx=N%` per agent — updated after each LLM turn.
When an agent's context is near full the orchestrator may send a `newSession`
message to reset it before the next task.

### Session lifecycle on reload

Agent IDs are persisted in the session so `/reload` reuses the same ID.
The daemon treats it as a reconnect (no duplicate registration).

## Files

```
pi-mail/                              Package root
├── package.json                      pi manifest (extensions + skills)
├── extensions/
│   ├── index.ts                      Extension entry point (TypeScript, loaded via jiti)
│   ├── daemon.mjs                    Singleton daemon (plain Node.js, no build step) — also serves the web UI
│   └── ui.html                       Web UI single-page app (served by the daemon)
├── skills/
│   └── mail-orchestrator/SKILL.md    Orchestrator skill, shipped with the plugin
└── README.md                         This file
```
