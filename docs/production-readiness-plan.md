# Production readiness and scaling plan

> Historical review. Several findings below have since been fixed or changed.
> Use the [1 October implementation review](architecture-review-2026-10-01.md)
> for the current single-server beta scope and verified results.

Reviewed: 11 September 2026. Baseline: `2475af3`, with a clean working tree before this report. Scope: current application, runner, worker, database migrations, deployment files, and existing test coverage. This is a code/configuration audit and implementation plan, not a penetration test, production capacity measurement, or certification. No application or infrastructure changes were made for this report.

## 1. Verdict

This is a functional early product, not just a mock-up. It has real Git storage, database-backed collaboration, authorization, isolated execution checkouts, handoff ownership, runner leases, durable completion retry, and automatic model discovery. Keep these foundations.

However, **I would not open unrestricted public signup or run arbitrary customers' agents on the shared server today**. There are identifiable security and durability gaps, and multi-host operation has not been demonstrated. A successful demo or build does not establish reliable recovery, tenant isolation, or a sustainable operating cost.

The next milestone should be a **small, invite-only, local-runner-first beta**, after the security and recovery gates below. Public launch and large-scale hosting are separate milestones. Avoid a wholesale rewrite, speculative microservices, Kubernetes, or multi-region active-active deployment before there is evidence they are needed.

### What has already improved

Do not treat every finding in `platform-review-2026-09-11.md` as still open. Subsequent implementation added:

- Per-turn ownership/version checks, atomic concurrent-turn admission, isolated turn checkouts, and compare-and-swap candidate promotion.
- Bounded conversation continuation across machines, independently of optional semantic memory.
- Runner lease checks, retryable completion outboxes, idempotent finalization, and explicit control recovery.
- Committed-tree file reads, static symlink checks for workspace writes, import finalization retries, and shared chat/file tabs.
- Model inventory refresh, per-device model/effort routing, and unavailable-model handling.
- Real PostgreSQL, browser, and Git-protocol regression coverage. The preceding implementation passed 173 default-plus-knowledge checks and browser integration; those results are not a load test, and were not rerun for this documentation-only review. Provider discovery was tested live; actual paid-provider/local-model execution still needs release smoke tests.

## 2. Current flaws, impact, and evidence

Severity is conditional on deployment: a local-only development capability becomes a launch blocker if exposed to untrusted customers. The findings below are static code/configuration observations unless stated otherwise; they are not claims of a demonstrated breach.

### F1 — Blocker: chat access revocation is incomplete

`app/lib/chat/auth.ts:34` accepts explicit conversation membership before requiring active organization membership. `app/lib/chat/store.ts:68` does not add an active-org predicate to that membership lookup. A suspended member retaining a conversation membership can therefore pass that guard. `app/api/chat/conversations/[id]/events/route.ts:19` checks access when opening the stream, but does not subsequently revalidate it.

**Impact:** an organization suspension/removal or token revocation need not promptly stop an existing chat subscription. Room authorization improvements do not automatically fix the separate organization-chat subsystem.

**Required:** enforce active organization membership consistently; invalidate live subscriptions on membership/token changes, with a periodic recheck as a fallback. Test public/private channels, DMs, suspended users, removed users, expired tokens, and already-open streams across two web replicas. Also audit memory/search/reference endpoints against the same effective-access rules.

### F2 — Blocker if enabled on the hosted service: terminal and agent isolation

`app/api/terminal/pty/route.ts:14` and `app/api/terminal/pty/route.ts:88` use the terminal gate but do not authenticate a user or bind PTY IDs to a room/owner. `app/lib/terminal/pty.ts:46` starts a shell in the application directory with its environment. `app/lib/terminal/guard.ts:16` relies partly on the request Host header; that is not proof of the remote client's identity. The normal production default disables this facility, but `docker-compose.yml:100` explicitly enables it.

`app/lib/ai/env.ts:14` inherits the execution process environment. The supplied worker has no non-root user declaration, and Compose mounts the operator's Claude credentials. Per-turn Git checkouts and CLI sandbox flags are useful, but are not a verified tenant security boundary. Static symlink checks also do not establish safety against concurrent malicious filesystem changes.

