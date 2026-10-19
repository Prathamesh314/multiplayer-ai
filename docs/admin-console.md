# Admin console

`/admin` is the operator dashboard for this deployment: growth, AI usage,
computers, system health and recent failures across every organisation. It is
read-only and shows no secrets (tokens, credentials, prompts or file contents).

## Signing in

Administrators are separate from app accounts (Clerk). They sign in at
`/admin/login` with an email and password stored in `platform_admins`
(migration 065, scrypt hashes only).

- Sessions last 12 hours in an HttpOnly, SameSite=Strict cookie (`mc_admin`);
  only the token's SHA-256 is stored.
- Five wrong passwords lock the account for 15 minutes. Sign-in attempts also
  share the strict per-address `auth` rate limit.
- A generated password must be replaced at first sign-in; changing a password
  ends the administrator's other sessions.
- Sign-ins, failures, lockouts, sign-outs and password changes appear under
  **Admin activity**.

Migration 065 creates the first administrator, `admin@multicode.ai`, with a
one-time password given to the owner.

## Adding an administrator or resetting a password

Run on the server, where `DATABASE_URL` points at production:

```sh
npm run admin:user -- someone@example.com "Their Name"
```

It prints a one-time password (send it privately). Running it for an existing
administrator resets the password, unlocks and re-enables the account, and
ends its sessions. To remove access, set `disabled_at`:

```sql
UPDATE platform_admins SET disabled_at = now() WHERE email = 'someone@example.com';
```

## Sections

- **Overview:** KPI cards (users, new and active users, AI turns, success rate,
  lines changed, organisations, computers online) compared with the previous
  7 days; 30-day charts of AI turns and sign-ups; agent mix; newest users.
- **Users** and **Organisations:** searchable, sortable tables with CSV export.
- **AI usage:** turns by outcome and agent, median and p95 turn time.
- **Computers:** online and paired computers, app versions and platforms.
- **System health:** queue backlog, expired leases, failures in 24 hours,
  database and repository storage, invitations, share links, integrations, with
  alerts when something needs attention.
- **Admin activity:** the console's own audit log.
