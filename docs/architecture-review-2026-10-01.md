# Architecture review and fixes — 1 October 2026

> Update, October 2: repository locking, abandoned-turn recovery, coordinated
> restore, signup/storage admission and release preparation are addressed in
> [launch-remediation.md](launch-remediation.md). The findings below are the
> original review; live deployment/signing/provider acceptance remains separate.


Scope: invite-only beta on one server, as selected by the product owner.
Started from clean `main` at `af01556`; `git pull --ff-only origin main` was
already current. This review traces the organization → project → member room →
repository → AI chat → turn → handoff/offline-review flow. It is not a capacity
certification or a claim that every endpoint has been independently audited.

## Architectural assessment

Keep the current TypeScript application, PostgreSQL state machine and local
runners. The concrete problems found here concern authorization, transactional
boundaries and recovery, rather than a need to change programming languages.
PostgreSQL owns durable collaboration state; Git owns code/checkpoints; local
or S3-compatible object storage holds compressed activity and optional archives.
Redis wakes clients/workers. The distinction between a chat and an execution
turn matters for control, concurrency and quotas.

Projects correctly support multiple repositories. Rooms group a member's work;
each chat currently targets one selected room repository. Local worktrees are
shared by chats targeting that room repository, so agent execution on the same
worktree serializes. Independent chats do not imply concurrent writes to one
working directory. Shared repositories remain independent room branches until
explicit publication/synchronization.

The server needs some durable project content to support offline review. It
already imports into Git objects without a persistent extracted checkout, and
the runner keeps editable files/dependencies locally. Storing only a GitHub URL
would lose unpushed code, unfinished changes and activity when a laptop is off.
Git compression and incremental transfer reduce storage; they do not make it
free or provide cross-repository global deduplication.

## Stage 1 — Access and live delivery

**Fixed:** explicit channel/DM membership previously bypassed organization
suspension. Database helpers also relied on callers to have checked access.
Migration `039_chat_access.sql` establishes one effective chat-access predicate.
The route guard, reads, public-channel joining and message writes now use it.
Writes hold relevant rows stable through commit, so a stale preflight cannot
authorize a message after suspension. Opening a private channel cannot revive
a removed membership. Channel/DM creation also checks active org membership
inside its transaction. Malformed identifiers/payloads get controlled errors.

**Fixed:** chat streams authenticated only at connection time, had unbounded
buffering, and could leak a subscription when cancellation raced setup. They
now use the shared bounded stream helper, recheck access before content delivery,
and check idle connections periodically. Authorization failures close the stream;
clients reload history after reconnect and deduplicate messages.

**Additional bug reproduced through real HTTP:** callbacks from a shared Redis
connection could resolve the wrong request cookie. A second login token for the
same user remained connected after that token was revoked. Streams now capture
their own token while inside the request and revalidate it explicitly; room and
account streams use the same approach. The regression uses real PostgreSQL,
Redis, cookies, Next.js routes and open SSE responses.

**Fixed:** message paging compared UUID alone while sorting by time and UUID.
It now uses the same composite order as the index, including PostgreSQL's UUIDv4
fallback and messages sharing timestamps. Cross-conversation cursors reveal no
messages.

**Fixed during Linux CI validation:** typing `@` before the teammate roster
arrived cleared the active mention. Later roster delivery did not reopen the
picker until another keystroke. The composer now retains the typed fragment
while choices load and derives visibility from the matching options. A browser
regression deliberately holds the roster response until after typing, then
requires suggestions to appear without changing the draft. Test artifacts also
use the operating system's temporary directory instead of macOS-only paths.

## Stage 2 — Durable data and admission limits

**Fixed:** GET `/api/sessions` triggered a background sweep that could permanently
remove inactive rooms and Git repositories after 30 days. It also discarded
working copies after 7 days without checking unfinished work or running turns.
The unsafe sweep and its unused deletion helpers were removed. The old
`MULTIPLAYER_AI_ARCHIVE_DAYS`/`MULTIPLAYER_AI_DELETE_DAYS` settings no longer act.
Room listing has no storage-deletion side effect.

The existing explicit storage-maintenance command remains available, initially
as a dry run. It verifies retained commits before removing clean legacy
checkouts and preserves dirty/untracked/ignored content. Checkpoint pruning
retains the latest and referenced snapshots. Permanent room deletion with a
grace period, inventory and recovery is a separate future lifecycle feature.

**Fixed:** hourly/monthly limits counted newly created chats, so continuations
could bypass them. Both preflight and atomic turn reservation now count accepted
execution turns. The organization admission lock covers checking the limits and
inserting the turn. The usage UI shows the same unit. Failed accepted turns count;
denied requests do not. Queued instructions within a turn remain part of that
turn. This is an execution admission limit, not provider token or dollar billing.

## Stage 3 — Organization consistency and release checks

**Fixed:** two owners could each modify the other while both transactions still
observed another active owner. Org roster mutations now serialize on the org
row, and management rights are rechecked in the transaction. Migration
`041_org_owner_serialization.sql` also protects direct database writes before
the existing deferred last-owner constraint executes.

