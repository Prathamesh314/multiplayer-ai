# Storage admission and accounting

The supported production profile uses one repository host, a shared local Git
and activity volume, and PostgreSQL shared by every web/worker process. Quota is
the sum of file lengths, including Git packs, indexes, refs and compressed activity
objects. It is not a filesystem block quota: hardlinks are counted per path, while
database files, embeddings, logs, backups and temporary workspaces are outside
the owner counter. Keep separate host disk monitoring and backup retention.

## Admission and concurrency

Migration `049_storage_accounting.sql` adds owner totals, per-resource totals,
pending reservations and a singleton capacity counter. A warm `ownerStorageBytes`
call is one indexed database read; it does not enumerate repositories or turns.
The first initialization inventories existing paths once. Activity inventory lists
actual activity directories and resolves their owners instead of probing every
historical turn for a directory that usually does not exist.

Every mutation holds its repository or activity-turn kernel lock. Other resources
can execute concurrently, including resources belonging to the same owner.
Admission briefly locks capacity then owner rows in that order, checks usage plus
pending reservations, and books capacity atomically across replicas. The capacity
transaction includes one `statfs` call but no directory walk, Git command, or lock
probe. Existing database statement, lock, idle-transaction and total transaction
deadlines apply. There is no SQL transaction spanning a Git mutation or its scan.

There are no fixed reservation slots. Disk headroom is twice the requested growth
with a 4 KiB minimum instead of 256 MiB per operation. Conservative operation
budgets still apply: ordinary Git writes reserve 32 MiB of quota, pushes 160 MiB,
and imports/copies increase their reservation when needed. Therefore a tiny Git
edit can still be refused near quota/free-space limits. The configurable defaults
remain 10 GiB per owner and a 2 GiB free-space floor. Git and activity storage must
share the monitored local filesystem; S3 and cold Git archives remain unsupported
with admission enabled.

## Recording actual usage

Git controls compressed loose objects, packs and index files, so logical input
sizes are insufficient to derive exact disk deltas. Each completed or failed Git
operation scans **only the affected repository once**, then atomically updates its
resource/owner totals and releases its reservation. This scan remains linear in
that repository's file count. This change removes organisation-wide scans and
duplicate sizing walks; it does not make writes to one huge repository constant
time. Copy/fetch sizing reads the source's stored counter.

Successful activity uploads record the compressed file's before/after sizes under
the turn lock. They do not sum uncompressed batch-row sizes: retries and identical
content at multiple sequences can share the same object. A failed upload is
remeasured because an atomic file rename can survive a database rollback. Those
orphan bytes remain charged; retrying the same object does not charge it twice.

Filesystem mutation and PostgreSQL cannot commit in one atomic transaction.
The durable reservation is consequently also a dirty marker, created before any
write. If the process dies or settlement fails, both marker and reserved capacity
remain. Before another write, the next holder of that resource lock remeasures it
and settles the old reservation. Settlement failures never silently clear it.

The worker checks up to 100 reservations per sweep, starting with unchecked/least
recently checked entries, once a minute. A reservation's age only selects recovery
candidates. Recovery must acquire the same kernel lock; it cannot reclaim a
stopped writer or a Git child that outlives its parent. Probes happen in recovery,
outside capacity transactions, rather than on each admission. Busy/failed entries
rotate so they cannot indefinitely starve later entries.

## Upgrade and maintenance

For migration 049, stop all old web/worker writers, apply migrations, then run
the bootstrap using the new worker image before reopening admission. The production
deployment script enforces this order and keeps services stopped if a backfill
fails after the schema changed. Back up the database and shared volume together.
See [production deployment](production-deployment.md) for the complete procedure.

From a checkout with the correct database/storage environment:

```sh
NODE_ENV=production npm run storage:accounting -- --bootstrap
NODE_ENV=production npm run storage:accounting -- --recover
NODE_ENV=production npm run storage:accounting -- --reconcile
```

For the deployed Compose stack, use the container's environment and volume paths:

```sh
docker compose --env-file .env.production -f compose.production.yml exec -T worker node --import tsx scripts/storage-accounting.ts --recover
docker compose --env-file .env.production -f compose.production.yml exec -T worker node --import tsx scripts/storage-accounting.ts --reconcile
```

`--bootstrap` skips initialized owners. `--recover` handles one bounded batch and
prints recovered, busy and failed resources; failed entries produce a nonzero exit
status. Repeat for additional batches or let the worker drain them. `--reconcile`
performs a full inventory, measuring resources individually under their locks and
correcting totals. It can run alongside current writers but is deliberately
expensive. Use it after reviewed out-of-band cleanup, storage restoration, or
filesystem repairs. It includes tracked orphan paths even if their metadata was
removed. Direct filesystem writes must not bypass admission during normal service.

Unexpected symlinks, sockets and other non-regular entries are not followed or
deleted. Their own `lstat` sizes are charged and an anomaly is recorded on their
resource. Writes to that resource fail with an actionable message; other clean
repositories under the same owner remain usable. An administrator must inspect
the path, repair it and reconcile. Permission/I/O errors fail closed rather than
being converted into a false zero-byte measurement.

Git garbage collection and retention are separate work. Automatic Git GC remains
disabled; this change does not prune objects, history, reflogs or abandoned import
indexes. Deleting a tracked file does not necessarily reclaim its historic Git
objects. Reviewed cleanup followed by reconciliation can reduce recorded usage,
but there is still no automatic Git reclamation or in-product cleanup workflow.

## Verification and performance

`npm test` includes admission-enabled tests on PGlite. CI additionally runs the
same suite on PostgreSQL, including competing writers in separate processes,
SIGSTOP, parent SIGKILL with surviving Git children, rollback after a file write,
failed settlement recovery, exact compressed activity accounting, small disk
reservations, and anomaly isolation. The scale fixture instruments filesystem
calls for an owner with 5,000 unrelated files and 3,000 historical turns, checking
that a normal activity write performs no directory walk. Eight owners overlap
using one kernel-lock helper per operation and no reservation-probe helpers.

Run the disposable benchmark with `npm run bench:storage`. On a warm local Mac
SSD with PGlite, five samples produced these medians on 2026-10-07:

| Operation | Median |
| --- | ---: |
| Usage read, empty owner | 0.15 ms |
| Usage read, 5,000 files / 3,000 turns | 0.16 ms |
| One-byte write to a small repo in that owner | 27.00 ms |
| One-byte write to the 5,000-file repo, including its settlement scan | 124.51 ms |
| Warm activity upload in that owner | 36.07 ms |

These synthetic results demonstrate which costs depend on historical data, not
production latency guarantees. They use real local files and kernel locks with
admission explicitly enabled. Network PostgreSQL, slower disks and larger changed
repositories will have different costs.
