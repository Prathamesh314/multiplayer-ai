# Collaboration load test

The harness starts its own **production Next.js server on loopback**, creates a
random PostgreSQL schema and temporary Git repositories, and runs authenticated
virtual users against the real HTTP APIs. It uses PostgreSQL and Redis from
`LOAD_TEST_DATABASE_URL` / `LOAD_TEST_REDIS_URL`, falling back to the usual
`DATABASE_URL` / `REDIS_URL` from the local environment. Use development or dedicated
test services: the schema is isolated, but CPU, connections and disk bandwidth
are shared with other databases on those services.

No paid AI calls, AI jobs, external messages, or real user credentials are used.
There is no arbitrary target URL option; all workload requests go to the child
server after its fixture account has been verified.

## Run

Start PostgreSQL and Redis, install dependencies, and build once:

```sh
npm run build -- --webpack
npm run test:load:unit
npm run test:load                         # 10 users; 3s ramp + 20s steady
npm run test:load -- --profile=100        # 100 users; 20s ramp + 60s steady
npm run test:load -- --profile=1000       # 1,000 users; 60s ramp + 120s steady
npm run test:load -- --profile=10000 --workers=4
```

Rebuild after changing application code. The harness deliberately does not run
against the development compiler. Larger profiles are explicit; they do not run
as part of `npm test`.

API request protection is now enabled. This direct-to-Next harness places all
virtual users in one untrusted `direct` ingress bucket; the default IP budget
will intentionally throttle large profiles. For a **capacity-only** experiment,
raise only that synthetic shared-ingress budget explicitly, retaining per-user
limits, and record these overrides with the result:

```sh
API_RATE_INGRESS_PER_MINUTE=1000000 API_RATE_INGRESS_BURST=1000000 npm run test:load -- --profile=1000
```

Do not copy those ingress values into production. Gateway/per-user protection
and outage behavior are exercised separately by `npm run test:deployment`.
The historical measurements below predate this API limiter and are not a
latency measurement of the current build.

On macOS/Linux, check `ulimit -n` before large runs. Each live stream needs a
socket in both the generator and server; HTTP traffic needs additional sockets.
If the shell has a small soft limit and the hard limit allows it, use
`ulimit -n 65536` in the test shell before starting the harness. This changes
only that shell and its children. The largest supported profile is 10,000 users.

Override settings for a specific experiment:

```sh
npm run test:load -- --users=250 --room-size=25 --ramp=30 --duration=120
npm run test:load -- --users=100 --poll-ms=1000 --write-ms=10000
npm run test:load -- --profile=100 --p95-ms=2000 --error-rate=0.005
npm run test:load -- --help
```

`--duration` is the steady window, after `--ramp`. Setup, warmup, final request
completion and delivery draining take additional time. `--sse=0` disables event
streams to isolate HTTP/SQL throughput. `--port=0` selects an available port;
an explicit port must be free.

The generator now uses separate Undici pools for event streams and HTTP requests.
`--http-connections=256` bounds HTTP sockets (range 1–4,096); each requested live
stream still has its own socket. The final comparisons use the default 256
HTTP connections with `--profile=1000` and `--profile=10000 --workers=4`.
Each transport is split
into pools of at most 64 connections, preserving the exact total socket budget
while avoiding large linear scans in Undici's dispatcher. Time waiting for an HTTP connection
counts toward request latency and the timeout. There are no automatic retries
to hide failures. This transport differs from the original unbounded shared
pool, so record the connection limit when comparing results.
HTTP uses Undici's request API to avoid the extra Fetch/Web Streams allocation
cost; SSE still consumes streamed events. Each user's timer sleeps until the
next scheduled operation instead of waking ten times per second while idle.
Poll/write periods and response validation are unchanged.

