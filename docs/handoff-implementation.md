# Handoff and room implementation report

Implemented 11 September 2026 in the local `main` checkout based on `b665b24`. Changes are uncommitted and have not been pushed or deployed. The earlier [platform review](platform-review-2026-09-11.md) remains the product/architecture assessment; this report records the subsequent implementation of the [phased plan](handoff-and-room-plan.md).

## Outcome

The core milestone now works in an integrated test: Alice offers an existing conversation, Bob discovers and accepts it in another browser, and Bob continues that same conversation for two separate turns through his own authenticated runner. Alice cannot submit after ownership transfers. Acceptance itself does not execute an agent or spend provider credits.

Imported folders now become the selected repository and their files appear immediately. Chat, file reads, edits, and Changes share the same repository selection. The room layout works at desktop and narrow mobile widths.

This is a tested prototype milestone, not certification for unrestricted public multi-tenant hosting.

## Phase 1 — execution foundations

- Persistent conversations and individual execution turns now have separate identities. A transaction admits one active turn per conversation and checks current driver, control version, effective role, and concurrency limits.
- Each turn uses an isolated Git checkout. Runners push only their exact immutable candidate ref, not the canonical room branch. Canonical promotion checks the expected base, preserving newer editor changes rather than overwriting them.
- Completion records and transcript updates are idempotent. Durable completion intent allows reconciliation after an interrupted Git/DB finalization without rerunning a paid agent.
- Runner protocol 2 advertises supported, authenticated agent CLIs. Claims, heartbeats, events, pushes, and completion are bound to the individual turn and current ownership version.
- An unclaimed local job fails with a reconnect explanation rather than silently switching to server execution. After handoff, continuation requires the recipient's eligible runner.
- Runner completion reports are stored locally before delivery, retried after restart, and removed only after acknowledgement. Failed or malformed reports do not prevent other reports from being delivered.
- Redis module imports now use literal imports. Actual Next.js integration exposed the old variable-import failure that broke Redis-backed locks and event delivery.

## Phase 2 — handoff

- Named and open offers, acceptance, decline, cancellation, expiry, and history are persisted. The room inbox exposes incoming offers even when the recipient has not opened the sender's chat.
- Acceptance is an idle-boundary ownership transfer with a confirmed repository checkpoint and transcript sequence. Offers may wait while a turn is active; live model processes are not transferred.
- Concurrent acceptance and acceptance-versus-submission are serialized. Permissions are rechecked, including project viewers, removed members, suspended organization members, and private-room access.
- The room owner can recover eligible abandoned work. Expired leases and old ownership versions cannot deliver a late result over a newer turn. Active/completing work is not casually taken over.
- Continuation includes bounded recent messages and accepted handoff notes even when the optional memory service is unavailable. The existing full transcript remains stored; the prompt is not unlimited context.
- The UI names the current driver, distinguishes watching from driving, shows actionable handoff errors, and reconciles through durable polling and realtime invalidations.

## Phase 3 — imported repository correctness

- Tree, file, and Changes APIs validate the selected repository belongs to the room and read the confirmed bare-Git snapshot. Reads no longer reset a shared working checkout or regress the stored head.
- Imports select and open the uploaded repository automatically. Incomplete allocations and final seed requests support retries; transient upload failures have bounded retries and visible errors.
- Repository identity accompanies saves and file events. Switching repositories restores that repository's buffers and tabs; stale asynchronous reads cannot populate a different repository.
- Failed or conflicted saves block switching, closing, or leaving rather than claiming a successful flush. Dirty buffers are not overwritten by another person's update.
- New imports persist their original base SHA for Changes. Historical imports without a known base show an explicit explanation rather than a misleading diff.
- File operations reject traversal and symlinks, including symlinked parent directories. Read size limits are enforced before returning content.

## Phase 4 — room UI

- One visible repository selector controls the whole workspace, with import progress, errors, and file counts.
- Desktop keeps chat and code together; the chat/team sidebar is optional and the terminal starts collapsed.
- Mobile has separate AI Chat, Files & Changes, and Chats & Team views, with a compact header and non-overflowing status bar.
- Handoff uses an accessible dialog, recipient picker, note, state, and history. Resizers also support keyboard arrows.
- The terminal explicitly identifies itself as a server terminal, not the recipient's runner or selected imported repository. A detached stream is labeled Detach, not a misleading promise to stop the process.
- Imported standalone repositories do not expose the default room's publish/sync controls. Empty GitHub-linked projects explain that linking currently stores metadata; users must import a local checkout.

## Verification evidence

Executed locally against the implementation:

