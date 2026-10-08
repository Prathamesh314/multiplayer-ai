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
`AUTH_PUBLIC_URL` to the matching public HTTPS origin (for example,
`https://cubeclashes.com`, used for invitation links and Clerk session origin checks),
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
HTTP/3 stays enabled, but QUIC early data is disabled (`servers { 0rtt off }`)
so the gateway verifies the client address before forwarding requests. Early
requests can otherwise lack the IP required by admission checks and produce
intermittent 403s in browsers. See [Caddy's early-data option](https://caddyserver.com/docs/caddyfile/options#0rtt).

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

For Cloudflare Free CDN with the existing VM, follow the
[Cloudflare public-assets setup](cloudflare-cdn.md). The same asset origin also
supports [GoDaddy CDN](godaddy-cdn.md). Keep the main application hostname direct
so live streams, authentication and private files never enter the asset CDN.

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

### Automatic releases from main

`Application checks` now deploys successful pushes to `main`, and successful
manual runs of that workflow on `main`. Pull requests run checks only. The
deployment job depends on the complete checks job, skips superseded commits,
and serializes releases without cancelling a running deployment. It sends the
exact checked commit as a Git bundle; production needs no GitHub token.

Configure these repository Actions settings once:

| Setting | Type | Value |
| --- | --- | --- |
| `PRODUCTION_DEPLOY_HOST` | Variable | Production SSH hostname/IP |
| `PRODUCTION_DEPLOY_SSH_KEY` | Secret | Dedicated Ed25519 private deployment key |
| `PRODUCTION_DEPLOY_KNOWN_HOSTS` | Secret | Host public key verified over an existing trusted connection |

On the host, install `scripts/deploy-ssh-entrypoint.sh` as root-owned executable
`/usr/local/sbin/multiplayer-ci-deploy`. Add the dedicated **public** key to root's
`authorized_keys` with `restrict,command="/usr/local/sbin/multiplayer-ci-deploy"`.
This key accepts only `deploy <40-character SHA>` and a bounded Git bundle on
stdin; it cannot request an interactive shell, arbitrary SSH commands, forwarding,
or file transfers. The installed entrypoint is deliberately outside the checkout;
entrypoint changes need an administrative installation. Access to this key and
changes on `main` remain privileged because reviewed release code runs on the host.

The host requires `/opt/multiplayer-ai`, the existing `.env.production`, Docker
Compose, Bash, Git, curl, flock, and timeout. Preserve any ignored
`compose.https.yml` overrides. Keep `BACKUP_ENCRYPTION_KEY` in the root-only
`/root/multiplayer-deployment-config/backup-key.env`, with a separate off-host copy.

`scripts/deploy-production.sh` removes unused Docker images and trims unused
build cache to 2 GB before checking disk space. Images referenced by containers
are preserved, so the current release remains available for rollback throughout
the update. It builds commit-tagged web/worker images while the old release is
live, then checks the worker CLI and boots a private web candidate without
publishing ports or replacing the live containers. The candidate must pass
dependency readiness and serve `/`, `/login` and `/workspace`. Build, runtime,
database preflight or migration-policy failures leave the live application alone.
The script refuses deployment during active AI work or with less than 8 GiB
available after cleanup. Only after validation does it close admission, create
an encrypted coordinated backup, run migrations once, reconcile storage counters
with all writers stopped, and wait for both web replicas. Only the running application
services are started with `--wait`; successful one-shot setup services are excluded.
It then checks image versions and public HTTPS pages. There is a short maintenance
window during backup and activation. Infrastructure sidecars and desktop installers
continue to have separate upgrade/release procedures.

Failures after activation starts restore the prior checkout, environment and
actual previous web/worker images, then verify both restored replicas. A failed
bootstrap or health check can roll back after a **reviewed compatible migration**;
it does not restore the database or discard new user data. This includes migration
049, which adds separate accounting tables without changing older application
tables. Storage reconciliation before each later activation catches writes made
by older code while it was restored.

Automatic deployment accepts pending migrations only if their exact SHA-256
appears in `db/deploy-compatible-migrations.json`. Unknown, edited or destructive
migrations are refused **before downtime**. Adding a hash is an explicit code
review decision: verify the previous release can continue reading/writing with
the schema and data produced by the new release. Prefer additive expand/contract
changes; destructive cleanup needs a separate planned upgrade. Never approve a
hash merely to make CI green. The release records its migration plan and verifies
that rollback observes only the original schema plus approved additions. If the
database cannot be queried, migrations disappeared, or an unplanned migration
appeared during rollout, automatic rollback stops rather than guessing about
data compatibility. Follow `backup-restore.md` for that exceptional recovery.
After fixing a failure, rerun the
workflow on the current `main`. Active-work refusals can be retried when work ends.
Retries can also use stopped web/worker containers after a failed bootstrap;
backup inventory uses their retained image rather than a failed release tag.
If a retry fails, a previously stopped application remains stopped. CI builds
the worker image and exercises storage bootstrap, repeated bootstrap, recovery,
reconciliation and the maintenance CLI on disposable PostgreSQL/storage before
allowing deployment. It also runs a healthy and a deliberately broken private
candidate beside a live HTTP server, verifying that neither replaces that server.
This single-host release still has a short maintenance window during coordinated
backup, reconciliation and activation; these protections are not multi-host
failover or a guarantee against VM/database failure.

Release records and the last successful SHA are under
`/root/multiplayer-deployment-config`; encrypted backups are under
`/root/multiplayer-backups`. After the new release passes its health checks, the
workflow removes unused images again, keeping only the latest web/worker release
and images still referenced by other containers. It never prunes containers,
volumes, application data, or backups. A cleanup failure after activation fails
the job with a clear message but leaves the verified release running. Older
releases must be rebuilt from their Git revision if needed later; encrypted
backups and release configuration records are retained. Monitor disk usage and
copy backups off-host using the existing backup procedure.
The Actions deployment log and job summary identify the deployed SHA and URL.

Back up PostgreSQL, `workspace_data` and memory data coherently to storage outside
this host. Test restoration before onboarding valuable repositories. Never run
`docker compose down -v` on this deployment. Development and production Compose
projects have different volume names; existing local data is not auto-migrated.

For an update, drain active work, back up state, pull the reviewed revision,
update `APP_VERSION`, build the new images, then stop `gateway web web2 worker`.
Remove the stopped `migrate` container, run migrations and backfill accounting
using the **new** images before starting any application service:

```sh
docker compose --env-file .env.production -f compose.production.yml rm -f migrate
docker compose --env-file .env.production -f compose.production.yml run --rm --no-deps -T migrate
docker compose --env-file .env.production -f compose.production.yml run --rm --no-deps -T worker node --import tsx scripts/storage-accounting.ts --reconcile
docker compose --env-file .env.production -f compose.production.yml up -d --no-deps --wait web web2 worker gateway
```

Do not mix pre-049 writers with ledger-aware writers: old writers cannot update
the new counters. Deployment reconciliation walks existing storage and can extend
the maintenance window; it is necessary after restoring pre-ledger writers, even
when the ledger was initialized before the failed release. New installations
with empty storage initialize owners lazily. [Storage accounting](storage-accounting.md)
documents explicit reconciliation and recovery. Keep the previous images until the new
release passes verification, and retain a pre-migration backup. An old image
alone cannot undo an incompatible database migration.
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

Set `SIGNUP_MODE=open` in `.env.production` to admit anyone after Clerk verifies
their email. Complete [Clerk authentication setup](clerk-auth.md), including
production keys and signed webhooks, before rebuilding and deploying. Clerk
manages Google/email sign-in, verification and recovery; the old Google OAuth
and Resend verification settings are retained only for rollback compatibility.

Production defaults to `SIGNUP_MODE=invite` when no mode is configured. Create the first private invitation
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

## Clerk authentication

Human authentication is managed by Clerk. Complete [Clerk setup](clerk-auth.md) before deploying this release. Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` at build time and `CLERK_SECRET_KEY` plus `CLERK_WEBHOOK_SIGNING_SECRET` at runtime in `.env.production`. Keep `AUTH_PUBLIC_URL` set to the public HTTPS origin. The deployment preflight preserves the current release if Clerk credentials are missing.
