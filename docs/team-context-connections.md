# Slack and Discord project context

The workspace's **Connections** view replaces the human channel/DM sidebar.
AI chats, task assignment, repositories, handoffs and previous chat records stay
in place. A project manager connects a Slack workspace or Discord server, then
explicitly shares up to ten public channels with that project's members.
Connecting alone imports nothing. Other members can inspect connections and open
the original channels, but cannot change them.

## Setup

Apply migrations (`npm run db:migrate`), build/restart the web app, and run the
background worker (`npm run worker`, or the production Compose worker). Keep
**one worker with the Discord token** per deployment: it owns one Discord Gateway
connection for every connected project. Multiple web replicas are supported.
The existing app memory backend remains PostgreSQL with optional Mnemosyne.

Set these server-only variables on web and worker processes:

```dotenv
INTEGRATIONS_PUBLIC_URL=https://app.example.com
INTEGRATIONS_ENCRYPTION_KEY=<64 hexadecimal characters from openssl rand -hex 32>
TEAM_CONTEXT_BACKEND=postgres
TEAM_CONTEXT_RETENTION_DAYS=30
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_SIGNING_SECRET=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
```

Configure either provider or both. The UI labels unconfigured providers as
needing server setup and disables authorization. Both Compose configurations
forward these variables. When running processes directly, Next and the worker
load the normal `.env` files. Slack requires a reachable HTTPS callback/event URL;
plain localhost cannot receive its events. Use a separately configured test app
and HTTPS development endpoint when testing actual installations.

The encryption key must remain stable; back it up separately from the database.
Slack access tokens use AES-256-GCM with the provider/project as authenticated
data. Losing/changing the key requires reconnecting affected Slack installations.
Tokens and app secrets never go to the browser, AI context or logs.

### Slack

1. Create a Slack app and copy its client ID, client secret and signing secret
   into the variables above.
   Enable distribution when customers in other Slack workspaces will install it.
2. Add the redirect URL
   `https://app.example.com/api/integrations/slack/callback`.
3. Request bot scopes **channels:read** and **channels:history**. Leave token
   rotation disabled for this initial adapter; rotating grants are rejected
   rather than silently retaining an expiring token. No send-message or DM scopes
   are requested.
4. Enable Events API subscriptions at
   `https://app.example.com/api/integrations/slack/events`. Subscribe to
   `message.channels`, `channel_archive`, `channel_deleted`, `channel_left`,
   `member_left_channel`, `app_uninstalled`, and `tokens_revoked` where offered.
   The route verifies Slack's raw-body HMAC and five-minute timestamp window,
   including URL verification. Database failures return 503 so Slack can retry.
5. In **Connections**, select a project and **Connect Slack**. Invite the installed
   app to each public channel, then **Choose channels**, confirm sharing with the
   project and save. Only public, unarchived channels containing the app appear.

Initial/reconciliation sync imports the latest **15 top-level messages** per
channel. Slack history calls share a database-backed cooldown of at least 65
seconds per remote workspace, including installations connected to several
projects. Live messages and thread replies arrive via Events API. Older thread
history is not backfilled by this bot-only integration.

### Discord

1. Create a Discord application/bot. Set its client ID, client secret and bot
   token. Register
   `https://app.example.com/api/integrations/discord/callback`.
2. Enable **Require OAuth2 Code Grant**. The callback accepts only the guild
   returned by Discord's token exchange, never the browser's `guild_id` hint.
   Enable **Public Bot** when other server administrators should install it.
3. Enable the privileged **Message Content Intent**. Obtain Discord approval
   where required for your application's size/status.
4. **Connect Discord** from a project. The OAuth grant requests `bot identify` and
   only **View Channel** and **Read Message History** bot permissions. Save the
   selected public text channels. The bot must actually be able to read them.

The worker uses discord.js for Gateway heartbeats, resumption, reconnects and
REST rate handling. Message create/edit/delete and bulk-delete events update
the source records. Guild/channel/role changes invalidate cached access until
reverified. DMs, private channels, voice, forum and thread channels are excluded.
Initial/reconciliation sync imports the latest **50 messages** per channel.

### Desktop authorization

