# Local execution: running agents on the user's machine

> Live updates and queued follow-up messages are implemented; see
> [live chat queues](live-chat-queues.md) for the current push protocol and provider limits.
>
> Implementation update: hosted Compose now requires users' own runners and
> disables server fallback. Runners use persistent room/repository worktrees,
> at `~/multicode-ai/workspaces/<repository>/<room>`, sharing a local cache
> across rooms using the same explicitly selected project repository. The historical
> design below includes earlier clone/fallback proposals; see
> [runner workspaces](runner-workspaces.md) and [deployment](../docker/README.md)
> for the current lifecycle, safety rules, and configuration. Parallel chats
> add a worktree per chat and concurrent turns per runner; see
> [parallel chats](parallel-chats.md).

The plan for moving agent execution off our servers and onto each member's
computer — Conductor's economics inside a multiplayer product. The web app we
have today becomes the **control plane**; a **runner** on the user's machine
becomes the execution plane; between them sits the **communication layer**
this document specifies. The desktop app is the final product; the runner is
the reason it exists.

## 1. The two planes

**Cloud control plane** (the current app, hosted by us — what customers pay for):
identity and orgs, rooms and transcripts, the knowledge layer (memory, repo
context, routing), canonical project repos, publish/sync, presence, billing.
Nothing here spawns an agent.

**Local execution plane** (the runner, on each member's machine):
receives run jobs addressed to *its user*, materializes the repo locally,
spawns the agent CLI with the *user's own* login (`~/.claude`, exactly what
the server borrows today via PR #17 — but now it is genuinely theirs),
streams output up, commits and pushes the result back.

Their CPU, their memory, their API limits. Our server never pays for
inference or spawns arbitrary code on our hardware.

## 2. Why the current design makes this an evolution, not a rewrite

Three standing decisions are the seams this plan cuts along:

1. **Sessions are git, not snapshots.** A run needs only `clone + checkout
   <sha>` — so an agent can execute anywhere the repo can reach, not just on
   the server's filesystem. (ARCHITECTURE.md already names server-local
   execution a deliberate, temporary ceiling.)
2. **Runs are plain-data jobs.** `AgentRunJob` crosses a queue already;
   `executeAgentRun` is an isolated core with an `onEvent` callback. Moving it
   to another machine changes *where* it runs, not *what* it is.
3. **Run output already travels over a bridge.** The worker publishes NDJSON
   events onto a per-run Redis channel (`run-stream.ts`) and the web route
   forwards them to the browser. A runner on someone's laptop is just a more
   distant worker; the browser contract does not change at all.

## 3. The communication layer

Users' machines sit behind NAT — the server can never connect *to* them, so
every link is dialed *out* by the runner. v1 uses only primitives the stack
already ships (SSE + streaming HTTP, both proven in this codebase); a
WebSocket gateway is a later optimization, not a prerequisite.

```
┌─────────── user's machine ───────────┐        ┌──────────── our cloud ────────────┐
│  Desktop app (Electron)              │        │  Next.js control plane            │
│  ├─ web UI → APP_URL (cloud)         │        │  ├─ run route (assembles prompt,  │
│  └─ runner daemon                    │        │  │   routes job, streams to UI)   │
│     ├─ 1. SSE  /api/runner/feed ◄────┼────────┤  ├─ runner API (feed/claim/events)│
│     ├─ 2. POST /api/runner/claim ────┼───────►│  ├─ git smart-HTTP (/api/git/…)   │
│     ├─ 3. git fetch/push  ───────────┼───────►│  ├─ Redis: per-run stream channel │
│     ├─ 4. spawn agent CLI (local)    │        │  └─ Postgres: runs, devices,      │
│     ├─ 5. POST …/events (NDJSON up) ─┼───────►│      transcripts, knowledge       │
│     └─ 6. POST …/complete ───────────┼───────►│                                   │
└──────────────────────────────────────┘        └───────────────────────────────────┘
```

