# Launch remediation — 2 October 2026

Scope: finish the five launch gates from the product review, retaining the
single-host deployment and local desktop execution model.

## 1. Repository write safety

Repository mutations now use kernel `flock` locks on the shared local data volume.
There is no expiring Redis lease to lose during a process pause or Redis restart.
The lock descriptor is inherited by Git children; killing the web process does
not admit another writer while its Git child is still running. Locks release
when the last descriptor closes. Lock files must never be removed during service.
Public mutation helpers, seed indexes, canonical refs, shared-repository creation,
and incoming runner pushes use the same repository identity. Existing Git ref
compare-and-swap checks remain in place. Detached asynchronous callbacks cannot
reuse closed descriptors.

This server requires Linux/macOS, Python 3, and a local filesystem with flock
semantics. The production images already include Python. Windows desktop runners
remain supported; run the server in Linux Docker on Windows. NFS and independent
repository-owning hosts are unsupported. Stop **all** old web and worker processes
before deploying this change: old Redis locks cannot coordinate with file locks.

Validation: independent lock instances, reentrancy, SIGSTOP, parent SIGKILL with
a real Git child, missing-helper rejection and escaped callbacks; existing merge,
conflict, storage and 10,000-file import regressions passed on macOS. Linux CI will
repeat the process tests.

## 2. Abandoned-turn recovery

The worker scans bounded batches independently of indexing. Preparation and
local dispatch now commit atomically. Interrupted preparation (5 minutes),
unclaimed work (15 minutes), expired desktop leases, expired server heartbeats,
and revoked access receive explicit terminal outcomes and release admission
slots. Server agents abort when their heartbeat cannot be renewed. Late writers
cannot promote an expired execution. Delivered-but-unconfirmed inputs remain
marked uncertain; work is never automatically replayed.

Persisted completions are retried idempotently under repository and database
locks. Recovery claims expire after a worker crash; redacted errors and bounded
backoff are recorded on the turn. Existing owner recovery respects live leases.
Candidate commits, local work, activity and snapshots are retained.

Validation: seven recovery scenarios on PGlite and real PostgreSQL, including
concurrent recovery workers, saved completions, revocation and late finalization;
the existing 30 handoff/repository scenarios also passed.

## 3. Coordinated backup and restore

Implemented encrypted coordinated backups, fresh-project restores, secure configuration recovery and integrity inventories. The isolated Docker drill restored 50 database tables, Git refs, checkpoints, compressed activity and SQLite memory; existing-target, wrong-key and tamper refusals passed. See [backup runbook](backup-restore.md).

## 4. Registration admission and storage limits

Production defaults to private email-bound invitations. Tokens are hashed and
claimed in the account-creation transaction; invalid/expired/replayed tokens fail.
Organisation email invitations preserve the existing join flow. Existing logins
continue in invite-only/closed mode. The operator can issue a beta invitation with
`npm run beta:invite -- EMAIL WORKSPACE_ORIGIN [HOURS]` and send it privately.

Repository/activity admission counts durable local file bytes across every room
and repository owned by an organisation (personal rooms share a per-user limit).
The default allowance is 10 GiB, with conservative headroom for each operation.
Git pushes are capped at 128 MiB and 250,000 packed objects (bounding index
growth) and reserve 160 MiB of allowance. A trusted pre-receive hook checks the
actual quarantined objects/indexes before accepting them, including bases added
to thin packs; ordinary Git
mutations reserve 32 MiB, with larger imports/copies checked before writing.
Owner file locks serialize competing admissions across replicas. Short capacity
locks reserve temporary disk space across owners, retaining a 2 GiB free-space
floor. Crashed reservations are reclaimed only after their kernel lock is free.
Activity retries already acknowledged do not spend the allowance again.

These are application admission limits measured in file bytes, not operating-system
block quotas. Database, embeddings, logs and backups require their own disk
monitoring/retention. The enforced beta profile uses local objects and disables
cold Git archives; do not enable another storage profile without its usage meter.
Read access remains available at the allowance. Increase the configured allowance
or perform reviewed retention cleanup when full; no work is silently deleted.

Validation includes rejected imports with unchanged Git data, competing room
writes, free-space refusal, orphan reservation reclamation, and atomic invitation
claims on PGlite and real PostgreSQL.

## 5. Release acceptance

Local signing-file support, release configuration/readiness preflight, and
post-build macOS signature/Gatekeeper/notarization verification are implemented.
The local private template is prepared; actual certificate and Apple credentials
must be supplied by the operator. No signing identity is currently visible here.

The user will deploy after these fixes; no production HTTPS workspace exists yet.
Signed platform installation/updates and real Slack/Discord OAuth/channel-context
acceptance therefore remain external launch gates. Existing provider protocol and
HTTP tests are run, but are not reported as live acceptance. See
[desktop release](desktop-release.md) and [team connections](team-context-connections.md).

Pack header validation follows the [Git pack format](https://git-scm.com/docs/gitformat-pack); Git itself validates object contents and checksums.

## Local validation record

The full application regression suite passed. The final webpack production build,
TypeScript check, signup HTTP tests, real-PostgreSQL recovery/invitation tests,
two-web-replica Caddy deployment test, browser UI/repository suites, and real
runner/Git/checkpoint/handoff integration passed. The real browser import made
1,001 files available to a teammate in about 2.1 seconds on this development Mac;
this is a fixture result, not a production latency promise.

Desktop policy tests and the real Electron/bundled-runner smoke test passed.
Slack/Discord protocol and production HTTP fixture tests passed. The encrypted
restore/configuration drill and Docker secret-exclusion check passed. ESLint has
zero errors and seven existing warnings in unchanged image/test code. CI repeats
the Linux checks, production image startup, and the isolated restore drill.
