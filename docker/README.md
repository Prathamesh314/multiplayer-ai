# Running multiplayer-ai

For an Internet-facing deployment use the standalone
[`compose.production.yml`](../compose.production.yml) and
[production deployment guide](../docs/production-deployment.md). It includes
HTTPS, two web instances, shared per-user API limits, private datastore ports,
health checks and one migration service. The commands below use the development
Compose file and should not be exposed publicly unchanged.

## Hosted app: local runners and users' own AI accounts

The `app` Compose profile hosts collaboration and repository storage. Each
user's paired runner executes coding agents on that user's machine with that
user's provider login. Credentials stay on the execution machine.

```bash
docker compose --profile app up --build
```

Open http://localhost:3000, sign in, and pair a runner through Settings → Devices.
The desktop app pairs its bundled runner automatically. For a standalone runner,
install and sign into a supported coding CLI, then run these commands from any folder:

```bash
npm install --global http://localhost:3000/downloads/multiplayer-ai-runner.tgz
multiplayer-ai-runner pair --server http://localhost:3000 --code YOUR_PAIRING_CODE
multiplayer-ai-runner start
```

For a remote deployment, pair against its HTTPS URL instead of localhost.
See [provider setup](../docs/providers-and-models.md) for supported options.

A turn follows this path:

1. Web authorizes the request and records a job for the caller's paired runner.
2. The runner fetches the specified Git commit and prepares the room repository's
   persistent local worktree (see [runner workspaces](../docs/runner-workspaces.md)).
3. The user's coding CLI runs with the user's own provider account.
4. The runner streams events and pushes a candidate Git commit to the server.
5. The server verifies the candidate and advances the room's code version.

If the caller has no compatible online runner, the app asks them to connect it.
It does not fall back to hosted agent execution.

| Variable | Web | Worker | Purpose |
| --- | --- | --- | --- |
| `LOCAL_RUNNERS` | `1` | — | Route coding turns to users' paired machines |
| `MULTIPLAYER_AI_TERMINAL` | `0` | `0` | Disable hosted terminal and inline agent execution |
| `AGENT_WORKER` | `0` | `0` | Disable hosted agent queue consumption |
| `REDIS_URL` | Compose Redis | Compose Redis | Live events, presence, and coordination |
| `DATABASE_URL` | Compose Postgres | Compose Postgres | Metadata, runner jobs, transcripts, and indexing jobs |
| `MULTIPLAYER_AI_DATA` | `/app/workspaces` | `/app/workspaces` | The same durable Git state |

The background worker still runs repository and memory indexing. Default
embeddings use local CPU resources and do not need a paid API account.
Optional paid memory extraction is separate: enabling it bills the configured
provider account. LiteLLM starts only with the additional `memory-extraction`
profile; configure the worker's extraction endpoint explicitly to use it.

No host AI credential directories are mounted into the web or worker.
The current images still contain legacy CLI binaries; their presence does not
enable hosted execution.

## Local development

```bash
./start.sh              # services, migrations, dev server, indexing worker
./start.sh services     # backing services only
./start.sh down         # stop services, keep data
```

This path runs Next.js on the host for hot reload. A compatible paired runner
takes precedence. Without one, the development terminal gate can allow inline
execution using the developer's machine. Set `MULTIPLAYER_AI_TERMINAL=0` to
require local runners here too.

For deliberate server-worker development, `AGENT_WORKER=1` enables the agent
queue when Redis is configured and the terminal gate allows the request.
This is separate from the hosted Compose defaults.

## Git storage and backups

Web and worker mount the same named volume, `workspace_data`, at
`/app/workspaces`. Web performs Git reads, writes, and runner transfers; the
worker indexes those repositories. Both must see the same state.

The server holds the shared repositories. Each user's machine holds persistent
room/repository worktrees. Chat, permissions, and handoff ownership are stored in Postgres,
not in Git. Back up both Postgres and the Git volume together.

`docker compose down -v` deletes the named volumes, including durable code and
database state.

## Deployment scope

These defaults select local execution; they are not a complete public deployment.
Compose still contains development credentials and published datastore ports.
Use the [production readiness plan](../docs/production-readiness-plan.md) for
the remaining deployment work.

The web container currently runs migrations at startup. Use a separate migration
job before adding web replicas. Build and test the actual images before release;
configuration validation alone does not establish runtime readiness.