**Fixed:** Docker's build context did not exclude `.env` files. Secret/config
directories, nested env files and generated/runtime state are now excluded.
A Docker build with harmless canaries verifies the actual COPY behavior while
preserving source, migrations and `.env.example` templates. This does not audit
any images previously built or distributed.

Added application CI for lint, default regressions, real PostgreSQL races,
desktop checks, the Docker-context test, production build and HTTP/browser
integration. Generated runner bundles are excluded from source linting; a
pre-existing unsafe error type in organization settings was corrected.
Existing non-failing lint warnings remain visible. Branch protection is an
operator/repository setting and was not changed by this patch.

## Verification

- `npm test`: full existing suite plus new chat access and quota regressions.
- `npm run test:architecture:postgres`: real simultaneous transactions; two-owner
  demotions, direct-SQL last-owner protection, stale admin rejection, concurrent
  message posting, suspension during a write, and twelve requests competing for
  one remaining monthly turn.
- `npm run test:integration`: build first; uses an isolated schema, disposable
  Redis and temporary Chrome profile. Tests public/private/DM suspension and
  token revocation on live streams, imports, assignments, handoffs, queued inputs,
  runner Git delivery and offline checkpoint review.
- `node tests/chat-ui.browser.mjs`: fixture-backed UI coverage including stream
  reconnect recovery, pagination, draft preservation and responsive layouts.
- `npm run test:desktop`, `npm run test:docker-context`, `npm run lint`, and
  `npm run build -- --webpack`.

PostgreSQL tests create and remove their own schema; no application records are
reset. Browser tests use temporary server/browser processes. These checks are
regressions, not a 1,000/10,000-user load test. The build still reports the existing
optional BullMQ Valkey dependency warning; the enabled Redis path builds.

## Remaining risks and next stages

Follow-up: shared per-user API token buckets and a standalone Caddy/two-web-instance
production configuration are now implemented. The development Compose defaults
remain development-only. See [production deployment](production-deployment.md)
for limits, authenticated proxy headers, health routing, shared storage and
failure-injection tests. Global signup restrictions and the data-integrity and
recovery findings below remain open; this is not a public-launch certification.

These are current findings, not implied fixes in this patch:

| Priority | Evidence and consequence | Next concrete stage |
| --- | --- | --- |
| High | `app/lib/session/lock.ts` ignores failed/zero Redis renewals. A stalled writer can continue after lease loss. | Add mutation-boundary fencing/cancellation, then inject process pauses and Redis restarts with competing writers. Throwing only after mutation is insufficient. |
| High | Recovery in `app/lib/ai/finalize.ts`/handoff flows is partly request-driven. A crash during preparation/dispatch can leave a turn holding a slot until recovery. | Add a coordinated reconciler with explicit deadlines, leases and operator-visible outcomes; never blindly rerun uncertain agent work. |
| High | PostgreSQL, bare Git and local objects are separate durable stores. No successful coordinated backup/restore drill was established here. | Back up the whole state, restore to an isolated server and verify refs, transcripts, checkpoints and artifact hashes before onboarding valuable repositories. |
| Medium | Pub/Sub notifications lack a durable cross-process outbox; a committed mutation can lose its notification, and some routes can return an error after persistence if publishing fails. | Add durable invalidation delivery and idempotent mutation IDs; test Redis loss between commit and delivery. |
| Medium | `mergeShared` updates project Git, room Git and later database metadata separately. Current Git pushes throw errors, but multi-step publication is not one transaction. | Record publication intent and reconcile partial outcomes, with failure injection between each durable step. |
| Medium | Room run lists, full transcript retrieval, directory trees and unread counts can grow with history. Each web/worker process has its own database pool. | Measure realistic histories; bound/page these reads and enforce a deployment-wide connection budget before increasing process count. |
| Deployment | Compose is a development-oriented configuration with default credentials and exposed backing-service ports. The app does not enforce a global beta allowlist. | Restrict beta ingress to invited users, configure TLS/secrets/private datastore access, and establish monitoring. Organization invitations alone do not close global signup. |
| Conditional | Optional BullMQ server execution uses disposable Compose Redis; it is disabled in the hosted local-runner profile. | Keep it disabled. Before enabling, use durable dispatch/reconciliation and persistent, non-evicting queue storage. |
| Future scale | Active Git storage is local to one shared host volume. | Introduce repository ownership/routing, fencing and tested failover before independent hosts; object storage alone is insufficient. |

Suggested next order: repository mutation safety → abandoned-turn recovery →
backup/restore drill → measured history/fan-out load → public-service hardening.
Do not claim production capacity or a zero-data-loss guarantee from passing
functional tests. The code and operational work above must be evaluated together.

## Upgrade

Deploy migrations `039`, `040` and `041` with this application revision using
`npm run db:migrate`, then restart web/worker processes. They add access logic,
an execution-usage index and roster serialization; they do not delete user rows
or relocate repositories. Rebuild desktop distributions separately when shipping
the updated embedded web app. GitHub CI runs after pushing; a locally passing
suite is not a claim that a hosted CI run has already succeeded.