**Required:** keep hosted terminal/server inference disabled for the initial local-runner beta. Authenticate and authorize every execution control; scope terminals and credentials to their owner. Before offering hosted execution, introduce independently isolated jobs with restricted filesystem/network access, CPU/memory/PID/disk limits, environment allowlists, short-lived credentials, cancellation, and sandbox-escape tests. A second customer must never execute using the operator's account.

### F3 — Blocker: image build context can include secrets

`.dockerignore:1` does not exclude `.env` or its variants. A local `.env` exists. `docker/worker/Dockerfile:34` copies the entire context into the final worker image; `docker/web/Dockerfile:23` copies it into the build stage. Git ignoring a file does not exclude it from Docker context.

**Impact:** a build from this checkout can contain environment secrets in worker image contents or build artifacts/cache. I did not build or inspect a published image, and am not claiming credentials have already leaked.

**Required:** exclude environment files, credential directories, test/runtime state, and dumps; use explicit runtime file copying and runtime secret injection. Test with harmless canary secrets that must not occur in image layers. If existing images/cache were distributed, inspect their exposure and rotate affected credentials.

### F4 — Blocker for queued server execution: Redis persistence contradicts queue use

`docker-compose.yml:46` configures Redis with both snapshots and AOF disabled, and no persistence volume. The same service is used by BullMQ agent/consolidation queues (`app/lib/queue/index.ts:42`, `worker/index.ts:30`).

**Impact:** a Redis restart can discard queued work. PostgreSQL turn records may survive, but that alone does not recreate a missing queue job. Local runner jobs are stored in PostgreSQL, so this is not a claim that every execution mode loses its job record.

**Required:** distinguish disposable presence from durable work. Use an appropriately persistent, non-evicting queue backend and a PostgreSQL-backed dispatch outbox/reconciler. Persistence alone is not an exactly-once guarantee: dispatch and completion must remain idempotent and fenced.

### F5 — High: distributed lock loss is not acted upon

`app/lib/session/lock.ts:158` renews the Redis lock but ignores a zero renewal result and catches renewal errors. The protected operation continues even if ownership has expired.

**Impact:** after a pause or Redis/network failure, two processes may believe they can mutate the same repository. Candidate promotion's existing Git compare-and-swap limits one class of overwrite, but does not fence every publish, sync, save, and cleanup operation.

**Required:** design repository-owner fencing at the storage mutation boundary, observe lease loss, and stop accepting writes when ownership cannot be established. Do not merely increase the TTL or throw an exception after a stale writer has already changed data. Test process pauses beyond lease duration, Redis restarts, and competing writers.

### F6 — High: publish/sync still have partial-success durability paths

`app/lib/session/repo.ts:240` and `app/lib/session/repo.ts:263` ignore the result of pushing the updated room branch while returning success. These are distinct from the corrected agent-turn commit path.

**Impact:** project and room refs, or the room's stored head and authoritative repository, can disagree after a failed push. In the publish case the project push may already have succeeded, making a blind retry or rollback unsafe.

**Required:** explicit durable intent and partial-delivery states, verification of each authoritative ref, idempotent retry/reconciliation, and clear UI recovery. Inject failures between project push, room push, metadata update, and response delivery.

### F7 — High: recovery and retention are not an operational service yet

`app/lib/ai/finalize.ts:124` provides per-run completion reconciliation, currently called from run/handoff requests. Worker failure handlers and user-driven recovery exist, but there is no checked-in global recovery scheduler that covers all abandoned preparation, dispatch, execution, and finalization states without a browser opening that run.

`app/lib/session/retention.ts:34` removes inactive room repositories by policy; `app/lib/session/retention.ts:80` triggers sweeping from a session-list request, with process-local scheduling and swallowed errors. Its file cleanup names the session's work/bare repository, not the full set of imported repositories, turn workspaces, candidate refs, and memory stores.

