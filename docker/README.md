# Running multiplayer-ai: the two topologies

There are two ways to run this app, and they differ in exactly one place: **where
an agent run executes.** Everything else — Postgres, Redis, the Mnemosyne memory
sidecar — is the same backing stack either way.

|                         | **Local DX** (default)                | **Staging / Prod** (`--profile app`)        |
| ----------------------- | ------------------------------------- | ------------------------------------------- |
| Web server              | host (`npm run dev`, HMR)             | `web` container (`next start`)              |
| Agent runs              | inline **or** host worker            | `worker` container, off the queue           |
| Command                 | `./start.sh`                          | `docker compose --profile app up --build`   |
| Git state lives on      | host filesystem (`./.multiplayer-ai`) | named volume `workspace_data`               |
| What starts by default  | services only (`docker compose up`)   | services **+** `web` **+** `worker`         |

The two coexist: `docker compose up` (no profile) brings up only the backing
services — that's what `./start.sh` uses. The `web` and `worker` containers are
behind the `app` profile, so they never start unless you ask for them.

---

## 1. Local DX — `./start.sh`

The day-to-day path. The web server runs on the host so Next's hot-module reload
stays fast; containerizing the dev server would drag file-watching across the VM
boundary and make edits laggy. Docker here only provides Postgres, Redis,
pgAdmin, and Mnemosyne.

```bash
./start.sh              # services → migrate → dev server (Ctrl+C stops)
./start.sh services     # just the services, start the app yourself
./start.sh down         # stop services, keep data
```

**Runs are inline by default.** Set `AGENT_WORKER=1` in your `.env` to route them
to a host worker instead; `start.sh` then starts `npm run worker` alongside the
dev server and tears it down with it (SIGTERM, so BullMQ drains the in-flight
job). On one host, web and worker share the same `MULTIPLAYER_AI_DATA` directory
for free — there is no volume to arrange.

> Why `AGENT_WORKER` is its own switch and not just "is Redis set": `REDIS_URL` is
> on by default for presence. Keying run execution off Redis alone would silently
> make a worker mandatory the moment anyone enabled presence — and with no worker
> running, every run would hang. The flag keeps the two concerns independent.

---

## 2. Staging / Prod — `docker compose --profile app up`

Both tiers run in containers and talk over the queue, exactly as production
would.

```bash
docker compose --profile app up --build
# then open http://localhost:3000
```

Open it on **`localhost`** specifically — see the terminal-guard note below.

A turn now flows: **`web` enqueues → `worker` pulls, spawns the CLI, commits to
the shared volume → live output streams back `worker → Redis → web → browser`.**
Watch it with `docker compose logs -f web worker`.

### The environment matrix

Both containers set these (see `docker-compose.yml`); the two **bolded** rows are
the ones that make or break the architecture.

| Variable                   | `web`               | `worker`            | Why                                                             |
| -------------------------- | ------------------- | ------------------- | -------------------------------------------------------------- |
| **`AGENT_WORKER`**         | `1`                 | `1`                 | web **enqueues** instead of running inline; worker **consumes** |
| **`MULTIPLAYER_AI_TERMINAL`** | `1`              | —                   | run guard refuses all runs in a prod build without it          |
| `MULTIPLAYER_AI_DATA`      | `/app/workspaces`   | `/app/workspaces`   | the shared git state; identical path on both (see §3)          |
| `REDIS_URL`                | `redis://redis:6379`| `redis://redis:6379`| queue + live-output bridge; compose network name, not host port|
| `DATABASE_URL`             | `…@postgres:5432/…` | `…@postgres:5432/…` | compose network name, not host port                            |
| `AGENT_WORKER_CONCURRENCY` | —                   | `2`                 | runs one worker executes at once                               |

**If `AGENT_WORKER=1` is missing on `web`**, the web container silently falls back
to spawning the CLI *inside itself*, bypassing the queue entirely and defeating
the whole point of the split. Both tiers must agree on the switch.

