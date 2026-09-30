import assert from "node:assert/strict";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { vector } from "@electric-sql/pglite-pgvector";
import { migrate } from "../db/migrate.mjs";
import { createProject, getProjectForUser } from "../app/lib/project/store.ts";
import { ensureMemberRoom } from "../app/lib/session/memberRoom.ts";
import { createRoomRepo, finishRoomRepoSeed, listRoomRepos } from "../app/lib/session/roomRepos.ts";
import { listProjectRepositories, getProjectRepository, projectRepositoryForRoom } from "../app/lib/project/repositories.ts";
import { attachProjectRepository, publishSelectedRepository } from "../app/lib/project/repository-workspaces.ts";
import { createRepo, writeSeedBatch, finishSeed, sharedRepositoryHeadSha, readCommittedBytes, mergeSave, syncRoom,
  ensureSharedRepository, forkRoomRepository } from "../app/lib/session/repo.ts";
import { barePath, sharedRepositoryBarePath } from "../app/lib/session/paths.ts";
import { repositoryContext } from "../app/lib/session/repository-context.ts";
import { getSession } from "../app/lib/session/store.ts";

const root = await mkdtemp(join(tmpdir(), "project-repositories-"));
process.env.MULTIPLAYER_AI_DATA = root;
delete process.env.REDIS_URL;
const db = await PGlite.create({ extensions: { citext, vector } });
let waiting = Promise.resolve();
async function acquire() {
  const before = waiting; let release;
  waiting = new Promise(resolve => { release = resolve; });
  await before; return release;
}
async function execute(sql, values) { const r = await db.query(sql, values); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; }
globalThis.__maPool = {
  async query(sql, values) { const release = await acquire(); try { return await execute(sql, values); } finally { release(); } },
  async connect() { const release = await acquire(); return { query: execute, release }; },
};
const first = async (sql, values) => (await db.query(sql, values)).rows[0];
let passed = 0;
async function check(name, task) { await task(); console.log(`  ok ${name}`); passed++; }

