import assert from 'node:assert/strict';
import {test} from 'node:test';
import {invitationDetails} from '../app/lib/auth/invitation-link.ts';

const token='a'.repeat(43);
test('a copied invitation or bare code preserves the credential and invited email',()=>{
  assert.deepEqual(invitationDetails('  '+token+'\n'),{token});
  assert.deepEqual(invitationDetails(`https://workspace.example.test/login?invite=${token}&email=owner%2Bbeta%40example.test`),{token,email:'owner+beta@example.test'});
  assert.deepEqual(invitationDetails(`https://workspace.example.test/invite/${token}`),{token});
  assert.deepEqual(invitationDetails(`http://localhost:3000/login?next=${encodeURIComponent('/invite/'+token)}`),{token});
});
test('unrelated, incomplete and non-web URLs cannot become invitations',()=>{
  for(const value of ['',token.slice(1),token+'b','javascript:alert(1)',`https://example.test/other?invite=${token}`,`https://user:password@example.test/login?invite=${token}`])assert.equal(invitationDetails(value),null);
  assert.deepEqual(invitationDetails(`https://example.test/login?invite=${token}&email=invalid`),{token});
});
