# Local execution and durable workspace history

Each room can contain multiple repositories. Each repository has its own local
worktree; chats working on that room repository share it. The desktop runner
executes agents and keeps dependencies and working files on the user's machine.

The server imports files directly into Git blobs and a private import index.
Finishing an import creates a tree and commit, without extracting a project
folder. Browser edits use a temporary index and three-way file merge; publish
and sync use `git merge-tree`. These require Git 2.38 or newer. Existing server
checkouts are preserved until inspected with the maintenance command below.
Development-only server agent execution still needs a temporary checkout; after
a successful candidate push that checkout is removed. Failed uploads retain it
for recovery. Hosted deployments should keep local runners required, as before.

## Activity and offline review

The updated runner saves ordered event batches locally before attempting upload.
The server writes compressed activity objects, then records their checksum and
sequence in PostgreSQL before acknowledging. A restart retries unacknowledged
batches. Gaps and conflicting retries fail; an acknowledged retry is idempotent.
Output, errors, notices and tool activity can be replayed from **Activity &
checkpoints** in a chat. Private thinking and local machine paths are not
included in shared replay. Existing saved chat messages remain in PostgreSQL.

The runner batches live output approximately once a second. A batch is limited
to 256 KB on the server, a turn to 8 MB, and replay pages to eight batches.
The browser keeps a bounded activity window instead of rendering an unlimited
transcript. The UI shows the last server synchronization time. Unsynchronized
changes, unsaved editor buffers and commands run outside the app are not
available when a laptop shuts down. This is workspace history, not desktop
screen recording.

## Checkpoints and takeover

The runner captures a checkpoint at turn start/end, every 30 seconds during a
turn, and polls previously used workspaces between claims for manual edits.
A checkpoint contains:

- Room/repository, turn, originating device, sequence and timestamps.
- Base commit and local HEAD.
- A commit whose tree represents the staging area.
- A commit whose tree represents working files, including eligible new files.

The checkpoint's parents retain the local HEAD and staging-area commit. Its
immutable Git ref is `refs/checkpoints/<turn-id>/<sequence>`. A temporary index
captures changes without modifying the user's actual index or branch. Only
missing Git objects transfer; unchanged captures produce no new checkpoint.
Checkpoint metadata becomes visible only after verifying the uploaded ref and
object relationships. Failed uploads/reports stay in the runner outbox.

Ignored files and untracked dependency/build/cache directories are excluded.
Tracked files remain tracked. A source file may be at most 8 MB and a captured
source tree 256 MB. Each turn can retain up to 120 distinct checkpoints;
start a new turn after reaching that limit. Git submodule references are
preserved, but edits inside a submodule require adding it as a separate room
repository. Checkpoints observe on-disk files; they are not filesystem-wide
atomic snapshots of a running application.

To take over:

1. Open the chat and inspect **Activity & checkpoints** while the driver is
   offline. Choose a checkpoint to see changed files and their diffs.
2. Accept an offered handoff, or have the room owner recover an abandoned turn.
   Active leases and pending finalization block recovery. Between turns, owner
   recovery requires the driver's runners to have been offline for two minutes
   (or the driver to have lost access).
3. As the current driver, select **Use checkpoint for next turn**. This does not
   start execution. The selection can only refer to this chat's repository.
4. Send the next prompt from a paired computer. The runner fetches the checkpoint,
   restores files and staging state, and starts the agent in that local worktree.

Restoration requires a clean local worktree and compatible repository HEAD.
Local edits and ignored files that would be overwritten stop the restore.
If the room has independently advanced, review/integrate the checkpoint instead
of automatically overwriting newer work. A failed restoration preserves the
checkpoint so it can be selected again. A returning old driver may upload its
remaining historical artifacts, but cannot promote code or resume execution
with stale control ownership.

## Storage backends and cold Git cache

The default is **server disk**, with no cloud account or credentials required:

```dotenv
STORAGE_PROVIDER=local
# Optional separate persistent disk/mount:
# STORAGE_LOCAL_DIR=/var/lib/multiplayer-ai/objects
```

Compressed activity objects live under `<MULTIPLAYER_AI_DATA>/objects/activity/`
(or `STORAGE_LOCAL_DIR/activity/`). Git histories stay in the bare repositories
under `<MULTIPLAYER_AI_DATA>/repos/` and `projects/`. These are durable data, not
disposable files. Back them up together with PostgreSQL. Local storage stays local
even if `STORAGE_BUCKET` or AWS credentials happen to be present.

`ObjectStore` separates application operations from storage providers. The
implemented adapters are `local` and `s3`; the latter supports configurable
S3-compatible endpoints, not just AWS. Native Azure Blob/GCS APIs would need
additional adapters; selecting an unknown provider fails instead of silently
writing to disk.