**Required:** one coordinated scheduler; age/lease-aware state reconciliation; operator-visible recovery; retention tombstones, grace periods, policy disclosure, and active-turn fencing. Implement an inventory of all storage associated with a room. Preserve unpublished/recoverable results and runner outboxes until the applicable retention decision is explicit. Test both accidental deletion and orphaned data.

### F8 — High: real-time delivery is best-effort without a complete replay contract

`app/lib/events/redis.ts:24` and `app/lib/ai/run-stream.ts:38` use Pub/Sub. `app/lib/events/index.ts:70` falls back to process-local events after setup failure. `app/lib/ai/finalize.ts:108` publishes completion notifications after the database transaction, swallowing publish failures.

**Impact:** a completed result may be durable while another client's screen stays stale; different replicas may see different live state after fallback. This is not the same as losing a persisted transcript. Redis documents Pub/Sub as at-most-once delivery, without offline replay. [Redis delivery semantics](https://redis.io/docs/latest/develop/pubsub/).

**Required:** durable state-change outbox, monotonic event cursors, reconnect catch-up, duplicate suppression, bounded buffers, and fresh authorization during replay. Keep transient presence disposable; token streams may use periodic snapshots rather than persisting every token. In multi-process production, expose a degraded/not-ready state instead of silently switching to an isolated in-memory bus.

### F9 — High: public-account abuse and usage accounting are incomplete

`app/api/auth/continue/route.ts:37` distinguishes existing emails from new accounts. No shared abuse limiter was found on sign-in, registration, or runner pairing. Recovery/verification flows and a deploy-time identity-security checklist are not present in the reviewed routes.

Concurrent turn admission is now protected in `app/lib/ai/turns.ts:11`; that earlier bug should not be reported as unfixed. However, hourly/monthly quotas in `app/lib/ai/usage.ts:31` count conversations, not individual turns, and the period checks occur separately from creation in `app/api/ai/run/route.ts:190`.

**Required:** rate limits by account/IP/device with trusted-proxy handling, bounded inputs and streams, non-enumerating account responses, verification/recovery, and an origin/CSRF review. Define what is being limited: turns, execution time, storage, or measured provider usage. Reserve and settle that unit atomically. Do not infer exact API spending from conversation counts or claim exact billing where a subscription CLI exposes none.

### F10 — Scaling blocker: repository storage is tied to the application host

`app/lib/session/paths.ts:14` resolves repositories on local disk. Compose shares a named workspace volume between web and worker, not a cross-host repository service.

**Impact:** adding an independent web host does not automatically give it the same authoritative files. Adding CPU or Redis does not solve this. PostgreSQL metadata and Git objects must both be durable and recovered consistently.

**Required:** for a bounded beta, explicitly operate one repository-owning host with backed-up persistent storage and documented downtime expectations. For multi-host growth, route repository operations to an owner with durable storage, fencing, and tested failover; shard ownership by repository only when needed. Use object storage for immutable snapshots/artifacts/backups, not as a pretend POSIX filesystem for concurrent Git writes.

### F11 — Scaling risk: unbounded reads and write-heavy polling

`app/lib/ai/runs.ts:266` loads the room's runs without paging; `app/lib/ai/runs.ts:337` loads all messages after a sequence with no page limit. `app/lib/session/repo.ts:934` builds the whole file tree. `app/lib/auth/tokens.ts:51` writes token activity on every authenticated request. `app/lib/db/client.ts:25` gives each process a pool of ten connections.

**Impact:** large histories/trees and frequent polling can drive memory use, database writes, and connection pressure. These are identifiable growth risks, not measured capacity limits. Team-chat message paging already exists and should not be unnecessarily replaced.

**Required:** keyset pagination and bounded payloads, lazy/virtualized tree and message rendering, immutable Git-tree/blob caching keyed by repo and commit with authorization before access, coalesced refresh, sampled token activity writes, query profiling, and a deployment-wide connection budget. Load-test before adding replicas or indexes indiscriminately.

