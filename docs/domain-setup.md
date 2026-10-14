# Moving the service to multicode.in

The product is now Multicode AI and the public origin is `https://multicode.in`.
This is the ordered cutover for the existing Bangalore VM, which currently
serves `cubeclashes.com`. Every step below happens in a dashboard or on the VM;
the repository changes that accompany it are already merged.

Nothing here changes where data lives. The VM, its Docker volumes, the database
and the Git storage are untouched; only the name in front of them changes.

## 0. Clear the registry hold first — nothing else can work until you do

`multicode.in` was registered at GoDaddy on 2026-10-13 and the registry
currently publishes it with **`clientHold`**:

```sh
whois multicode.in | grep -i 'Domain Status'
dig +short NS multicode.in      # returns nothing while the hold is in place
```

`clientHold` means the registry removes the domain from DNS entirely. No A
record, Cloudflare zone, certificate or Clerk verification can succeed while it
is set — every lookup fails regardless of what the zone says.

It is normally set on a new registration until the **registrant email address is
verified**. Find GoDaddy's "Verify your email address" message (check spam),
complete it, and confirm with the `whois` command above that `clientHold` is
gone. If it does not clear within a few hours, contact GoDaddy support: only the
registrar can lift it. Do not start step 1 until `dig +short NS multicode.in`
returns GoDaddy's `ns23/ns24.domaincontrol.com`.

## 1. Create the Cloudflare zone

`cubeclashes.com` already uses Cloudflare nameservers (`galilea`/`dante`), with
the apex, `www` and `assets` all resolving to `143.110.177.77` and none of them
proxied. Mirror that, in the same Cloudflare account:

1. **Add/Onboard a domain** → `multicode.in` → **Free** plan.
2. Create the records below. The new zone has no history to preserve, so there
   is no GoDaddy zone file to import — but do not delete anything GoDaddy
   pre-created for parking/forwarding without checking it first.

| Type | Name | Content | Proxy status |
| --- | --- | --- | --- |
| A | `@` | `143.110.177.77` | DNS only (gray) |
| CNAME | `www` | `multicode.in` | DNS only (gray) |
| A | `assets` | `143.110.177.77` | DNS only (gray) |

Confirm the IPv4 in the DigitalOcean dashboard before trusting it; the value
above was observed on 2026-10-13 as the live `cubeclashes.com` origin. Do not
add an AAAA record unless the VM actually has routable IPv6; a DNS64-synthesized
`64:ff9b::…` address is not the server's address.

The `www` record is required now, not optional: the gateway serves a separate
site, `APP_WWW_DOMAIN`, that redirects to the apex, and it needs that name to
resolve in order to obtain a certificate. Compose derives the value from
`APP_DOMAIN` (`www.multicode.in`), so there is nothing to set by hand; override
it only to point some other hostname at this deployment.

## 2. Point GoDaddy at Cloudflare

GoDaddy currently answers for `multicode.in` with `ns23.domaincontrol.com` and
`ns24.domaincontrol.com`. In **DNS → Nameservers → Change → Use my own
nameservers**, enter the exact two nameservers Cloudflare assigned to *this*
zone — they differ per zone, so do not reuse the `cubeclashes.com` pair.

Leave DNSSEC off until the zone shows **Active**, then enable it in Cloudflare
and add the DS record at GoDaddy. Wait for **Active** before step 3.

## 3. Switch the application origin

Everything the old hostname is written into lives in one file on the VM:
`/opt/multiplayer-ai/.env.production` (the checkout path is unchanged — see
"What was deliberately not renamed"). The complete set:

| Variable | New value | Applied by |
| --- | --- | --- |
| `APP_DOMAIN` | `multicode.in` | restart (Caddy site + certificate) |
| `AUTH_PUBLIC_URL` | `https://multicode.in` | restart |
| `APP_ASSET_DOMAIN` | `assets.multicode.in` | restart — **step 5, not now** |
| `NEXT_PUBLIC_ASSET_PREFIX` | `https://assets.multicode.in` | **rebuild** — step 5, not now |
| `DESKTOP_DOWNLOAD_MAC_URL` and the other four `DESKTOP_DOWNLOAD_*` URLs | same paths under `https://multicode.in` | **rebuild** |
| `INTEGRATIONS_PUBLIC_URL` | `https://multicode.in` — only if Slack/Discord are connected | restart |
| `EMAIL_FROM` | `Multicode AI <verify@multicode.in>` — only if Resend is still in use | restart |