Desktop users open the web workspace from **Connect Slack/Discord**, sign in
there with their app account, then finish OAuth in that browser. They can return
to the desktop app and **Refresh status**. This preserves the desktop navigation
sandbox and keeps OAuth state bound to the same signed-in account. Expired,
replayed, cross-user or cross-provider states cannot complete a connection.

## Retrieval, permissions and lifecycle

Selected channels are deliberately **shared with the whole project**. External
user identities are attribution, not app accounts. External service membership
is not mirrored onto each project member; managers confirm their authority to
share before saving. Only public channels are supported in this version.

PostgreSQL holds bounded source records: provider, workspace/server, channel,
message ID, author, timestamp, optional reply ID, text and source URL. Attachments,
media and binary files are not downloaded. English/simple full-text indexes
retrieve at most eight candidates. Prompts receive complete, attributed JSON
records within the existing 6,000-character discussion budget. They are marked
as historical evidence, not instructions, and are not promoted into approved AI
facts. Ask, for example, “What did Slack say about checkout retries in
#engineering?” Unknown/ambiguous channel or author selectors do not broaden the
search. Explicit Slack/Discord mentions trigger the discussion route.

Every retrieval checks current project membership, active organisation
membership, deleted accounts, project archival, current channel selection and
source deletions. Project room guests do not gain project-wide external context.
Messages from another project cannot be returned even by a future remote search
backend. Removing a channel or disconnecting deletes its imported records;
late events and old sync jobs cannot recreate it. Reconnect starts with no
selected channels. Other projects and original Slack/Discord content are not
changed, and the shared bot remains installed until an external administrator
removes it. Existing AI transcripts already containing an excerpt are retained.

Live events are idempotent; newer edits win and deletions leave text-free
tombstones so delayed history cannot resurrect messages. The worker reconciles
recent history/permissions roughly every ten minutes. More projects linked to
the same Slack workspace or provider throttling can delay this. Channels whose
access has not been verified in 30 minutes are excluded from retrieval. Provider
permission changes can take up to that window to be reflected if no event arrives.
History reconciliation protects messages arriving during the fetch and detects
missed deletions in the recent returned window. It is **not a complete archive**:
events missed during a long outage, old edits/deletions outside that window, and
old Slack thread replies cannot all be recovered by this initial adapter.

Retention defaults to 30 days (configurable 1–365) and 10,000 records/channel,
with text capped at 16,000 characters/message. The worker prunes expired records;
retrieval also enforces retention when the worker is unavailable. The bounded
Discord event queue disconnects/reconciles rather than growing without limit.
Monitor worker warnings, connection status, provider limits and database storage.

## Future providers, including Mosaic

`TeamAdapter` in `app/lib/integrations/types.ts` separates vendor OAuth/channel
APIs from normalized records. `ContextSearchBackend` in `context.ts` separates
search from storage and authorization. `TEAM_CONTEXT_BACKEND=postgres` uses the
existing local database; `disabled` stops external discussion recall. Unknown
backends are not silently treated as working integrations.

A future Mosaic adapter can deliver/search the same source identities. Its
candidate IDs must be hydrated through the local access/deletion checks before
entering prompts. Register that adapter and add its configuration only after its
actual API and retention model are available; this change does not fabricate a
Mosaic endpoint, send it data, or replace the existing memory system.

## Verification

`npm run test:team-context` covers encryption, signed requests, OAuth binding and
replay, channel eligibility, tenant access, suspension, event ordering,
deletions, disconnect and provider throttling with isolated fixtures. The browser
suite covers the Connections UI, channel search, sharing consent, failed-save
retry, disconnect and responsive layouts. Actual Slack/Discord installation
requires real app credentials and a reachable HTTPS deployment; mocked protocol
tests do not certify a live third-party installation.

`TEAM_CONTEXT_TEST_POSTGRES=1 npm run test:team-context` runs those scenarios in
temporary PostgreSQL schemas. After a production build,
`npm run test:team-context:http` verifies real HTTP authentication, manager gates,
OAuth account/state binding and signed event delivery against an isolated schema.

References: [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/),
[Slack signed requests](https://docs.slack.dev/authentication/verifying-requests-from-slack/),
[Slack history limits](https://docs.slack.dev/reference/methods/conversations.history/),
[Discord OAuth](https://docs.discord.com/developers/topics/oauth2),
[Discord Gateway](https://docs.discord.com/developers/events/gateway).
