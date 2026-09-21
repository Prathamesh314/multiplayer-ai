# Local demo readiness

Verified on 21 September 2026, on the founder's Mac, starting from commit
`7db80bd`. This report covers a local product demo. It does not certify public
hosting, every model/provider, or arbitrary AI answer accuracy.

## Verified evidence

| Check | Result |
| --- | --- |
| Default automated suite | Passed: 239 checks across schema, repositories, permissions, memory, handoffs, models, and storage |
| Production build | Passed with `npm run build -- --webpack`; Turbopack hit a host process/port restriction |
| TypeScript and lint | Passed; four existing lint warnings remain (avatar images and one memo dependency) |
| Real PostgreSQL and browser integration | Passed: 22 backend checks plus two-browser collaboration, imports, model refresh, and handoff flows |
| Live Codex: repository question | Read a random repository value and correctly summed 17 + 25; approximately 13.6 seconds |
| Live Codex: follow-up | Recalled a unique label from the preceding message; approximately 8.8 seconds |
| Live Codex: code change | Created exactly the requested file, committed it, persisted the transcript, and showed it after browser reload; approximately 30.5 seconds |
| Repository semantic search | Passed against actual local Ollama and pgvector, including semantic-only lookup, source/commit citations, and incremental reuse |
| Conversation semantic memory | Passed actual app write/recall and separate-bank isolation against Mnemosyne; synthetic memory removed afterward |
| Local migrations | Applied 030 and 031; database schema is current |
| Local prerequisites | Git, PostgreSQL, Redis, and provider discovery passed |
| App startup | Local testing mode started successfully; `/login` returned HTTP 200 |
| Background worker | Fixed `@next/env` default-import startup failure; worker starts with the named import |

The first development browser run was interrupted by a full refresh while build
work was concurrent. A separate rerun passed, including the real-provider checks.
Do not build or change application files while recording the demo.

Mnemosyne's advertised tool schema omits bank arguments, but its pinned dispatch
implementation accepts them. This was checked against the installed source and
verified by a real cross-bank isolation test. Tool discovery alone is not the
test of memory correctness.

## Provider status on this machine

- **Codex:** installed, signed in using ChatGPT, model discovery working, and
  three real app turns passed. Use this for the first recorded demo.
- **Claude Code:** installed but signed out. It has not passed a real response
  test. Complete its login before choosing it.
- **OpenCode:** installed and model discovery working. A real inference turn
  was not tested; discovery does not guarantee every listed model is usable.
- **Gemini / Ollama CLI:** not installed. The separate Ollama embedding service
  is running; it is not the same as a configured coding agent.
- **Codex with Ollama / LM Studio:** no local generation models discovered.

## Start the same local setup

Use Node 24, Docker services, Git, and your signed-in Codex CLI. Keep the existing
`.env`; it contains connection configuration. Do not copy credentials into docs.

```sh
docker compose up -d
npm run db:migrate
npm run doctor -- --local
```

Then keep two terminals open:

```sh
# Terminal 1: web app, explicitly local-disk testing mode
npm run demo:local

# Terminal 2: background memory/repository jobs, same storage mode
npm run demo:worker
```

Open http://127.0.0.1:3000 and sign into your app account. Select Codex in the
room's provider picker. This setup uses `APP_ENV=testing`; development and
production still require cloud storage as documented in [Git storage](git-storage.md).
The demo commands do not silently downgrade a deployed cloud environment.

On this Mac, `/usr/bin/git` is blocked by an unaccepted Xcode license, while
the installed Command Line Tools Git works. If your terminal sees that error,
prefix commands for this session with:

```sh
export PATH="/Library/Developer/CommandLineTools/usr/bin:$PATH"
```

This affects the current shell only. Repair the Xcode installation separately
if you want `/usr/bin/git` to work normally.

## Repeat the checks before recording

```sh
npm test
npm run build -- --webpack
npm run test:demo
npm run test:demo:live
npm run test:repo-context:live
npm run test:memory:live
```

`test:demo` needs the configured local PostgreSQL/Redis services and Chrome.
It uses temporary repositories and a temporary SQL schema, then removes them.
Chrome defaults to its macOS application path; `CHROME_BIN` can override it.
It runs a separate app on port 3103 and Chrome debugging on 9224.

`test:demo:live` additionally makes three real Codex calls using your existing
provider login and may consume subscription usage/credits. `DEMO_AGENT` can
select another installed provider. It verifies exact fixture answers, durable
transcripts, and a committed edit; it is intentionally absent from `npm test`.
`test:memory:live` creates and removes a synthetic memory in a unique test bank.

## Remaining boundaries before the application/demo

The shared-session browser tests use a deterministic runner to test transport
and handoff. The separate live checks use real Codex through server execution
on this controlled local machine. A **real AI continuation across two paired
physical machines** still needs a rehearsal with the second teammate; do not
present the simulated runner test as proof of that deployment.

Cloud Git storage has isolated automated coverage but no real bucket validation
on this machine. No bucket is configured here. A cloud demo requires the
backfill and recovery procedure in the storage guide.

Automatic fact extraction is not configured locally. Durable transcripts,
keyword memory, reviewed memory records, and semantic lookup exist, but do not
demo automatic proposal extraction without setting up and testing its model.

The historical [production audit](production-readiness-plan.md) contains public
hosting gaps beyond this local verification. The Docker context now excludes
environment and credential directories; no image-layer inspection was performed.
Do not expose this local demo's terminal/server execution to the public internet.

Application CI now runs the default tests, lint, and production webpack build
on PRs. Browser/live-provider checks remain explicit local commands because they
need local services, Chrome, and the founder's provider login. The application
checks also [passed on GitHub for commit 64e2bff](https://github.com/Prathamesh314/multiplayer-ai/actions/runs/35598287799).
Initial Windows desktop CI passed its UI checks but failed deleting a still-locked
Chromium profile. The smoke harness now terminates its entire Windows process
tree and retries temporary-file cleanup. See [PR #38](https://github.com/Prathamesh314/multiplayer-ai/pull/38)
for the latest platform check results.

For application positioning, founder facts, video, and batch selection, use
[YC application preparation](yc-application.md). A recorded local demo is ready
to rehearse; customer traction and founder information still need actual inputs.
