# Starting a deployment over

Emptying the application's data while keeping the schema — after a beta, or
after a domain move where the old content is no longer wanted. This is
irreversible. Take a backup first and keep it until you are sure.

## The data is in four places, not one

Clearing Postgres alone does not give you a clean deployment. It gives you a
deployment whose rows are gone and whose bytes are not, with Git history and
memory on disk that nothing points at any more.

| Store | Where | Holds |
| --- | --- | --- |
| PostgreSQL | the `postgres` service | accounts, orgs, projects, rooms, chats, transcripts, memory records, invitations, accounting |
| `workspace_data` | `/app/workspaces` | `repos/*.git` (the durable record of every room), `projects/*.git`, `objects/` |
| `mnemosyne-data` | `/data` in the mnemosyne service | the semantic memory sidecar |
| Redis | the `redis` service | rate-limit buckets and presence — ephemeral, rebuilds itself |

Clerk is a fifth, outside this deployment entirely: see
[After the reset](#after-the-reset).

The script lives in the worker image, which is built from the repository, so
**deploy first**: a VM running an older release does not have
`scripts/reset-data.mjs` yet and the command below will not find it.

## 1. Back up, and check the backup

```sh
cd /opt/multiplayer-ai
npm run test:backup   # or follow docs/backup-restore.md for the real procedure
```

Copy the encrypted archive **off the host** along with the separately held
encryption key. A backup you have not moved is not a backup.

## 2. Stop everything that writes

Reset with the application running and it will write new rows mid-truncate, and
leave repositories behind that the database no longer knows about.

```sh
docker compose --env-file .env.production -f compose.production.yml stop web web2 worker
```

Leave `postgres` running — the next step needs it.

## 3. Empty the database

```sh
docker compose --env-file .env.production -f compose.production.yml \
  run --rm --no-deps -T worker node scripts/reset-data.mjs
```

With no arguments it changes nothing: it prints the database name and the exact
row count of every table, so you can see what is at stake. Run it again with
`--confirm <database>` to go ahead. The name has to match, which is what stops
this firing against the wrong database.

It keeps the schema, every index and constraint, and two things a blanket
`TRUNCATE` would destroy: `schema_migrations`, without which the next deploy
replays migrations over a schema that already has them, and the
`storage_capacity` singleton, which only a migration ever inserts and which
storage accounting silently stops working without.

## 4. Clear the repositories and objects

```sh
docker compose --env-file .env.production -f compose.production.yml \
  run --rm --no-deps -T worker sh -c 'rm -rf /app/workspaces/repos /app/workspaces/projects /app/workspaces/objects'
```

Remove those three directories, not the volume or its root: the root is a mount
point and the application recreates the directories on demand.

## 5. Clear the memory sidecar

```sh
docker compose --env-file .env.production -f compose.production.yml stop mnemosyne
docker volume rm multiplayer-production_mnemosyne-data
```

Check the volume's real name with `docker volume ls` first; it is prefixed with
the Compose project name. Compose recreates it empty on the next start.

## 6. Start up and rebuild the counters

```sh
docker compose --env-file .env.production -f compose.production.yml up -d --wait
docker compose --env-file .env.production -f compose.production.yml \
  run --rm --no-deps -T worker node --import tsx scripts/storage-accounting.ts --bootstrap
```

Then `--check` to confirm the ledger agrees with what is actually on disk.
Skipping this leaves the quota accounting describing storage that no longer
exists, and admission will refuse work against a limit nothing is using.

## After the reset

**You will have no accounts, and no way in.** Production defaults to
`SIGNUP_MODE=invite`, and the invitation table is now empty, so nobody —
including you — can sign up. Decide before you start:

- set `SIGNUP_MODE=open` and redeploy, or
- mint the first invitation directly:

  ```sh
  docker compose --env-file .env.production -f compose.production.yml \
    run --rm --no-deps worker npm run beta:invite -- you@example.com https://multicode.in
  ```

**Clerk still has every user.** Identities live in Clerk, not here, so the
accounts you deleted still exist there and can still sign in — they will simply
arrive with no organisation, project or room, and `SIGNUP_MODE` decides whether
they are admitted at all. For a genuinely clean start, delete the users in the
Clerk dashboard too, or accept that old identities can return.

**Paired computers are gone.** Device records were in `runner_devices`, so
every member re-pairs from Desktop settings. Their local worktrees are on their
own machines and are untouched.

## Verifying

```sh
curl -sI https://multicode.in/ | head -1          # 200
```

Then sign in, create an organisation, a project and a room, and run one AI
turn. That exercises the schema, the recreated directories and the rebuilt
counters together. If storage admission refuses, step 6 was skipped.
