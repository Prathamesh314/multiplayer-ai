# Multicode AI: product and engineering review

Review date: 11 September 2026. Reviewed baseline: `b665b24`, the latest `origin/main` pulled during this review. The UI improvements described below are additional, uncommitted changes in the local `main` checkout.

## Subsequent implementation

The prioritized handoff, turn-isolation, imported-file, and room-UI work is now implemented locally. See [the implementation report](handoff-implementation.md) for fixes, test evidence, upgrade instructions, and remaining limits. Findings below describe the original reviewed baseline; this update does not certify the remaining platform for public hosting.

## My assessment

The idea is worth pursuing. The implementation is a substantial prototype with real persistence, git operations, role checks, streaming, local execution, and tests. It is not yet ready for a public, multi-tenant launch. Several problems affect the core promise: continuing a conversation, seeing the latest code, preserving a completed change, and keeping one team's execution away from another team's data.

I would keep the architecture and narrow the next milestone to one reliable workflow: **two engineers continue the same AI task, retain its context, review the resulting diff, and publish a tested change.** More general chat features or more model choices will not compensate for a failure in that workflow.

### How the idea fits YC

This is a direct match to YC's Fall 2026 “Multicode AI” request by Aaron Epstein. It explicitly discusses teammates watching, redirecting, and handing off a live agent session, including engineering teams. That supports the problem area; it does not establish customer demand for this particular product or predict admission. [YC's actual request](https://www.ycombinator.com/rfs).

The strongest positioning is: “A shared workspace where engineering teams can pick up each other's AI work without losing context.” The current feature list sounds broader: editor, terminal, team messenger, agent dashboard, memory system, desktop client, and execution platform. Buyers need one reason to adopt it before they need all of those capabilities.

Competition is real. Conductor already documents parallel agents and isolated workspaces. Cursor documents shared transcripts that recipients can fork and continue. My inference is that parallel execution and transcript sharing alone will be difficult to defend. Your opportunity is coordinated work between multiple people: clear ownership, handoff, shared decisions, approvals, and reliable continuation. [Conductor](https://www.conductor.build/docs/concepts/parallel-agents), [Cursor](https://prod.cursor.com/help/ai-features/shared-transcripts).

## Git reconciliation

- The initial `git pull --ff-only origin main` reported up to date at `0ab3f37`.
- The team-chat commit `8901211` existed on `Prathamesh314/review-main-branch-code` and was initially absent from main. I fast-forwarded local main to review it.
- You subsequently merged that feature as squash commit `b665b24` / PR #35. I pulled again and rebased with autostash; Git skipped the equivalent local commit and restored the UI edits. Local `HEAD` and `origin/main` now agree.
- I compared divergent feature branches against main using stable aggregate patch IDs, rather than assuming that a different commit SHA meant missing functionality. The feature branches, including the Conductor restyle and runner phases, have equivalent squash commits in main or are ancestors of it.
- **There is still work outside main.** The `personal_branch` contains a divergent server/bootstrap rewrite (`f7fe83b`, `b8a8507`). Its later commit removes substantial platform code. It is not a missing incremental feature and was not merged over the current application.
- The `dakar` worktree contains uncommitted handoff code, API routes, UI, tests, and `017_run_handoff.sql`. That migration number predates main's existing migrations through `024`; the work also overlaps code that has since changed. It needs an explicit integration pass, not a blind copy. I preserved it in its original worktree.
- The `podgorica` worktree has untracked planning HTML/PDF files under `docs/`; they remain there.

Therefore, **the committed feature work is accounted for, but it would be inaccurate to say every experimental or uncommitted change on this computer is in main.** No new commit or push was made for this review.

## What is already good

1. **Real git behavior.** Rooms fork from a project repository, publish and sync through git, and expose conflicts instead of pretending edits always merge. The real-git tests exercise useful behavior.
2. **Useful separation of concerns.** Session, organisation, project, execution, runner, event, presence, and knowledge modules have recognizable boundaries. Shared server/runner finalization is the right direction.
3. **Persistent collaboration.** Runs, messages, participants, channels, DMs, and membership records survive a browser session. This is well beyond a mock dashboard.
4. **Good security building blocks.** Passwords use a memory-hard KDF; authentication and device tokens are hashed in storage; cookies are HttpOnly; many routes check explicit roles; SQL generally uses parameter binding. These are foundations, not proof that all authorization paths are correct.
5. **Thoughtful execution limits.** Agent wall-time and output caps, a worker queue, atomic device job claims, push ancestry checks, and Redis-backed repository locking show attention to operational concerns.
6. **Bounded context retrieval.** Knowledge routing limits fan-out and prompt size. Explicit context, repo context, and ambient memory are distinguished. Publishing can gate memory ingestion.

## Findings to address before launch

P0 means a security boundary can fail when the relevant endpoint is exposed. P1 means a core workflow, data-integrity guarantee, or authorization rule is broken. P2 means operational or product hardening. These issues remain open unless explicitly identified as fixed in the UI section.

### 1. P0: repository file access can escape through symlinks

Evidence: `app/lib/session/paths.ts:71`, `app/lib/session/repo.ts:656`, `app/lib/session/repo.ts:681`, `app/lib/session/repo.ts:699`.

`resolveInside` checks the lexical path prefix. `readFile` and `writeFile` subsequently follow symlinks. A repository path can therefore point outside its working directory while still passing the path check. The HTTP file route validates relative paths but does not add symlink protection.

**Reproduced with synthetic files:** a link inside a temporary room pointing to a sibling file allowed both reading and overwriting that sibling through the real repo helpers. No user files or secrets were used.

Fix: enforce filesystem containment for reads, writes, and seed operations, including symlinked parent directories and creation of new files. Use file-descriptor/no-follow protections where supported and isolate execution so a malicious concurrent process cannot race path validation. Test leaf links, directory links, nonexistent targets, and races. A string normalization check alone is insufficient.

### 2. P1: existing server checkouts stay stale after runner pushes

Evidence: `app/lib/session/repo.ts:842`, `app/lib/ai/finalize.ts:92`, `app/api/sessions/[id]/file/route.ts:41`.

Runner completion advances the bare repository and stored head. `ensureWork` immediately returns when the server checkout already exists; it does not reconcile it with that head. The editor reads the existing checkout. A new agent result can therefore be recorded successfully while the browser still reads old source code.

**Reproduced:** created a room, pushed a new commit from a second clone, called `ensureWork(room, newSha)`, and read the original file contents from the server checkout.

Fix: make reads use the authoritative commit, and define a locked reconciliation protocol for materialized workspaces. Do not solve this by blindly hard-resetting a checkout that another writer or agent is using.

### 3. P1: a failed push is reported as a successful durable commit

Evidence: `app/lib/session/repo.ts:800`, especially the ignored result of `gitOk(...push...)` near line 823.

`commitWork` returns the local commit SHA even when pushing it to the room's bare repository fails. Callers can store that SHA as the durable head. Deleting the supposed cache or rebuilding on another machine then loses access to that commit.

**Reproduced:** redirected a temporary checkout's origin to a nonexistent repository, changed a file, and called `commitWork`. It returned a SHA that did not exist in the original bare repository.

The runner has a related static defect: `runner/index.ts:110` uses `code = code ?? 1` in its catch handler. If the agent exited with zero but `commitAndPush` then throws, zero is retained and the completion report can mark the run successful with no delivered commit.

Fix: only advance durable metadata after confirming delivery. Preserve failed local work with an explicit “committed locally, delivery pending” state and a retry/reconciliation path. Back up both PostgreSQL and the durable bare repositories; database backup alone cannot restore code.

### 4. P1: ordinary follow-ups do not receive guaranteed conversation history

Evidence: `app/api/ai/run/route.ts:218`, `app/api/ai/run/route.ts:319`, `app/lib/ai/prompt.ts:25`, `app/lib/ai/catalog.ts:110`, `app/lib/ai/execute.ts:67`.

A follow-up reopens the stored run and launches a fresh one-shot CLI. The assembled prompt contains the new user prompt and optional retrieved/imported/reference context, but no guaranteed transcript of the current conversation and no stored vendor resume identifier. This fails most clearly with semantic memory disabled: “use the second approach you suggested” has no reliable access to the previous answer.

Fix: distinguish a conversation from an execution turn. Build every turn from a bounded current-conversation transcript plus a maintained summary, or resume a vendor session with an explicit portable fallback. Test continuation on another person's machine and with the memory sidecar disabled. The uncommitted handoff work does not fix ordinary continuation in current main.

### 5. P1: the hosted control plane blocks local-runner submissions

Evidence: `app/api/ai/run/route.ts:102`, `app/api/ai/run/route.ts:381`, `app/lib/terminal/guard.ts:18`.

The terminal gate executes before local-runner routing. It rejects non-loopback Host values, even with `MULTIPLAYER_AI_TERMINAL=1`. Requests to a normal hosted domain cannot reach the “send this to my computer” path. That contradicts the planned cloud-control-plane/local-execution topology.

Fix: separate authorization for submitting a runner job from permission to execute a shell on the web host. Allow authenticated, authorized local-runner submissions independently. Keep server execution disabled unless a separate safe execution policy permits it. Do not merely remove the gate globally.

### 6. P1: PTYs are not bound to a signed-in user or room

Evidence: `app/api/terminal/pty/route.ts:15`, `app/api/terminal/pty/route.ts:89`, `app/lib/terminal/pty.ts:46`.

Both PTY endpoints rely on the terminal host/environment gate. They do not require application authentication, check room roles, or bind the supplied terminal ID to an owner. New shells start in `process.cwd()` with the server environment, rather than a room-specific execution context.

This is a local-development trust boundary today, not an authenticated multiplayer terminal. Host headers also do not prove that the TCP peer is local. It becomes substantially more dangerous if a proxy makes those routes reachable with an allowed Host.

Fix: authenticated terminal ownership, room authorization, explicit execution location, process limits, and per-user isolation. The local desktop terminal and a shared hosted terminal need separate policies.

### 7. P1: run admission and turn sequencing are vulnerable to races

Evidence: `app/lib/ai/usage.ts:39`, `app/api/ai/run/route.ts:160`, `app/lib/ai/runs.ts:119`, `app/lib/ai/runs.ts:152`, `app/lib/ai/execute.ts:74`.

Quota checks and run creation happen separately, so simultaneous requests can both pass admission. Continuing a run is not guarded by an atomic transition that refuses an already-running turn. `appendMessage` allocates `MAX(seq) + 1`, assuming a single writer despite co-driving and asynchronous notices. Agent processes edit outside the short git-operation lock, so two processes or a human save can share an actively mutating tree.

Fix: unique execution-turn IDs, atomic admission/reservations, per-conversation serialization, and atomic message sequence allocation. Execute each turn in an isolated checkout and merge its result explicitly. Test simultaneous new runs, simultaneous follow-ups, same-file human/agent edits, and lock renewal loss.

### 8. P1: runner leases do not provide recovery, and completion is not idempotent

Evidence: `app/lib/runner/jobs.ts:71`, `app/lib/runner/jobs.ts:81`, `app/lib/runner/jobs.ts:105`, `app/api/runner/runs/[runId]/complete/route.ts:72`, `runner/index.ts:107`.

Claims record lease expiry, but `claimedJob` does not enforce expiry and no claimed-job expiry reaper was found. The cloud reclaim path only handles unclaimed queued jobs. A machine disappearing after claim can leave a job stranded. The runner makes one completion call; a lost response has no durable local retry record.

The completion endpoint finalizes and publishes before atomically closing the job. Two concurrent reports can both pass `claimedJob` and duplicate finalization. Conversely, swallowed persistence errors in finalization can coexist with a successful completion response.

Fix: a durable turn state machine, claim fencing, periodic renewal independent of model output, expired-claim recovery, an idempotent completion operation, and a runner outbox for retrying reports. Preserve work from a stale attempt without allowing it to overwrite a newer attempt.

### 9. P1: suspended chat members can retain access, and open chat streams outlive revocation

Evidence: `app/lib/chat/auth.ts:34`, `app/lib/chat/store.ts:68`, `app/api/chat/conversations/[id]/events/route.ts:61`.

Explicit conversation membership is accepted before active organisation membership is checked. Suspending an org member keeps their membership rows, so an existing DM or channel member can still satisfy the conversation guard. Deleting an org membership does cascade conversation memberships; suspension is the distinct failing case.

The new conversation SSE route checks access only at connection time. Unlike room events, it does not react to role changes. An already-connected subscriber can continue receiving messages after removal until the stream closes.

Fix: require active organisation membership on every conversation operation, and make revocation close or invalidate live subscriptions. Test suspension, removal, logout/token expiry, and loss of access during an open stream.

### 10. P1: selecting GitHub does not actually import the repository

Evidence: `app/components/orgs/dialogs.tsx:264`, `app/lib/project/store.ts:78`, `app/lib/session/memberRoom.ts:52`, `app/lib/session/repo.ts:135`.

The form stores GitHub repository and upstream URL metadata. Project provisioning initializes an empty bare repository and forks it; it does not clone the supplied GitHub source. This means a GitHub-looking project can open without the expected code. Publishing also targets the platform's internal project main, not a GitHub pull request.

Fix: a real repository import flow with progress, failure state, private-repo authentication, branch selection, and eventual GitHub PR creation. Until implemented, label metadata-only association accurately and guide users through importing code.

### 11. P1 before multi-tenant hosting: execution isolation is incomplete

Evidence: `app/lib/ai/env.ts:16`, `app/lib/ai/execute.ts:112`, `app/lib/terminal/pty.ts:51`, `docker/worker/Dockerfile:1`.

The agent environment copies the server environment except a few launch markers. Worker processes share the host/container and its credentials. The supplied worker image has no non-root `USER` declaration. Vendor CLI permission modes are not a substitute for a tenant boundary, especially for filesystem reads, shell tools, or inherited credentials.

Fix: minimize environment variables, run with dedicated identities, isolate filesystem and network access, grant narrowly scoped credentials, and make server fallback an explicit policy. A trusted operator running a local prototype is a different threat model from arbitrary hosted customers.

### 12. P2: public-account, deployment, and quality controls need completion

- `app/api/auth/continue/route.ts:37` distinguishes known email addresses from new ones. No rate limiter was found around login, registration, or pairing. Add abuse limits and account recovery/verification before public signup.
- Finalization catches errors in durable transcript/head updates (`app/lib/ai/finalize.ts:106`, `:185`). Durable failure should be observable and recoverable, rather than only appearing in a transient stream.
- Redis presence/event/lock modules dynamically import a variable module name. The webpack build warns about these dependency expressions. Verify a production run with Redis enabled; a successful static build is not proof that these paths load correctly.
- Existing global lint fails with eight errors: one explicit `any` in `OrgSettingsDialog.tsx` and seven CommonJS-import rule violations in the Electron files. Use a scoped CommonJS lint configuration where appropriate rather than mechanically converting Electron modules.
- `npm test` omits `test:knowledge`; run it in CI as well. There is no checked-in browser integration suite or CI workflow in the reviewed tree.
- Several UI files are large: `Workspace.tsx` is about 900 lines, `AiPanel.tsx` about 1,500, and organisation dialogs about 1,200. Extract execution state, conversation rendering, and individual dialogs as those areas change; a wholesale rewrite is unnecessary.
- `LandingContent.tsx` contains obsolete claims such as files staying in the browser and team chat being committed to git. Imported code is uploaded; chat is persisted in PostgreSQL. The active home route uses `OrgWorkspace`, but stale surfaces and documentation should still be retired or corrected.

## UI improvements delivered

- Replaced the mostly empty organisation home with a project overview, real project count, search, repository/role information, direct room actions, and member actions.
- Added clear loading, empty, no-results, failed-load, retry, and missing-room states. A failed workspace request no longer pretends the user has no organisations.
- Newly created projects now refresh into the overview and sidebar immediately. Viewer projects offer a read-only room action rather than promising a personal writable room.
- Added a route back from team chat to the project overview and collapsible project/chat navigation on smaller screens.
- Redesigned sign-in with a clearer explanation of the product, a focused account form, and scrolling on short/mobile viewports.
- Reworked organisation onboarding with a clearer first action and improved spacing/type hierarchy.
- Converted shared modals to native modal dialogs for focus containment and inert background content; added explicit restoration of focus when a dialog unmounts, Escape behavior, and description association.
- Added visible keyboard focus, accessible error announcements, keyboard-visible room actions, system color-scheme support for form controls, reduced-motion handling, and stronger muted-text contrast in light mode.

The UI uses existing design tokens, fonts, icons, and backend operations. There are no fabricated activity metrics or new dependencies. The in-room editor/AI work surface remains a separate future design pass; this delivery concentrates on entry, navigation, and project discovery.

## Validation and its limits

| Check | Result |
| --- | --- |
| Existing `npm test` | 111 passed, 0 failed: schema 62, presence 16, repo 5, lock 7, prompt 14, stream 7 |
| `npm run test:knowledge` | 29 passed, 0 failed |
| `npx next typegen` followed by `npx tsc --noEmit` | Passed after refreshing route types for the newly merged chat endpoints |
| Lint on changed TS/TSX files | No errors; two existing organisation-image warnings |
| Whole-repository lint | Existing errors described above; not treated as a passing check |
| Default Turbopack build | Blocked by this environment: font network access first, then an OS port-binding failure in PostCSS processing |
| `npm run build -- --webpack` | Passed; existing dynamic dependency and optional BullMQ dependency warnings remain |
| Headless Chrome, production build | Desktop/mobile login and home, search/clear, editor/viewer missing-room feedback, modal Tab containment/Escape/focus restoration, mobile navigation, light theme, project-load error/retry, project creation refresh, empty organisation onboarding passed using mocked API responses |
| Targeted real-git/filesystem probes | Reproduced symlink escape, stale materialized checkout, and false durable-push success in isolated synthetic temporary directories |

Browser fixtures deliberately intercept API responses; they validate frontend behavior, not live PostgreSQL authorization, actual agent inference, or multi-user synchronization. No real customer/project records were created. I did not execute paid model runs, deploy infrastructure, run a load test, or validate Electron packaging and Windows behavior. The backend findings identified as static analysis still need dedicated integration regression tests when fixed.

## What to build next

### First: make the shared task dependable

1. Fix filesystem containment, terminal ownership, execution isolation, and chat revocation before exposing the platform to untrusted users.
2. Fix bare-repository durability and reconciliation after runner delivery.
3. Add a conversation/turn model with reliable history, atomic admission, idempotent completion, and abandoned-run recovery.
4. Make the hosted local-runner path work without granting execution privileges on the web server.
5. Complete real source import and a review-to-PR workflow, with test results tied to the exact commit being reviewed.

### Then: demonstrate why multiplayer changes the outcome

Implement one structured handoff: current goal, completed work, remaining work, decisions, relevant files, checks run, next owner, and acceptance. Integrate the existing handoff prototype against current main with a new migration and explicit compatibility tests. Let teammates suggest steering while a turn is active, and define who can accept it; two simultaneous prompts should not mean two unsynchronized processes.

Add a compact review surface that connects prompt, author, agent, diff, test result, approval, and published commit. Make context inspectable: show which decisions and chats informed a turn, permit correction, and re-check visibility when information is reused. Approval should be a workflow event, not inferred from a successful CLI exit.

### Customer validation

Start with small engineering teams already using agents daily, especially teams working asynchronously across time zones. Recruit five design partners and observe real tasks, not only feedback on a demo. Those counts are proposed experiment targets, not YC requirements.

Measure team activation as two members participating in one real task that reaches an accepted change. Track time from invitation to the second person's useful contribution, handoff completion rate, accepted changes per active team, weekly team retention, repeated context explanations, execution failure rate, and lost-work incidents. Define “accepted” as a human-reviewed outcome rather than a zero exit code.

Ask teams to compare this workflow with their existing editor plus team chat and GitHub. If they do not return without reminders, adding more features is unlikely to fix the adoption problem. Capture concrete before/after examples and ask for paid pilot commitments once the shared workflow is dependable.

### Business model and scope

A team subscription with customer-owned local execution is a reasonable hypothesis. Meter hosted fallback separately once usage attribution and hard caps are trustworthy. Local execution reduces some compute costs; it does not eliminate storage, bandwidth, support, reliability engineering, or security costs. Test willingness to pay before building a full billing system.

Avoid turning this into a replacement for every editor and messenger. Keep lightweight chat where it supports a task, integrate existing team tools, and spend the next engineering effort on context continuity, safe handoff, review, and recovery.

## Will this work?

**As an idea:** yes, it addresses an explicitly recognized problem and has a plausible engineering-team starting market. Retention and willingness to pay remain unproven.

**As a local prototype:** there is enough real implementation to develop and test the workflow. Passing unit/schema/git tests is encouraging, but the reproduced defects mean successful-looking actions are not always trustworthy.

**As a hosted multiplayer product today:** not reliably. The execution gate, checkout synchronization, conversation continuation, durability, and authorization gaps should be treated as launch blockers.

**As a YC application:** tell the story through a real team completing work that was awkward before, show the live handoff, and bring evidence of repeated use. The project has enough substance to support that story once its central workflow is reliable.