| Check | Result |
| --- | --- |
| Existing default test suites | Pass |
| Handoff/repository suite | 21 checks pass; includes state transitions, concurrency, authorization, Git isolation, stale results, symlinks, save failures, recovery, and completion retry |
| Same handoff suite against PostgreSQL with concurrent connections | 21 checks pass |
| Knowledge suite | 29 checks pass |
| TypeScript | Pass |
| Real Next.js API + PostgreSQL + Redis + two independent Chrome contexts | Pass |
| Browser folder upload, automatic repository selection, opening imported files | Pass |
| Real runner claim, smart-HTTP Git push, and completion APIs | Two successive turns after handoff pass; duplicate completion and old-driver refusal pass |
| Desktop 1440px and mobile 390px screenshots | Inspected; responsive room layout and imported code visible |
| Production webpack build | Pass, with BullMQ's optional `@valkey/valkey-glide` resolution warning |
| Default Turbopack build | Blocked by CSS worker/internal-port `EPERM`, including retry outside the sandbox |
| Global ESLint | Existing 8 errors and 4 warnings remain; errors are in OrgSettingsDialog and Electron CommonJS files |
| Changed-code targeted lint and whitespace check | No new lint errors; existing chat hook warning remains |

The browser integration uses real application APIs and Git transport, with deterministic simulated runner output. No real model invocation or provider spending was used. A real-provider smoke test on a configured recipient device is still appropriate before release. Failure tests inject specific states; they are not exhaustive network chaos or power-loss testing.

### Reproduce

```sh
npm test
npm run test:knowledge
npx tsc --noEmit
npm run build -- --webpack

HANDOFF_TEST_POSTGRES=1 node --env-file=.env --import tsx tests/handoff.test.mjs
HANDOFF_TEST_POSTGRES=1 HANDOFF_TEST_BROWSER=1 node --env-file=.env --import tsx tests/handoff.test.mjs
```

The default handoff suite uses disposable PGlite and temporary Git repositories. PostgreSQL mode requires a `DATABASE_URL` whose account can create/drop a temporary schema. Browser mode additionally needs Redis, Chrome, and available ports 3103 and 9224. Set `CHROME_BIN` if Chrome is not at the default macOS application path. Browser builds use `.next-handoff-test` to avoid the normal development output. Test schemas, repositories, and browser/server processes are cleaned up; screenshots and server logs are written under `/tmp`.

## Local upgrade and rollout

Migrations `025_handoff_turns.sql` and `026_import_base.sql` were applied to the actual local database after verifying there were no active runs/jobs. A permission-restricted database backup was created first:

`/tmp/multicode-ai-before-handoff-20260911.dump`

That temporary backup is not a long-term production backup. Existing user application, worker, and runner processes were not restarted, and no cloud environment was changed.

For another environment:

1. Stop new submissions and drain active jobs. Back up both PostgreSQL and durable repositories; rehearse the upgrade on a copy.
2. Apply pending migrations with the environment's `DATABASE_URL`, for example `node --env-file=.env db/migrate.mjs`.
3. Upgrade and restart compatible web, worker, and local runner code together. This implementation requires runner protocol **2**; older runners are rejected rather than allowed to consume incompatible work. Existing pairing tokens can remain in place.
4. Start the bundled runner by signing in to the desktop app, or install the [standalone runner](../runner/README.md) and run `multicode-ai-runner start` on each participating user's device. Verify it reports an installed, signed-in provider. Restart the app and worker using their existing process manager.
5. Smoke-test a named handoff, recipient continuation, imported-file edit, and final diff before admitting normal traffic.

Do not roll back only the executable to a protocol-1 version while retaining queued protocol-2 work. Preserve history, completion intents, candidate refs, and runner outboxes during any recovery.

### Recovery boundaries

- If canonical code advances during a turn, the completion reports a conflict and preserves its candidate at `refs/turns/<turnId>`. Manual review/merge is needed; it is intentionally not an automatic overwrite.
- A failed completion delivery remains in `<runner data directory>/outbox`. Restore connectivity and run the runner to retry; do not rerun the model just to resend a result. Permanently rejected or malformed reports require operator inspection.
- Legacy runs already marked running without a turn record need operator review rather than automatic takeover. This is why draining work before upgrade matters.
- Reconciliation handles persisted completion intent and recognizes an already-promoted candidate. Arbitrary intervening writes or machine-level failures still require operational investigation.

## Remaining product and engineering work

The original product judgment is unchanged: focus on reliable team continuation rather than adding another broad editor/chat feature list. This implementation gives that proposition a demonstrable workflow. Validate it with real teams by measuring successful handoffs, time to resume, repeat weekly use, and whether teammates trust the resulting diff.

Before a public multi-tenant launch, resolve the remaining isolation, terminal-execution, secret-handling, and operational findings in the original review. Add a real-provider smoke test, production monitoring and recovery runbooks, deployment checks, and broader browser/accessibility coverage.

Explicitly outside this delivery: migrating a live CLI process, automatic private GitHub cloning/OAuth, new billing semantics or usage dashboards, SSO, cloud sandbox deployment, and a redesigned publish/sync workflow. Existing monthly/hourly quota accounting remains conversation-based; this work guards concurrent turn admission, not an entire billing migration. Historical import bases are not guessed, and interrupted imports are not a full remote synchronization protocol.

No implementation is foolproof. The supplied tests establish the specific handoff, repository, and UI behaviors above; they do not remove the need for staged rollout and real customer validation.
