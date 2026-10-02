# Single-server beta deployment

The production configuration uses Caddy for HTTPS and least-connection routing
to two identical Next.js web instances. Both use the same PostgreSQL database,
Redis and Git/object volume. One background worker handles indexing. Coding
agents run on paired user machines; hosted terminals and agent execution remain
disabled. This is one host with two web instances, not multi-host failover.

## Initial deployment

Use a Linux host with Docker Engine and the Compose plugin, Git, persistent disk
and a domain pointing directly to the host. Start by restricting beta access to
approved networks. Rate limiting does not make global registration invite-only.
The default resource estimate is 4 vCPUs, 16 GB RAM and 100 GB SSD including local
embeddings; measure your workload rather than treating this as a capacity promise.

```sh
git clone https://github.com/Prathamesh314/multiplayer-ai.git
cd multiplayer-ai
git switch main
git pull --ff-only origin main
cp docker/production.env.example .env.production
chmod 600 .env.production
```

Edit `.env.production`: set `APP_DOMAIN` to the hostname without a scheme,
`ACME_EMAIL` to the certificate contact, and generate three **different** secrets
with `openssl rand -hex 32`. Fill `POSTGRES_PASSWORD`, `PROXY_SHARED_SECRET` and
`MNEMOSYNE_MCP_TOKEN`. Hex passwords avoid connection-URL escaping problems.
Set `APP_VERSION` to your release identifier/commit for identifiable images.
Never paste the output of `docker compose config` into public logs: it contains
resolved secrets. Use `config --quiet` for validation.

```sh
docker compose --env-file .env.production -f compose.production.yml config --quiet
docker compose --env-file .env.production -f compose.production.yml build web worker mnemosyne
docker compose --env-file .env.production -f compose.production.yml up -d
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs --tail=100 gateway web web2 worker
```

Use this standalone file, **not** an overlay on `docker-compose.yml`. Only Caddy
publishes host ports (80 and 443); database, Redis, memory, embeddings and both
web instances are private. Restrict administrative SSH at the host firewall.
Keep HTTP certificate validation reachable and allow HTTPS to your beta users.
Caddy saves certificates in persistent volumes and redirects HTTP to HTTPS.

`migrate` runs once after PostgreSQL/Redis health checks and must finish before
web or worker starts. It exits successfully after applying pending migrations.
Both web replicas run the same image and start without running migrations.
Each web instance has one process and a ten-connection PostgreSQL pool; the
indexing worker adds its own pool. Do not multiply `WEB_CONCURRENCY` and replicas
without budgeting database connections and testing the result.

Web readiness checks PostgreSQL and the rate-limit Redis connection. The gateway
removes unhealthy backends within its health-check interval. It does not expose
the internal `/health/ready` endpoint publicly. Readiness does not certify every
optional sidecar, repository, or worker job; monitor those separately.

## Request limits

Every explicit API handler is wrapped by `withApiLimit`. A source-coverage test
fails if a new HTTP export omits the wrapper. Framework-generated OPTIONS
responses are not counted; HEAD delegates to the limited GET handler.

Signed-in requests resolve the current account from the database before choosing
the account bucket. Different cookies or devices belonging to one user share
that account's allowance within each policy. Cookie parsing matches Next.js,
including percent decoding and duplicate-cookie precedence. Caller-supplied user
IDs do not select a bucket. Normal route authorization and token revocation checks
still run; this limiter does not grant access or cache authorization.

| Policy | Sustained requests/minute | Burst | Scope |
| --- | ---: | ---: | --- |
| `INGRESS` | 6,000 | 1,500 | Client IP, before identity lookup |
| `ANONYMOUS` | 120 | 40 | Client IP for unauthenticated ordinary API calls |
| `AUTH` | 20 | 10 | Client IP, shared by login/continue/register, even with a cookie |
| `PAIR` | 10 | 5 | Client IP for exchanging a code; user for minting a code |
| `READ` | 600 | 120 | User, ordinary API reads |
| `WRITE` | 180 | 60 | User, ordinary API mutations |
| `UPLOAD` | 120 | 60 | User, folder import batches |
| `STREAM` | 60 | 20 | User, opening live streams |
| `RUNNER` | 600 | 120 | User, runner control/acknowledgements/checkpoint metadata |
| `ACTIVITY` | 600 | 180 | User, runner activity/lease event requests |
| `GIT` | 120 | 40 | User, Git protocol requests |

Override `API_RATE_<POLICY>_PER_MINUTE` and `API_RATE_<POLICY>_BURST` in
`.env.production`; the production Compose configuration forwards them to both
web instances. Each value must be an integer from 1 to 1,000,000. A token bucket
allows a short burst, then replenishes at the sustained rate; it is not a strict
fixed-minute counter. Separate policies prevent ordinary browser reads from
spending the runner's control allowance. IP ingress limits are shared by users
behind the same NAT; tune deliberately for large offices and load generators.

