# Handoff and room reliability: phased implementation plan

Prepared 11 September 2026 against main at `b665b24`, including the existing uncommitted dashboard improvements. This document records the original plan. Implementation has since completed for the core handoff, imported-file, and responsive-room milestones; see [implementation results, validation, and rollout boundaries](handoff-implementation.md).

## Objective and order

First deliver a reliable handoff of an existing AI conversation to an authorized teammate. Then fix imported-repository browsing and editing. Then improve the room page around those working behaviors. Preserve the current dashboard changes and other worktrees.

A handoff is complete when the next person can continue the same conversation, against the correct committed repository state, using their own authorized execution environment, without losing context or allowing two owners to execute simultaneously.

## Phase 0 — investigation and design review

Completed by source inspection:

- Reviewed the unfinished handoff migration, store, APIs, prompt injection, and UI in the `dakar` worktree against current main.
- Traced folder scanning, imported repository allocation/seeding, repository selection, tree/file/changes requests, autosave, file events, and room layout.
- Checked current runner job identity, claim/completion protocol, agent discovery, execution routing, migrations, and existing tests.
- Confirmed that application code remains unchanged in this planning turn.

### What explains the missing files

`Workspace.tsx:161` explicitly keeps the editor on the original room repository after an import. The import handler updates `roomRepos` and `chatRepoId`; it does not load the imported tree. `scanSession`, file saves, and the Changes view only address the room's default repository. The selected AI repository and the visible code can therefore differ.

Related defects to account for:

- File-save and editing events have a path but no repository identity; two repositories containing `src/index.ts` cannot be distinguished.
- Editor buffers, pending saves, and conflicts are keyed by path alone.
- Opening an existing conversation does not establish a single repository selection shared by the editor and AI panel.
- Imported repository records do not store an explicit seed/base SHA for their Changes view.
- Reads use materialized checkouts; the earlier review reproduced stale data after runner pushes. The tree route can also fall back to an older local head instead of reporting a synchronization failure.
- A GitHub project association currently stores metadata and provisions an empty repository; that is a separate issue from a successful local folder upload whose files are invisible.

These are source-confirmed causes and risks. The user's exact upload must still be reproduced against controlled fixtures during implementation; there is no evidence yet that their uploaded files were actually lost.

### Why the handoff prototype cannot be copied directly

- Its migration is numbered `017`; main already has migrations through `024`, and the prototype predates imported repositories and the current runner protocol.
- Acceptance changes the driver without proving that the old turn has reached a durable boundary.
- Permissions are partly checked outside the transaction, and targeted recipients come from an explicit roster that can omit members with effective project access.
- An unknown PATCH action falls through to acceptance. A room-wide offer can be globally declined by someone other than a designated recipient.
- The briefing is marked consumed before prompt construction and job delivery succeed. Its outer update also lacks a final unconsumed predicate; the intended concurrency guarantee needs an actual test.
- Briefing only the first post-handoff turn does not solve later one-shot CLI continuation.
- Current `runner_jobs` uses the conversation/run ID as its primary key. A later turn in the same chat can collide with the previous job row. Queue identity and conversation identity need separation.
- Current capability discovery inspects the web host, not the recipient's computer. Both the composer and run route can block hosted local-runner execution using the terminal gate.

## Proposed product contract

1. **One execution controller per conversation.** Keep `startedBy` as immutable authorship. Add a distinct current driver. Other authorized members can watch, discuss, fork, and request/accept control; a stale browser cannot dispatch a turn after giving control away. This makes control explicit where today's API permits co-driving without a durable ownership transition.
2. **Handoff occurs between turns.** An offer may be created while work is running. Acceptance is disabled and rejected by the server until the active turn is finished and its result is durably recorded, or an abandoned attempt is safely fenced off. No live CLI process migration is promised.
3. **Offers are durable.** Support a named teammate or any eligible room editor, an optional note, a one-hour initial expiry, cancellation, targeted decline, acceptance, and a visible history. Ignoring an open offer does not cancel it for everyone.
4. **Acceptance does not spend compute.** It transfers control. The new driver reviews the context and submits the next prompt deliberately. An offline device produces a clear connection requirement rather than silently executing on the previous person's machine or the web host.
5. **Repository binding is preserved.** A handed-off conversation retains its `repoId`, room, and latest confirmed commit. Switching models does not switch codebases or discard the transcript.
6. **Every continuation receives context.** Persist the prompt snapshot for each execution turn, including bounded recent conversation, handoff note, repository/commit information, and any explicit references. Retry delivery uses the same snapshot.
7. **Ownership is not access.** Handoff never grants room or organisation membership. Evaluate effective access, including private-room rules and suspended users, when offering, accepting, submitting, claiming, and completing work.
8. **Owner recovery is explicit.** An authorized room owner can recover control from a departed/suspended driver or an abandoned attempt, with an audit entry. Recovery must not bypass active execution fencing or create a second live writer.

