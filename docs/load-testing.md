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
```

Rebuild after changing application code. The harness deliberately does not run
against the development compiler. Larger profiles are explicit; they do not run
as part of `npm test`.

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
- Peak live streams, unexpected disconnects, received messages, missing own
  messages and deliveries to already-connected room members, and event-delivery
  latency. Receiving a message from the wrong room fails the stream check.
- Peak Next.js process RSS (via `ps` on macOS/Linux), load-generator RSS and
  event-loop delay, and fixture database/disk growth. These are process metrics;
  PostgreSQL/Redis memory and total host CPU are **not** measured.
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
load-balanced replicas. History requests use chats with no AI turns, so they
measure metadata access rather than large diff/replay payloads.

The generator, server and usually PostgreSQL/Redis share one machine. A passing
small local run validates the harness and the exercised behavior, **not** a
production 1,000-user capacity claim. Record hardware, profile, achieved request
rate and failure/latency results together. A large generator event-loop delay
also makes the measurement suspect. Use dedicated services and repeat larger
profiles before drawing capacity conclusions.
