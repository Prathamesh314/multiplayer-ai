# Google signup and sign-in

> Legacy runbook for releases before the Clerk migration. Current authentication is managed by Clerk; use [Clerk setup](clerk-auth.md). The endpoints described below are retired in current releases.

Google is an additional login method for every user, not an email allowlist.
Email signup collects only an email and password in one form. Usernames are
generated automatically. New Google accounts enter the workspace immediately
after Google authentication without choosing a username or creating a password. The configured `SIGNUP_MODE` still applies: `invite`
requires a current invitation for the verified Google email; `closed` permits
existing accounts to sign in but blocks new accounts. Google approval itself does
not join an organisation or grant project access. Organisation invitations still
go through their existing acceptance page.

## Google Cloud setup

1. Select or create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Open Google Auth Platform and configure Branding (app name, support/contact
   email and your app domain). Choose an External audience to support customers
   outside your own Google Workspace organisation.
3. Under Clients, create a **Web application** OAuth client. Add the exact
   authorized redirect URI `https://cubeclashes.com/api/auth/google/callback`.
   For a different deployment substitute its own HTTPS origin. This server
   redirect flow does not require a JavaScript origin or Google API keys.
4. Download the client JSON and save it outside the repository (for example,
   `/root/multiplayer-deployment-config/google-oauth.json` on the production host).
   Set server-only configuration in `.env` locally or `.env.production` on the server:

   ```dotenv
   SIGNUP_MODE=open
   AUTH_PUBLIC_URL=https://cubeclashes.com
   GOOGLE_OAUTH_CREDENTIALS_FILE=/absolute/path/to/google-oauth.json
   ```

   Production Compose mounts this host file read-only into both web replicas.
   Use the server's path, not a path that exists only on your laptop. The file
   must be readable by the web process; for the production root-run containers,
   keep it mode `600`. After setting or replacing it, recreate both web services:

   ```sh
   docker compose --env-file .env.production -f compose.production.yml up -d --no-deps --force-recreate --wait web web2
   ```

   The downloaded JSON must contain the `web.client_id` and `web.client_secret`
   fields; Desktop client and service account JSON are not accepted. Alternatively,
   leave the file path empty and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   individually. A configured file takes precedence. Neither file contents nor
   file errors are sent to the browser. Keep a private backup of the JSON: the
   application's backup archives include the environment's path, not this
   external credential file.

5. In Testing mode add the Google accounts that will test the app. For general
   customer access, complete Google's applicable branding/consent requirements
   and change the audience publishing status to In production. Only basic
   `openid email profile` scopes are requested; no Gmail or Drive access.
6. Deploy migration `045_google_auth.sql` before starting the updated web
   services. Compose forwards these runtime variables to both web instances.
   After changing credentials, recreate web/web2 so they load the new values.
   Keep the secrets out of Git and client-side environment variables.

The login button is shown only when the client ID, secret and valid public
origin are configured. There is no single-user restriction in the code. For
local tests use a separate Google client with an exact loopback callback such
as `http://localhost:3000/api/auth/google/callback`. Only loopback origins may
use HTTP.

## Existing accounts

Provider identities are keyed by Google's immutable `sub`, never by email.
Once linked, the same Google account signs in to the same app account even when
its Google email changes. The app's existing email is not silently changed.
When a previously unlinked Google identity matches an existing app email, the
user must prove ownership with that app account's password before linking.
Google-only accounts cannot be linked to a second Google identity this way.
Deleted accounts remain blocked. Password login continues to work after linking.
Google also marks the matching stored email as verified, so enabled
[email verification](email-verification.md) does not ask for an additional code.

## Desktop flow

Google authorization uses the system browser, including with the existing
desktop preview builds. Click Continue with Google in the desktop app; compare
the displayed request code in the browser; authorize Google and explicitly
confirm desktop sign-in. Return to the desktop app and click Complete sign-in.
Keep the desktop login screen open throughout this flow.

The browser grants approval to a single ten-minute request. Only the originating
app has the random verifier needed to redeem it. Redemption is atomic and
single-use, and sets the app's existing Secure/HttpOnly session cookie. No Google
token or app session token is passed in a URL, clipboard or Electron IPC. The
desktop runner then connects through the existing automatic connection flow.
There is no background sign-in polling or new desktop binary requirement.

## Security and verification

The authorization-code flow uses PKCE S256, browser-bound single-use state and a
nonce. The server validates Google's RSA signature, issuer, audience, authorized
party when supplied, expiry, issue time, nonce and verified email with `jose`.
Public origins and Google endpoints are fixed by server configuration. OAuth
completion and desktop redemption require a matching Origin header and use the
existing auth rate-limit budget. Untrusted return URLs fall back to `/workspace`.

PostgreSQL shares short-lived state between replicas; raw browser tokens, state
and invitation tokens are stored as hashes. PKCE verifiers are removed once the
exchange succeeds. Expired requests are pruned when new sign-ins begin. Google
access/refresh tokens are not retained. Errors do not log provider responses.

`npm run test:google-auth` covers signature/claim validation, state binding and
replay, invitation restrictions, account linking, deleted accounts and desktop
approval/redemption. Set `GOOGLE_AUTH_TEST_POSTGRES=1` and `DATABASE_URL` to run
the store cases in a disposable PostgreSQL schema. `npm run test:google-auth:http`
exercises production routes with a test-only provider transport; it does not
replace a real Google consent test with configured credentials.

References: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect),
[web application OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred),
[Google OAuth browser policy](https://developers.google.com/identity/protocols/oauth2/policies#browsers).