## Phase 1 — foundations required for reliable handoff

### Data and execution identity

- Retain `agent_runs` as the existing conversation identifier to avoid breaking links and history.
- Add a per-execution turn record: unique turn ID, conversation ID, initiating driver, provider/model, repository, base/result SHA, state, immutable prompt snapshot, execution destination, timestamps, and failure detail.
- Add a control version to the conversation. Atomically validate driver/version and reserve one active turn per conversation; integrate quota admission into that reservation.
- Use the turn ID for runner delivery, worker queue job IDs, completion idempotency, and streamed event attribution. Use an attempt/fencing token for lease ownership. Reject incompatible old runner protocols with an actionable upgrade message.
- Allocate message sequence numbers atomically, including handoff notices and asynchronous execution messages.
- Use new migrations with the next unused numbers (currently `025` onward); do not modify already-applied migrations. Backfill driver ownership from `started_by` and preserve old conversation history without inventing historical per-turn facts.

### Durable execution and delivery

- Execute in a turn-specific checkout. Do not let concurrent agents and the browser mutate the same live work directory.
- Publish a candidate result to a turn-specific ref, then promote it only if the attempt is current and the expected canonical head still matches. A changed head creates a visible conflict/review outcome; preserve both changes.
- Fence canonical ref promotion as well as database completion. Checking only the completion HTTP request does not stop an old runner from pushing first.
- Record success only after the commit is present in the durable repository. Correct the server's ignored push failure and the runner's retained zero exit code after a push exception.
- Make finalization restartable across git and database operations. These cannot share a transaction: record intent/result, compare expected heads, and reconcile interrupted promotion without repeating the model execution.
- Renew leases independently of model output. Persist completion reports locally for retry. Expired/revoked attempts cannot publish late results into the active room; preserve recoverable output separately.
- On an abandoned run, surface failure/recovery from the last confirmed commit. Do not automatically replay an agent's possibly destructive work.
- Separate permission to submit a local-runner job from permission to run a shell on the server. Keep server execution subject to its own existing gate; do not remove terminal protections globally.
- Advertise runner capabilities and select an eligible device belonging to the new driver. Handle multiple devices, missing providers, missing login, and version mismatch explicitly.

Primary areas: `db/migrations`, `app/lib/ai/runs.ts`, `app/lib/ai/finalize.ts`, `app/lib/ai/prompt.ts`, `app/api/ai/run`, `app/lib/runner`, `app/lib/queue`, runner API routes, `runner/`, and the git execution helpers.

**Exit gate:** two ordinary successive turns on a local runner succeed; duplicate submissions execute once; late/duplicate completion cannot duplicate messages or overwrite newer code; a failed push is never displayed as successful delivery; previous conversation context survives a device change.

## Phase 2 — complete the handoff feature

- Port the useful offer/history UI and domain concepts from `dakar` onto the new execution model, preserving current imported-repo and memory behavior.
- Implement offer, accept, cancel, targeted decline, expiry, and owner recovery with strict request validation and guarded transitions in transactions.
- Lock/check the conversation and offer consistently so acceptance cannot race a new turn, cancellation, expiration, revocation, or another acceptance. One pending offer and one winner per offer.
- Capture a verifiable handoff checkpoint at the boundary: repository identity, current confirmed head, conversation sequence, outgoing driver/provider, and note. A failed prior turn is described as failed, never as fully saved work.
- Return idempotent results for retried actions by the same actor. Conflicting actions return a useful conflict response followed by state refresh.
- Update UI control checks from starter identity to current driver, retaining starter attribution. Reconcile the selected conversation from fresh server state instead of a stale object captured when it was opened.
- Add a Handoff action, eligible recipient picker, pending/waiting state, accept/decline/cancel controls, current-driver badge, and history in the chat.
- Restore state from the database on reload and SSE reconnection. Events signal invalidation; they are not the sole record of the transfer.
- Keep unavailable-computer/provider states distinct from rejected permissions and failed requests. Do not claim that accepting an offer has already started an agent.

