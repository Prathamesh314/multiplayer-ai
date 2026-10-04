// Loaded only by the isolated HTTP test process using Node's --import flag.
// Application code never imports this module or exposes provider overrides.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

assert.equal(process.env.GOOGLE_AUTH_HTTP_TEST, '1');
const nativeFetch = globalThis.fetch;
const clientId = 'http-fixture-client', clientSecret = 'http-fixture-secret';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(publicKey), alg: 'RS256', kid: 'google-http-fixture', use: 'sig' };
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [publicJwk] });
  if (url.href === 'https://oauth2.googleapis.com/token') {
    const request = new Request(input, init);
    const body = new URLSearchParams(await request.text());
    assert.equal(body.get('client_id'), clientId);
    assert.equal(body.get('client_secret'), clientSecret);
    assert.equal(body.get('redirect_uri'), process.env.AUTH_PUBLIC_URL+'/api/auth/google/callback');
    assert.equal(body.get('grant_type'), 'authorization_code');
    const fixture = JSON.parse(Buffer.from(body.get('code'), 'base64url').toString());
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), fixture.challenge);
    const idToken = await new SignJWT({ email: fixture.email, email_verified: true, nonce: fixture.nonce, name: 'HTTP Google User' })
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid }).setIssuer('https://accounts.google.com')
      .setAudience(clientId).setSubject(fixture.subject).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return Response.json({ id_token: idToken, access_token: 'test-access-token-must-not-be-stored' });
  }
  return nativeFetch(input, init);
};
