/**
 * Moves the pre-accounts JSON store into Postgres.
 *
 *     node db/import-sessions.mjs <handle>
 *
 * Sessions used to have no owner — access was a per-browser cookie key — so
 * every imported session has to be assigned to somebody. That is the whole
 * reason this is a script with an argument rather than an automatic migration:
 * only you know whose sessions these were.
 *
 * Re-runnable: sessions that already exist are skipped, not duplicated.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const handle = process.argv[2];
if (!handle) {
  console.error("Usage: node db/import-sessions.mjs <handle>");
  process.exit(1);
}

const dataRoot = process.env.MULTIPLAYER_AI_DATA
  ? resolve(process.env.MULTIPLAYER_AI_DATA)
  : resolve(process.cwd(), ".multiplayer-ai");
const storeFile = resolve(dataRoot, "sessions.json");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

let stored;
try {
  stored = JSON.parse(await readFile(storeFile, "utf8"));
} catch {
  console.log(`Nothing to import: ${storeFile} does not exist.`);
  process.exit(0);
}

if (!Array.isArray(stored) || stored.length === 0) {
  console.log("Nothing to import: the store is empty.");
  process.exit(0);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const owner = await client.query("SELECT id FROM users WHERE handle = $1", [handle]);
if (owner.rows.length === 0) {
  console.error(`No user with handle "${handle}". Register first, then re-run.`);
  await client.end();
  process.exit(1);
}
const ownerId = owner.rows[0].id;

let imported = 0;
let skipped = 0;

for (const session of stored) {
  if (typeof session?.id !== "string") continue;

  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO sessions (id, owner_id, name, join_code, root_name,
                             created_at, last_active_at, pinned, archived_at)
       VALUES ($1,$2,$3,$4,$5,
               to_timestamp($6/1000.0), to_timestamp($7/1000.0), $8,
               CASE WHEN $9::bigint IS NULL THEN NULL ELSE to_timestamp($9/1000.0) END)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        session.id,
        ownerId,
        session.name ?? "Imported session",
        session.joinCode ?? "AAAA-BBBB",
        session.repo?.rootName ?? null,
        session.createdAt ?? Date.now(),
        session.lastActiveAt ?? session.createdAt ?? Date.now(),
        session.pinned === true,
        session.archivedAt ?? null,
      ],
    );

    if (inserted.rows.length === 0) {
      await client.query("ROLLBACK");
      skipped += 1;
      continue;
    }

    await client.query(
      `INSERT INTO session_members (session_id, user_id, role, added_via)
       VALUES ($1, $2, 'owner', 'owner')`,
      [session.id, ownerId],
    );

    const repo = session.repo;
    if (repo) {
      await client.query(
        `INSERT INTO session_repos
           (session_id, root_name, base_branch, base_sha_at_fork, session_branch, head_sha,
            dep_lockfile_hash, spec_doc_sha, container_image_digest, upstream_url,
            last_test_status, last_test_sha, seeded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, to_timestamp($13/1000.0))`,
        [
          session.id,
          repo.rootName ?? session.name ?? "project",
          repo.baseBranch ?? "main",
          repo.baseShaAtFork ?? repo.headSha,
          repo.sessionBranch ?? `session/${session.id}`,
          repo.headSha,
          repo.depLockfileHash ?? null,
          repo.specDocSha ?? null,
          repo.containerImageDigest ?? null,
          session.upstreamUrl ?? null,
          repo.lastTestStatus ?? "unknown",
          repo.lastTestSha ?? null,
          repo.seededAt ?? session.createdAt ?? Date.now(),
        ],
      );
    }

    await client.query("COMMIT");
    imported += 1;
    console.log(`imported ${session.id} — ${session.name ?? "(unnamed)"}`);
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`failed ${session.id}: ${cause.message}`);
  }
}

await client.end();
console.log(`\n${imported} imported, ${skipped} already present.`);
console.log("The git repos under <data>/repos are untouched and still the record.");