### 3.1 Pairing and identity

- A user pairs a device from the web app: **Settings → Devices → “Pair this
  computer”** issues a one-time pairing code; the runner exchanges it for a
  long-lived **device token** (random 256-bit, stored hashed — same pattern as
  `auth_tokens`). Table:

  ```sql
  CREATE TABLE runner_devices (
    id           uuid PRIMARY KEY DEFAULT new_id(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         text NOT NULL,              -- "Prathamesh’s MacBook Pro"
    token_hash   bytea NOT NULL UNIQUE,
    platform     text,
    version      text,                       -- runner build, for forced upgrades
    last_seen_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz
  );
  ```

- Device tokens authenticate **only** the runner API and the git endpoint —
  never the normal web session surface. Revocable from the web UI; revocation
  kills the feed connection on next heartbeat.

### 3.2 Job routing (local-first, cloud-fallback)

The run route keeps doing everything it does today up to job creation
(access, cost gate, knowledge recall, prompt assembly — all server-side).
Then, instead of one shared queue:

1. If the **initiating user** has a device with `last_seen_at` within 30s →
   insert the job as `agent_runs.execution = 'local'`, `status = 'queued'`,
   notify that user's feed channel.
2. The runner **claims** it: `POST /api/runner/claim {jobId}` → atomic
   `UPDATE … SET assigned_device_id, lease_expires_at WHERE status='queued'
   RETURNING` — two devices racing get exactly one winner. The lease renews
   with heartbeats; a reaper requeues expired leases.
3. No online device (or claim not made within 10s) → **fallback**: the job
   goes to the existing server worker queue (`execution = 'server'`), subject
   to the org's cloud limits. Fallback is a paid-plan feature (see §6); free
   orgs get a clear "open your desktop app to run agents" error instead.
4. The browser's stream is unchanged: the run route already subscribes to the
   per-run Redis channel before enqueueing; local and server execution are
   indistinguishable to the UI except for a "ran on Prathamesh's MacBook"
   badge worth adding.

New columns: `agent_runs.execution text NOT NULL DEFAULT 'server'`,
`assigned_device_id uuid`, `lease_expires_at timestamptz`.

### 3.3 The runner protocol (all endpoints device-token-authed)

| Endpoint | Direction | Purpose |
|---|---|---|
| `GET  /api/runner/feed` | SSE down | Long-lived: job-available notices, cancel notices, config, "please upgrade" |
| `POST /api/runner/claim` | up | Atomically claim a job; returns the full `AgentRunJob` + repo ref + base SHA |
| `POST /api/runner/runs/:id/events` | up | Ordered NDJSON event frames (`out`/`think`/`act`/`err`), batched ≤250ms; server republishes verbatim onto the run's Redis channel |
| `POST /api/runner/runs/:id/complete` | up | Terminal report: exit code, result SHA (after push), captured output; server does **all** persistence |
| `POST /api/runner/heartbeat` | up | Presence + lease renewal + version |
| `GET/POST /api/git/:repoRef/…` | both | Git smart-HTTP (below) |

Design rule: **the runner is dumb and stateless.** It never writes our
database, never assembles prompts, never touches the knowledge layer. It
reports facts; the server persists turns, finishes the run, computes diff
stats, ingests memory (approval-gating unchanged), and emits room events.
This keeps trust narrow and lets us evolve the schema without shipping a
runner update.

### 3.4 Repo transport: git smart-HTTP

The server exposes its bare repos over git's smart-HTTP protocol:

- `GET /api/git/:repoRef/info/refs?service=…`, `POST …/git-upload-pack`,
  `POST …/git-receive-pack` — implemented by piping the request through
  `git upload-pack / receive-pack --stateless-rpc <barePath(repoRef)>`
  (spawned per request; the request body streams to stdin, stdout streams
  back). `repoRef` is a session id or a `room_repos` id — the same id-is-the-
  repo-handle invariant the whole git layer already lives by.
