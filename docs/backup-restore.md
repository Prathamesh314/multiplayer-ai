# Coordinated backup and restore

This profile covers the single Linux Docker host using local object storage and
local desktop runners. It pauses gateway, both web replicas, worker and memory
service, then encrypts a PostgreSQL custom dump, the complete workspace volume,
the memory volume, the deployment environment file and an integrity inventory.
Originally running services restart even if backup fails. Expect a maintenance
window; this is a point-in-time maintenance backup, not continuous PITR.

Keep a random 32-byte key as 64 hex characters in `BACKUP_ENCRYPTION_KEY`, supplied
from a password manager or private process environment. Keep it separately from
backups. The command never prints the key or resolved configuration. Individual
artifacts use authenticated AES-256-GCM encryption, checksums, and private file
permissions. A backup is valid only when its manifest exists.

```sh
npm run backup:create -- --output /secure/backups/new-backup-directory
```

Defaults are `compose.production.yml` and `.env.production`. Override with
`--compose FILE --env-file FILE --project NAME`. Copy the completed encrypted
backup **off the server**, retain the original key, and retain the reviewed source
revision/images separately. A backup on the same disk does not cover host loss.

Restore uses the same application/schema revision as the backup. Recover the
original environment into a new private file after host loss:

```sh
npm run backup:restore-config -- --source /secure/backups/backup-directory --output .env.recovered
```

Review configuration locally, retain `INTEGRATIONS_ENCRYPTION_KEY`, and adjust
hostname/other environment-specific settings without printing secrets. Restore
requires an entirely new Compose project and new volumes; it never overwrites a
running deployment:

```sh
npm run backup:restore -- --source /secure/backups/backup-directory --env-file .env.recovered --project multiplayer-restored --report /secure/backups/restore-report.json
```

All artifacts authenticate before target creation. Only PostgreSQL/Redis start;
web, worker and gateway remain stopped. The verifier compares every public-table
row digest, Git refs, referenced commits/checkpoints and activity/object hashes
against the source. The restore must retain the original integration encryption
key. Inspect the report, then start the reviewed application images using the
same project/environment arguments. Do not run destructive development reset
commands against these volumes.

Run `npm run test:backup` for the isolated Docker drill. It creates fresh fixture
projects only, checks real PostgreSQL/Git/activity/SQLite memory restoration,
refuses existing targets, and rejects tampering/wrong keys before creating a
target. `BACKUP_TEST_IMAGE` selects a prebuilt production web image. The fixture
uses a small real SQLite database instead of contacting an LLM/memory provider.
It does not establish your production recovery time or backup frequency; measure
both on the deployed dataset and repeat the drill after storage/schema changes.
