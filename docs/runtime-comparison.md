# Go versus TypeScript: measured prototype comparison

Measured September 30, 2026. The database and Git workloads were close between
these implementations. Go was about **20× faster on this integer-heavy graph
algorithm** and **2.9× faster on the CPU-heavy mixed workload with 10,000 live
connections**. That supports investigating Go for a measured compute bottleneck;
it does not justify rewriting all business logic.

Across both prototypes, **352,538 timed requests completed with zero request or semantic
failures**, plus **176,000 verified event deliveries without loss, duplication, or
cross-room delivery**. All four trials passed ten contract-test groups, including
intentional overload rejection and recovery. Database task counts reconciled
exactly, no streams remained open, and all temporary schemas/files/processes were
cleaned up. Expected 503 responses in the explicit overload contract test are not
counted as failures of the separate timed workloads.

## Results

Throughput is the arithmetic mean of two trials per runtime. Latency is the range
of per-trial p95s, in milliseconds; for multi-operation scenarios it is the
**slowest operation's p95**, not a pooled percentile. Higher throughput is better;
lower latency is better. The fixed-rate test intentionally caps arrivals, while
other rows primarily measure closed-loop capacity.

| Workload | TypeScript req/sec | Go req/sec | TypeScript p95 ms | Go p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Database reads | 3,237.12 | 3,259.35 | 88.5–94.1 | 85.5–87.8 |
| Task transactions | 2,202.41 | 2,090.32 | 64.5–65.9 | 67.7–71.9 |
| Fixed 1,000 reads/sec | 999.72 | 999.62 | 5.5–5.6 | 5.2–5.8 |
| Saturated database pool | 87.25 | 86.12 | 1,468.6–1,489.3 | 1,493.4–1,508.4 |
| CPU graph traversal | 25.57 | 509.51 | 1,252.7–1,265.7 | 81.2–83.7 |
| 10,000-file snapshot comparison | 105.59 | 131.75 | 167.1–173.5 | 230.0–235.3 |
| Git diff | 113.30 | 109.98 | 341.6–344.9 | 350.1–360.4 |
| Mixed work + 1,000 live users | 467.20 | 1,313.84 | 2,703.1–2,744.0 | 118.6–123.5 |
| Mixed work + 10,000 live users | 431.84 | 1,241.38 | 2,829.2–3,073.2 | 138.4–142.6 |

The snapshot result is an important exception to a simple speed ranking: Go had
higher throughput but worse p95 latency in the standalone snapshot scenario.
Task writes and Git diffs were slightly faster in TypeScript here. Two short
repeats are insufficient to treat small differences as decisive.

With 10,000 connected users, sampled peak service RSS was **869–1,001 MiB for
TypeScript** and **687–691 MiB for Go**. This is process memory, not total machine
memory or disk storage. PostgreSQL and the generator are excluded. Earlier
workloads in each trial can influence retained heap size; this is not an idle
per-connection memory measurement.

Event-delivery p95 with 10,000 connections was **87–96 ms for TypeScript** and
**122–131 ms for Go**. Thus Go's much better CPU-heavy request latency did not
translate into lower broadcast latency in this test. Every expected event arrived
in both implementations. The generator's p99 event-loop delay in those scenarios
was approximately 22 ms, including the monitor's 20 ms resolution.

## What was tested

- Same machine: macOS arm64, 12 logical CPUs, 16 GiB RAM, Node 24.14.0,
  Go 1.26.1, and the same local PostgreSQL database.
- Same SQL, real application migrations and room permission function, 10 database
  connections, four simultaneous compute jobs, and 256 generator HTTP connections.
- 10,000 accounts in 1,000 rooms, 100,000 initial tasks, reset for each trial.
- Two rounds in TypeScript → Go → Go → TypeScript order. Each timed scenario runs
  for ten seconds plus in-flight request drain; pool saturation uses a fixed
  256-request batch instead.
- Snapshot comparisons use two 10,000-file manifests. Graph work performs 32
  traversals of a generated 20,000-node graph. Git runs against a real 500-file
  repository with 175 changed paths.
- Mixed work is 70% database reads, 20% task writes, 5% graph computation, and 5%
  large snapshots, with 128 concurrent requests and separate live connections.
  There are 1,000 and 10,000 live-user stages, with four broadcast cycles each;
  the first cycle overlaps request traffic.
- Authentication failures, token revocation, cross-room denial, viewer restrictions,
  64 simultaneous duplicate task writes, conflicting retries, authorized task
  completion, oversized/invalid input, client cancellation, and 512-request CPU
  overload are checked before timing. Computation outputs and durable task counts
  are checked as well as HTTP status codes.

The Go race detector and fixed computation-vector tests are separate from timing.
TypeScript uses persistent worker threads for compute work; the comparison does
not deliberately block its HTTP event loop with graph traversal.

## What this means for the application

1. **Keep database and ordinary business logic in TypeScript for now.** At 1,000
   scheduled reads/sec, both prototypes had roughly 5–6 ms p95. When ten database
   connections were deliberately occupied by 100 ms operations, both fell to
   about 86–87 requests/sec with roughly 1.5-second p95. Go did not remove that
   database queue.
2. **Consider Go for a proven CPU bottleneck.** This graph algorithm clearly
   benefits, and Go also had much lower snapshot latency in the CPU-heavy mixed test.
   Profile the actual application's expensive operations before deciding which
   component to move. Queue isolation and worker design also affect the result.
3. **Do not extrapolate these numbers to the full application.** These prototypes
   omit Next.js rendering/middleware, Redis distribution, durable activity storage,
   AI execution, offline replay, and many workflows. The 10,000 live connections
   coexist with 128 active mixed requests; this is not 10,000 concurrent expensive
   requests. The earlier full-app 10,000-user latency problem remains a separate
   capacity and queueing issue.
4. **Validate any migration in the real deployment.** Use a separate load-generator
   machine, longer soak tests, production-like data/networking, full permission
   and persistence behavior, and matching CPU/memory limits. Runtime, driver,
   parser, and algorithm choices are all part of these results.

The application runtime was not changed by this experiment. The prototypes are
kept outside application routes and workers.

Validation passed: full `npm test` (including 6,275 room-permission parity checks),
production `npm run build -- --webpack`, prototype computation tests and Go race
detector, TypeScript checking, and lint on all new JavaScript/TypeScript code.

## Artifacts and reproduction

- [Prototype code, commands, methodology, and limitations](../benchmarks/runtime/README.md)
- [Complete measured hard-run report](../benchmarks/runtime/results/2026-09-30-hard.json)
- [Existing full-application load tests](load-testing.md)

```sh
npm run bench:runtime:build
npm run bench:runtime:test
npm run bench:runtime -- --profile hard
```

Preliminary failed smoke/stress runs exposed a PostgreSQL URL-options parsing
mismatch, expected cancellations being classified as internal errors, and a
localhost TCP connection-burst limit. These were corrected before the retained
successful run. The overload test now paces socket establishment in 32-connection
batches while still exceeding the compute queue's capacity. An unnecessary
second manifest-decoding pass in Go was also removed before the final run.
