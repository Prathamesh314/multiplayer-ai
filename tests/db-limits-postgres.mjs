import assert from 'node:assert/strict';
import pg from 'pg';
import {randomInt} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {databaseConfig} from '../app/lib/db/config.ts';
import {transaction} from '../app/lib/db/client.ts';
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required for isolated connection tests.');
const db=new pg.Pool(databaseConfig(process.env.DATABASE_URL,{
  DB_STATEMENT_TIMEOUT_MS:'300',DB_LOCK_TIMEOUT_MS:'100',DB_IDLE_TRANSACTION_TIMEOUT_MS:'250',DB_TRANSACTION_TIMEOUT_MS:'800',DB_IDLE_TIMEOUT_MS:'100',
}));
db.on('error',()=>{});
globalThis.__maPool=db;
try {
  await assert.rejects(db.query('SELECT pg_sleep(1)'),error=>error.code==='57014');
  assert.equal((await db.query('SELECT 1 AS n')).rows[0].n,1);
  const holder=await db.connect(),key=randomInt(1,2147483647);
  holder.on('error',()=>{});
  try{
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)',[key]);
    await assert.rejects(transaction(async tx=>tx.query('SELECT pg_advisory_xact_lock($1)',[key])),error=>error.code==='55P03');
    await holder.query('ROLLBACK');
  }finally{holder.release(true);}
  await assert.rejects(transaction(async()=>{await delay(500);}),error=>error.code==='25P03');
  // Frequent queries avoid the idle deadline; total duration still disconnects.
  await assert.rejects(transaction(async tx=>{
    for(let i=0;i<30;i++){await tx.query('SELECT 1');await delay(60);}
  }));
  assert.equal((await db.query('SELECT 1 AS n')).rows[0].n,1,'dead connection never returns to callers');
  await delay(350);
  assert.equal(db.idleCount,0,'unused pool connections close automatically');
  console.log('PASS: PostgreSQL enforces query, lock, idle-transaction and total-transaction deadlines; pool recovers and closes idle connections.');
}finally{delete globalThis.__maPool;await db.end();}
