// Test-only transport loaded with Node --import. Production never imports it.
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
assert.equal(process.env.EMAIL_PROVIDER_TEST,'1');
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.href!=='https://api.resend.com/emails')return nativeFetch(input,init);
  assert.equal(init.headers.authorization,'Bearer fixture-resend-key');
  assert.equal(init.headers['content-type'],'application/json');
  const body=JSON.parse(init.body);
  assert.equal(body.from,'Multiplayer AI <verify@example.test>');
  const code=/code is (\d{6})/.exec(body.text)?.[1];assert.ok(code);
  await appendFile(process.env.EMAIL_TEST_OUTBOX,JSON.stringify({email:body.to[0],code})+'\n');
  return body.to[0].endsWith('delivery-fails@example.test')
    ? Response.json({error:'secret-provider-error-must-not-leak'},{status:503})
    : Response.json({id:crypto.randomUUID()});
};