**Exit gate:** user A finishes a turn, offers it to B, B accepts in another browser and on another simulated device, B continues the same conversation on the same imported/default repository, and A can no longer dispatch into it. Repeat with provider change, memory disabled, refresh, disconnect, and a failed previous turn.

Stop for a handoff milestone review before the room redesign. Only underlying repository fixes necessary to make handoff truthful belong ahead of this gate.

## Phase 3 — fix imports, file visibility, and repository consistency

- Introduce one authorized repository context resolver shared by tree, file, save, changes, and presence routes. Preserve the existing default-repo API behavior; a supplied `repoId` must belong to the authorized room and be fully seeded.
- Read tree/files/diffs at the confirmed commit from the bare repository where possible. A GET must not hard-reset an active working copy or downgrade authoritative metadata to an older cache head.
- Bound file reads before loading content; reject traversal and protect reads/writes against leaf and parent symlink escapes. Git blob reads should not dereference a repository symlink into host files.
- Route saves to the selected repository with expected-head/three-way-merge protection; update the matching head record only after durable delivery.
- Make the workspace repository selector drive AI, explorer, editor, Changes, and status together. Opening a conversation selects its bound repository. A continued conversation cannot silently change repositories; choosing another repository starts a new conversation context.
- Namespace buffers, open tabs, pending saves, conflicts, cursors, and incoming events by room/repository/path. Cancel or ignore stale loads when selection changes. Do not let a late response populate a different repository's tab.
- Flush and verify saves before discarding a buffer. Preserve unsaved buffers by repository on switches; a failed/conflicted flush must not erase them. Restore the selected repository safely on reload, with a fallback if access is lost or it was removed.
- On successful import, select and load that repository immediately. Show scanning/uploading/finalizing/ready/failed states, counts of skipped files, retry, and actionable errors.
- Make import completion idempotent and serialize competing seed requests. Preserve enough upload state to retry a failed import without a duplicate-name dead end. Only explicitly abandoned, incomplete imports may be cleaned up; do not delete a ready repository as an error-recovery shortcut.
- Persist a seed/base SHA for imported-repository changes. Backfill from verified import history when available; represent an unknown base explicitly rather than guessing.
- Broadcast repository identity on import and file/head changes. Another member's upload appears after refresh/reconnect, and a change in repo A does not alter repo B's tree.
- Treat GitHub import separately: implement an actual import into the selected project repository, with branch and authentication checks, or show the association as awaiting import. Never present an empty metadata association as completed code import. Prefer an authenticated GitHub integration for private repositories rather than accepting credentials in URLs.
- Keep publish/sync enabled only where a project remote exists. Imported standalone repositories must not publish into the default project by accident.

**Exit gate:** import two folders containing the same relative filename; each opens, edits, persists, and reloads independently. A runner update is visible on both clients. An interrupted upload recovers. A viewer cannot write, a foreign repo ID is refused, and symlink/traversal attempts cannot touch outside files.

## Phase 4 — improve the room page

Desktop direction:

```text
Room / Project    Repository selector    Connection / Driver    Handoff
---------------------------------------------------------------------
Chats / Team      AI conversation       Files | Editor | Changes
                                       Terminal (collapsible)
---------------------------------------------------------------------
Selected repository / branch / save state / execution location
```

- Give the current task and repository clear visual priority. Keep handoff and ownership close to the conversation, not buried in global settings.
- Make AI and code panes usable at laptop widths, with bounded resizing and predictable collapse/restore controls.
- On smaller screens, use navigable Chat / Files / Changes panels rather than squeezing three fixed-width columns into the viewport.
- Open Files after import; open the editor after selecting a file. Preserve recoverable workspace state across chat navigation.
- Separate empty repository, loading tree, failed import, unavailable file, unsaved changes, conflict, disconnected stream, and missing runner states.
- Label the terminal's actual execution machine/directory. A server terminal must not imply that it is operating in the selected imported repository or on the recipient's computer.
- Use the existing theme and shared accessible dialogs. Add keyboard names, focus behavior, resize keyboard support, readable text, and clear active-tab state.
- Extract repository state/loading, buffer/save state, and handoff state from the large `Workspace`/`AiPanel` components as needed for these changes. Avoid an unrelated visual or architectural rewrite.

