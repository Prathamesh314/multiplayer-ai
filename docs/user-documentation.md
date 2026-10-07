# Public user documentation

The handbook at `/docs` is publicly readable without an account. The homepage
desktop/mobile navigation, footer, and Docs section link to it. Signup/setup
requirements also link to the prerequisites guide.

## Content and rendering

- `app/docs/content.ts`: typed guide metadata, ordered sections, Markdown bodies,
  stable section IDs, and screenshot references. These are end-user instructions;
  server operations stay in the deployment runbook.
- `app/docs/[slug]/page.tsx`: static generation, per-guide metadata, accessible
  tables, source screenshots, section anchors, and previous/next navigation.
- `app/components/docs/DocsNavigation.tsx`: full-text guide/section search and
  responsive navigation. Search stays in the browser; no query is sent externally.
- `app/components/docs/CodeBlock.tsx`: command copying with visible error handling.
- `app/docs/screenshots.ts`: image registry, dimensions, labels, and alt text.

When a UI label or workflow changes, update its guide and recapture the affected
screen. Preserve guide slugs and section IDs where possible so shared links keep
working. Do not copy architectural plans into user instructions without checking
the current components and server behavior.

## Coverage and code references

| User guide area | Implementation to check |
| --- | --- |
| Prerequisites, installation, desktop settings | `desktop/setup.html`, `desktop/main.js`, `runner/README.md`, `app/lib/desktop-downloads.ts` |
| Accounts and email verification | `app/components/auth/`, `app/lib/auth/` |
| Computer and AI provider setup | `app/components/ai/`, `app/lib/ai/catalog.ts` |
| Projects, rooms, invitations, administration | `app/components/orgs/`, `app/lib/org/` |
| Repositories, files, publication | `AddRepositoryDialog`, `ProjectRepositoryPicker`, `EditorArea`, `ExplorerPanel`, `TopBar` |
| Conversations, models, attachments, queue | `AiPanel`, `ModelPicker`, `ComposerPicker`, `chat.tsx`, `QueuedMessages` |
| Handoff and checkpoint history | `HandoffPanel`, `WorkspaceHistory`, `app/lib/runner/checkpoints.ts` |
| Guest sharing and access | `ShareChatDialog`, `GuestAccess`, `app/lib/sharing/` |
| Briefings, reviews, feedback, inbox | `app/components/collaboration/` |
| Memory | `MemoryDialog`, `app/lib/knowledge/` |
| Tasks | `app/components/tasks/TaskPanel.tsx` |
| Slack and Discord | `ConnectionsPanel`, `app/lib/integrations/` |
| Terminal availability | `TerminalPanel`, `app/lib/terminal/guard.ts` |

The handbook distinguishes cloud/provider execution from local model inference,
and the hosted terminal from the paired computer. It documents that Publish is
an in-app repository operation, not a GitHub push or pull request. Organisation
invitations, guest chat access, and handoff offers have different expiration rules.

## Screenshot provenance and regeneration

Every file in `public/docs/images/` is captured from the current application UI
or the packaged desktop setup screen. No UI is drawn or generated for the images.
Names, conversations, files, models, membership, and connection states are sample
data. Captions identify that data as illustrative. No customer accounts, live
invitation tokens, provider credentials, or real email deliveries are used.

`scripts/capture-docs.mjs` reuses isolated browser API fixtures from the existing
workspace UI checks. The fixture helpers contain no app imports or side effects
on import; they are injected into a fresh browser profile. API calls made by the
sample workspace are intercepted, and unknown API paths do not reach the server.
The signup verification response and desktop bridge are also simulated. No AI
task is submitted to a provider. The tool refuses non-loopback server addresses.

With dependencies and a local Chrome installation available:

```sh
npm run build -- --webpack
npm run docs:capture
npm run test:docs
```

`docs:capture` prepares desktop assets, starts a local production-mode server,
captures the real screens at 1440 × 960, and saves lossless WebP images. Images
remain sharp when enlarged. `CHROME_BIN` overrides the browser executable. The
capture and test scripts clean up their server and temporary browser profile.
To use an already running local server, set `DOCS_BASE_URL` and invoke the Node
script directly without `--start-server`.

Review regenerated images visually, especially modal scroll position, selected
repository, and code/content labels. Never publish a capture from a personal
browser profile or replace a screenshot with an imagined mockup.

## Verification

`npm run test:docs` checks guide route and section references, image dimensions
and transfer budgets, all public guide responses, missing-route 404 behavior,
homepage entry points, full-text search, screenshot keyboard dismissal/focus,
and mobile/desktop navigation. Its preview screenshots go to Node's temporary
directory as `multiplayer-docs-*.png`.

The application workflow runs these checks after the production build. Changes
to shared fixture helpers should also run `test:ui` and `test:workspace-ui`.
External provider documentation links are kept as official references; model
catalogs and installer versions are not copied into a static release list.
