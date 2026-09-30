# Go / TypeScript runtime experiment

Two isolated HTTP prototypes implement equivalent operations against the application's
real PostgreSQL schema. They do not replace any application routes, desktop code, or
workers. Do not expose these experimental servers publicly.

## Reproduce

Requires macOS or Linux, Node 24+, Go 1.26+, Git, the installed npm dependencies, and PostgreSQL with
the application's extensions available. The harness loads `.env*` through `@next/env`.
Set `LOAD_TEST_DATABASE_URL` to a disposable PostgreSQL instance if available;
otherwise it uses `DATABASE_URL`. The database user needs permission to create and
drop schemas. No production application schema is mutated, but the test consumes
database resources, so use a development instance.

```sh
npm run bench:runtime:build
npm run bench:runtime:test
npm run bench:runtime -- --profile smoke
npm run bench:runtime -- --profile hard
```

Hard mode defaults to two rounds, ten seconds per timed scenario, 10,000 users,
1,000 rooms, and 100,000 initial tasks. Order is TypeScript → Go → Go → TypeScript.
Change duration with `--seconds 30` or repetitions with `--rounds 3`.
Reports are written to `.load-test-results/runtime-<timestamp>.json`.
`SIGINT` stops scheduling traffic and cleans up owned servers, temporary files,
and the isolated `load_test_*` schema. Do not force-kill the harness if cleanup is
required. Builds belong in the ignored `.test-build/runtime/` directory.

## What is held constant

- One HTTP service process, PostgreSQL pool of 10, identical SQL in `sql/queries.json`.
- Four CPU jobs at a time. TypeScript uses four persistent worker threads; Go uses
  four job slots and `GOMAXPROCS=4`. This is not an OS-enforced equal CPU quota:
  Node also has its event loop and internal threads.
- Unprepared parameterized queries (`pg` and pgx `QueryExecModeExec`), permission
  checks through `room_access_role`, identical payloads, no response caching.
- Generator HTTP pool of 256 connections, separate live-connection pools,
  15-second request deadlines, 2 MiB request bodies, 70-second keep-alive.
- Loopback-only listeners and a random per-process benchmark key. Bearer tokens
  are also required for database and room operations.
- Same pre-generated snapshots, graph inputs, and Git commits. Git is invoked
  directly with hooks, text conversion, external diff, and global config disabled.

Each runtime starts fresh. Tasks are reset before each trial; JIT and database
caches are warmed before measurement. Both query implementations use the same
indexes and real database permission function. The graph uses explicitly defined
32-bit overflow arithmetic, and fixed vectors verify both implementations.

## Workloads and correctness

| Scenario | Hard-mode work |
| --- | --- |
| Database reads | 256 concurrent requests alternating task lists and room rosters |
| Transaction writes | 128 concurrent permission-checked, idempotent task inserts |
| Fixed arrival rate | 1,000 scheduled reads/sec; queue time included; missed starts reported |
| Pool saturation | 256 requests, concurrency 128, each holding a connection for 100 ms |
| CPU graph | 32 concurrent requests; 32 BFS traversals of a 20,000-node generated graph |
| Snapshot analysis | 16 concurrent requests; two 10,000-file manifests, additions/changes/deletions |
| Git diff | 32 concurrent real Git processes; 500-file repository, 125 edits, 25 additions/deletions |
| Live collaboration | 1,000 then 10,000 authenticated streams; mixed reads/writes/CPU/snapshots and room fanout |

Every timed graph, snapshot, and Git response is checked against its expected
result. Every acknowledged task write is reconciled with the final database row
count. Live delivery checks recipient identity, room isolation, duplicates, losses,
and connection cleanup; one broadcast cycle overlaps mixed request traffic.

Before each trial, contract checks verify authentication, cross-room access,
immediate token revocation for new requests, viewer write rejection, concurrent
duplicate writes, conflicting retry rejection, assignment completion permissions,
invalid/oversized bodies, and recovery after canceled database requests. Hard mode
also sends 512 concurrent CPU requests to exercise bounded queue rejection and
recovery. Expected 503s in this explicit overload test are separate from failures
in timed normal workloads. Go tests include the race detector.

## Reading the reports

Latency is measured at the client through response-body consumption, including
connection pool wait. Fixed-rate latency starts at the scheduled arrival time,
not the actual dispatch time. Other scenarios are closed-loop concurrency tests;
they measure capacity and queueing, not a guaranteed arrival-rate SLO.

Each scenario records throughput, p50/p95/p99/max latency, status counts, semantic
failures, database acquisition and query timing, service CPU, sampled process-tree
RSS, and generator event-loop delay. CPU includes the service's own threads but
excludes child Git CPU; RSS includes sampled child processes. Two-second RSS
sampling can miss short peaks. Database and generator resources are not charged
to service RSS. Server-Timing's `db` value includes client-side query round trips.

## Limits of the experiment

- These are smaller prototypes, **not** the complete Next.js application. Do not
  compare their throughput directly with earlier full-app load tests as a rewrite
  speedup. They omit Next middleware/rendering, Redis distribution, durable event
  storage, AI execution, checkpoint uploads, and several application workflows.
- Live events use an in-memory single-process bus. This tests connections and
  fanout, not offline activity persistence, reconnect replay, or cross-server
  permission revocation. Connected streams are authenticated on opening only.
- Connections are not the same as active requests: 10,000 streams coexist with
  128 concurrent mixed requests, not 10,000 simultaneous expensive operations.
- Both services, the generator, PostgreSQL, and Git share this machine. Network,
  database, JSON parsing, generator limits, GC, and scheduler contention affect
  results. A dedicated remote generator and production-like deployment are needed
  before making capacity guarantees.
- Frameworks/drivers/parsers differ. This compares these implementations, not an
  intrinsic speed ranking of languages. TypeScript snapshot work includes worker
  message copying; Go uses standard JSON decoding and goroutines.
- Git is tested separately from 10,000 streams because macOS process spawning can
  fail when inherited descriptor numbers exceed its spawn limit.
- Two short repeats identify direction and variability, not statistical confidence
  or long-running leak freedom. Slow-reader attacks and real network partitions
  are not covered by the current suite.

Use the measured results to decide whether a particular component merits a Go
prototype in the real application. A wholesale rewrite is a separate decision
requiring full feature parity and an end-to-end deployment comparison.