"**rebuild**" means the value is a Docker build argument baked into the web
image: `NEXT_PUBLIC_ASSET_PREFIX`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and all
`DESKTOP_DOWNLOAD_*`. Editing the running container's environment does nothing
for those; the deployment workflow rebuilds, so a normal deploy is enough.

Set `APP_DOMAIN` and `AUTH_PUBLIC_URL` now, leave the asset variables for step
5, and deploy through the **Application checks** workflow on `main`. Do not
rebuild by hand.

Caddy requests certificates for `multicode.in` and `www.multicode.in` on
startup, using its existing persistent certificate storage. Keep port 80
reachable for the ACME challenge. Then check:

```sh
curl --fail --silent --output /dev/null --dump-header - https://multicode.in/
curl --silent --output /dev/null --dump-header - https://www.multicode.in/   # 308 to the apex
```

`AUTH_PUBLIC_URL` is what invitation links are built from and what Clerk checks
session origins against, so sign-in stays broken until step 4 completes.

## 4. Re-issue the third-party integrations

Each of these is bound to the old hostname and must be redone for the new one.
Work through them before announcing the domain.

- **Clerk** — follow [clerk-auth.md](clerk-auth.md). A production instance is
  tied to one domain, so create one for `multicode.in`, add the CNAMEs Clerk
  gives you to the Cloudflare zone (keep them **DNS only**), and move the
  webhook endpoint to `https://multicode.in/api/webhooks/clerk`. This issues new
  `pk_live_…`, `sk_live_…` and `whsec_…` values. The publishable key is a Docker
  **build argument**, so changing it requires a rebuild, not just a restart.
- **Resend** — follow [email-verification.md](email-verification.md). Verify
  `multicode.in` (or `mail.multicode.in`), publish its DKIM/SPF/DMARC records in
  Cloudflare, and set `EMAIL_FROM="Multicode AI <verify@multicode.in>"`.
