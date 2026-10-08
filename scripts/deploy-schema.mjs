// Explicitly reviewed backwards compatibility, bound to the exact SQL bytes.
// An unknown migration must never take a live site into an irreversible rollout.
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

function versions(values) {
  if(!Array.isArray(values)||values.some(v=>typeof v!=='string'||!/^\d+_[a-z0-9_]+\.sql$/.test(v))||new Set(values).size!==values.length)throw new Error('Invalid migration inventory.');
  return values;
}
export function deploymentPlan(applied,migrations,approved) {
  versions(applied);versions(migrations.map(m=>m.name));
  const known=new Set(migrations.map(m=>m.name));
  if(applied.some(name=>!known.has(name)))throw new Error('The candidate does not contain every applied migration. Deployment refused before downtime.');
  const pending=migrations.filter(m=>!applied.includes(m.name));
  for(const migration of pending) {
    if(!/^[a-f0-9]{64}$/.test(migration.sha256)||approved[migration.name]!==migration.sha256)throw new Error(`Migration ${migration.name} has no reviewed rollback-compatible policy for these SQL bytes. Keep the current release running; use an expand/contract migration or a planned manual upgrade.`);
  }
  return {applied,pending:pending.map(m=>m.name)};
}
export function checkRollback(plan,current) {
  versions(plan.applied);versions(plan.pending);versions(current);
  const allowed=new Set([...plan.applied,...plan.pending]);
  if(plan.applied.some(name=>!current.includes(name))||current.some(name=>!allowed.has(name)))throw new Error('Database migration state changed outside the verified deployment plan.');
}
async function main() {
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1024*1024)throw new Error('Migration inventory is too large.');}
  const applied=input.trim()?input.trim().split(/\r?\n/):[];
  if(process.argv[2]==='--plan') {
    const directory=new URL('../db/migrations/',import.meta.url);
    const migrations=[];
    for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort())migrations.push({name,sha256:createHash('sha256').update(await readFile(new URL(name,directory))).digest('hex')});
    const approved=JSON.parse(await readFile(new URL('../db/deploy-compatible-migrations.json',import.meta.url),'utf8'));
    console.log(JSON.stringify(deploymentPlan(applied,migrations,approved)));
  } else if(process.argv[2]==='--rollback'&&process.argv[3]) {
    checkRollback(JSON.parse(await readFile(process.argv[3],'utf8')),applied);
    console.log('Database remains compatible with the previous release.');
  } else throw new Error('Usage: deploy-schema.mjs --plan | --rollback PLAN_FILE');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