try {
  // Start on the previous schema, with real legacy Git history on disk.
  await db.exec(`CREATE TABLE schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO schema_migrations(version) VALUES ('032_project_repositories.sql')`);
  await migrate(db);
  const alice = (await first(`INSERT INTO users(handle,email,display_name,connect_code) VALUES ('alice','alice@repos.test','Alice','PK-AAAA-AAAA') RETURNING id`)).id;
  const bob = (await first(`INSERT INTO users(handle,email,display_name,connect_code) VALUES ('bob','bob@repos.test','Bob','PK-AAAA-AAAB') RETURNING id`)).id;
  const org = (await first(`INSERT INTO orgs(slug,name,created_by) VALUES ('repos','Repositories',$1) RETURNING id`, [alice])).id;
  for (const user of [alice,bob]) await db.query(`INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,$3)`, [org,user,user === alice ? 'owner' : 'member']);
  const legacy = (await first(`INSERT INTO projects(org_id,slug,name,created_by,source,github_repo,default_branch,upstream_url)
    VALUES ($1,'legacy','Legacy',$2,'github','acme/legacy','develop','https://github.com/acme/legacy.git') RETURNING id`, [org,alice])).id;
  const legacyRoom = "legacyroomxx";
  await db.query(`INSERT INTO sessions(id,org_id,project_id,owner_id,name,join_code) VALUES ($1,$2,$3,$4,'Old room','ABCD-EFGH')`, [legacyRoom,org,legacy,alice]);
  await ensureSharedRepository(legacy);
  const oldFork = await forkRoomRepository(legacyRoom, legacy, "Old repo");
  // attachRepo uses the unchanged insert shape and works on the previous schema.
  await db.query(`INSERT INTO session_repos(session_id,root_name,base_branch,base_sha_at_fork,session_branch,head_sha)
    VALUES ($1,'Old repo','main',$2,$3,$2)`, [legacyRoom,oldFork.headSha,oldFork.sessionBranch]);
  const legacyRun = (await first(`INSERT INTO agent_runs(session_id,started_by,agent_id,base_sha) VALUES ($1,$2,'codex',$3) RETURNING id`, [legacyRoom,alice,oldFork.headSha])).id;
  await db.query(`DELETE FROM schema_migrations WHERE version='032_project_repositories.sql'`);
  await migrate(db);

  await check("migration preserves repository metadata, Git paths, room bindings, and chats", async () => {
    const repos = await listProjectRepositories(legacy);
    assert.equal(repos.length, 1); assert.equal(repos[0].id, legacy);
    assert.equal(repos[0].githubRepo, "acme/legacy"); assert.equal(repos[0].defaultBranch, "develop");
    assert.equal(await sharedRepositoryHeadSha(legacy), oldFork.headSha);
    assert.equal(await projectRepositoryForRoom(legacyRoom, null), legacy);
    assert.equal((await first(`SELECT session_id FROM agent_runs WHERE id=$1`, [legacyRun])).session_id, legacyRoom);
    const project = await getProjectForUser(org, "legacy", alice);
    assert.equal("githubRepo" in project, false);
  });

  const created = await createProject({ orgId: org, createdBy: alice, name: "Platform" });
  assert.equal(created.ok, true);
  const project = created.project;
  const room = await ensureMemberRoom(project, alice, "manager", "alice");
  const other = await ensureMemberRoom(project, bob, "editor", "bob");
  await check("new projects and member rooms start without any Git repository", async () => {
    assert.equal(room.repo, null); assert.equal(other.repo, null);
    assert.deepEqual(await listProjectRepositories(project.id), []);
    await assert.rejects(access(sharedRepositoryBarePath(project.id)), { code: "ENOENT" });
    await assert.rejects(access(barePath(room.id)), { code: "ENOENT" });
    assert.equal((await ensureMemberRoom(project, alice, "manager", "alice")).id, room.id);
  });

  async function imported(name) {
    const repo = await createRoomRepo({ sessionId: room.id, rootName: name, createdBy: alice });
    await createRepo(repo.id);
    await writeSeedBatch(repo.id, [{ path: "code.txt", data: Buffer.from(`${name}\n`).toString("base64") }]);
    const seed = await finishSeed(repo.id, name);
    await finishRoomRepoSeed(repo.id, { headSha: seed.headSha, upstreamUrl: null });
    return { ...repo, headSha: seed.headSha };
  }
  const frontend = await imported("frontend"), backend = await imported("backend");
  await check("multiple imported repositories remain room-only until explicitly shared", async () => {
    assert.equal((await listRoomRepos(room.id)).length, 2);
    assert.deepEqual(await listProjectRepositories(project.id), []);
    const ctx = await repositoryContext(room, new Request(`https://example.test/?repoId=${frontend.id}`));
    assert.equal(ctx.ref, frontend.id);
    const wrongRoom = await repositoryContext(other, new Request(`https://example.test/?repoId=${frontend.id}`));
    assert.equal(wrongRoom.status, 404);
  });
  const publish = repo => publishSelectedRepository({ sessionId: room.id, repoId: repo.id, projectId: project.id, name: repo.rootName, createdBy: alice, headSha: repo.headSha });
  const frontPublished = await publish(frontend), backPublished = await publish(backend);
  const frontShared = await getProjectRepository(frontPublished.projectRepositoryId);
  const backShared = await getProjectRepository(backPublished.projectRepositoryId);
  await check("one project contains independent shared histories", async () => {
    assert.equal(frontPublished.ok, true); assert.equal(backPublished.ok, true);
    assert.notEqual(frontShared.id, backShared.id); assert.notEqual(frontShared.id, project.id);
    assert.equal((await listProjectRepositories(project.id)).length, 2);
    assert.equal(await sharedRepositoryHeadSha(frontShared.id), frontend.headSha);
    assert.equal(await sharedRepositoryHeadSha(backShared.id), backend.headSha);
  });
  const frontOther = await attachProjectRepository(other.id, frontShared, bob);
  const backOther = await attachProjectRepository(other.id, backShared, bob);
  await check("another room selects several repositories, and re-selection is idempotent", async () => {
    assert.equal((await attachProjectRepository(other.id, frontShared, bob)).id, frontOther.id);
    assert.equal((await listRoomRepos(other.id)).length, 2);
    assert.equal((await readCommittedBytes(frontOther.id, frontOther.headSha, "code.txt")).toString(), "frontend\n");
    assert.equal((await readCommittedBytes(backOther.id, backOther.headSha, "code.txt")).toString(), "backend\n");
    assert.equal((await getSession(other.id, bob)).repo, null);
  });
  await check("publishing and syncing frontend never changes backend", async () => {
    const edit = await mergeSave(frontend.id, "code.txt", "frontend\n", "frontend v2\n", frontend.headSha, { name: "Alice", email: "alice@repos.test" });
    const published = await publish({ ...frontend, headSha: edit.headSha });
    assert.equal(published.ok, true);
    const synced = await syncRoom(frontOther.id, frontShared.id);
    assert.equal(synced.ok, true);
    assert.equal((await readCommittedBytes(frontOther.id, synced.sha, "code.txt")).toString(), "frontend v2\n");
    assert.equal(await sharedRepositoryHeadSha(backShared.id), backend.headSha);
  });
  await check("database refuses binding either room repository form to a different project", async () => {
    await assert.rejects(createRoomRepo({ sessionId: legacyRoom, rootName: "wrong-project", createdBy: alice, projectRepositoryId: frontShared.id }), /another project/);
    await assert.rejects(db.query(`UPDATE session_repos SET project_repository_id=$2 WHERE session_id=$1`, [legacyRoom, frontShared.id]), /another project/);
    assert.equal(await projectRepositoryForRoom(legacyRoom, null), legacy);
  });
  console.log(`\n${passed} project repository tests passed`);
} finally {
  delete globalThis.__maPool;
  await db.close();
  await rm(root, { recursive: true, force: true });
}
