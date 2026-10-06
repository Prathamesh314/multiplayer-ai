import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {databaseConfig,databaseLimits,isDatabaseBusy} from '../app/lib/db/config.ts';
import {transaction} from '../app/lib/db/client.ts';

test('finite connection, statement, lock, idle transaction and total transaction limits',()=>{
  const limits=databaseLimits({});
  assert.equal(limits.idleTimeoutMillis,30000);assert.equal(limits.connectionTimeoutMillis,5000);
  assert.equal(limits.statement_timeout,30000);assert.equal(limits.lock_timeout,5000);
  assert.equal(limits.idle_in_transaction_session_timeout,15000);assert.match(limits.options,/transaction_timeout=60000/);
  for(const value of ['0','-1','NaN','301000'])assert.throws(()=>databaseLimits({DB_LOCK_TIMEOUT_MS:value}));
  for(const code of ['57014','55P03','40P01','25P03','25P04'])assert.equal(isDatabaseBusy({code}),true);
  const config=databaseConfig('postgres://test@localhost/test?options=-c%20search_path%3Dfixture',{});
  assert.match(new URL(config.connectionString).searchParams.get('options'),/search_path=fixture -c transaction_timeout=60000/);
});
test('failed rollback discards the connection and retains the original error',async()=>{
  const client=new EventEmitter(),calls=[];let discarded;
  client.query=async text=>{calls.push(text);if(text==='ROLLBACK')throw Error('connection lost');return {command:text};};
  client.release=value=>{discarded=value;};globalThis.__maPool={connect:async()=>client};
  try{await assert.rejects(transaction(async()=>{throw Error('original failure');}),/original failure/);assert.deepEqual(calls,['BEGIN','ROLLBACK']);assert.equal(discarded,true);}
  finally{delete globalThis.__maPool;}
});
test('idle transaction disconnect cannot commit success or leak an error listener',async()=>{
  const client=new EventEmitter(),calls=[];let discarded;
  client.query=async text=>{calls.push(text);return {command:text};};client.release=value=>{discarded=value;};
  globalThis.__maPool={connect:async()=>client};
  try{await assert.rejects(transaction(async()=>{client.emit('error',Error('transaction deadline'));return 'incorrect success';}),/transaction deadline/);
    assert.equal(calls.includes('COMMIT'),false);assert.equal(discarded,true);assert.equal(client.listenerCount('error'),0);}
  finally{delete globalThis.__maPool;}
});
