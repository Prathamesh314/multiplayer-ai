// Production HTTP/Chrome checks against an isolated PostgreSQL schema and a
// disposable Redis. Build the app first; DATABASE_URL only supplies the server
// on which the temporary schema is created. Existing application rows are unused.
import nextEnv from '@next/env';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

nextEnv.loadEnvConfig(process.cwd(),true);
const name='multiplayer-integration-'+randomUUID().slice(0,8);
execFileSync('docker',['run','--rm','-d','--name',name,'-p','127.0.0.1::6379','redis:7-alpine','redis-server','--save','','--appendonly','no'],{stdio:'pipe'});
try {
  const address=execFileSync('docker',['port',name,'6379/tcp'],{encoding:'utf8'}).trim();
  if(!/^127\.0\.0\.1:\d+$/.test(address))throw new Error('Unexpected Redis test address');
  process.env.REDIS_URL='redis://'+address;
  process.env.HANDOFF_TEST_POSTGRES='1';
  process.env.HANDOFF_TEST_BROWSER='1';
  process.env.HANDOFF_TEST_PRODUCTION='1';
  await import('./handoff.test.mjs');
} finally {execFileSync('docker',['stop','--time','2',name],{stdio:'pipe'});}
