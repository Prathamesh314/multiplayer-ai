# Runtime Git storage and recovery

`APP_ENV=testing` uses the existing local repositories under
`MULTIPLAYER_AI_DATA` (default `.multiplayer-ai`). `APP_ENV=development` and
`APP_ENV=production` use S3-compatible object storage. If APP_ENV is absent,
NODE_ENV is used (`test` maps to testing); an absent NODE_ENV means development.
Do not set `NODE_ENV=testing` in Next.js.

Configuration is read when an operation starts and pinned until it finishes.
Changing configuration does not require rebuilding the app. Cloud mode fails
closed when configuration, S3, or Postgres is unavailable; it never acknowledges
a durable write by falling back to local disk.

## Architecture and implementation

```text
Web / worker / authenticated Git HTTP
              |
       session/repo.ts              public GitService boundary
              |
       git-storage/service.ts       hydration, leases, fencing, publication
          /              \
     Postgres        GitObjectStore
     refs + leases   local (tests) / S3-compatible cloud
     generations     immutable, content-addressed Git bundles
              |
       repo-local.ts                Git CLI against disposable caches
```

The Git service is currently an application module used by web and worker,
coordinated through Postgres. The existing authenticated `/api/git/<repo>/...`
surface remains the runner's HTTP transport. This change does **not** deploy a
separate gRPC service or make Git/agent execution available inside an edge
runtime. Each Git-capable host still needs Git, Node.js, and writable temporary
space. Hosts do not share a Git filesystem.

Read these files first:

- [`config.ts`](../app/lib/git-storage/config.ts): runtime policy and per-process cache roots.
- [`objects.ts`](../app/lib/git-storage/objects.ts): pluggable object-store interface, local and S3 adapters.
- [`service.ts`](../app/lib/git-storage/service.ts): leased operations, checksum verification, and atomic ref publication.
- [`repo.ts`](../app/lib/session/repo.ts): all public repository operations.
- [`http.ts`](../app/lib/git-storage/http.ts): smart-HTTP responses are held until a push is durable.
- [`031_git_object_storage.sql`](../db/migrations/031_git_object_storage.sql): refs, leases, history, backfill jobs, and retention records.
- [`retention.ts`](../app/lib/session/retention.ts): archive, explicit deletion, grace, and restoration.

## Durable writes and concurrency

1. Acquire per-repository leases in a stable order. Every acquisition increases
   a fencing generation; leases expire after 45 seconds and renew every 10.
2. Rehydrate the node's bare repo and working cache from the current manifest
   if its generation differs. Verify the downloaded bundle's SHA-256 and refs.
3. Run Git against that cache. Agent turns use isolated temporary checkouts;
   successful finalized turns release their working directory.
4. Produce a self-contained bundle containing all refs, including `refs/turns/*`,
   and upload it under its SHA-256. The S3 adapter uses streaming multipart
   uploads for large bundles and aborts failed multipart uploads.
5. Atomically publish the bundle pointer, refs, and history in Postgres only
   while the writer still owns its lease. A stale worker may upload an orphan
   immutable object but cannot change the authoritative refs. Multi-repository
   publish updates the room and project manifests in one transaction.
6. Only then acknowledge the save or runner push. Dependent application head
   updates are fenced too. A failed upload leaves the previous manifest intact.

Seed batches are checkpointed so changing web nodes halfway through an import
does not lose earlier files. No code-context indexing happens until seeding
finishes. Read access still goes through room permissions and runner tokens;
cloud bucket credentials never go to browsers or runners.

This initial implementation stores a **full Git bundle per changed revision**,
not incremental packfiles. That makes recovery self-contained but increases
upload bandwidth and storage for large or busy repositories. Bundle history is
retained; automatic object garbage collection is deliberately absent. Git HTTP
requests are limited to 512 MiB and two minutes. Measure workload cost before
raising these limits or adding incremental packs.