Do not confuse file-descriptor limits with available TCP source ports. On this
Mac, 10,000 SSE connections plus a 4,096-connection HTTP pool and sockets in
TIME_WAIT exhausted the local ephemeral-port range (`EADDRNOTAVAIL`). A
smaller HTTP budget leaves more headroom; the final run uses 256. For production capacity
measurements, use a separate load-generator host and check its port budget too.

`--keep-alive-ms=70000` matches `npm run next:start`, the production container,
and the desktop's local production server. It controls idle HTTP connection
reuse, not request execution time: requests still have a 10-second client
deadline. A short diagnostic at 1,000 users changed this from 5,000 to 70,000 ms
and eliminated the observed connection resets. Keep the application's timeout
longer than any downstream proxy's idle timeout, as described in
[Next.js deployment guidance](https://nextjs.org/docs/app/api-reference/cli/next#configuring-a-timeout-for-downstream-proxies).

`--workers=1` is the default; `--workers=4` starts four Next.js processes sharing
one port through Node's cluster module. This matters on macOS: even with a higher
`ulimit`, `posix_spawn` cannot wire a child-process descriptor at or above 10,240.
More than 10,000 live sockets in one process caused Git reads to fail with
`spawn EBADF`. A separate reproduction opened 10,300 read-only `/dev/null`
descriptors: `git --version` failed, then succeeded after closing them.

Hosted deployments can use `WEB_CONCURRENCY=4 npm run next:start` (or set
`WEB_CONCURRENCY` for the Compose web service). Multiple processes require
`REDIS_URL`, `LOCAL_RUNNERS=1` and `MULTIPLAYER_AI_TERMINAL=0`; startup rejects
incompatible settings. Local terminals and inline execution retain the default
single-process mode. All web processes must share the same database, Redis and
Git/object storage. Each adds a ten-connection database pool and its own bounded
Git read cache. Budget those resources before increasing concurrency. The
supervisor replaces failed processes with bounded restarts and shuts down all
workers on termination. This adds process concurrency, not additional machines.

Setup builds the first 20-file bare repository using the app's import path,
then copies it into independent repositories with separate session refs. The
measured workload and number of rooms/files are unchanged; this only removes
repeated fixture-seeding Git subprocesses before the timer starts.

## Workload

Each virtual user has a unique account, browser token and simulated device token.
Users share one organization and are grouped into projects/rooms (10 users per
room by default). Every room has a small 20-file Git repository; every user has
an existing chat. A virtual user:

- Signs in through its fixture session and holds a room SSE connection open.
- Polls chat tasks and its task inbox every 5 seconds.
- Reads teammate and room rosters every 15 seconds.
- Sends presence every 20 seconds and device identity/heartbeat requests every
  30 seconds.
- Reads the Git file tree, one file, and checkpoint/history metadata every
  30 seconds.
- Creates a task, retries the same request to check idempotency, and completes
  it as the recipient. The first and every fifth subsequent assignment start a
  new chat; the others use the existing chat.
- Sends a synthetic room message and consumes the resulting live events.

The first write happens shortly after activation so smoke tests exercise writes;
subsequent writes follow `--write-ms` (30 seconds by default). Users ramp in
gradually, and requests within a user are sequential. This is a **closed-loop**
workload: a slower server lowers the achieved request rate. It does not promise
a fixed arrival rate, and 1,000 connected users does not mean 1,000 simultaneous
HTTP requests. Reports include the actual peak requests in flight.

## Results and pass/fail

Each run writes `.load-test-results/<run>.json` and `<run>.server.log` (Git ignored).
The console prints steady-state request statistics. JSON also contains ramp-up
measurements, HTTP status counts, bounded failure examples, and:

- Per-operation count, error rate, p50/p95/p99 and maximum latency. Percentiles
  use bounded-memory logarithmic histograms with approximately 1% resolution.
  Latencies are grouped by request start phase, including slow responses that
  finish after the window. Steady requests/second counts responses completed
  inside the steady window, so a long final drain cannot inflate throughput.
  `successfulLatency` separately measures only semantically successful responses;
  the original overall latency/error gates remain in force. Transport errors
  include safe error codes such as `network:ECONNRESET`, without credential-bearing
  error messages.
- Peak live streams, unexpected disconnects, received messages, missing own
  messages and deliveries to already-connected room members, and event-delivery
  latency. Receiving a message from the wrong room fails the stream check.
- Peak aggregate web-process-tree RSS (via `ps` on macOS/Linux), load-generator RSS and
  event-loop delay, and fixture database/disk growth. These are process metrics;
  PostgreSQL/Redis memory and total host CPU are **not** measured.
  Summed RSS can count shared pages more than once; it is not unique physical
  memory consumption and is not directly comparable with older parent-only RSS.
  Generator event-loop maximum delay is also reported so rare stalls are visible.
  A separate sampler avoids the generator's own high-descriptor spawn limit;
  sample counts and failures are reported. Child server logs go directly to
  disk so logging does not wait on the generator's event loop.
- Checks that acknowledged tasks and completions exist exactly once, new task
  chats have tasks, and human assignments created no AI turns.
- Cleanup success and errors. Raw authentication tokens and connection strings
  are not included in the report.

Exit code **0** means the checks pass. Exit code **1** means setup, cleanup,
correctness, connection coverage, or a performance threshold failed. Defaults:
steady-state HTTP and event-delivery p95 at most 1,500 ms, error rate at most 1%, all users
activated, and all requested live streams reached. Interrupted runs fail rather
than presenting partial results as a successful benchmark.

Ctrl+C stops traffic, closes the child server, removes only this run's Redis
presence keys, drops only its random schema, and removes its temporary files.
The harness never flushes Redis or deletes the application's data directory.
A forced process kill or host crash cannot guarantee cleanup: the console prints
the `load_test_<uuid>` schema name for recovery. Review ownership before manually
removing leftovers.

## What the result establishes

This tests collaboration API traffic and live room connections. It does not
measure browser rendering, Electron performance, real AI inference, large Git
pushes/checkpoint uploads, archive eviction, long-term storage retention, or
separate-host replicas. Optional clustered runs exercise cross-process event
delivery on one host. History requests use chats with no AI turns, so they
measure metadata access rather than large diff/replay payloads.

The generator, server and usually PostgreSQL/Redis share one machine. A passing
small local run validates the harness and the exercised behavior, **not** a
production 1,000-user capacity claim. Record hardware, profile, achieved request
rate and failure/latency results together. A large generator event-loop delay
also makes the measurement suspect. Use dedicated services and repeat larger
profiles before drawing capacity conclusions.

## Local measurements — 2026-09-30

The production app from `5774d65` (harness baseline `f3f4d6c`) was tested on
macOS with Node 24.14.0, 12 logical CPUs and 16 GiB RAM. The generator and server
shared the host. Both profiles use 10 users per room, live streams, a 120-second
steady window, and the default 1% error / 1,500 ms p95 thresholds. The test shell's
file-descriptor limit was raised to 65,536; application settings were unchanged.

| Target users | Peak live users | Requests/sec in steady window | Failed requests, including ramp | Slowest endpoint p95 | Peak app RSS | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 1,000 | 783.0 | 2,528 / 126,707 (2.00%) | 2,439.60 ms | 682.0 MiB | Failed |
| 10,000 | 4,125 | 846.4 | 132,008 / 171,331 (77.05%) | 40,133.84 ms | 2,119.2 MiB | Failed; target not reached |

Requests/sec includes failed responses and is not successful-operation throughput.

The 1,000-user run used a 60-second ramp. No live streams disconnected and no
expected message deliveries were missed; event-delivery p95 was 1,938.14 ms,
above the threshold. Task persistence/idempotency checks passed. The HTTP
failures were recorded as network failures, with no HTTP error response; this
report does not identify their underlying socket error. Generator event-loop
p99 was 24.99 ms. Cleanup succeeded.

The 10,000-user attempt used a 120-second ramp. It recorded 20,851 HTTP 500
responses, 21,130 timeouts, 89,977 network failures and 50 HTTP 422 responses.
The server log repeatedly reported database-pool connection timeouts. A database
activity sample during the ramp showed nine active task-roster queries; the app
pool has ten connections. The roster query checks access across organization
members, making it a likely optimization target for this single-organization
workload. This sample is evidence of contention, not a complete query profile.

Generator event-loop p99 was 423.62 ms, so the reported large latencies include
load-generator delays. Sampled client sockets for the test server stayed below
the host's 16,384-port ephemeral range; this does not identify the underlying
causes of all network failures. The result is a failed local stress attempt,
not a measurement of capacity at 10,000 active users.

Task-count reconciliation also failed: 2,690 tasks were stored versus 2,224
acknowledged, and 1,119 completions were stored versus 1,071 acknowledged.
These excess writes are consistent with requests committing after a client
timeout or lost response; the count check alone does not establish duplicate
tasks or data corruption. No orphan task chats or AI turns were found. Cleanup
succeeded.

Raw reports on the test machine:

- `.load-test-results/2026-09-30T11-06-25.298Z-dbf918d1.json` (1,000 users).
- `.load-test-results/2026-09-30T11-11-22.105Z-b7d65a36.json` (10,000-user target).

These historical measurements do not establish production capacity or large-project
storage behavior. The following investigation found both application bottlenecks
and load-generator defects; they are not directly comparable to corrected runs.

## Performance changes and regression coverage

The original generator repeatedly composed request signals with one long-lived
signal using `AbortSignal.any`. A CPU profile on Node 24.14.0 showed nearly all
sampled CPU time in `internal/abort_controller` dependency-finalizer scans; one
10,000-user attempt recorded a 177,838 ms generator stall. The historical
latency/failure numbers above therefore include a serious generator defect and
must not be interpreted as server-only capacity measurements. Requests now use
explicit cancellation callbacks and clear timers/subscriptions on completion;
stream cancellation also avoids the shared composite-signal graph. Regression
tests verify that 10,000 concurrent requests share one parent listener and that
completion leaves no parent listeners behind. Ramp/idle timers use the same
constant-time subscription registry, avoiding repeated scans of thousands of
listeners in Node's EventTarget. Socket pools are sharded for the same reason.

- Task rosters resolve the caller once, then consider active room members,
  public-room project members and organization administrators. The authoritative
  permission function still filters every candidate; ordinary organization
  members no longer incur per-person permission checks. Migration
  `035_roster_lookup.sql` indexes the administrator lookup.
- Migration `036_room_access_lookup.sql` joins each membership once in the
  permission function, retaining its original revocation and viewer precedence.
  A parity test compares 6,275 decisions with the original function across
  organization/project/room roles, missing or removed memberships, suspended
  users, deleted accounts/rooms, and public/private/personal rooms.
- Login tokens are validated against current database state on every request,
  while `last_used_at` writes happen at most once per minute. Device tokens also
  retain live revocation checks, with liveness writes at most every 10 seconds
  (below the runner's 15-second heartbeat and 30-second online threshold).
  Unchanged device inventories are not rewritten on heartbeat.
- Room metadata and the caller's derived role are read in one database query.
- Full-commit Git file/tree reads share a process cache capped at 32 MiB and
  4,096 entries. Mutable refs, errors, missing files and objects over 1 MiB are
  not cached. Cache keys include repository, full commit ID and operation/path;
  callers still perform authorization before every read. Concurrent identical
  reads share work and receive independent buffers.
- Background task/history polling skips hidden pages and overlapping requests.
  History refreshes ignore responses belonging to an older run or refresh.
- Production HTTP keep-alive is 70 seconds to avoid the observed connection
  reuse/reset failures around the previous idle timeout.

Permission tests compare optimized rosters against `room_access_role`, including
private rooms, inherited access, viewers, suspended/deleted accounts and removed
project membership. Authentication tests cover immediate revocation/expiry,
profile changes and timestamp throttling. Cache tests cover isolation, mutation
safety, byte/entry bounds, shared reads and failure retries. These run alongside
the existing application suite; desktop unit and smoke tests remain separate.
`npm run test:server` (after a production build) also verifies replacement of a
crashed web worker, bounded restart failures, released ports and no orphan
workers after shutdown.

## Corrected final measurements — 2026-09-30

Same Mac: Node 24.14.0, 12 logical CPUs, 16 GiB RAM, local PostgreSQL/Redis and
the generator sharing the host. Both final runs use 256 HTTP connections,
70-second idle keep-alive, live streams and unchanged 1% error / 1,500 ms p95
gates. The 10,000-user run uses four web processes and the shell's 65,536 FD
limit. These are local measurements, not production capacity guarantees.

| Users | Web processes | Total requests | Failed | Steady requests/s | Slowest HTTP p95 | Event-delivery p95 | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 1 | 139,133 | 0 | 875.2 | 8.78 ms | 6.03 ms | Passed all gates |
| 10,000 | 4 | 650,980 | 0 | 2,748.1 | 5,217.68 ms | 4,674.07 ms | Failed latency gates |

The 1,000-user run maintained all streams and delivered all expected messages.
All 5,437 task assignments and completions reconciled, with no orphan chats or
AI turns. Cleanup passed. Peak aggregate web RSS was 1,314.9 MiB; generator
event-loop p99 was 21.14 ms and maximum delay was 155.45 ms.

All 10,000 live streams were established with no unexpected disconnects or
missing deliveries. All 38,011 acknowledged assignments existed exactly once;
all 36,873 acknowledged completions persisted. No orphan task chats or AI turns
were created, and cleanup passed. Aggregate web RSS peaked at 3,306.1 MiB;
generator RSS peaked at 744.3 MiB. All 126 server-memory samples succeeded.
Generator event-loop p99 was 29.11 ms, with a 1,450.18 ms maximum stall.
The fixture's Git disk size did not grow; database growth was about 48.4 MiB.

The failure problem is resolved in this corrected run, but 10,000-user latency
is **not** resolved to the target. Requests queued under the measured workload.
This result does not justify shipping a promise of fast service for 10,000
simultaneously active users on this host. Production sizing still needs a
separate generator, representative repositories/history, and database/web
capacity measurements on the intended deployment.

Earlier controlled comparisons are retained rather than hidden: four processes
with 1,000 HTTP connections also had zero request failures but a 6,835.29 ms
slowest p95. Eight processes with the same 1,000-connection budget performed
worse on this host: 34,485/383,212 requests failed and p95 reached 32,531.67 ms.
More processes are not an automatic improvement; the single-process production
default remains unchanged. The final run combines the permission-query update
and smaller pool, so it does not isolate their individual contributions.

Raw local reports:

- Final 1,000 users: `.load-test-results/2026-09-30T14-41-28.256Z-4d387ae9.json`.
- Final 10,000 users: `.load-test-results/2026-09-30T14-35-44.807Z-10480d0c.json`.
- Earlier four processes: `.load-test-results/2026-09-30T14-20-30.914Z-0f22652e.json`.
- Eight-process comparison: `.load-test-results/2026-09-30T14-26-17.083Z-bb983836.json`.

Validation: full `npm test`, production Webpack build, lint on changed code,
17 desktop unit checks, desktop smoke checks, and both server lifecycle checks
passed. Migrations 035 and 036 were applied to the local development database.

For the separate Go versus TypeScript experiment, see
[the prototype comparison](runtime-comparison.md). Its smaller HTTP services and
different workload are not a direct speedup measurement against this full-app test.
