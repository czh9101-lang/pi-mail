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

## Setup

This is a pi package that bundles the extension **and** the `mail-orchestrator`
skill. Install it like any other package:

```bash
pi install ./pi-mail                                 # local path
# or, once published:
pi install git:github.com/<user>/pi-mail
pi install npm:pi-mail
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
- Starting a task → `"implementing X in repo Y (issue PBD-123)"`
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
  - Task start: `mail_set_status "implementing auth refactor (PBD-456)"`
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
│   └── daemon.mjs                    Singleton daemon (plain Node.js, no build step)
├── skills/
│   └── mail-orchestrator/SKILL.md    Orchestrator skill, shipped with the plugin
└── README.md                         This file
```
