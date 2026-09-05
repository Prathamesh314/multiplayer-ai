# multiplayer-ai

A collaborative, browser-based IDE where several people and several AI coding
agents work in the same repository at the same time. Each "room" is a live
workspace with a file explorer, a code editor, a terminal, a team chat, and an
AI panel. Humans edit files while AI agents (Claude Code, Codex, Gemini) run
against the same working copy, and everyone sees the changes stream in as they
happen.

The guiding idea is that collaboration state is **git**, not a shared mutable
document: every change — human or agent — is committed, so the history is real,
conflicts are resolved by merge, and any room can be forked or merged like a
branch. `ARCHITECTURE.md` documents the load-bearing decisions in depth; this
file is the overview.

## Core concepts

- **Organization → Project → Room.** An organization holds projects; a project
  has one canonical repository (its shared `main`); a room is a fork of that
  project that people and agents work in. Access is role-based, with invitations
  and share links.
- **Room = branch.** Opening a room checks out its own working copy on a
  `session/<id>` branch. Publishing a room merges its work back onto the
  project's `main`; syncing pulls `main` back into the room.
- **Runs.** A single agent turn is a "run": a prompt, the agent's streamed
  thinking/tool-activity/reply, and the commit it produces. Runs are durable —
  they persist as a conversation others can watch and continue.

## How it works

### State is git, never a snapshot
The persistent state of a room is a set of git coordinates
(`repo_url · branch · head_sha`), not a filesystem image. Agent turns auto-commit
at the turn boundary; human editor edits are committed on a short debounce.
Working copies under the data root are a rebuildable cache — deleting them never
loses a session. See `ARCHITECTURE.md` for why rooms are separate per-room repos
rather than one shared checkout.

### Agents are local CLIs, driven one prompt at a time
An agent run spawns the vendor CLI (`claude`, `codex`, or `gemini`) in one-shot
mode against the room's working copy. The app reuses the machine's existing CLI
login rather than handling API keys itself. The CLI's stdout is parsed into a
live stream of three kinds of output — reply, thinking, and tool activity — sent
to the browser as newline-delimited JSON. Whatever the agent changed is committed
when the run ends.

By default a run executes inline in the web server. When `AGENT_WORKER=1` (and
Redis is configured), runs are instead enqueued and executed by a separate worker
process, so a heavy or runaway agent never degrades the shared web server. The
client sees the same stream either way. The web and worker tiers can also run as
containers sharing one volume — see `docker/README.md`.

### Real time over Server-Sent Events
Live updates (file saved, someone is typing, run output, presence) are broadcast
to watchers over SSE, because the traffic is entirely server-to-client. Presence
and multiplayer cursors ride the same event layer. Concurrent edits to the same
file are reconciled with a three-way git merge rather than an OT/CRDT layer; a
true conflict surfaces to the editor instead of being silently overwritten.

### Semantic shared memory (optional)
An optional sidecar (`mnemosyne`) gives the agents cross-room memory. Each room
has a memory "bank"; a completed run's exchange is remembered there, and at the
start of a run the most relevant memories across the rooms a user can see are
recalled and woven into the prompt. A consolidation ("sleep") pass distills raw
exchanges into durable canonical facts. When the sidecar is not configured, the
app skips recall and ingest and falls back to plain fork / `@room/chat` context.

### Graceful degradation
Optional infrastructure fails open. Redis powers presence, the live event bus,
and the run queue when present; without it the app runs single-process with an
in-memory bus. The memory sidecar is skipped entirely when absent. The product
works with nothing but Postgres and the app itself.

## Typical workflows

- **Collaborate in a room.** Open a room, browse and edit files in the editor,
  use the terminal, and chat with the team. Edits commit automatically; other
  members see them live.
- **Run an agent.** Write a prompt in the AI panel, pick an agent and model, and
  watch it think, use tools, and edit files in real time. The result is committed
  and recorded as a run others can open and continue.
- **Reference other chats.** Mention another room or run with `@room/<id>` to
  pull its relevant context into the current prompt.
- **Publish / sync.** Merge a room's work up to the project's `main`, or pull the
  latest `main` down into a room. Conflicts abort cleanly and are reported.
- **Develop the app.** `./start.sh` brings up the backing services, applies
  migrations, and starts the dev server in one command.

## Technology

| Area | Choice |
| --- | --- |
| Web / API | Next.js (App Router) with React; the repo pins a specific Next build — read `AGENTS.md` before changing framework code |
| Language | TypeScript |
| Database | PostgreSQL (session/run/org metadata; git holds the code itself) |
| Real time | Server-Sent Events; Redis pub/sub across processes, in-memory otherwise |
| Queue | BullMQ on Redis for the decoupled agent-run and memory-consolidation workers |
| Terminal | node-pty + xterm.js |
| Agents | Claude Code, Codex, and Gemini CLIs, run locally |
| Memory | `mnemosyne` sidecar over MCP (optional); LiteLLM to reach Claude for consolidation |
| Desktop | Electron shell around the same app |
| Styling | Tailwind CSS |
| Local services | Docker Compose (Postgres, Redis, pgAdmin, the sidecar) |

## Repository layout

```
app/
  api/            HTTP + streaming endpoints (auth, orgs, projects, sessions, runs, ai, terminal)
  components/     UI, including components/workspace/ (the room IDE)
  lib/            server + shared logic
    session/      git-native room repos, working copies, locks
    ai/           agent catalog, run execution, streaming, memory
    queue/        BullMQ run + consolidation queues
    events/       SSE event bus (Redis / in-memory)
    presence/     who is online (Redis / in-memory)
    project/, org/, auth/, terminal/
worker/           standalone worker process (agent runs, memory consolidation)
db/               SQL migrations + runner
docker/           Dockerfiles and compose service configs
desktop/          Electron entry point
ARCHITECTURE.md   the load-bearing design decisions
docker/README.md  host vs. containerized run topologies
```

## Getting started

Prerequisites: Node.js, Docker (for the local services), and at least one agent
CLI installed and signed in (for example `claude`).

```bash
cp .env.example .env      # optional; sensible dev defaults are built in
./start.sh                # services -> migrations -> dev server
```

Then open http://localhost:3000. Other entry points:

```bash
./start.sh services       # just the backing services; start the app yourself
npm run dev               # the Next.js dev server on its own
npm run worker            # the background worker (agent runs / consolidation)
npm run start             # the Electron desktop app
npm test                  # the test suite
```

Configuration is read from `.env` — see `.env.example` for every setting,
including `REDIS_URL`, `AGENT_WORKER`, the memory sidecar, and memory
consolidation. Anything optional is off by default and degrades gracefully.