**Exit gate:** a first-time user can identify the selected repo and driver, import and open a file, see whether it saved, find changes, and hand a conversation to a teammate without guessing which pane controls which repository.

## Phase 5 — integrated verification and release preparation

| Scenario | Required result |
| --- | --- |
| A offers while a turn is running | Offer is visible; acceptance waits for a durable boundary |
| B and C accept an open offer concurrently | One driver; the loser sees the committed winner |
| A submits as B accepts | One ordered outcome: submission reserves first, or transfer wins and A is refused |
| Acceptance races cancellation/expiry | Exactly one valid final status; no mixed ownership |
| Missing/unknown action, malformed IDs/body | Validation response; no ownership mutation |
| Suspended user, removed project member, private room, viewer | No unauthorized offer/accept/execute/read escalation |
| Recipient has effective project access but no explicit room roster row | Correctly included if authorized; no new membership granted |
| User has several devices or a missing provider | Only one eligible claim; clear setup status when none qualify |
| Old device reports/pushes after lease recovery | No canonical overwrite; result retained for recovery if appropriate |
| Completion succeeds but HTTP response is lost | Retry returns the same result without duplicated execution or transcript |
| Process dies after git promotion, before metadata update | Reconciliation completes the recorded operation once |
| Sender disappears after offering | Durable offer/history remain; only confirmed code is promised |
| Memory sidecar is disabled; recipient switches provider | Current conversation and handoff note still reach subsequent turns |
| Two repos contain the same file path | Tabs, saves, diffs, and cursors remain isolated |
| Slow file read finishes after switching repos | Result updates only its original repository/buffer |
| Unsaved/conflicted buffer during switch, close, or disconnect | Buffer is retained or explicit recovery is offered |
| Upload retries final batch or fails midway | No duplicate finalization; retry has a defined path |
| New clone versus existing cached checkout | Both show the same confirmed tree and contents |
| Browser reconnects after missed events | Driver, run state, repository list, and head reconcile from durable state |
| Existing database upgraded through new migrations | History and room bindings preserved; rerunning migration is safe |

Validation layers:

1. Pure tests for state transitions, prompt budgets, and buffer/repository identity.
2. Schema and store tests against disposable PGlite; multi-connection race and locking tests against disposable real PostgreSQL.
3. Real-git tests using temporary repositories, including failed delivery, stale checkout, branch conflicts, and symlink fixtures.
4. API integration tests for permissions, lifecycle, imported-repo reads/writes, and idempotency. Use a deterministic fake agent and simulated runners for repeatable assertions.
5. Two-browser end-to-end tests with the actual API, database, and event bus. Mocked screenshots alone do not qualify as the handoff milestone.
6. Type generation, TypeScript, changed-file lint, all existing suites including knowledge, and production build. Report existing unrelated lint failures separately. Retest the default bundler; retain a documented webpack check if the known environment limitation persists.
7. Optional final real-provider smoke test only with a configured test account/device; it must not replace deterministic execution tests.

Deployment preparation: drain active jobs before the protocol/schema upgrade, record the minimum runner version, back up database and durable repositories, test the migration on a clone, and deploy compatible web/worker/runner versions together. Preserve new history on rollback; do not promise that an older binary can consume the new job format.

## Design review verdict and boundaries

This plan addresses the observed gaps and includes explicit checks for races, retries, disconnects, stale state, permissions, context continuity, and wrong-repository writes. It is **not a claim of being foolproof**: the implementation must pass these gates, and new failures may refine the design.

Still to resolve through implementation evidence: private GitHub credential setup, real database/Redis test availability, provider capability detection on recipient devices, and recovery behavior under actual process/network interruptions. None should be represented as already tested.

Deferred beyond this work: live migration of a running model process, autonomous spending on acceptance, broad billing/SSO work, replacing the entire editor, and general cloud sandbox deployment. Existing security findings remain tracked; this work must not weaken current execution restrictions.

Implementation proceeds in order: **execution foundations → completed handoff → import/file correctness → room UI → integrated verification**. Each phase ends with an evidence-based status update and a concrete working result. The planning turn stopped here as requested. The subsequent approved implementation is documented in [the implementation report](handoff-implementation.md); the investigation observations above describe the pre-implementation baseline.
