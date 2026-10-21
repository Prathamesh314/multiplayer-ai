import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {userFromSessionToken} from '../app/lib/auth/session-token.ts';
import {deviceFromToken} from '../app/lib/runner/devices.ts';
const f=await memoryFixture();
const token=randomBytes(32).toString('hex'), hash=createHash('sha256').update(token).digest();
try {
  await f.db.query("INSERT INTO auth_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 day')",[f.alice,hash]);
  assert.equal((await userFromSessionToken(token)).id,f.alice);
  const used=async()=>String((await f.db.query('SELECT last_used_at FROM auth_tokens WHERE token_hash=$1',[hash])).rows[0].last_used_at);
  const before=await used(); await userFromSessionToken(token); assert.equal(await used(),before);
  await f.db.query("UPDATE auth_tokens SET last_used_at=now()-interval '2 minutes' WHERE token_hash=$1",[hash]);
  const stale=await used(); await userFromSessionToken(token); assert.notEqual(await used(),stale);
  await f.db.query('UPDATE users SET display_name=$2 WHERE id=$1',[f.alice,'Updated']);
  assert.equal((await userFromSessionToken(token)).displayName,'Updated');
  await f.db.query('UPDATE auth_tokens SET revoked_at=now() WHERE token_hash=$1',[hash]);
  assert.equal(await userFromSessionToken(token),null);
  await f.db.query("UPDATE auth_tokens SET revoked_at=NULL,issued_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE token_hash=$1",[hash]);
  assert.equal(await userFromSessionToken(token),null);
  await f.db.query("UPDATE auth_tokens SET expires_at=now()+interval '1 day' WHERE token_hash=$1",[hash]);
  await f.db.query('UPDATE users SET deleted_at=now() WHERE id=$1',[f.alice]);
  assert.equal(await userFromSessionToken(token),null);
  assert.equal(await userFromSessionToken('unknown'),null);
  await f.db.query('UPDATE users SET deleted_at=NULL WHERE id=$1',[f.alice]);
  await f.db.query("INSERT INTO runner_devices(user_id,name,token_hash) VALUES ($1,'test',$2)",[f.alice,hash]);
  // Never sent a heartbeat: authenticated, but not online (only a heartbeat brings it online).
  const unseen=await deviceFromToken(token); assert.equal(unseen.userId,f.alice); assert.equal(unseen.online,false); assert.equal(unseen.lastSeenAt,null);
  await f.db.query("UPDATE runner_devices SET last_seen_at=now() WHERE token_hash=$1",[hash]);
  const device=await deviceFromToken(token); assert.ok(device.online);
  assert.equal((await deviceFromToken(token)).lastSeenAt,device.lastSeenAt);
  await f.db.query("UPDATE runner_devices SET last_seen_at=now()-interval '12 seconds' WHERE id=$1",[device.id]);
  assert.ok(Date.now()-(await deviceFromToken(token)).lastSeenAt<5000);
  await f.db.query('UPDATE runner_devices SET revoked_at=now() WHERE id=$1',[device.id]);
  assert.equal(await deviceFromToken(token),null);
  console.log('Session and device authentication: throttled writes, live revocation, expiry and account changes passed.');
} finally {await f.close();}