Rejections return JSON, HTTP 429, `Retry-After`, `X-RateLimit-Limit` (burst),
`X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix seconds until full refill), and
`Cache-Control: no-store`. Successful API responses also expose bucket headers
and are not cached by shared proxies. Folder imports and idempotent queued-input
claims honor a bounded Retry-After delay. A temporary 429 alone no longer aborts
an execution lease; the existing 40-second renewal deadline still applies.

The Redis Lua operation atomically refills/debits using Redis server time and
expires idle buckets. Redis failures return a bounded, retryable 503 **before**
the API handler executes. There is no per-replica fallback that could multiply
allowances. Production Redis uses AOF and no-eviction with a 256 MiB memory cap;
alert on memory, rejected writes and failures. AOF `everysec` is not a zero-loss
durability guarantee. Repository writers now use kernel file locks on the shared
local volume independently of Redis; see `launch-remediation.md`.

Local single-process development without Redis uses a bounded in-memory store.
Without `API_TRUST_PROXY=1`, IP headers are ignored and anonymous/ingress requests
share the `direct` bucket. This mode is not suitable for public ingress.

## Gateway trust, streaming and retries

Caddy overwrites `X-Multiplayer-Client-IP` with the actual peer address and adds
`X-Multiplayer-Proxy-Secret`. The API trusts the address only when the configured
secret matches. Missing/forged gateway credentials get 403. IPv6 privacy
addresses share a /64 bucket; IPv4-mapped IPv6 addresses normalize to IPv4.
Do not put another CDN/proxy in front without configuring and testing the trusted
client-address chain: this configuration intentionally ignores arbitrary
`X-Forwarded-For` values. Do not expose either web container directly.

Caddy selects the backend with fewer active requests; long-lived SSE streams
count as active connections. SSE is flushed immediately without response
buffering, and Git/upload requests are not buffered by Next.js Proxy middleware.
Upstream keep-alive is 30 seconds, below Next's 70-second timeout. There are no
automatic upstream retries: a partially executed mutation must not be silently
sent to the second backend. Clients reconcile uncertain outcomes with existing
idempotency/recovery mechanisms. A dropped stream reconnects and reloads state.

The gateway caps incoming request bodies at 300 MB; existing API-specific
validation still applies. This cap is not a total repository-storage quota.
Request rates also do not cap the total number of open SSE connections, all
in-flight work, or volumetric DDoS traffic. Public-service protection still needs
appropriate ingress controls, monitoring and measured connection/admission limits.

## Data, updates and release gates

Back up PostgreSQL, `workspace_data` and memory data coherently to storage outside
this host. Test restoration before onboarding valuable repositories. Never run
`docker compose down -v` on this deployment. Development and production Compose
projects have different volume names; existing local data is not auto-migrated.

For an update, drain active work, back up state, pull the reviewed revision,
update `APP_VERSION`, build the new images, then stop `gateway web web2 worker`.
Remove the stopped `migrate` container with `docker compose ... rm -f migrate`,
then `docker compose ... up -d`. This ensures the migration service runs for the
new revision before traffic resumes. Keep previous images and a pre-migration
backup. An old image alone cannot undo an incompatible database migration.
This initial procedure has a maintenance window; it is not zero-downtime deploy.

Desktop installers are released separately. Set the three `DESKTOP_DOWNLOAD_*`
variables before building the web image; the Docker build now forwards them.
Empty variables retain explicitly labeled demo links. See `desktop-release.md`.

For optional Slack/Discord project context, follow `team-context-connections.md`.
Configure the app credentials on web and worker, retain the encryption key, and
run one Discord gateway worker per deployment. The human chat sidebar is replaced
by Connections; AI chats and tasks stay in the app.

The October 2 remediation implements kernel repository locks, abandoned-turn
recovery, coordinated backup/restore, invitation admission and storage admission.
See `launch-remediation.md` for tests, scope and remaining external release gates.
Stop **all** old web/worker replicas before upgrading the lock implementation.

Production defaults to `SIGNUP_MODE=invite`. Create the first private invitation
against the deployed database using `npm run beta:invite -- EMAIL HTTPS_ORIGIN`;
organisation admins can then invite their team through the existing UI. Inside
the production network, use the worker image's bundled source/runtime:

```sh
docker compose --env-file .env.production -f compose.production.yml run --rm --no-deps worker npm run beta:invite -- person@example.com https://your-workspace.example
```

The command prints a private single-use link; send it only to its recipient. Use
`SIGNUP_MODE=closed` to pause new accounts without blocking existing logins.
`ORG_STORAGE_LIMIT_BYTES` defaults to 10 GiB and `STORAGE_MIN_FREE_BYTES` to 2 GiB.
Admission failures explain the allowance/disk issue without removing existing work.
These controls do not bound PostgreSQL, logs, backups, or embedding data; monitor
those separately. Follow `backup-restore.md` for encrypted off-host backups and
an actual restore drill before accepting valuable data.

## Verification

- `npm run test:rate-limit`: token budgets, expiry, bounded memory, spoofing,
  failure handling, route coverage, request-body preservation and client retries.
- Build, then `npm run test:deployment`: an isolated PostgreSQL schema, disposable
  Redis, two production Next processes and the actual Caddy config. Verifies
  cross-process/session/device quotas, revocation, forged headers, Redis outage,
  health routing, SSE delivery, a 12 MiB upload and no replay after an uncertain
  write. Requires Docker and DATABASE_URL; no existing application rows are used.
- Existing application, desktop and HTTP/browser regressions remain in CI.
- CI also builds the actual production web image and runs
  `node tests/container-smoke.mjs` to check native dependencies, startup and
  protected API/readiness responses when dependencies are absent. Server builds
  use the Node image's bundled headers, compile native addons with C++20 for
  Node 24, and skip the unused Electron binary.

References: [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[Redis token buckets](https://redis.io/docs/latest/develop/use-cases/rate-limiter/nodejs/),
[Docker production guidance](https://docs.docker.com/compose/how-tos/production/).
