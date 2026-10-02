import {mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import pg from 'pg';
const exec=promisify(execFile),db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
try {
  const first=async(sql,args)=>(await db.query(sql,args)).rows[0];
  const user=(await first(`INSERT INTO users(handle,email,display_name,connect_code) VALUES ('restore','restore@example.test','Restore','PK-AAAA-AAAB') RETURNING id`)).id;
  const org=(await first(`INSERT INTO orgs(slug,name,created_by) VALUES ('restore','Restore',$1) RETURNING id`,[user])).id;
  await db.query(`INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'owner')`,[org,user]);
  const project=(await first(`INSERT INTO projects(org_id,slug,name,created_by) VALUES ($1,'restore','Restore',$2) RETURNING id`,[org,user])).id;
  const room='restoreroomx';
  await db.query(`INSERT INTO sessions(id,owner_id,org_id,project_id,name,join_code) VALUES ($1,$2,$3,$4,'Restore','ABCD-EFGH')`,[room,user,org,project]);
  const bare=join(process.env.MULTIPLAYER_AI_DATA,'repos',room+'.git');await mkdir(bare,{recursive:true});
  const git=async(args,input)=>(await exec('git',['-c','user.name=Restore','-c','user.email=restore@example.test','--git-dir',bare,...args],{input})).stdout.trim();
  await git(['init','--bare','-b','main']);
  // A real commit, candidate ref and checkpoint ref must all survive restoration.
  const tree=(await exec('git',['--git-dir',bare,'hash-object','-t','tree','/dev/null'])).stdout.trim();
  // hash-object without -w does not store an empty tree; mktree consumes EOF.
  const {spawnSync}=await import('node:child_process');
  const stored=spawnSync('git',['--git-dir',bare,'mktree'],{input:'',encoding:'utf8'}).stdout.trim();
  if(stored!==tree)throw new Error('Fixture tree mismatch.');
  const sha=await git(['commit-tree',tree,'-m','Restore fixture']);
  const turn=randomUUID();await git(['update-ref',`refs/heads/session/${room}`,sha]);await git(['update-ref','refs/heads/main',sha]);
  await git(['update-ref',`refs/turns/${turn}`,sha]);await git(['update-ref',`refs/checkpoints/${turn}/1`,sha]);
  await db.query(`INSERT INTO session_repos(session_id,root_name,base_branch,base_sha_at_fork,session_branch,head_sha)
    VALUES ($1,'repo','main',$2,$3,$2)`,[room,sha,`session/${room}`]);
  const run=(await first(`INSERT INTO agent_runs(session_id,started_by,agent_id,base_sha,status) VALUES ($1,$2,'codex',$3,'completed') RETURNING id`,[room,user,sha])).id;
  await db.query(`INSERT INTO agent_turns(id,run_id,driver_user_id,control_version,status) VALUES ($1,$2,$3,0,'completed')`,[turn,run,user]);
  await db.query(`INSERT INTO agent_run_messages(run_id,seq,role,body) VALUES ($1,1,'agent','A transcript that must survive restore.')`,[run]);
  const device=(await first(`INSERT INTO runner_devices(user_id,name,token_hash,version) VALUES ($1,'Fixture',$2,'2') RETURNING id`,[user,Buffer.from(randomUUID())])).id;
  await db.query(`INSERT INTO workspace_snapshots(id,turn_id,run_id,session_id,repo_ref,device_id,sequence,base_sha,head_sha,index_sha,snapshot_sha,captured_at)
    VALUES ($1,$2,$3,$4,$4,$5,1,$6,$6,$6,$6,now())`,[randomUUID(),turn,run,room,device,sha]);
  const text='[{"kind":"tool","text":"Read source code"}]',hash=createHash('sha256').update(text).digest('hex');
  const key=`activity/${turn}/${hash}.gz`,directory=join(process.env.MULTIPLAYER_AI_DATA,'objects','activity',turn);
  await mkdir(directory,{recursive:true});await writeFile(join(directory,hash+'.gz'),gzipSync(text));
  await db.query(`INSERT INTO run_activity_batches(turn_id,sequence,object_key,content_hash,bytes) VALUES ($1,1,$2,$3,$4)`,[turn,key,hash,Buffer.byteLength(text)]);
}finally{await db.end();}