| Service | STORAGE_PROVIDER | STORAGE_ENDPOINT | STORAGE_REGION | STORAGE_PATH_STYLE |
| --- | --- | --- | --- | --- |
| Server disk (default) | `local` | unused | unused | unused |
| AWS S3 | `s3` | leave unset | bucket's region | `0` |
| Cloudflare R2 | `s3` | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | `0` |
| DigitalOcean Spaces | `s3` | `https://<region>.digitaloceanspaces.com` | service's region | `0` |
| MinIO / compatible service | `s3` | your service URL | configured signing region | `1` |

For cloud storage, also set `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID` and
`STORAGE_SECRET_ACCESS_KEY`. `STORAGE_SESSION_TOKEN` supports temporary credentials.
If explicit storage credentials are absent, the AWS SDK credential chain is used
(e.g. a workload IAM role). Never use `NEXT_PUBLIC_*` for these secrets.
`STORAGE_PREFIX` optionally places objects under a namespace such as `production`;
use the same value on all web/worker instances.

Provider references: [AWS credentials](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials.html),
[R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/),
[Spaces S3 compatibility](https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/).

To move providers later:

1. Pause web/worker writes (runners retain pending uploads locally).
2. Copy the entire object directory/namespace to the destination, preserving keys
   such as `activity/<turn>/<hash>.gz` and `git/<repository>/<hash>.bundle`.
3. Verify object counts, sizes and checksums; keep the original copy for rollback.
4. Update storage settings on every web/worker instance and restart them together.
5. Verify history reads and archive restoration before resuming writes.

Database object keys remain unchanged. Changing configuration does **not** copy
existing objects automatically. Hot bare repositories remain on the Git disk;
enable the optional archival policy below to move idle Git history into the
configured object store.

Cold Git archival is opt-in:

```dotenv
STORAGE_COLD_GIT=1
STORAGE_GIT_CACHE_BYTES=2147483648
```

After repository operations, a throttled sweep evicts least-recently-used Git
repositories toward that byte budget. It creates a Git bundle containing all
refs, uploads it, verifies the stored checksum, commits its location to
PostgreSQL, and only then evicts the local bare directory. The next operation
hydrates a verified copy. New archives also record the symbolic default branch
or detached HEAD, so restoration does not assume the branch is named `main`
(migration `034_archive_head.sql`). Reads, writes and streamed Git transfers pin their
repositories for their full operation. Imports and pinned repositories are never
evicted. The byte budget is a target for idle storage: active repositories and
archive scratch space may temporarily exceed it. Application replicas sharing
Git storage must share Redis locks and the filesystem, as before.

The filesystem backend can exercise this workflow locally; it still uses the
same physical disk. External object storage is needed to move those bytes off
the application server. Bundles preserve repository authorization boundaries;
private rooms are not merged into one fetchable Git repository. Deduplication
is Git's per-repository object reuse, not global cross-tenant deduplication.
Stale pin files after a hard process crash conservatively block eviction; inspect
`git-pins/*` and stop the old process before removing its stale pin.

## Maintenance and upgrading

```sh
npm run db:migrate
npm run desktop:prepare
npm run storage:maintain                # inspect old server checkouts
npm run storage:maintain -- --apply     # remove only verified redundant copies;
                                       # prune superseded checkpoints older than 7 days
npm run storage:maintain -- --trim      # enforce the configured cold-cache target
```

Maintenance preserves dirty/untracked/ignored files, unfamiliar checkout layouts,
and local refs/reflog commits not retained by the bare repository. It does not
remove user-machine worktrees or failed temporary execution folders. Inspect
preserved folders manually. Checkpoint retention keeps the newest checkpoint
of each turn and anything selected/queued for restore. Ref deletion leaves
Git objects to ordinary grace-period GC or the next archive compaction; it does
not run immediate destructive object pruning.

Use a dedicated private bucket/prefix lifecycle policy only after coordinating
it with database retention; arbitrary expiry would break readable history.
Old unreferenced objects from an interrupted upload may require an operator
orphan-object audit. Already-uploaded activity is retained for the chat's
lifetime; this version does not silently expire its history.

## Testing

- `npm run test:repo`: object-only edits, fork, merge, sync and conflicts.
- `npm run test:runner-workspaces`: unchanged captures, durable retry, cross-device
  staged/unstaged/untracked restoration, ignored files and pairing isolation.
- `npm run test:handoff`: durable activity, ordering, retry, authorization/state
  fencing, uploaded checkpoints, and cold archive eviction/rehydration.
- The PostgreSQL/Chrome handoff suite exercises real APIs and Git smart HTTP.

For a manual offline test, pair two desktops, start a local run, wait for its
checkpoint to show in the chat, then disconnect the first desktop. On the
second computer, review the saved activity/diff, recover or accept control,
select the checkpoint, and send a prompt. Verify the first computer's unsynced
edits are neither displayed as synchronized nor overwritten when it reconnects.
