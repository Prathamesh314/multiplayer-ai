import {clerkFixture} from "../helpers/clerk-fixture.mjs";
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { cp, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { migrate } from '../../db/migrate.mjs';

const alphabet='abcdefghjkmnpqrstuvwxyz23456789';
const randomId=()=>Array.from(randomBytes(12),byte=>alphabet[byte%alphabet.length]).join('');
const hash=token=>createHash('sha256').update(token).digest();

export async function fixture(databaseUrl,config,dataDirectory) {
  const clerk=await clerkFixture();
  const schema='load_test_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:10000,query_timeout:15000});
  let pool,created=false;
  const users=[], rooms=[];
  const orgId=randomUUID();
  async function close() {
    delete globalThis.__maPool;
    try { if (pool) await pool.end(); if (created) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await clerk.close(); await admin.end(); }
  }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created=true; console.log('Temporary schema: '+schema);
    const scoped=new URL(databaseUrl); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    pool=new pg.Pool({connectionString:scoped.toString(),max:5,connectionTimeoutMillis:10000,query_timeout:15000});
    globalThis.__maPool=pool;
    process.env.MULTIPLAYER_AI_DATA=dataDirectory;
    process.env.REDIS_URL=''; process.env.STORAGE_COLD_GIT='0';
    await migrate({query:(sql,args)=>pool.query(sql,args),exec:sql=>pool.query(sql)});
    const {createRepo,writeSeedBatch,finishSeed}=await import('../../app/lib/session/repo.ts');
    const {attachRepo}=await import('../../app/lib/session/store.ts');
    const setup=await pool.connect();
    try {
    await setup.query('BEGIN');
    for (let index=0;index<config.users;index++) {
      const deviceToken=randomBytes(32).toString('base64url');
      const user={index,id:randomUUID(),token:null,deviceToken,deviceId:randomUUID(),runId:randomUUID(),connectionId:randomUUID()};
      const code=randomId().slice(0,8).toUpperCase();
      await setup.query(`INSERT INTO users(id,handle,email,display_name,connect_code) VALUES ($1,$2,$3,$4,$5)`,
        [user.id,`load_${index}`,`load_${index}@example.test`,`Load user ${index}`,`PK-${code.slice(0,4)}-${code.slice(4)}`]);
      user.token=await clerk.link(setup,user.id,{expiresIn:10800});
      await setup.query(`INSERT INTO runner_devices(id,user_id,name,token_hash,version) VALUES ($1,$2,'Load fixture',$3,'2')`,[user.deviceId,user.id,hash(deviceToken)]);
      users.push(user);
      if (users.length%1000===0) console.log(`Prepared ${users.length}/${config.users} accounts.`);
    }
    await setup.query('COMMIT');
    } catch(error) {await setup.query('ROLLBACK');throw error;} finally {setup.release();}
    await pool.query(`INSERT INTO orgs(id,slug,name,created_by) VALUES ($1,'load-test','Load test',$2)`,[orgId,users[0].id]);
    await pool.query(`INSERT INTO org_members(org_id,user_id,role)
      SELECT $1,id,CASE WHEN id=$3 THEN 'owner' ELSE 'member' END FROM unnest($2::uuid[]) AS id`,[orgId,users.map(u=>u.id),users[0].id]);
    let template;
    for (let start=0;start<users.length;start+=config['room-size']) {
      const members=users.slice(start,start+config['room-size']), room={id:randomId(),projectId:randomUUID(),members};
      await pool.query(`INSERT INTO projects(id,org_id,slug,name,created_by) VALUES ($1,$2,$3,'Load project',$4)`,[room.projectId,orgId,`load-${start}`,members[0].id]);
      await pool.query(`INSERT INTO sessions(id,owner_id,org_id,project_id,name,join_code,visibility) VALUES ($1,$2,$3,$4,'Load room','ABCD-EFGH','public')`,[room.id,members[0].id,orgId,room.projectId]);
      let repo;
      if (!template) {
        await createRepo(room.id);
        await writeSeedBatch(room.id,Array.from({length:20},(_,n)=>({path:`src/file-${n}.txt`,data:Buffer.from(`Load fixture ${n}\n`+'content\n'.repeat(64)).toString('base64')})));
        repo=await finishSeed(room.id,'Load repository'); template={id:room.id,repo};
      } else {
        // Identical fixture contents, but independent bare repositories and refs.
        // Avoid tens of thousands of seed subprocesses outside the measured run.
        const target=join(dataDirectory,'repos',room.id+'.git');
        await cp(join(dataDirectory,'repos',template.id+'.git'),target,{recursive:true,errorOnExist:true,force:false});
        await rename(join(target,'refs','heads','session',template.id),join(target,'refs','heads','session',room.id));
        repo={...template.repo,sessionBranch:`session/${room.id}`};
      }
      await attachRepo(room.id,repo,null);
      for (const [index,user] of members.entries()) {
        user.roomId=room.id; user.orgId=orgId; user.assignee=members[(index+1)%members.length];
        await pool.query(`INSERT INTO project_members(project_id,org_id,user_id,role) VALUES ($1,$2,$3,'editor')`,[room.projectId,orgId,user.id]);
        await pool.query(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,$3,'owner')`,[room.id,user.id,index===0?'owner':'editor']);
        await pool.query(`INSERT INTO agent_runs(id,session_id,started_by,driver_user_id,agent_id,base_sha,title,status) VALUES ($1,$2,$3,$3,'codex',$4,'Load chat','completed')`,[user.runId,room.id,user.id,repo.headSha]);
        await pool.query(`INSERT INTO agent_run_participants(run_id,user_id,role) VALUES ($1,$2,'owner')`,[user.runId,user.id]);
      }
      rooms.push(room);
      if (rooms.length%100===0) console.log(`Prepared ${rooms.length}/${Math.ceil(config.users/config['room-size'])} rooms and repositories.`);
    }
    return {clerkEnv:clerk.env,schema,databaseUrl:scoped.toString(),pool,users,rooms,orgId,close,
      bytes:async()=>Number((await pool.query(`SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','m')`,[schema])).rows[0].bytes),
      redisKeys:()=>[...users.flatMap(user=>[`presence:conn:${user.connectionId}`,`presence:user:${user.id}`]),...rooms.map(room=>`presence:session:${room.id}`),`presence:org:${orgId}`]};
  } catch (error) { await close(); throw error; }
}