The protocol choices follow the official [Git bundle documentation](https://git-scm.com/docs/git-bundle)
and [AWS SDK multipart upload guide](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-s3.html).

## Configuration

```dotenv
APP_ENV=development
GIT_S3_BUCKET=your-private-git-bucket
AWS_REGION=us-east-1
GIT_S3_PREFIX=multiplayer-git
# Other S3-compatible providers:
# GIT_S3_ENDPOINT=https://your-object-storage-endpoint
# GIT_S3_FORCE_PATH_STYLE=true
```

Use IAM/workload identity or the SDK's standard AWS credential environment
variables. The identity needs object reads, writes, and multipart abort
permissions under the configured prefix. The app does not create buckets or
change bucket policy. Web and worker must agree on database, bucket, prefix,
endpoint, and mode. `GIT_CACHE_DIR` chooses a parent for automatically unique
process cache directories; its contents are disposable in cloud mode.

Apply `npm run db:migrate` before deploying these code paths. A fresh cloud
installation can start directly in cloud mode. Existing disk-based installations
must complete the following migration first.

## Migration without losing existing rooms

1. Keep the existing disk/volume and its backup. Set `APP_ENV=development` (or
   production), cloud credentials, and `GIT_STORAGE_PHASE=shadow` on the existing
   host. Shadow mode continues reading the legacy `MULTIPLAYER_AI_DATA` root
   while requiring successful cloud publication for new acknowledged writes.
   This is a migration mode, not a topology for independent disk-based replicas.
2. Run `npm run storage:backfill`. It queues every bare room/import/project repo
   found under the legacy root. Run the worker on that same host to drain jobs;
   inspect `git_storage_jobs.last_error` for failures. Jobs retry after failures.
3. Stop writes briefly and wait for the queue to empty. Run
   `npm run storage:verify`. It downloads bundles into a separate temporary
   cache and compares every ref with the legacy source. Do not flip on a failure.
4. Set `GIT_STORAGE_PHASE=cloud` on all web/worker processes and restart them.
   Confirm reads, a save, a publish, and a runner clone from a fresh node.
5. Keep the old volume through your rollback period; only then decommission it.
   The migration commands never remove it automatically. Once cloud writes have
   begun, switching back to stale shadow disks is not a safe rollback.

Changing to a different bucket/prefix later also requires copying and verifying
the referenced objects first; configuration changes alone do not move data.

## Retention and deletion

Inactivity only archives. Before removing room/import working copies, the app
records a restorable bundle for every initialized repository. Active runs are
skipped. `MULTIPLAYER_AI_ARCHIVE_DAYS` defaults to seven; the old automatic
`MULTIPLAYER_AI_DELETE_DAYS` policy is removed.

Organization owners/admins can explicitly request deletion. Personal-room
owners have the equivalent authority for their own rooms. The server requires
the exact room name as confirmation:

```text
POST /api/sessions/<id>/retention
{ "action": "delete", "confirmName": "Exact room name" }

POST /api/sessions/<id>/retention
{ "action": "restore" }
```

Deletion first creates a backup record and hides the room with a tombstone.
After a seven-day grace period, the sweep may remove local copies. Cloud bundles,
metadata, messages, and IDs remain available for restoration, including after
the grace period. Permanent destruction of archived objects is a separate
operator policy and is not performed by this code. Restoring local testing
backups requires the original local archive directory.

## Validation

`npm run test:git-storage` tests real Git with isolated PGlite metadata and a
local implementation of the object-store contract. It covers independent node
caches, concurrent writers, failed uploads, stale lease fencing, corrupted
bundles, seed recovery, project publication, HTTP advertisements, push durability,
and retention.
It also tests the actual AWS SDK signing and multipart implementation against a
simulated HTTP transport. `npm test` runs this alongside the existing suites.

These tests do not provision or contact a real cloud bucket. Validate credentials,
provider compatibility, and recovery with your bucket before production cutover.
