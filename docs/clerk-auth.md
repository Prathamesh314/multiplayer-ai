# Clerk authentication

Clerk manages sign-up, Google/email sign-in, verification, password recovery, multi-factor authentication, account settings and browser sessions. Multicode AI retains organisation, project, room and shared-chat permissions. Those permissions are not Clerk Organisations.

## Configure a Clerk application

1. Create an application in the [Clerk dashboard](https://dashboard.clerk.com/). Enable **Email** and **Google**. For a simple experience, enable email verification codes; passwords are optional according to your Clerk settings. Require email verification before sign-up completes.
2. Copy the publishable and secret keys into your local `.env`. Never commit credentials:

   ```dotenv
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   AUTH_PUBLIC_URL=http://localhost:3000
   SIGNUP_MODE=open
   ```

3. Run database migrations (`npm run db:migrate`) and restart the development server. The application uses `/login`, `/login?mode=signup`, `/auth/complete`, and `/account`. Use those sign-in/sign-up URLs if configuring application paths in Clerk. Application links preserve the destination and invitation token through authentication.
4. In Clerk, add a webhook endpoint at `https://multicode.in/api/webhooks/clerk`. Subscribe to **user.updated**, **user.deleted**, **session.ended**, **session.revoked**, and **session.removed**. Put its signing secret in `CLERK_WEBHOOK_SIGNING_SECRET`. For local delivery, use a development tunnel and the corresponding development webhook secret.
5. Create a Clerk production instance for `multicode.in` before deploying. Complete Clerk’s DNS and Google OAuth configuration. Use the exact DNS records and Google redirect URI supplied by Clerk; the old `/api/auth/google/callback` is retired. Clerk authentication CNAMEs should follow Clerk's DNS instructions; do not add application CDN caching rules to authentication endpoints.
6. Put the production `pk_live_...`, `sk_live_...`, `whsec_...`, `AUTH_PUBLIC_URL=https://multicode.in` and `SIGNUP_MODE=open` into the VM’s `.env.production`. The publishable key is a Docker build argument; changing it requires rebuilding the web image. The secret key and webhook signing secret are runtime environment variables, never build arguments.

The release preflight refuses to replace the running application if these three Clerk credentials are missing. Keep a database backup and the previous release available while enabling a new authentication provider.

## Existing users

An existing user signs in or creates their Clerk account with the **same verified primary email** used in Multicode AI. The application links that identity to the existing UUID, preserving conversations, repositories, organisation membership and project access. It never trusts an email or user ID submitted by the browser for this link.

Old passwords are not imported into Clerk. Existing users can use Google or an email verification code, then manage their password and security settings in **Account settings**. Enable the email-code method before rollout so users without a Google account have a clear migration path. Old application cookies and password/Google/email-code API endpoints no longer authenticate users.

An email already linked to a different Clerk identity cannot be reassigned automatically. Deleted accounts stay deleted. A Clerk webhook never creates a workspace account or grants project access.

`SIGNUP_MODE=open` admits a new verified identity. `invite` requires a valid application invitation; `closed` permits existing users only. Clerk's own sign-up restriction settings are separate: keep them aligned with the intended signup policy. A shared-chat invitation still grants only its stated view/comment permissions.

## Desktop sign-in

The app opens straight to the same Clerk sign-in and sign-up form as the website; email sign-in and sign-up happen in the app. Google does not allow sign-in inside an app's own window, so in the app Clerk's social buttons are hidden and **Continue with Google** signs in through the browser instead. The only frames from another site the app allows are Cloudflare Turnstile, Clerk's bot check (`desktop/policy.js`, `frameAllowed`).

For the browser flow, choose **Continue with Google**, sign in through Clerk, and explicitly approve the matching code. Return to the desktop app and choose **Complete sign-in**. A request expires after ten minutes. Redemption requires the desktop's random verifier, succeeds once, and checks that the approving Clerk session is still active. The app exchanges approval for a Clerk sign-in ticket valid for sixty seconds. No application login cookie is minted.

If session activation is interrupted, choose **Complete sign-in** again. The app keeps the redeemed ticket and created session in memory for that request, refreshes Clerk's client, and resumes only a session belonging to the approved account. It does not redeem the approval again. An expired ticket requires **Start again**; closing or reloading the sign-in screen also starts a new request. Required Clerk session tasks still complete before entering the workspace.

Runner device credentials remain separate machine credentials. Signing out of one browser does not disconnect a paired computer. Disconnect computers in the workspace. Deleting the Clerk account revokes its devices; disabled accounts cannot use device tokens.

## Operations and verification

Signed webhooks propagate account updates, deletion and session revocation. Monitor delivery errors in Clerk and retry failed events. Duplicate events are safe, and older profile updates cannot overwrite newer ones. Requests check the local revoked-session record; live streams also stop on session JWT expiry and reconnect using the current Clerk cookie.

Run `npm run test:clerk` for account-linking, admission, deletion and desktop proof checks. With local PostgreSQL configured, run `npm run test:clerk:http` against a production build. These use temporary RSA keys and a local provider fixture to exercise real Clerk JWT verification; they do not bypass production authentication or send emails.

Before the first production rollout, verify actual Google sign-in, email-code sign-up, recovery, account settings, sign-out, an existing account, an invitation, webhook delivery, and desktop browser approval using your Clerk development application. Automated local fixtures cannot verify your Clerk dashboard or Google configuration.
