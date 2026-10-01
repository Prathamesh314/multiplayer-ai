import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { vector } from "@electric-sql/pglite-pgvector";
import { migrate } from "../../db/migrate.mjs";
import { transaction } from "../../app/lib/db/client.ts";
import { recordExchange } from "../../app/lib/knowledge/memory-records.ts";
import pg from "pg";

export async function memoryFixture({deferMemoryMigration=false, postgres=false}={}) {
  delete process.env.MNEMOSYNE_URL;
  delete process.env.MEMORY_EXTRACTION_URL;
  delete process.env.REDIS_URL;
  let db, cleanup;
  if (postgres) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL integration tests.');
    const schema = `review_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({connectionString:process.env.DATABASE_URL});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new pg.Pool({connectionString:process.env.DATABASE_URL, options:`-c search_path=${schema},public`});
    globalThis.__maPool = scoped;
    db = {query:(sql,params)=>scoped.query(sql,params), exec:sql=>scoped.query(sql)};
    cleanup = async()=>{await scoped.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();};
  } else {
    db = await PGlite.create({ extensions: { citext, vector } });
    cleanup = ()=>db.close();
  }
  // Serialize whole transactions: PGlite has one connection, unlike pg.Pool.
  let waiting = Promise.resolve();
  async function acquire() {
    const previous = waiting;
    let release;
    waiting = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  }
  const execute = async (sql, params) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  if (!postgres) globalThis.__maPool = {
    async query(sql, params) { const release = await acquire(); try { return await execute(sql, params); } finally { release(); } },
    async connect() { const release = await acquire(); return { query: execute, release }; },
  };
  if (deferMemoryMigration) await db.exec(`CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO schema_migrations(version) VALUES ('030_memory_records.sql')`);
  try {
    await migrate(db);
    const first = async (sql, params) => (await db.query(sql, params)).rows[0];
    const alice = (await first(`INSERT INTO users(handle,email,display_name,connect_code)
      VALUES ('alice','alice@memory.test','Alice','PK-AAAA-AAAA') RETURNING id`)).id;
    const bob = (await first(`INSERT INTO users(handle,email,display_name,connect_code)
      VALUES ('bob','bob@memory.test','Bob','PK-AAAA-AAAB') RETURNING id`)).id;
    const outsider = (await first(`INSERT INTO users(handle,email,display_name,connect_code)
      VALUES ('outsider','outsider@memory.test','Outsider','PK-AAAA-AAAC') RETURNING id`)).id;
    const org = (await first(`INSERT INTO orgs(slug,name,created_by) VALUES ('memory','Memory',$1) RETURNING id`, [alice])).id;
    for (const user of [alice,bob,outsider]) await db.query(`INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,$3)`, [org,user,user === alice ? 'owner' : 'member']);
    const project = (await first(`INSERT INTO projects(org_id,slug,name,created_by) VALUES ($1,'memory','Memory',$2) RETURNING id`, [org,alice])).id;
    for (const [user,role] of [[alice,'editor'],[bob,'viewer']]) await db.query(`INSERT INTO project_members(project_id,org_id,user_id,role) VALUES ($1,$2,$3,$4)`, [project,org,user,role]);
    const room = "memoryroomxx", other = "memoryotherx", secret = "memorysecret";
    for (const [id,owner,visibility] of [[room,alice,'public'],[other,bob,'public'],[secret,outsider,'private']]) {
      await db.query(`INSERT INTO sessions(id,owner_id,org_id,project_id,name,join_code,visibility)
        VALUES ($1,$2,$3,$4,$1,'ABCD-EFGH',$5)`, [id,owner,org,project,visibility]);
      await db.query(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,'owner','owner') ON CONFLICT DO NOTHING`, [id,owner]);
    }
    const message = async (text, scope = room, user = alice) => (await first(`INSERT INTO session_messages(session_id,user_id,body) VALUES ($1,$2,$3) RETURNING id`, [scope,user,text])).id;
    const exchange = async ({ prompt = "Explain retry policy", reply = "Retry policy allows three attempts.", sha = null, scope = room, paths = ["src/retry.ts"] } = {}) => {
      const run = (await first(`INSERT INTO agent_runs(session_id,started_by,agent_id,base_sha,status)
        VALUES ($1,$2,'codex',$3,'completed') RETURNING id`, [scope,alice,'a'.repeat(40)])).id;
      const turn = randomUUID();
      const completion = { userPrompt: prompt, output: reply };
      await db.query(`INSERT INTO agent_turns(id,run_id,driver_user_id,control_version,status,result,completion,ended_at)
        VALUES ($1,$2,$3,0,'completed',$4,$5,now())`, [turn,run,alice,JSON.stringify({ headSha:sha, changes:sha ? paths.map(path => ({path,added:1,removed:0})) : [] }),JSON.stringify(completion)]);
      const agentMessage = (await first(`INSERT INTO agent_run_messages(run_id,seq,role,body) VALUES ($1,1,'agent',$2) RETURNING id`, [run,reply])).id;
      const input = { sessionId:scope,runId:run,turnId:turn,prompt,reply,agentMessageId:agentMessage,commitSha:sha,repoRef:scope };
      await transaction(tx => recordExchange(tx,input));
      const record = await first(`SELECT * FROM memory_records WHERE source_turn_id=$1 AND parent_id IS NULL`, [turn]);
      return { ...record, input };
    };
    return { db, first, alice, bob, outsider, org, project, room, other, secret, message, exchange,
      close: async () => { delete globalThis.__maPool; await cleanup(); } };
  } catch (cause) { delete globalThis.__maPool; await cleanup(); throw cause; }
}