- **Authorization:** the device's user must have write access to the room the
  ref belongs to. Enforced before spawning git, using the same `access`/role
  checks as the file routes.
- **Push discipline:** a pre-receive check confines pushes to the repo's own
  session branch, fast-forward from the job's `baseSha` only. The server
  updates `head_sha` after `complete` *and* after verifying the reported SHA
  exists in the bare repo — the runner cannot claim a commit it didn't push.
- The runner keeps a local mirror per repoRef (`~/.multiplayer-ai/repos/…`),
  so subsequent runs fetch deltas only. Working copies are disposable, as on
  the server.

### 3.5 Execution core: one implementation, two hosts

Extract the spawn/stream/commit core of `app/lib/ai/execute.ts` into
`packages/agent-runtime` (plain TS, no Next/DB imports): agent catalog args,
process spawn + group-kill, output caps, stream parsing. The server worker
and the desktop runner both consume it, so behavior (caps, timeouts, commit
messages) can never drift between cloud and local execution. What stays out:
DB persistence and events (server-only), replaced in the runner by the
protocol calls above.

### 3.6 Security model (this is remote → local code execution; treat it as such)

- **Prompts execute only on their author's machine.** Routing is keyed by the
  *sender* of each turn, not the run's starter: your prompt goes to your own
  device (or the cloud), even when you co-drive a teammate's run. Nobody
  else's words ever execute on your hardware — the consent question answers
  itself structurally, with no setting to get wrong.
- Runner works only inside its own workspace directory; the tray UI shows
  what is running and offers per-run kill. (Agents can still touch the
  machine — the same trust model Conductor ships with; we say so plainly.)
- Device tokens: hashed at rest, narrow surface, revocable, listed with
  last-seen in the web UI.
- Job payloads contain only what the run needs (prompt already assembled;
  no other rooms' content).
- Version handshake: the server can refuse runner versions with known holes.

## 4. What changes in the product

- **Desktop app** (`desktop/`): grows from "Electron shell that boots a local
  server" into: web UI pointed at the cloud (`APP_URL` — the hook already
  exists), plus the runner daemon with a tray widget (online status, current
  run, device name, pause). Also ship the runner headless (`npx
  multiplayer-runner`) for servers/power users — same protocol.
- **Org concurrency caps** (`0/3 running`) apply to **cloud fallback only**.
  Local runs are uncapped — the whole point. The badge splits: "2 running
  locally · 0/3 cloud".
- **Knowledge layer:** untouched. Recall and ingest are control-plane work
  and stay server-side; publish-gated memory approval is unchanged because
  publish still lands on the server's canonical repo.

## 5. Build order (each phase ships and is testable alone)