- **Google Cloud Console** — needed, but not for this application's own URLs;
  see [Clerk and Google](#4a-clerk-and-google) below. Every route under
  `/api/auth/google/` answers **410 Gone** ("Sign-in has moved to Clerk"), so
  `https://multicode.in/api/auth/google/callback` is not a URI to register
  anywhere, and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
  `GOOGLE_OAUTH_CREDENTIALS_FILE` in `.env.production` are dead configuration.
  [google-sign-in.md](google-sign-in.md) describes the retired flow and is kept
  for history only.
- **Slack / Discord** — only if Connections are in use; see
  [the integration cutover](#4c-slack-and-discord-cutover) below. The two
  providers are not symmetrical: Slack has a live inbound event URL that stops
  working the moment the old domain does, Discord has none.
- **GitHub Actions** — the deployment job's summary URL already points at the
  new domain. `PRODUCTION_DEPLOY_HOST`, `PRODUCTION_DEPLOY_SSH_KEY` and
  `PRODUCTION_DEPLOY_KNOWN_HOSTS` address the VM over SSH and do **not** change
  with the public domain.

## 4a. Clerk and Google

These are one job, not two: a Clerk **production** instance cannot use Clerk's
shared Google credentials the way a development instance does, so moving to
`multicode.in` forces a trip through Google Cloud Console as well.

Order matters — each step produces a value the next one needs.

1. **Clerk → create the production instance for `multicode.in`.** An instance
   is bound to one domain; the existing one cannot be renamed.
2. **Clerk → DNS.** Clerk lists CNAMEs to publish (`clerk`, `accounts`,
   `clkmail`, and two `clk*._domainkey` records). Add them to the Cloudflare
   zone exactly as given and keep every one **DNS only (grey)** — proxying an
   authentication hostname breaks the flow. Wait for Clerk to show the domain
   verified before continuing.
3. **Clerk → SSO connections → Google**, with both *Enable for sign-up and
   sign-in* and **Use custom credentials** switched on. Clerk then displays an
   **Authorized Redirect URI**. Copy it; do not guess it. It points at Clerk's
   own frontend-API hostname on your domain, *not* at this application.
4. **Google Cloud Console → APIs & Services → Credentials → OAuth client ID**,
   type *Web application*. Paste Clerk's redirect URI into **Authorized
   redirect URIs**. Reuse the existing client if you have one — just add the
   new URI alongside the old, and remove the old after cutover.
5. **Google Cloud Console → OAuth consent screen.** This is the only place the
   rebrand is visible to users: the app name and support email appear on
   Google's consent dialog, so change "Multiplayer AI" to **Multicode AI** and
   add `multicode.in` under authorised domains. A published external app may
   need re-verification if you change the domain — check before announcing.
6. **Back in Clerk**, paste the Google **Client ID** and **Client Secret**.
7. **Clerk → webhook endpoint** → `https://multicode.in/api/webhooks/clerk`,
   subscribing to `user.updated`, `user.deleted`, `session.ended`,
   `session.revoked`, `session.removed`.
8. **The VM.** Put the new `pk_live_…`, `sk_live_…` and `whsec_…` into
   `.env.production` and deploy. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is a
   Docker **build argument**, so a restart is not enough — the deployment
   workflow rebuilds, which is why a normal deploy is the right way to apply
   it. The secret key and webhook secret are runtime-only and must never be
   build arguments.

Expect **every signed-in user to be signed out**: sessions belong to the Clerk
instance, and this is a different instance. Accounts themselves survive —
a user signs in again with the same verified primary email and the application
relinks them to their existing UUID, keeping conversations, repositories and
project access. The release preflight refuses to replace the running
application if any of the three Clerk credentials is missing, so a half-done
configuration fails before it takes traffic rather than after.

## 4b. Turn the hosted terminal on, if you want it

It is off by default and three separate things have to be true, which is why
"it does not work" is usually configuration rather than a fault:

1. `MULTIPLAYER_AI_TERMINAL=1` in `.env.production`, then redeploy. Without it
   the panel says the terminal is disabled in production builds.
2. You must be **signed in**. The routes require an account, because on a
   public host the old loopback-only rule is no longer standing in for
   authentication.
3. The host needs a shell. The image ships bash, and the resolver picks the
   first of zsh/bash/sh that exists; `MULTIPLAYER_AI_SHELL` overrides it.

The panel prints which of these failed. Read `docker/README.md` first: enabling
this gives every signed-in member a **root shell inside the web container**.

## 4c. Slack and Discord cutover

Set `INTEGRATIONS_PUBLIC_URL=https://multicode.in` in `.env.production` and
redeploy. It must be an HTTPS origin with no path, query or fragment — the
integration code rejects anything else with a 503 rather than guessing. Every
redirect URI below is derived from it, so the dashboards and this variable have
to agree exactly.

**Do not change `INTEGRATIONS_ENCRYPTION_KEY`.** Stored tokens are sealed
against `<provider>:<projectId>`, not against the origin, so the domain change
does not invalidate them: existing connections keep working and nobody has to
reconnect. Rotating that key would break all of them.

### Slack — two URLs, one of them time-critical

In [api.slack.com/apps](https://api.slack.com/apps) → your app:

1. **OAuth & Permissions → Redirect URLs** — add
   `https://multicode.in/api/integrations/slack/callback`. Keep the old entry
   until the cutover is finished; Slack allows several. This one only affects
   *new* connect flows, and an unlisted URI fails at authorisation time, not at
   startup, so nothing warns you until someone tries to connect.
2. **Event Subscriptions → Request URL** — change to
   `https://multicode.in/api/integrations/slack/events`. **This is the urgent
   one.** It is where Slack pushes live messages, and it accepts exactly one
   URL, so the moment `cubeclashes.com` stops resolving, live Slack messages
   stop arriving. Update it as soon as the new domain serves HTTPS.

   Slack posts a `url_verification` challenge the instant you save, and the
   route answers it, so the new origin must already be live — otherwise Slack
   refuses the URL. The page should show **Verified**.
3. Confirm the subscribed bot events are unchanged: `message.channels`,
   `channel_archive`, `channel_deleted`, `channel_left`, `member_left_channel`,
   `app_uninstalled`, `tokens_revoked`.
4. Scopes stay `channels:read` and `channels:history`. A redirect-URL change
   does not require reinstalling the app; a scope change would.

If events are interrupted, the periodic reconciliation sync still imports the
most recent 15 top-level messages per channel, so a short gap mostly heals
itself. A long one loses the messages in between.

### Discord — one URL, and no event endpoint

In [discord.com/developers/applications](https://discord.com/developers/applications)
→ your app → **OAuth2 → Redirects**: add
`https://multicode.in/api/integrations/discord/callback`.

That is the whole change. Discord messages arrive over a Gateway connection the
background worker opens **outbound** using `DISCORD_BOT_TOKEN`, so there is no
inbound webhook to repoint and live Discord context is unaffected by the domain
move. Leave **Require OAuth2 Code Grant** and the **Message Content Intent**
as they are.

### Verifying

Reconnect one Slack channel and one Discord channel from **Connections** in a
project, then post a message in each and confirm it appears. That exercises the
new redirect URI, the token exchange and live delivery together. Once it works,
remove the old `cubeclashes.com` redirect entries from both dashboards.

## 5. Enable the asset CDN

Only after the apex is healthy, follow
[cloudflare-cdn.md](cloudflare-cdn.md) to point `assets.multicode.in` at the
origin, verify it DNS-only, then switch that one record to **Proxied**. Keep the
apex and `www` DNS-only: proxying the main hostname would cap request bodies at
Cloudflare's 100 MB — below the 128 MiB this application's Git receiver accepts
— and would change the trusted-client-IP handling.

## 6. Retire cubeclashes.com

Keep it resolving for as long as people may still hold old links. Its zone is
already in Cloudflare, so the cheapest handover is a **Redirect Rule** on that
zone sending `https://cubeclashes.com/*` to `https://multicode.in/$1` with a 308.
Do not point the old hostname at the application: two origins serving the same
app means split cookies and invitation links that fail Clerk's origin check.

Existing desktop installs keep their saved workspace address, so each person
must open **Desktop settings** and change it to `https://multicode.in`. Paired
devices are bound to the server they paired with, so they need to pair again.

## What was deliberately not renamed

The rebrand covers the product: the website, documentation, emails, the desktop
app and the runner package. It deliberately stops at identifiers that own live
state or external identity, because renaming them would cost real data or
continuity for no visible gain:

| Identifier | Why it stays |
| --- | --- |
| `MULTIPLAYER_AI_DATA`, `MULTIPLAYER_AI_TERMINAL` | The VM's `.env.production` already sets them; a rename silently falls back to defaults and the workspace repositories appear to vanish. |
| `/opt/multiplayer-ai` | The deploy entrypoint in root's `authorized_keys` runs against this path. |
| Compose project names, volume and image names, `POSTGRES_USER` | Compose prefixes volumes with the project name — renaming orphans the database, workspace and Redis volumes rather than moving them. |
| `X-Multiplayer-Client-IP`, `X-Multiplayer-Proxy-Secret` | Gateway and application must agree; renaming buys nothing. |
| `ai.multiplayer.desktop` (appId) | Changing the bundle id breaks desktop auto-update for everyone already installed. |
| `github.com/Prathamesh314/multiplayer-ai` | The repository itself has not been renamed. |

Two user-visible paths did change name but stay backward compatible: the desktop
app's `userData` directory and the default worktrees folder
(`~/multicode-ai/workspaces`) both keep using the old `multiplayer-ai` location
when it already exists, so nobody has to re-pair or re-clone.

## Verification before you tell anyone

Each of these exercises a different piece of the cutover; a green homepage
proves only the first.

```sh
whois multicode.in | grep -i clientHold          # must print nothing
dig +short NS multicode.in                       # the Cloudflare pair
curl -sI https://multicode.in/ | head -1         # 200
curl -sI https://www.multicode.in/ | head -1     # 308 to the apex
curl -sI https://assets.multicode.in/docs/images/workspace.webp | head -1   # 200, step 5
```

Then, in a browser: sign in with Clerk; open an invitation link and check it
carries the new hostname; pair a computer from **Your computers**; send one AI
prompt. If Connections are configured, reconnect one Slack or Discord channel.

## What this does not do

Changing the domain does not migrate accounts, invitations already sent, or
Clerk sessions — users will be signed out when the Clerk instance changes. It
does not move the server, change its capacity, or provide multi-region serving.
Verify an actual sign-in, an invitation link, an email delivery and a runner
pairing on the new domain before pointing anyone at it.