**The terminal guard.** Agent runs are remote code execution, gated by
`app/lib/terminal/guard.ts`: in a production build it refuses runs unless
`MULTIPLAYER_AI_TERMINAL=1` **and** the request arrived on a loopback Host. That
is why the web env sets the flag and why you reach the app at
`http://localhost:3000` — a non-loopback hostname is refused by design. Exposing
this beyond localhost means rethinking that guard; it is a deliberate RCE
boundary, not an oversight.

---

## 3. The shared-volume contract

`web` and `worker` mount **one named volume, `workspace_data`, at the same
absolute path, `/app/workspaces`, in both.** This is the load-bearing detail of
the containerized topology.

**Why it exists.** The whole session state is git — bare repos and working copies
under the data root (see `ARCHITECTURE.md`). The worker commits there; the web
server reads from there. They must see the *same bytes*.

**Why a named volume and not a host bind mount.** A git working copy's `.git`
file records an **absolute** gitdir path. If the worker cloned at
`/data/work/<id>` but the web server saw it at `/some/host/path/work/<id>`, the
web server would read a `.git` pointing at a directory it has no copy of, and git
would break. A host bind mount makes those paths differ between host and
container; a **named volume mounted at one identical path in both containers**
makes them the same by construction. Neither container touches a host path, so
the whole path-identity problem disappears.

**Do not wipe it casually.** `docker compose down -v` deletes `workspace_data` —
that is every session's durable git state, not disposable cache like the presence
Redis. Back it up like a database.

---

## 4. Injecting AI provider credentials

The worker spawns the vendor CLIs (`claude`, `codex`, `gemini`) and must be
signed in — the app never handles API tokens itself; each CLI owns its own
credential (this is the "reuse the machine's login" model). The compose files
mount the host's Claude login **read-only** into both containers:

```yaml
volumes:
  - ${HOME}/.claude:/root/.claude:ro
```

- `worker` needs it to **run** the agent.
- `web` needs it to **detect** login state so the composer shows "signed in" and
  offers the agent to select.
- The containers run as root, so the CLI looks in `/root/.claude`. If your host
  keeps its config elsewhere, adjust the source path.
- For other providers, add the equivalent mounts (e.g. Codex/Gemini credential
  directories) as you enable those agents in `app/lib/ai/catalog.ts`.
- Read-only is deliberate: the container reads the login, it should never mutate
  it. Sign in on the host (`claude auth login`) and the container picks it up.

For a real deployment (no host to borrow a login from) you would instead sign the
CLIs in during image build or mount a credentials secret — same target path,
different source.

---

## Known unknowns — read before the first `--build`

Compose config is validated, but the images had not been built when this was
written. Expect to shake these out on the first real build/run:

- **`node-pty` compiles from source.** The first `--build` runs a native-addon
  compile (hence `python3`/`make`/`g++` in both Dockerfiles). It can take several
  minutes and is the slowest layer; it caches after that. A failure here is
  almost always a missing build tool in the image.
- **Agent CLI versions drift.** The Dockerfiles `npm install -g` the CLIs
  unpinned. Pin them for reproducible images, and keep the set in step with
  `app/lib/ai/catalog.ts`.
- **Credential layout.** `~/.claude → /root/.claude` assumes your host's Claude
  config lives there and that the CLI in-container reads `/root/.claude`. Verify
  with `docker compose exec worker claude auth status`.
- **Migrations run from `web`.** The `web` container applies migrations on start,
  which is fine for one instance. A multi-replica web deploy should run
  `node db/migrate.mjs` as a separate one-shot job instead, so N replicas don't
  race the schema.
- **Stalled runs fail, they don't retry.** By design (`attempts: 1`,
  `maxStalledCount: 0`): a worker killed mid-run marks the job failed rather than
  re-executing a half-mutated working tree. The session stays at whatever it
  committed (never uncommitted, by the repo invariant); the run row reconciles to
  failed.