### F12 — Release/operations gap: successful local tests are not a release pipeline

There is no checked-in `.github` CI workflow. `package.json:21` defines useful tests, but the default test chain omits the knowledge suite and optional real PostgreSQL/browser coverage. Docker installs unpinned global CLI versions; web startup runs migrations inside each instance (`docker/web/Dockerfile:55`). The Compose file is development-oriented: exposed datastore ports, default credentials, and a shared operator identity are not a production configuration.

No checked-in production SLO dashboards, restore-drill evidence, or load-test results were found. External infrastructure may exist outside this repository; it was not inspected. Some existing modules still exceed a thousand lines, increasing regression risk, but file size is not itself a launch blocker.

**Required:** reproducible builds, one migration owner, staging with production topology, CI gates, structured redacted telemetry, alerts and runbooks, vulnerability/secret scanning, signed release artifacts where applicable, rollout/rollback procedures, and backup restoration exercises. Extract complex UI/execution state incrementally under tests rather than rewriting everything.

### F13 — Product completeness, not a raw scaling defect

`app/lib/project/store.ts:77` stores GitHub source metadata; it is not an authenticated GitHub clone/PR integration. `app/api/sessions/[id]/publish/route.ts:25` publishes to the platform's internal project main. Folder import works, but those are different capabilities.

Automatic model discovery is also not proof that every discovered model works for a coding turn on every installed CLI/device. Local hardware, tool compatibility, authentication, rate limits, and CLI versions still matter.

**Required:** either accurately label unsupported integrations or implement a GitHub App import/PR flow with branch protections, checks, scoped installation tokens, webhook validation, and retries. Maintain a supported provider/CLI matrix, real-provider smoke tests, capability-based UI, clear offline/auth errors, and safe runner upgrades. Preserve the current rule against silently substituting a model or automatically replaying a paid turn.

## 3. Target architecture and non-negotiable invariants

Start with a modular monolith for the control plane, not a distributed rewrite:

```text
Browser / desktop
    -> TLS gateway: request limits, trusted proxy policy, stream handling
    -> Next.js control plane: identity, authorization, rooms, handoffs, APIs
        -> PostgreSQL: authoritative metadata, turns, dispatch/event outboxes
        -> Redis: presence/fan-out; persistent queue configuration if used
        -> Repository owner: Git objects/refs, fenced mutations, durable disk
        -> Scheduler/dispatchers: reconciliation, retention, indexing
    -> authenticated, owner-scoped local runners via the control plane
        -> user's configured coding CLI/local model in a turn workspace

Later, if required: isolated hosted execution pool, separate from web/database.
Backups: PostgreSQL PITR + versioned Git/artifact snapshots + recovery manifest.
```

- One authorized driver/version per turn; stale attempts cannot promote changes.
- A completed durable change means its objects, canonical ref, and metadata agree; retries do not rerun inference or duplicate completion.
- Durable acceptance means a dispatch record can survive process/queue failure.
- Losing a UI stream cannot lose work; reconnect retrieves authoritative state.
- Every request, replay, and tool control respects current effective access.
- No untrusted job receives application database credentials or another user's provider credentials.
- Model refresh never changes a pinned selection, installs weights, spends inference credits, or substitutes a hosted executor without an explicit policy.

Keep one region initially. Local runners reduce hosted inference requirements, but the control plane still stores uploaded code, prompts, transcripts, and possibly memory; do not describe it as a zero-data cloud service.

## 4. Phased delivery plan

Owners are roles to assign, not people already staffed. Estimates should follow Phase 0; the repository alone cannot establish a credible completion date.