| Phase | Deliverable | Proof it works |
|---|---|---|
| **0. Devices + pairing** ✅ *(shipped — runtime extraction moved to phase 2)* | `runner_devices`/`runner_pairing_codes` + `agent_runs` execution columns (migration 021); pairing, devices, heartbeat API (`app/api/runner/*`, `app/lib/runner/devices.ts`); Connect-your-AI onboarding gate incl. local models via Ollama | Schema tests (52 green); live curl: pair rejects bad codes, heartbeat authenticates and 401s revoked tokens |
| **1. Git over HTTP** ✅ *(shipped)* | Smart-HTTP endpoint (`app/api/git/[repoRef]/…`) with device auth, room-role authz (`app/lib/runner/git-access.ts`), denyNonFastForwards + denyDeletes | Live against `next dev`: clone + push round-trip succeeded; no/wrong token refused; force-push and branch deletion rejected by the server |
| **2. Runner protocol** ✅ *(shipped)* | `runner_jobs` queue (migration 022) with atomic SKIP LOCKED claim; long-poll claim (a v1 simplification of the SSE feed — sub-2s delivery, proxy-proof), events up-stream onto the per-run channel + watcher bus, `/complete` with commit verification (`verifyPushedCommit`); local-first routing in the run route with a 20s atomic reclaim to the cloud path; shared finalization (`app/lib/ai/finalize.ts`) | Live simulated runner: claim → smart-HTTP clone → push → events → complete; driver stream byte-identical to a worker run incl. verified exit; runner-sent `exit` filtered; foreign-run events 404; unclaimed job reclaimed with notice + cloud dispatch |
| **3. Headless runner** ✅ *(shipped)* | `runner/` CLI (`npm run runner -- pair\|start [--once]`): config with 600-perm token file, heartbeat loop, long-poll claim, smart-HTTP repo cache, agent spawn reusing the catalog + stream parsers with executor-equivalent caps, 250ms event batching, commit/push, completion report; diff stats moved to the bare repo (`diffStatBare`) so locally-pushed commits count | Live: a real `claude` run claimed by the real CLI — paired via `runner pair`, cloned, executed on the machine's own login, streamed start/act/think/out frames to the driver, pushed its commit, `/complete` verified; file content confirmed in the room's repo |
| **4. Desktop integration** ✅ *(shipped — packaging/icons remain)* | "Your computers" dialog (list/liveness/revoke + pair-this-computer with minted code and copyable command, completion shows itself); profile-menu entry; Electron supervises the runner when paired with a tray (state glyph on macOS, pause/resume, pair entry); consent is structural — sender-keyed routing (§3.6) | Live API round-trip: mint → `runner pair` → device online in list → revoke → runner's next request 401s; UI verified by typecheck; tray needs a manual desktop click-through |
| **5. Monetize** | Stripe plans; cloud-fallback metering; per-plan gates; cap badge split | Billing round-trip in test mode |

Honest sizing: phases 0–2 are the engineering heart (~2–3 weeks of focused
work), 3 is ~1 week, 4 is UI-heavy (~1–2 weeks), 5 depends on billing scope.

## 6. How this earns money

The runner inverts our cost curve: inference and compute — the expensive,
usage-proportional part — moves to hardware and API accounts the customer
already owns. What we sell is the coordination that has no local substitute:

- **Free:** solo/small org, local execution only, basic memory. The desktop
  app is genuinely useful free — that is the acquisition engine.
- **Team (per seat):** the multiplayer core — shared knowledge layer, org
  admin, private rooms, room visibility, priority features.
- **Cloud fallback (metered or bundled):** runs still execute when the
  laptop is closed — kick off a run from your phone, a teammate's machine is
  off, CI-style automation. This is the *only* place our compute is spent,
  which is exactly why it can be priced.
- **Enterprise later:** SSO, audit, self-hosted control plane, policy
  controls on what runners may execute.

Margin logic: seats scale with people (near-zero marginal cost to us once
execution is local); cloud minutes are priced above cost as a convenience,
not subsidized as the default.

## 7. Risks and open questions

- **NAT/proxy realities:** SSE through corporate proxies is battle-tested but
  not universal; the WS gateway upgrade path exists if feed reliability
  disappoints. Runner must reconnect with jittered backoff and reconcile
  claimed-but-unreported runs on reconnect.
- **Clock/lease tuning:** lease + reaper windows need real-world tuning so a
  sleeping laptop fails over fast without double-executing (claim atomicity
  prevents double-*claim*; the reaper must never requeue a run whose events
  are still arriving).
- **Large repos:** first clone of a big repo over smart-HTTP is slow; mirror
  cache mitigates every run after the first. Consider shallow clone at
  `baseSha` for first materialization.
- **CLI availability on user machines:** the runner must detect missing
  agent CLIs / logins and surface actionable errors into the run stream
  (the catalog's install/login status checks already exist server-side —
  reuse them locally).
- **Windows:** process-group kill and pty behavior differ; phase 3 targets
  macOS/Linux first, Windows in phase 4.
