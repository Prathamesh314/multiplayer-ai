# Providers and automatic model discovery

The model picker now reads inventories from the machine that will execute the turn, instead of relying on release names compiled into the frontend. One-time CLI installation/account login is still required; discovery does not authenticate accounts, run models, buy credits, upgrade binaries, or download model weights automatically.

## Supported execution options

| Option | Model inventory | Setup on the execution machine |
| --- | --- | --- |
| Claude Code | Rolling Opus/Sonnet/Haiku aliases; exact IDs through Anthropic's Models API when `ANTHROPIC_API_KEY` is configured | Install Claude Code and sign in normally |
| Codex CLI | Codex App Server `model/list`, including the selected model's supported reasoning efforts | Install/update Codex and sign in normally |
| Gemini CLI | Its current default; individual text-generation models through Google's Models API when `GEMINI_API_KEY` or `GOOGLE_API_KEY` is configured | Install Gemini CLI and complete its login/setup |
| OpenCode | Refreshed inventory from configured providers, filtered to tool-capable text models | Install `opencode-ai`, then `opencode auth login` |
| Ollama | Models installed on the default local Ollama server | Install/start Ollama and explicitly download a model first; this option is chat-only |
| Codex + Ollama | Installed Ollama models, executed using Codex's OSS backend | Install Codex, start Ollama at `127.0.0.1:11434`, and choose a tool-capable model |
| Codex + LM Studio | LM Studio's served model IDs, excluding recognizably embedding-only IDs | Install Codex, start LM Studio's API server at `127.0.0.1:1234`, and make a compatible model available |

OpenCode provides the multi-provider integration: for example OpenRouter, OpenAI, Anthropic, Google, DeepSeek, Groq, and other providers configured in OpenCode. This is not a separate implementation of every provider's API in this application. Custom OpenAI-compatible endpoints can be configured through OpenCode. Its credentials stay with OpenCode on the execution machine.

Local coding depends on the model's tool support, server compatibility, and available RAM/VRAM. Discovery alone cannot establish that an arbitrary downloaded model will perform coding tasks reliably. The dedicated local options use the default localhost endpoints; use OpenCode configuration for custom endpoints. Do not assume that a model served by a locally running proxy is necessarily offline: cloud-backed models and user configuration can still use a remote service.

## Automation and failure behavior

- Cloud/CLI inventories refresh on a five-minute cache cycle. Local inventories refresh on a thirty-second cycle. The runner's existing heartbeat drives this while it is running, including when no browser is open; a server-only setup refreshes on application requests.
- OpenCode's refresh updates its upstream model registry. Codex asks its installed CLI for available models. Anthropic/Google API discovery handles pagination and uses credentials only in request headers to fixed official endpoints. Subscription-only Claude/Gemini users retain rolling aliases/default behavior without extracting their OAuth tokens.
- The browser refreshes provider metadata every thirty seconds and on window focus. Model selection uses a searchable picker with inventory source, update time, and stale/error status. The Providers button exposes installation and connection guidance after an agent is already connected.
- Concurrent discovery requests share work. Requests have time/output limits, forced refreshes are briefly throttled, and only normalized model IDs, labels, and effort choices cross the runner boundary.
- Failed refreshes retain the last successful inventory for at most twenty-four hours, visibly marked stale. After that, only safe CLI defaults/aliases remain; providers requiring an explicit model have no fallback model.
- Successful refreshes replace the inventory rather than permanently accumulating retired IDs. A selected model that disappears stays visibly unavailable; the app does not silently choose a newer or more expensive model.
- The server validates the model and effort before reserving execution. Claims require an online device owned by the caller advertising that exact model/effort. The executor revalidates availability before invoking the CLI. An unavailable runner model does not silently route to server execution.
- Existing handoff ownership, turn fencing, Git isolation, and completion guarantees remain in place.

New models appear when the upstream registry/API/installed CLI exposes them and the configured account can use them. This is automatic discovery, not a guarantee of immediate day-zero access to every release. CLI upgrades, provider contract changes, account approval, and local model installation remain external prerequisites.

## Configuration and rollout

1. Apply `027_runner_model_catalog.sql` with `node --env-file=.env db/migrate.mjs` after backing up the database.
2. Restart the application, worker, and updated runner. Runner protocol 2 remains compatible; older runners without model inventories can only take default Claude/Codex/Gemini jobs. Update them to advertise explicit models. Old Ollama jobs without a chosen model are no longer eligible.
3. Install/connect additional providers on each user's own execution machine. For OpenCode: `npm install -g opencode-ai`, then `opencode auth login`. Local models must be installed explicitly through Ollama/LM Studio.
4. Start the runner with `npm run runner`. In the room, open Providers, choose an execution option, then use the model picker.

Optional exact-model discovery credentials are `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY` in the execution process environment. They are not stored in the room database, sent to browsers, or included in runner heartbeats. Do not paste API keys into shared chat. The web process only performs server-side CLI discovery when its existing terminal-execution gate allows that environment; otherwise the UI uses the signed-in user's runner snapshots.

No new third-party application dependencies or paid inference calls are required by discovery itself. Using a configured provider to execute a turn follows that provider's account/billing rules.

## Validation

`npm run test:models` covers discovery normalization, capability filtering, pagination, concurrent refresh, stale expiry, removed models, and error redaction. `npm run test:handoff` includes exact-model/effort routing and legacy runner compatibility. The optional real PostgreSQL/browser suite covers model-picker updates from real heartbeat/API requests, per-user catalog isolation, newly advertised models, removed-selection preservation, and refusal before execution.

```sh
npm test
npm run test:knowledge
HANDOFF_TEST_POSTGRES=1 HANDOFF_TEST_BROWSER=1 node --env-file=.env --import tsx tests/handoff.test.mjs
npx tsc --noEmit
npm run build -- --webpack
```

Live Codex `model/list` and OpenCode registry discovery were checked against the installed CLIs without starting a model turn. Local-server discovery and external Models APIs also have deterministic fixture tests; no real local-weight generation or paid-provider inference is claimed by those tests.

## Official references

- [Codex model discovery](https://developers.openai.com/codex/app-server/)
- [Codex OSS/local-provider options](https://developers.openai.com/codex/cli/reference/)
- [OpenCode model refresh](https://opencode.ai/docs/cli/)
- [OpenCode provider configuration](https://opencode.ai/docs/providers/)
- [Claude Code rolling aliases](https://code.claude.com/docs/en/model-config)
- [Anthropic Models API](https://platform.claude.com/docs/en/api/models/list)
- [Google Models API](https://ai.google.dev/api/models)
- [Ollama installed-model inventory](https://docs.ollama.com/api/tags)
- [LM Studio model inventory](https://lmstudio.ai/docs/developer/openai-compat/models)