| Phase | Deliverables and dependencies | Owner | Exit gate |
| --- | --- | --- | --- |
| 0 — Define the release | Document local-runner-first scope, threat model, data map, supported OS/CLI versions, beta workload, and release checklist. Inventory external infrastructure. Record the current test/lint/build baseline. | Product + engineering lead | A bounded beta scope and explicit exclusions; every finding has an owner and reproducible acceptance test. |
| 1 — Close security blockers | F1–F3 and F9 identity/abuse controls. Hosted execution off; safe proxy/container settings; image-secret exclusions; consistent effective access and revocation; rate limits; verification/recovery or managed equivalent. Establish CI early. | Backend/security + platform | Authorization matrix passes across two tenants/replicas; revoked readers stop receiving events within a proposed 5-second bound; spoofed Host does not grant execution; image canary-secret scan is clean. No unresolved critical/high security issue in enabled beta features. |
| 2 — Make accepted work recoverable | F4–F8 and retention/backup portions of F10/F12. Durable dispatch/event outboxes, independent reconciliation, fenced repository writes, publish/sync recovery, coordinated retention, complete backups. Depends on the Phase 0 topology. | Backend/storage + platform | Kill processes at each persistence boundary; restart Redis; disconnect a runner; interrupt a push; repeat completion. Every accepted turn settles or exposes an actionable recoverable state, without duplicate inference or silent overwrite. Restore DB and Git together on a fresh host. |
| 3 — Invite-only beta | Complete reproducible deployment, alerts/runbooks, compatibility checks, real-provider tests, clear import/PR labeling, offline UX, export, and conflict/recovery UI. Depends on Phases 1–2. | Product/frontend + platform | A small cohort completes import → shared task → handoff → recipient continuation → reviewed result. Every failure is visible and support can recover it. Hold/reduce rollout if integrity or access controls fail. |
| 4 — Prove multi-host capacity | F10–F11: separate repository ownership from web placement, distribute authorized events, cap/paginate reads, profile queries, budget connections, implement admission/backpressure and failure-domain isolation. | Platform/performance + backend | Two web replicas serve the same rooms correctly during rolling restart; repository ownership failover is fenced; agreed load/soak tests meet the targets below with no state divergence. |
| 5 — Public launch and growth | Turn-based usage accounting, abuse operations, support/export/deletion workflows, verified GitHub integration if advertised, staged releases, dependency/provider updates, and independent security review. Hosted execution is a separate gated project, not implicitly enabled here. | Engineering lead + operations/product | Launch checklist signed off; recovery drill and alert exercise pass; capacity/cost envelope documented; sustained beta use and reliability justify expansion. |

Phases 1 and 2 are the critical path; scale features do not compensate for broken access control or lost work. Public launch does not require building every enterprise feature, but anything advertised must work and every enabled trust boundary must be tested.

### First implementation batch

1. Fix conversation membership authorization and add suspension/open-stream regression tests.
2. Prevent secrets entering image layers; explicitly disable hosted PTY/server execution and remove shared operator credentials from the production profile.
3. Add mandatory CI for typecheck, full lint, default tests, knowledge tests, real PostgreSQL/browser tests, and production image smoke tests. Resolve existing lint issues deliberately rather than suppressing all rules.
4. Specify durable dispatch/recovery states; make queue restarts and partial publish failures first-class tests.
5. Implement coordinated repository/DB backup and restore before onboarding customer repositories.

## 5. Proposed launch targets and capacity proof

These are acceptance targets to refine with the team, **not current measured capabilities or customer promises**. Count concurrent connections, executing turns, repository size, and message volume—not registered accounts alone.

| Area | Proposed beta/launch acceptance target |
| --- | --- |
| Control-plane availability | 99.5% during invite-only beta; 99.9% target for public launch, measured with external probes and user-visible failures. Track provider and offline-runner failures separately, not invisibly. |
| Interactive latency | p95 under 500 ms for ordinary metadata APIs under the agreed workload; measure imports, Git operations, and model latency separately. |
| Handoff | p95 under 2 seconds for an idle-run offer/accept to appear on the other online client. Running-turn boundaries are intentionally excluded. |
| Recovery | Abandoned work detected within 2 minutes after its applicable lease/preparation deadline; no replay of a possibly executed turn without explicit safe recovery. |
| Reconnection | Current state converges within 5 seconds of restored connectivity, or shows an explicit reconnect/degraded state. |
| Data recovery | Initial objective: RPO at most 5 minutes and RTO at most 60 minutes for the whole recoverable DB+Git state. Measure actual restored heads, not just successful backup uploads. Tighten acknowledged-write durability guarantees before promising zero data loss. |
| Isolation | Zero unauthorized reads/writes in the automated cross-tenant matrix; close findings from an independent security review before public release. |

