import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publicOrigin, PublicOriginError} from '../app/lib/http/public-origin.ts';

const internal = new Request('https://0.0.0.0:3000/api/orgs/team/invitations', {
  headers: {host:'attacker.example',origin:'https://attacker.example','x-forwarded-host':'attacker.example','x-forwarded-proto':'http'},
});

test('public links use the configured origin, ignoring container and spoofed headers',()=>{
  assert.equal(publicOrigin(internal,{NODE_ENV:'production',AUTH_PUBLIC_URL:' https://workspace.example/ '}),'https://workspace.example');
  assert.equal(publicOrigin(internal,{NODE_ENV:'production',AUTH_PUBLIC_URL:'https://workspace.example:8443'}),'https://workspace.example:8443');
});

test('missing or invalid public configuration fails instead of creating a broken invitation',()=>{
  for(const value of ['', ' ', 'invalid', 'https://0.0.0.0:3000', 'https://[::]:3000',
    'http://workspace.example', 'ftp://workspace.example', 'https://user:secret@workspace.example',
    'https://workspace.example/path', 'https://workspace.example/?host=other', 'https://workspace.example/#fragment']) {
    assert.throws(()=>publicOrigin(internal,{NODE_ENV:'production',AUTH_PUBLIC_URL:value}),PublicOriginError);
  }
});

test('local development keeps usable links without OAuth or public URL configuration',()=>{
  for(const [host,expected] of [['localhost','localhost'],['127.0.0.1','127.0.0.1'],['[::1]','[::1]'],['0.0.0.0','localhost'],['[::]','localhost']]) {
    assert.equal(publicOrigin(new Request(`http://${host}:3000/api/orgs/team/invitations?x=1`),{NODE_ENV:'development'}),`http://${expected}:3000`);
  }
  assert.equal(publicOrigin(internal,{NODE_ENV:'production',AUTH_PUBLIC_URL:'http://localhost:3000'}),'http://localhost:3000');
  assert.throws(()=>publicOrigin(new Request('https://attacker.example/api/invitations'),{NODE_ENV:'development'}),PublicOriginError);
  assert.throws(()=>publicOrigin(internal,{NODE_ENV:'development',AUTH_PUBLIC_URL:'invalid'}),PublicOriginError);
});
