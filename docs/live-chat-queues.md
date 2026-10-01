# Live updates and messages during an AI run

The browser uses a shared SSE connection per room and a shared account SSE
connection. Redis pub/sub announces changes across server processes. Components
refresh on an announcement, reconnect, or user interaction; they no longer poll
for tasks, handoffs, devices, provider catalogs, room rosters, or history.
SSE is the server-to-client push transport; normal authenticated HTTP requests
remain the write transport. A WebSocket service is not needed for these flows.

## Message delivery

While your agent works, use **Queue message** below the chat. The driver can
remove a message until an executor claims it. Teammates can see queue state.
Messages and acknowledgements are durable in PostgreSQL's `agent_run_inputs`;
Redis only provides wakeup notifications. The existing BullMQ queue still
schedules server execution turns. Local execution uses durable `runner_jobs`.
The input queue shares the same database transaction and control checks as the
chat, so it does not need a second BullMQ job for every instruction.

- **Codex:** one app-server thread stays alive. `turn/steer` adds instructions to
  the active turn using its expected turn ID. Codex determines when it consumes
  the instruction; this cannot change a tool command already running. If the
  response has just finished, the instruction starts another turn in the same
  thread. See the [official app-server protocol](https://developers.openai.com/codex/app-server).
- **Other CLI providers:** the current process completes, then queued instructions
  run sequentially in the same workspace with bounded prior conversation context.
  The UI explicitly says “queued for the next response.” These providers do not
  yet support mid-turn injection in this application.

Claiming is FIFO, one instruction at a time, scoped to an execution turn. Stable
request IDs make network retries idempotent. Acknowledgement saves the additional
user message to the shared transcript. Provider acceptance means the instruction
was submitted; it does not guarantee the requested work succeeded.

An empty-queue check closes intake atomically with the chat lock before execution
finishes. A late submission receives an error and keeps its draft. A failed or
recovered execution marks undelivered inputs failed and claimed inputs unconfirmed.
Unconfirmed instructions are never automatically replayed: inspect output first,
then explicitly copy one back into the composer if needed. This avoids claiming
exactly-once delivery across a process or network failure.

Only the current driver with editor access and the current control version can
submit or cancel inputs. Devices must own the live execution lease. Per turn:
50 non-cancelled messages, 32,000 characters per message, 256,000 characters total.
Execution retains a ten-minute deadline and bounded output across follow-ups.

## Runner connection and liveness

The runner opens `/api/runner/events`, then claims work only at startup, after
finishing a job, or when the server announces work/reconnect. Older runners can
still long-poll `/claim`; waiting is pub/sub driven instead of repeatedly querying
SQL. The browser and runner read durable state after reconnecting. Slow readers
are disconnected, and the runner reconnects if keepalives stop.

Liveness is intentionally separate from data polling:

- The runner's SSE connection renews **device presence** every 15 seconds.
- Only the process executing a job sends its lease renewal every 15 seconds.
  A restarted daemon cannot renew an abandoned job by merely reconnecting.
- Browser presence still sends a lightweight heartbeat every 20 seconds, whose
  online-user response now updates the roster without another members request.
- Local checkpoint/outbox maintenance continues every 30 seconds. Unchanged
  provider inventories and empty activity buffers do not generate refresh calls.

Deploy migration `038_chat_input_queue.sql`, rebuild the app, and update/restart
runners together. New runners advertise `supportsInputs`; old runners cannot
claim executions with pending inputs. Redis is required for local execution and
cross-process push. Single-process development can use the memory event bus.
Durable input survives a restart, but failed AI execution is not automatically
resumed. After an interrupted execution, recover control and review its inputs.

## Validation

`npm run test:live-chat` exercises wakeup races, shared streams, cancellation,
Redis subscription races, Codex steering and completion-boundary behavior,
uncertain delivery, and sequential CLI delivery with deterministic fake agents.
`npm run test:handoff` covers database ordering, permissions, retries, cancellation,
intake closure and failed-input handling. Its real PostgreSQL/browser mode also
checks idle network traffic, the working-chat composer and live acknowledgements.
No paid model inference is required by these tests.