PostgreSQL PITR needs a base backup plus WAL archiving; a periodic logical dump alone is not PITR. Git repositories and configuration need their own coordinated recovery plan. [PostgreSQL recovery documentation](https://www.postgresql.org/docs/current/continuous-archiving.html).

Build a workload ladder rather than declaring support for an arbitrary user count:

1. Provisional beta case: 25 connected users, 10 active rooms, and 5 concurrent turns; record repository sizes, open streams per user, token rate, and hot-room fan-out.
2. Growth case: 100 then 500 connected users, with explicitly provisioned runner/worker capacity. Use deterministic model simulators for platform load and a small separate real-provider acceptance suite.
3. Data cases: 1k/10k/100k-file repositories and long transcripts; record what is supported, rejected, or requires paging before launch. Do not promise every size merely because it was included in a test plan.
4. Failure cases: cold caches, slow clients, packet loss, sleeping runners, Redis restart, PostgreSQL failover, full disk, stale locks, simultaneous publishing, revocation during streaming, and rolling deployment.
5. Run a sustained soak, not only a burst. Measure RSS, event lag, queue age, database connections/WAL, lock wait, Git latency, network egress, error rate, and cost per successful workflow. Expand only while both latency and correctness hold.

Do not count autoscaling as success if it only increases a database or shared-disk bottleneck. Keep admission limits below measured sustainable capacity and expose overload as a retryable user-visible state.

## 6. Release evidence and operational checklist

- CI artifacts: pinned application/CLI versions, build digest, dependency/secret scans, schema compatibility, unit/integration/browser reports, real-provider matrix, and accessibility checks for the core workflow.
- Deploy once: migrations as a separately locked release job; backward-compatible expand/contract schema changes; feature flags; compatible runner protocol rollout; drain/rollback instructions that preserve candidates and outboxes.
- Telemetry: structured request/org/room/run/turn/device correlation IDs, with no raw credentials or default full-prompt logging. Alert on old queued/preparing turns, lease failures, completion backlog, pub/sub degradation, failed backups, disk pressure, and denied-access spikes.
- Audit: membership changes, handoffs/recovery, device pairing/revocation, execution location, model selection, publish, exports, and deletion. Distinguish security audit records from transient debug logs.
- Disaster recovery: encrypted, separately access-controlled backups; restore manifests linking repository heads to metadata; recurring fresh-host restore drills; inspection of unpublished candidate work before garbage collection.
- Identity/data lifecycle: account recovery, revocation, explicit upload/provider disclosure, export, deletion across repositories/transcripts/memory/backups according to documented retention, and support escalation. This plan is not a claim of legal or compliance certification.
- Security verification: map the application's controls and tests to an appropriate OWASP ASVS profile; commission review of the execution/tenant boundaries rather than relying only on UI tests. [OWASP ASVS overview](https://devguide.owasp.org/en/11-security-gap-analysis/01-guides/02-asvs/).

## 7. Product priorities and deferred work

The adoption hypothesis is stronger than “another editor with more models”: a teammate can reliably pick up AI work without reconstructing the task. Measure successful recipient continuations, time to resume, reviewed changes shipped, repeat team usage, and reasons for abandoning a handoff.

Prioritize trustworthy handoffs, visible execution location, clear failure/recovery, real repository connectivity, and a reviewable result. Defer multi-region writes, large service decomposition, additional vector infrastructure, and broad enterprise features until usage or actual buyer requirements justify them. Optional semantic memory must not be required for core correctness; test its authorization, provenance, and failure behavior before expanding it.

**Bottom line:** the project can become a production product without discarding the current code. The next investment should be proving security, durability, operability, and the team workflow—not simply adding more features or servers.
