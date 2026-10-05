# Email verification

Email/password signup and login require a six-digit email code once per account
when `EMAIL_VERIFICATION_ENABLED=true`. New registrations and existing unverified
accounts receive no login session or connect code until verification succeeds.
Verified accounts sign in with their password normally. Google signup verifies
the address through Google; linking or returning through Google also verifies
the stored email when it matches the provider's verified address.

## Configure Resend

1. Add a sending domain in [Resend](https://resend.com/domains), such as
   `cubeclashes.com` or `mail.cubeclashes.com`, and publish the DNS records Resend
   supplies. Wait until the domain is verified.
2. Create a Resend API key with permission to send from that domain.
3. Set these server-only values in `.env.production` on the VM (or `.env` locally):

   ```dotenv
   EMAIL_VERIFICATION_ENABLED=true
   RESEND_API_KEY=re_your_api_key
   EMAIL_FROM="Multiplayer AI <verify@cubeclashes.com>"
   AUTH_PUBLIC_URL=https://cubeclashes.com
   ```

   The `EMAIL_FROM` address must use your verified sending domain. The Resend
   test sender is not a general production sender. Do not prefix these variables
   with `NEXT_PUBLIC_` or commit the API key.
4. Apply migration `046_email_verification.sql` through the deployment pipeline.
   For an already deployed version, recreate both web services after changing
   the environment:

   ```sh
   cd /opt/multiplayer-ai
   docker compose --env-file .env.production -f compose.production.yml -f compose.https.yml up -d --no-deps --force-recreate --wait web web2
   ```

5. Sign up with an email you control, check delivery (including spam), enter the
   code, sign out, and sign in again. The second sign-in should not ask for a code.

The rollout setting defaults to `false` so an unconfigured mail service does not
interrupt existing deployments. Enable it only after configuring delivery. Once
enabled, missing credentials and provider outages **never bypass verification**.
A provider failure keeps the account unverified and lets the user retry from the
code screen. Disabling the setting does not mark anyone's address as verified.
Existing login sessions remain valid; unverified users are checked at their next
email/password sign-in. This is address verification, not a code on every login.

## Flow and limits

- Codes expire after 10 minutes; the pending browser request expires after one hour.
- Five incorrect code attempts exhaust that code.
- Sending is limited to once per minute and five deliveries per account per hour,
  shared by all web replicas. Failed sends count toward the budget too.
- Resending invalidates the previous code. A new password login from another
  browser can replace the challenge only after the same cooldown.
- Refreshing the login page preserves the pending verification through an
  HttpOnly, Secure, SameSite cookie. It contains a random browser secret, not a
  login session. Cancelling invalidates that request without resetting its budget.
- PostgreSQL stores the browser token's SHA-256 and the code's HMAC keyed by the
  browser secret. Plaintext codes and provider errors are never logged or returned
  by application routes. Only the email provider receives the code for delivery.
- Verification atomically marks the current email verified and consumes the
  challenge. Deleted accounts, changed email addresses and replayed codes fail.
- The legacy `/api/auth/continue` endpoint uses the same verification gate as
  `/api/auth/login` and `/api/auth/register`. Verification/resend/cancel requests
  require the workspace Origin and use the shared authentication rate limiter.

`npm run test:email-verification` covers persistence, expiry, limits, replay,
concurrency, deletion and delivery failure. Set `EMAIL_TEST_POSTGRES=1` to run
against an isolated PostgreSQL schema. `npm run test:email-verification:http`
exercises two production web instances and a real browser with a test-only mail
transport; it sends no real emails. Both checks run in CI. A real inbox delivery
check is still required after configuring Resend.

References: [Resend sending API](https://resend.com/docs/api-reference/emails/send-email),
[domain verification](https://resend.com/docs/dashboard/domains/introduction).
