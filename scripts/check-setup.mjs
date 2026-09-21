import nextEnv from "@next/env";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import pg from "pg";
import {createClient} from "redis";
import {listMigrations} from "../db/migrate.mjs";
import {gitStorageConfig} from "../app/lib/git-storage/config.ts";
import {detectAgents} from "../app/lib/ai/detect.ts";

if(process.argv.includes("--local")) process.env.APP_ENV="testing";
nextEnv.loadEnvConfig(process.cwd(),true);
let failures=0;
async function check(name,task,required=true) {
  try {console.log(`PASS ${name}: ${await task()}`);}
  catch(cause) {
    if(required) failures++;
    // Do not print connection strings, credential-bearing URLs, or CLI output.
    console.log(`${required?'FAIL':'WARN'} ${name}: ${cause.safeMessage || cause.code || 'check failed; inspect local configuration'}`);
  }
}
const issue=message=>Object.assign(new Error(message),{safeMessage:message});
await check("Git",async()=>{
  try {return (await promisify(execFile)('git',['--version'],{timeout:5000})).stdout.trim();}
  catch {throw issue('Git cannot run. On macOS, verify Xcode/Command Line Tools setup and PATH.');}
});
await check("Storage policy",async()=>{
  try {const config=gitStorageConfig();return `${config.mode} (configuration checked; cloud access needs a separate live check)`;}
  catch {throw issue('Set APP_ENV=testing for local disk, or configure GIT_S3_BUCKET for development/production.');}
});
await check("Postgres migrations",async()=>{
  if(!process.env.DATABASE_URL) throw issue('DATABASE_URL is unset');
  const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
  try {
    await db.connect();
    const applied=new Set((await db.query('SELECT version FROM schema_migrations')).rows.map(row=>row.version));
    const pending=(await listMigrations()).filter(version=>!applied.has(version));
    if(pending.length) throw issue(`Run npm run db:migrate; ${pending.length} migration(s) pending`);
    return 'connected; schema is current';
  } finally {await db.end();}
});
await check("Redis",async()=>{
  if(!process.env.REDIS_URL) throw issue('REDIS_URL is unset; multi-process live events are unavailable');
  const redis=createClient({url:process.env.REDIS_URL,socket:{connectTimeout:5000,reconnectStrategy:false}});
  redis.on('error',()=>{});
  try {await redis.connect();return await redis.ping();}
  finally {if(redis.isOpen) redis.destroy();}
});
await check("Provider discovery",async()=>{
  const agents=await detectAgents(true);
  for(const agent of agents.filter(agent=>agent.installed)) {
    console.log(`  ${agent.id}: ${agent.auth ? (agent.auth.loggedIn?'signed in':'signed out'):'login not probed by this provider'}, ${agent.models?.choices.length||0} model choices${agent.models?.stale?' (stale)':''}`);
  }
  if(!agents.some(agent=>agent.installed&&(!agent.auth||agent.auth.loggedIn)&&agent.models?.choices.length)) throw issue('No usable execution option discovered');
  return 'inventory available; run test:demo:live to verify real responses';
});
console.log(failures?`${failures} required check(s) failed.`:'Local prerequisites passed. This does not certify response quality or production readiness.');
process.exitCode=failures?1:0;
